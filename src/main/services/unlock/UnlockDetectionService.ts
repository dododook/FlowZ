/**
 * 解锁检测编排器（main）。
 *
 * 职责：懒建/重 pin 检测专用 session（走用户真实分流出口）→ 打 trace 取 egress（兼作缓存 key）→
 * 6 checker `Promise.allSettled` 逐个 settle 即广播 progress → 组装 UnlockSnapshot 缓存/返回。
 * gating（核未运行短路）、单飞、缓存/节流、切节点失效全在此。
 *
 * 关键不变量（见 flowz-unlock-detection.md 硬约束）：
 *  - session 兜底：setProxy reject → 本轮放弃（返回全 timeout），**绝不落 default session**（那会测宿主 IP）；
 *  - 端口取 localProxyPort 单一真值（由 getMixedPort 注入），端口变才重 pin（对齐 UpdateNetwork）；
 *  - **就绪门**（H6）：核刚起时进程在跑但 mixed inbound 尚未真正路由 → egress trace 兼作就绪探针。首次即时探
 *    （核已就绪则零延迟），失败退避重试；拿到有效 egress = 就绪才跑 checker。重试耗尽 → notReady，不提交
 *    快照/缓存（不污染成假 timeout），后续 invalidate/手动刷新会重试。退避 sleep 受 epoch 守卫（对齐 H1）；
 *  - egress 探得（就绪）后失败不再发生；缓存 key=egressIp，切节点天然失效、不写缓存；
 *  - **warmup 补测**：就绪门只证「单点连通」非「各端点已热」→ 首轮个别 checker 撞冷隧道 8s 超时。commit 前仅对
 *    timeout 服务退避补测 ≤SETTLE_RETRY_MAX_ROUNDS 轮（保留高置信结果），缓存只写收敛快照（epoch 守卫同就绪门）；
 *  - force 绕 TTL 但保底硬下限（防手点连发触发对端限频）；非 force 命中 TTL 直接返回缓存。
 */

import { session as electronSession, type Session } from 'electron';
import {
  SERVICE_IDS,
  type ServiceId,
  type UnlockEgress,
  type UnlockProgress,
  type UnlockResult,
  type UnlockSnapshot,
} from '../../../shared/unlock-detection';
import type { ProxyExitBlock } from '../../../shared/types';
import { parseTrace } from '../IpInfoService';
import { CHECKERS } from './checkers';
import { CHECKER_BUDGET_MS, EGRESS_TRACE_URL, UA } from './unlock-endpoints';
import {
  makeUnlockFetch,
  type UnlockFetch,
  type UnlockRequest,
  type UnlockResponse,
} from './unlock-http';

const PARTITION = 'flowz-unlock';
/** 非 force 缓存 TTL（解锁态随出口时变，30min 足够且省对端配额）。 */
const TTL_MS = 30 * 60_000;
/** force 硬下限（绕 TTL 但仍防手点连发触发对端限频）。 */
const FORCE_MIN_MS = 15_000;
/**
 * 就绪门（H6）：核刚 running 时 mixed inbound 尚未真正路由 → egress trace 探针会失败。首次即时探（核已就绪则
 * 零延迟），失败按此退避重试。总预算 ≈ (ATTEMPTS-1)*BACKOFF + 各探测耗时 ≈ 3.6s+，覆盖典型启动窗口。
 */
// 就绪门退避 schedule（D3，M1 重试内化主进程）：前 3 攻 1.2s（冷启动常态 <4s 就绪，零回归），后 3 攻拉长
// （+4/+4/+8s，末攻 ≈ 触发后 ~20s）吸收原渲染端 M1 覆盖窗。attempt n 的退避 = schedule[n-1]；总攻数 = length+1。
export const READINESS_BACKOFF_SCHEDULE_MS = [1200, 1200, 1200, 4000, 4000, 8000];
export const READINESS_MAX_ATTEMPTS = READINESS_BACKOFF_SCHEDULE_MS.length + 1; // 7
// B1 自适应就绪确认：疑似 flap（曾失败过）时，成功探测后追加 1 次确认（此间隔后连续 2 成才判就绪）；
// 首攻即成（健康路径）零代价直接就绪，不伤「连上即点亮」体感。
export const READINESS_CONFIRM_MS = 1200;
/**
 * warmup 定向补测（settle-retry）：首轮 allSettled 后，仅对 `timeout` 的服务退避重打 ≤N 轮（第 n 轮退避
 * = n × BACKOFF），收敛后再 commit。治「就绪门过了、个别 checker 仍撞冷隧道 8s 超时」的首轮瞬态——低置信
 * timeout 不与命中 marker 的高置信结果同权落定/缓存。快路径（无 timeout）零开销；轮数×单 checker 预算双封顶。
 */
export const SETTLE_RETRY_MAX_ROUNDS = 2;
export const SETTLE_RETRY_BACKOFF_MS = 2000;

export interface UnlockServiceDeps {
  /** 当前 mixed inbound 端口（= localProxyPort(config)，pin 目标）。 */
  getMixedPort: () => number;
  /** sing-box 是否在运行（gating）。 */
  isRunning: () => boolean;
  /** 选中 TS 出口 API 直判无效（未选出口设备/离线/未广告）→ 非空即短路检测（零网络）。缺省视作出口有效。 */
  getExitBlock?: () => ProxyExitBlock | null;
  /** 单个 checker settle 时广播（→ EVENT_UNLOCK_PROGRESS）。 */
  onProgress: (p: UnlockProgress) => void;
  /** 缓存失效时广播（→ EVENT_UNLOCK_INVALIDATED）。 */
  onInvalidated: () => void;
  /** 可选调试日志（§12.2 X2）：per-leg 传输失败逐条记（host/err/phase/bytes/elapsed），供真机 V36 分诊 WARP 下
   *  ChatGPT/Gemini「超时」归因（服务侧网络层拦截 vs 我方 false-timeout）。缺省不记（单测/未注入零副作用）。 */
  log?: (msg: string) => void;
  /** 测试注入：替换真实 net.request 传输（默认 makeUnlockFetch(session)）。 */
  transport?: (session: Session, req: UnlockRequest) => Promise<UnlockResponse>;
  /** 测试注入：时钟。 */
  now?: () => number;
}

export class UnlockDetectionService {
  private proxiedSession: Session | null = null;
  private pinnedPort: number | null = null;
  /** key = egressIp。 */
  private cache = new Map<string, { snap: UnlockSnapshot; at: number }>();
  private lastSnapshot: UnlockSnapshot | null = null;
  private lastRunAt = 0;
  private inflight: Promise<UnlockSnapshot> | null = null;
  /**
   * 失效代（generation）计数：invalidate() 递增。每轮 doRun 开始时捕获当时的 epoch，完成时若与当前 epoch 不符，
   * 说明本轮在飞期间发生过切节点/起停（缓存已作废）→ 不写快照/缓存、progress 不再广播、不作为 fresh 返回。
   * run() 亦据此判在飞任务是否仍新鲜：新鲜则 join，已作废则链在其后重跑（H1，防陈旧结果覆盖新节点）。
   */
  private epoch = 0;
  private inflightEpoch = -1;
  /**
   * 退避 sleep 的中止句柄（就绪门 + warmup 补测共用；invalidate 时立即唤醒 + 清定时器，防悬挂）。单飞保证同时
   * 至多一个退避 sleep 在跑（就绪门与补测在同一 doRun 内串行，不并存）。
   */
  private readinessAbort: (() => void) | null = null;

  constructor(private readonly deps: UnlockServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** 纯读最近快照（供页面挂载水合，零网络）；无则 null。 */
  getSnapshot(): UnlockSnapshot | null {
    return this.lastSnapshot
      ? { ...this.lastSnapshot, results: { ...this.lastSnapshot.results } }
      : null;
  }

  /** 切节点/起停代理时失效：递增 epoch（作废在飞轮）+ 清缓存 + 快照，广播 INVALIDATED（渲染端复位、视 running 重跑）。 */
  invalidate(): void {
    this.epoch++;
    // 唤醒就绪门退避 sleep：epoch 已变，wake 后本轮即放弃（不提交），同时清定时器防悬挂。
    this.readinessAbort?.();
    this.cache.clear();
    this.lastSnapshot = null;
    this.lastRunAt = 0;
    this.deps.onInvalidated();
  }

  /**
   * 跑一轮检测。gating 短路 → 空快照 blockedReason；force 硬下限内直接返回上次快照。
   * 单飞：在飞任务仍新鲜（epoch 未变）→ 直接 join；已被 invalidate 作废 → 链在其后重跑一轮（H1）。
   */
  async run(force = false): Promise<UnlockSnapshot> {
    if (!this.deps.isRunning()) {
      return { results: {}, checkedAt: null, egress: null, blockedReason: 'proxy-not-running' };
    }
    // 选中 TS 出口 API 直判无效 → 短路（零网络零就绪门）：经死出口检测只会空转就绪门数十秒。所有触发面
    // （挂载/跃迁/invalidate/手动/未来新增）都汇聚此处，一处短路全局生效；出口恢复由翻转对账 invalidate 重检。
    if (this.deps.getExitBlock?.()) {
      return { results: {}, checkedAt: null, egress: null, blockedReason: 'exit-invalid' };
    }
    if (this.inflight) {
      // 在飞任务的 epoch 仍是最新 → 对端单飞直接 join；已被 invalidate（epoch 变）→ 其结果已陈旧，
      // 不 join，改为链在其后重跑一轮（仍保持对端单飞、不并发），返回新一轮的新鲜快照。
      if (this.inflightEpoch === this.epoch) return this.inflight;
      return this.chainRun(force);
    }
    // S-gate（D2）：已提交的 notReady 失败终态 → 非 force 直接返终态（防 mount/切 tab 反复重扫死出口就绪门）。
    // 位置=M-gate 之后（配置无效优先级更高）、inflight 之后（在飞新鲜轮优先 join）、force 之前（手动响应回路豁免）。
    // 解除通道 = invalidate（一切真状态变化：起停/切节点/G-flip/G-flip2 均清 lastSnapshot）+ force。
    if (!force && this.lastSnapshot?.notReady) {
      return this.getSnapshot() as UnlockSnapshot;
    }
    // 手点连发保底（force 也不得 <15s 重打）→ 直接返回上次快照。
    if (force && this.lastSnapshot && this.now() - this.lastRunAt < FORCE_MIN_MS) {
      return this.getSnapshot() as UnlockSnapshot;
    }
    return this.launchRun(force);
  }

  /** 启动一轮新 doRun 并登记为在飞（记录其 epoch）；settle 后若仍是当前在飞则清空。 */
  private launchRun(force: boolean): Promise<UnlockSnapshot> {
    const startEpoch = this.epoch;
    const task = this.doRun(force, startEpoch);
    this.inflight = task;
    this.inflightEpoch = startEpoch;
    void task.finally(() => {
      if (this.inflight === task) {
        this.inflight = null;
        this.inflightEpoch = -1;
      }
    });
    return task;
  }

  /** 在飞任务已被作废：链在其后重跑一轮（保持对端单飞，不并发发起第二轮传输）。 */
  private chainRun(force: boolean): Promise<UnlockSnapshot> {
    const prev = this.inflight as Promise<UnlockSnapshot>;
    const startEpoch = this.epoch;
    const task = prev.then(() => this.doRun(force, startEpoch));
    this.inflight = task;
    this.inflightEpoch = startEpoch;
    void task.finally(() => {
      if (this.inflight === task) {
        this.inflight = null;
        this.inflightEpoch = -1;
      }
    });
    return task;
  }

  /**
   * 懒建/重 pin 检测 session，返回绑定其上的 fetch。端口无效 / setProxy reject → 返回 null（本轮放弃，
   * 绝不回落 default session）。测试经 deps.transport 注入 fake 传输，跳过真实 net.request。
   */
  private async ensureFetch(): Promise<UnlockFetch | null> {
    const port = this.deps.getMixedPort();
    if (!port || port <= 0) return null;
    try {
      if (!this.proxiedSession || this.pinnedPort !== port) {
        const s = this.proxiedSession ?? electronSession.fromPartition(PARTITION);
        await s.setProxy({ proxyRules: `socks5://127.0.0.1:${port}` });
        this.proxiedSession = s;
        this.pinnedPort = port;
      }
    } catch {
      return null; // setProxy reject → 不冒险走未 pin 会话
    }
    const s = this.proxiedSession;
    const transport = this.deps.transport;
    const base: UnlockFetch = transport ? (req) => transport(s, req) : makeUnlockFetch(s);
    const log = this.deps.log;
    if (!log) return base;
    // X2（§12.2.3）：包一层记 per-leg 失败（error 非空 = 传输失败）。判定行为零变化（reachable 只看 error）、纯诊断；
    // 限频天然成立（每 leg 每轮至多一条，轮次已被 §10 S-gate/TTL 约束）。V36 分诊依赖。
    return async (req) => {
      const t0 = this.now();
      const res = await base(req);
      if (res.error) {
        let host = req.url;
        try {
          host = new URL(req.url).host;
        } catch {
          /* 非法 url 保留原始串 */
        }
        log(
          `unlock leg fail host=${host} err=${res.error} phase=${res.phase ?? '?'} bytes=${res.bytes ?? 0} elapsed=${this.now() - t0}ms`
        );
      }
      return res;
    };
  }

  private async doRun(force: boolean, startEpoch: number): Promise<UnlockSnapshot> {
    // Z1（§12.4.3 GAP①）：链节真正执行时 epoch 已再变（快切经死出口时 chainRun 排队期间又被 invalidate）→ 零网络收口。
    // commit 的 epoch 守卫使其原样返回当前快照，陈旧链自然塌缩为廉价 no-op、新鲜末轮立即起跑（不再各烧 1 次就绪门 trace）。
    // 位于所有 run() 层 gate（S/M/force-min/缓存）之后，只删网络行为，§10 触发矩阵零变化。
    if (startEpoch !== this.epoch) {
      return this.commit({ results: {}, checkedAt: null, egress: null }, startEpoch, null);
    }
    const fetch = await this.ensureFetch();
    if (!fetch) {
      // 无法建代理会话（端口无效 / setProxy reject）→ 全 timeout，不缓存（下次可重试）。
      const results: Record<string, UnlockResult> = {};
      for (const id of SERVICE_IDS) {
        results[id] = { status: 'timeout' };
        if (startEpoch === this.epoch) this.deps.onProgress({ serviceId: id, result: results[id] });
      }
      return this.commit({ results, checkedAt: this.now(), egress: null }, startEpoch, null);
    }

    // 就绪门（H6）：egress trace 兼作「inbound 已就绪」探针。首次即时探（核已就绪则零延迟），失败退避重试；
    // 拿到有效 egress = 就绪。退避 sleep 每次 wake 比对 epoch（切节点/停代理即放弃本轮，对齐 H1）。
    const egress = await this.probeReady(fetch, startEpoch);
    if (!egress) {
      // 就绪门耗尽/退避期被 invalidate → **提交** notReady 终态快照（D1，非原「不提交」）：使 mount get() 见终态
      // 不重扫（S-gate 兜住），checkedAt 保持 null（不说谎，本轮没跑 checker）。lastRunAt 置位——本轮真跑了一整轮
      // 就绪门网络，force 15s 硬下限据此生效（顺带修 manual 无防连发）。commit 的 epoch 守卫：在飞被 invalidate
      // 则不落陈旧终态（返复位快照，H1 语义原样）；egress=null → 天然不入 cache。解除 = invalidate/force/G-flip2。
      this.lastRunAt = this.now();
      return this.commit(
        { results: {}, checkedAt: null, egress: null, notReady: true },
        startEpoch,
        null
      );
    }

    // 缓存命中（非 force + 未过 TTL + 本轮未被作废）→ 直接返回缓存（不重打 checker）。
    if (!force && startEpoch === this.epoch) {
      const c = this.cache.get(egress.ip);
      if (c && this.now() - c.at < TTL_MS) {
        this.lastSnapshot = c.snap;
        return c.snap;
      }
    }

    this.lastRunAt = this.now();
    const results: Record<string, UnlockResult> = {};
    const runOne = async (id: ServiceId): Promise<void> => {
      let result: UnlockResult;
      try {
        result = await this.runChecker(id, fetch);
      } catch {
        result = { status: 'timeout' }; // checker 内部异常兜底（不应发生，防御）
      }
      results[id] = result;
      // epoch 闸：本轮在飞期间被 invalidate（切节点/起停）→ 陈旧 progress 不再广播（防点亮旧节点结果）。
      if (startEpoch === this.epoch) this.deps.onProgress({ serviceId: id, result });
    };
    await Promise.allSettled(SERVICE_IDS.map(runOne));

    // warmup 定向补测（settle-retry）：就绪门只证「单点(cloudflare)连通」，非「各目标端点已热」；冷隧道/DNS 前几秒
    // 个别 checker（大 body / 多请求链）会撞 8s 超时。timeout 是低置信瞬态兜底，不该与命中 marker 的 ok/blocked/partial
    // 同权落定并缓存 30min。故 commit 前仅对 timeout 的服务退避补测 ≤N 轮（保留高置信结果、只重打灰的，对端友好），
    // 收敛后再 commit → 缓存写收敛快照。退避 sleep 复用就绪门句柄（invalidate 可唤醒放弃，单飞保证同时至多一个）。
    for (let round = 1; round <= SETTLE_RETRY_MAX_ROUNDS; round++) {
      const timeoutIds = SERVICE_IDS.filter((id) => results[id]?.status === 'timeout');
      if (timeoutIds.length === 0) break; // 全部高置信 → 快路径零额外开销
      if (startEpoch !== this.epoch) break; // 本轮已作废 → commit 守卫会丢弃
      // 灰点翻回 pulse spinner（视觉诚实：补测中，非终态）。
      for (const id of timeoutIds)
        this.deps.onProgress({ serviceId: id, result: { status: 'checking' } });
      await this.sleep(SETTLE_RETRY_BACKOFF_MS * round); // 递增退避 2s→4s；隧道进一步热
      if (startEpoch !== this.epoch) break; // 退避期间被 invalidate → 放弃本轮
      await Promise.allSettled(timeoutIds.map(runOne));
    }

    // B2 低置信不缓存：就绪门撞运气过（egress 非 null）但 6 checker 全 timeout（flap 期典型）→ 提交 lastSnapshot
    // 使 UI 如实显示灰/超时 + mount 水合零网络，但**跳过 cache 写入**（传 null egress 键）+ 标 lowConfidence——避免垃圾
    // 快照按 egressIp 锁 30min，下一真触发（含 G-flip2 伴测成功）即重检。命中任一 marker 的高置信结果照常入缓存。
    const lowConfidence = SERVICE_IDS.every((id) => results[id]?.status === 'timeout');
    return this.commit(
      { results, checkedAt: this.now(), egress, ...(lowConfidence ? { lowConfidence: true } : {}) },
      startEpoch,
      lowConfidence ? null : egress
    );
  }

  /**
   * 完成收口：若本轮 epoch 已变（在飞期间 invalidate 过）→ 结果对应旧出口/旧分流，作废——不写 lastSnapshot/cache、
   * 不作为 fresh 返回（返回当前已复位快照，通常为空），避免陈旧结果覆盖新节点（H1）。
   */
  private commit(
    snap: UnlockSnapshot,
    startEpoch: number,
    egress: UnlockEgress | null
  ): UnlockSnapshot {
    if (startEpoch !== this.epoch) {
      return this.getSnapshot() ?? { results: {}, checkedAt: this.now(), egress: null };
    }
    this.lastSnapshot = snap;
    if (egress) this.cache.set(egress.ip, { snap, at: this.now() }); // egress 失败不写缓存
    return snap;
  }

  /**
   * N3：给单 checker 加总预算（Promise.race 兜底）。单请求各 8s 传输超时，但 Disney 主链+备法可 4 连请求串联、
   * 最坏尾延迟累加 → 此处对整个 checker 封顶 CHECKER_BUDGET_MS，超预算落 timeout（有界即可，非精确）。
   */
  private runChecker(id: ServiceId, fetch: UnlockFetch): Promise<UnlockResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<UnlockResult>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'timeout' }), CHECKER_BUDGET_MS);
    });
    return Promise.race([
      CHECKERS[id](fetch).finally(() => {
        if (timer) clearTimeout(timer);
      }),
      budget,
    ]);
  }

  /**
   * 就绪门探测：egress trace 兼作「inbound 已就绪」探针。attempt 0 立即探（核已就绪则零延迟，如手动刷新），
   * 失败则退避 READINESS_BACKOFF_SCHEDULE_MS[attempt-1] 重试，至多 READINESS_MAX_ATTEMPTS(7) 次（D3）。
   * B1 自适应确认：健康路径（一路成功）首成即就绪、零确认；疑似 flap（曾失败过）成功后追加 1 次确认探测
   * （READINESS_CONFIRM_MS + 一探，连续 2 成才就绪）。**时长上界**：纯黑洞（全失败）≈ sum(schedule)+末探 ≈ 76s；
   * 间歇 flap（每攻 primary 成、confirm 超时）最坏叠加 6×(CONFIRM+确认探超时) → 可达 ~130s（有界、非 hang，仅
   * 单轮一次；此后 S-gate 拦住重扫）。epoch 守卫：退避 sleep 后 / 每次探测（含确认探）后比对 startEpoch，invalidate
   * 已递增（切节点/停代理）→ 立即放弃本轮（返 null），退避定时器由 invalidate 唤醒不悬挂（对齐 H1）。耗尽 → null。
   */
  private async probeReady(fetch: UnlockFetch, startEpoch: number): Promise<UnlockEgress | null> {
    let everFailed = false; // 是否曾有一攻失败（触发 B1 确认，疑似 flap）
    for (let attempt = 0; attempt < READINESS_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await this.sleep(READINESS_BACKOFF_SCHEDULE_MS[attempt - 1] ?? 8000); // D3：退避取 schedule
        if (startEpoch !== this.epoch) return null; // 退避期间被 invalidate → 放弃本轮
      }
      const egress = await this.probeEgress(fetch);
      if (startEpoch !== this.epoch) return null; // 探测期间被 invalidate → 放弃本轮
      if (egress) {
        if (!everFailed) return egress; // 健康路径：首攻/一路成功 → 直接就绪，零代价
        // B1：疑似 flap（曾失败过）→ 追加 1 次确认（连续 2 成才判就绪；确认失败则续 schedule）。
        await this.sleep(READINESS_CONFIRM_MS);
        if (startEpoch !== this.epoch) return null;
        const confirm = await this.probeEgress(fetch);
        if (startEpoch !== this.epoch) return null;
        if (confirm) return egress; // 2 连成 → 就绪
        everFailed = true; // 确认失败 → 本轮不判就绪，续下一攻 schedule
      } else {
        everFailed = true;
      }
    }
    return null; // 重试耗尽，未就绪
  }

  /** 就绪门退避 sleep：可被 invalidate 立即唤醒（清定时器防悬挂）。resolve 后 probeReady 据 epoch 判是否放弃。 */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.readinessAbort = null;
        resolve();
      }, ms);
      this.readinessAbort = () => {
        clearTimeout(timer);
        this.readinessAbort = null;
        resolve();
      };
    });
  }

  private async probeEgress(fetch: UnlockFetch): Promise<UnlockEgress | null> {
    try {
      const res = await fetch({ url: EGRESS_TRACE_URL, headers: { 'User-Agent': UA } });
      if (res.status !== 200 || !res.body) return null;
      const info = parseTrace(res.body);
      return info ? { ip: info.ip, region: info.countryCode } : null;
    } catch {
      return null;
    }
  }
}
