/**
 * 节点域名解析上游模型（issue #147 多源 race）。纯逻辑、无 I/O，UI 校验 + 主进程 race server 共用、可逐项单测。
 *
 * 设计 docs/design/issue147-node-dns-race-resolver.md §9：
 *  - 内置上游单一真值（ali/dnspod/system），IP 派生自 shared/dns 的 DOH_*_IP（杜绝硬编漂移）。
 *  - 自定义上游强制纯 IP（parseDnsServerSpec.isDomain 拒绝）：零 bootstrap + route 直连放行确定。
 *  - Tier1（加密 DoH/DoT）抢跑、上限 3；Tier2（明文 UDP / system）兜底不占额度、不与 DoH 抢跑。
 *  - canonical 去重：内置与等价自定义合并（先去重再数上限）。
 */
import { DOH_ALIDNS_IP, DOH_DNSPOD_IP, parseDnsServerSpec } from './dns';
import type { CustomDnsUpstream } from './types';

/** 一个解析上游 = 一种解析方式 + 其 Tier。 */
export interface ResolveUpstream {
  id: string; // 'ali' | 'dnspod' | 'system' | 自定义 id
  kind: 'doh' | 'udp' | 'system'; // doh: DoH/DoT over IP（fetch/TLS）; udp: 明文 UDP; system: 系统 DNS
  ip?: string; // 纯 IP（doh/udp；system 无）
  port?: number;
  path?: string; // 仅 DoH(https)
  dot?: boolean; // doh kind 下是否 DoT(tls)——实现侧区分 DoH(fetch) vs DoT(TLS)
  tier: 1 | 2; // Tier1 抢跑（加密）/ Tier2 兜底（明文 UDP / system）
}

/** Tier1 抢跑上游上限（设计 §9.1：2 见顶、第 3 冗余；只数 Tier1，Tier2 不占额度）。 */
export const MAX_TIER1_UPSTREAMS = 3;

/** 内置上游 id。 */
export type BuiltinUpstreamId = 'ali' | 'dnspod' | 'system';

/** 内置上游单一真值（id → ResolveUpstream），IP 派生 DOH_*_IP，杜绝硬编漂移。 */
export const BUILTIN_UPSTREAMS: Record<BuiltinUpstreamId, ResolveUpstream> = {
  ali: { id: 'ali', kind: 'doh', ip: DOH_ALIDNS_IP, port: 443, path: '/dns-query', tier: 1 },
  dnspod: { id: 'dnspod', kind: 'doh', ip: DOH_DNSPOD_IP, port: 443, path: '/dns-query', tier: 1 },
  system: { id: 'system', kind: 'system', tier: 2 },
};

/** 解析档位的初始默认（race on 多选 / off 单选）。 */
export const DEFAULT_POOL_IDS: readonly string[] = ['ali', 'dnspod'];
export const DEFAULT_SINGLE_ID = 'ali';

/**
 * 自定义上游 spec → ResolveUpstream；**强制纯 IP**（parseDnsServerSpec.isDomain 拒绝），非法/域名返回 null。
 * https(DoH) / tls(DoT) → Tier1 加密抢跑；udp / 裸 IP → Tier2 明文兜底。
 */
export function parseCustomUpstream(
  c: CustomDnsUpstream | undefined | null
): ResolveUpstream | null {
  if (!c || !c.id || !c.spec) return null;
  const p = parseDnsServerSpec(c.spec);
  if (!p || p.isDomain) return null; // 纯 IP 强制
  if (p.type === 'udp') {
    return { id: c.id, kind: 'udp', ip: p.server, port: p.port, tier: 2 };
  }
  // DoT（tls://）二期未实现：race server queryOneUpstream 对 dot 直接 throw（永远 FAIL）。
  // 此处拒绝，避免 UI 接受 tls:// 上游、用户以为生效却静默全 FAIL。待 DoT 落地后改回 dot: p.type==='tls'。
  if (p.type === 'tls') return null;
  return {
    id: c.id,
    kind: 'doh',
    ip: p.server,
    port: p.port,
    path: p.path || '/dns-query',
    dot: false,
    tier: 1,
  };
}

/** UI 校验：自定义 spec 是否合法（纯 IP DoH/DoT/UDP）。供「添加自定义上游」按钮 enable / 错误提示。 */
export function isValidCustomUpstreamSpec(spec: string): boolean {
  return parseCustomUpstream({ id: '_probe', spec }) !== null;
}

/** canonical 去重 key：system 唯一；其余按 (kind, IP, port, path)。udp 与 doh 即便同 IP 也不同（协议/端口不同）。 */
export function upstreamCanonicalKey(u: ResolveUpstream): string {
  if (u.kind === 'system') return 'system';
  return `${u.kind}:${u.ip}:${u.port}:${u.path ?? ''}`;
}

export interface ResolvedUpstreams {
  tier1: ResolveUpstream[]; // 抢跑（去重 + 上限 3）
  tier2: ResolveUpstream[]; // 兜底（不抢跑、不占额度）
  directIps: string[]; // 全部纯 IP（供 BOOTSTRAP_DIRECT_DNS_IPS 合并 + route 直连放行）
}

/**
 * 解析上游 id 列表 → Tier1/Tier2 分桶 + canonical 去重 + Tier1 上限 3。
 * @param ids 勾选(pool)/单选([single]) 的上游 id。无效 id / 自定义解析失败 / 重复 → 跳过。
 * @param custom 自定义上游定义。
 * 空 Tier1（全不勾/全无效/仅 Tier2）→ 回退默认 [ali,dnspod]，防误配致无抢跑上游全断（设计 §9.3 校验闸）。
 */
export function resolveUpstreams(
  ids: readonly string[],
  custom: readonly CustomDnsUpstream[] = []
): ResolvedUpstreams {
  const customById = new Map<string, ResolveUpstream | null>();
  for (const c of custom) customById.set(c.id, parseCustomUpstream(c));

  const seen = new Set<string>();
  const tier1: ResolveUpstream[] = [];
  const tier2: ResolveUpstream[] = [];
  for (const id of ids) {
    const up =
      (BUILTIN_UPSTREAMS as Record<string, ResolveUpstream | undefined>)[id] ?? customById.get(id);
    if (!up) continue; // 无效 id / 自定义非纯 IP → 跳过
    const key = upstreamCanonicalKey(up);
    if (seen.has(key)) continue; // 去重（内置与等价自定义合并）
    seen.add(key);
    if (up.tier === 1) {
      if (tier1.length < MAX_TIER1_UPSTREAMS) tier1.push(up); // 上限 3（去重后）
    } else {
      tier2.push(up);
    }
  }
  // 空 Tier1 → 回退默认 [ali,dnspod]（race 需至少一个抢跑上游）。去重防与已有 Tier2 重复。
  if (tier1.length === 0) {
    tier1.push(BUILTIN_UPSTREAMS.ali, BUILTIN_UPSTREAMS.dnspod);
  }
  const directIps: string[] = [];
  for (const u of [...tier1, ...tier2]) {
    if (u.ip && !directIps.includes(u.ip)) directIps.push(u.ip);
  }
  return { tier1, tier2, directIps };
}
