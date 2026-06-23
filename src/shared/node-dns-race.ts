/**
 * 节点域名解析 race 转发核心（issue #147 §4/§5）。纯逻辑 + 注入上游查询（单测零网络）。
 *
 * 三态 race：
 *  - HIT 抢跑：任一上游返回 NOERROR+含 qtype 记录 → 立即取该上游【完整响应 wire】透传（回填内核 query id），取消其余；
 *  - EMPTY 不抢跑：上游返回空解析（NODATA/NXDOMAIN）不立即用 → 等本层所有上游 settle 才下「空」结论；
 *  - FAIL≠EMPTY：上游故障（SERVFAIL/超时/畸形）不算答案；全 FAIL → buildServfail。
 * Tier 分层：先 Tier1 抢跑；Tier1 全无 HIT 才查 Tier2（兜底，不与 Tier1 抢跑）。整体受 totalBudgetMs 硬约束。
 */
import { decodeDnsQuestion, classifyDnsResponse, setDnsMessageId, buildServfail } from './dns-wire';
import type { ResolveUpstream } from './node-resolver-upstreams';

/** 注入：对一个上游发 query wire，返回响应 wire；FAIL（超时/网络错/拒绝）→ reject。signal 触发即中断。 */
export type UpstreamQueryFn = (
  upstream: ResolveUpstream,
  query: Uint8Array,
  signal: AbortSignal
) => Promise<Uint8Array>;

export interface RaceForwardOpts {
  query: UpstreamQueryFn;
  totalBudgetMs?: number;
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
}

export const DEFAULT_RACE_BUDGET_MS = 2000;

interface TierResult {
  hit?: Uint8Array;
  empty?: Uint8Array;
}

/**
 * 单层 race：并发查一组上游。HIT 抢跑（first wins，取消其余）；无 HIT 等全部 settle、记录任一 EMPTY 整包。
 * 外部 budgetSignal abort → 用已收集到的 EMPTY 收口（仍取消 in-flight）。
 */
function raceTier(
  query: Uint8Array,
  qtype: number,
  upstreams: readonly ResolveUpstream[],
  fn: UpstreamQueryFn,
  budgetSignal: AbortSignal
): Promise<TierResult> {
  if (upstreams.length === 0) return Promise.resolve({});
  return new Promise<TierResult>((resolve) => {
    let pending = upstreams.length;
    let empty: Uint8Array | undefined;
    let settled = false;
    const ctrl = new AbortController();
    const finish = (r: TierResult) => {
      if (settled) return;
      settled = true;
      budgetSignal.removeEventListener('abort', onBudget);
      ctrl.abort(); // 取消其余 in-flight
      resolve(r);
    };
    const onBudget = () => finish({ empty });
    if (budgetSignal.aborted) {
      resolve({});
      return;
    }
    budgetSignal.addEventListener('abort', onBudget, { once: true });
    for (const up of upstreams) {
      fn(up, query, ctrl.signal).then(
        (resp) => {
          if (settled) return;
          const cls = classifyDnsResponse(resp, qtype);
          if (cls === 'HIT') return finish({ hit: resp });
          if (cls === 'EMPTY' && !empty) empty = resp;
          if (--pending === 0) finish({ empty });
        },
        () => {
          if (settled) return;
          if (--pending === 0) finish({ empty }); // FAIL：不抢跑，递减
        }
      );
    }
  });
}

/**
 * race 转发主入口：内核 query wire → 三态 race（Tier1 抢跑 → Tier2 兜底）→ 响应 wire（回填内核 id）。
 * 畸形 query → SERVFAIL。HIT/EMPTY 透传命中上游的【完整响应】（多 A/TTL/CNAME 全保留供内核 DialSerial）。
 */
export async function raceForward(
  query: Uint8Array,
  upstreams: { tier1: readonly ResolveUpstream[]; tier2: readonly ResolveUpstream[] },
  opts: RaceForwardOpts
): Promise<Uint8Array> {
  const q = decodeDnsQuestion(query);
  if (!q) return buildServfail(query);

  const budgetCtrl = new AbortController();
  const timer = setTimeout(() => budgetCtrl.abort(), opts.totalBudgetMs ?? DEFAULT_RACE_BUDGET_MS);
  try {
    // 阶段 1：Tier1 抢跑
    const r1 = await raceTier(query, q.qtype, upstreams.tier1, opts.query, budgetCtrl.signal);
    if (r1.hit) return setDnsMessageId(r1.hit, q.id);
    let empty = r1.empty;

    // 阶段 2：Tier1 无 HIT 且预算未尽 → Tier2 兜底（不与 Tier1 抢跑）
    if (!budgetCtrl.signal.aborted && upstreams.tier2.length > 0) {
      const r2 = await raceTier(query, q.qtype, upstreams.tier2, opts.query, budgetCtrl.signal);
      if (r2.hit) return setDnsMessageId(r2.hit, q.id);
      empty = empty ?? r2.empty;
    }

    // 阶段 3：有 EMPTY → 如实空（NODATA/NXDOMAIN 透传，回填 id）；全 FAIL → SERVFAIL
    return empty ? setDnsMessageId(empty, q.id) : buildServfail(query);
  } finally {
    clearTimeout(timer);
  }
}
