/**
 * sing-box 核就绪门控（issue #159 纵深网，跨平台）。
 *
 * helper 路径（startViaHelper）原「spawn 即 emit started」：起后数秒才死的核（如 Windows wintun open 卡死）
 * 要等 10s 健康检查兜底才被发现。改为等核真就绪（管理 API 端口可连）再判成功；起核期内核死/超时 → 抛可重试
 * 错误交 runStartWithRetry 快速重起 → 残余失败 ~秒级自愈而非 10s+，且不再向 UI/stats 假报「已连接」。
 *
 * 纯逻辑 waitForCoreReady 注入 isAlive/isReady/sleep，便于无真实进程/端口/计时器的单测。
 */
import { connect } from 'net';

/**
 * 「核已起但起核期未就绪/退出，应交 runStartWithRetry 静默重起」的标记错误。
 * 关键：startSingBoxProcess 的 helper 路径 catch 会把**普通**错误回退到提权路径（UAC/osascript）——若就绪失败抛普通
 * 错误，会被误判为「helper 启动失败」而弹 UAC，违背重试初衷。故抛本类，catch 端 instanceof 命中即 re-throw（透传给 retry）。
 * 文案不含 nonRetryableErrors 关键词（找不到/权限/permission/enoent/eacces/eperm/配置文件格式错误/invalid config）→ shouldRetry 判可重试。
 */
export class CoreStartRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreStartRetryError';
  }
}

/**
 * issue #176：本次起核在就绪等待期内被「更新的 start/stop」接管（lifecycleGeneration 变化）的让位标记错误。
 * 关键区别于 CoreStartRetryError：**不重试、不清理**——接管方拥有进程/系统代理/适配器状态，本腿必须静默退场，
 * 绝不调 stopCore()/cleanup()（会清掉接管方的 refs）。start() 包装层 instanceof 命中即 return（不 rethrow）。
 * 背景：旧实现就绪/重试腿不读世代令牌，被去抖重启/用户停止接管后仍烧满 12s + stopCore + retry，与接管流叠加
 * 抢放 wintun 适配器 → 「管理 API 未绑定」假超时自我放大（Windows TUN 重启风暴根因）。
 */
export class CoreStartSupersededError extends Error {
  constructor(message = 'sing-box 起核已被更新的启动/停止操作接管，本腿让位') {
    super(message);
    this.name = 'CoreStartSupersededError';
  }
}

/**
 * issue #324：Windows TUN「持续性初始化失败」终态标记错误。
 * 与 CoreStartRetryError 的关键区别：**终态、不重试**。语义——单次 start 内起核重试预算耗尽，且全程（跨所有重试腿）
 * 从未观测到自家 wintun 适配器出现、而适配器探测链路本身可用（排除杀软拦 PowerShell 的 unknown 误判）→ 判定
 * 不是瞬态释放竞态（#159/#176），而是 wintun 驱动/被拦/冲突 VPN 类持续性故障，继续「正在自动重试」只会无限循环
 * 误导用户。故转为携可操作诊断的终态错误上抛，由 start() 收口 + EVENT_PROXY_ERROR（errorCode=TUN_INIT_PERSISTENT）
 * 驱动渲染端诊断卡。走 instanceof 判别（对齐 CoreStartSupersededError 先例），**不进 nonRetryableErrors 词表**。
 * 不跨 start 累计计数（下次冷启环境可能已修复，应允许重试）——单次 start 内「预算耗尽且从未见适配器」已是强判据。
 */
export class CoreStartTunPersistentError extends Error {
  // review Low#4：终态判据（预算耗尽 + 探测可用但全程未见适配器）对「非 wintun 类持续起核失败」（坏配置/端口占用/慢机
  // 冷启拉 ruleset 超时）同样命中——那些场景适配器也从未创建。故文案**不独指 wintun**：先陈述观测事实 + 引导开诊断采集
  // 定位（真正拍板证据），再把 wintun/冲突 VPN 列为常见原因之一。定向到具体根因的日志佐证留真机项 #1 后增强。
  constructor(
    message = 'TUN 适配器持续未能建立，起核重试均未成功——已停止无谓重试。常见原因：wintun 驱动被杀软拦截/损坏、其它 VPN/TUN 客户端占用，或内核/配置/端口导致起核失败。请开启「诊断采集」重导日志以定位；若确为 wintun，检查杀软隔离区的 wintun.dll 并关闭其它 TUN/VPN 客户端后重试。'
  ) {
    super(message);
    this.name = 'CoreStartTunPersistentError';
  }
}

/**
 * 起核错误「按文案判不可重试」的关键词黑名单（issue #176 起核 retry 分类）。权限/找不到/坏配置类无论重试多少次
 * 都不会好 → 直接失败。**新增 CoreStartRetryError 文案时务必不误命中这些词**（issue #324 A1「…未建立」/A3
 * 「…从未创建」/「…初始化未完成」均已避开，由 startMessageIsNonRetryable 单测守卫，防未来加词静默把可重试文案变不可重试）。
 */
export const NON_RETRYABLE_START_ERROR_PATTERNS = [
  '找不到',
  '权限',
  'permission',
  'enoent',
  'eacces',
  'eperm',
  '配置文件格式错误',
  'invalid config',
] as const;

/** message 是否命中「不可重试」黑名单（大小写不敏感）。runStartWithRetry.shouldRetry 与单测共用同一判据，杜绝漂移。 */
export function startMessageIsNonRetryable(message: string): boolean {
  const m = message.toLowerCase();
  return NON_RETRYABLE_START_ERROR_PATTERNS.some((p) => m.includes(p));
}

/**
 * TCP 可连探测（管理 API 已绑定即就绪）。零提权。连上 → true；超时/拒绝/错误 → false。
 */
export function probeTcpReachable(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/**
 * ready=就绪；dead=进程已退出（起核期死）；timeout=进程在但管理 API 未在预期内绑定；
 * superseded=就绪等待期内被更新的 start/stop 接管（issue #176），应静默让位（不重试、不清理）。
 */
export type CoreReadyOutcome = 'ready' | 'dead' | 'timeout' | 'superseded';

/** waitForCoreReady 注入依赖（单测可替换为桩）。 */
export interface CoreReadyDeps {
  /**
   * 核进程是否存活。允许返回 Promise（B4）：Windows 上这条腿是 `tasklist` 子进程，同步版会阻塞 event loop，
   * 起核窗内每轮一次足以让主进程可感卡顿。同步桩（返回 boolean）照常可用——`await` 对非 Promise 是恒等。
   */
  isAlive: () => boolean | Promise<boolean>;
  /** 管理 API 是否可连（就绪信号）。 */
  isReady: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  /** 本次起核是否已被更新的 start/stop 接管（issue #176，可选；缺省视作未接管）。 */
  isSuperseded?: () => boolean;
  /**
   * 单调毫秒时钟，缺省 `Date.now`。用于把 timeoutMs 落成**真的时间预算**（见 waitForCoreReady 头注）。
   * 单测想验预算本身时注入一个跟着 sleep 走的假时钟；不注入则退化为「轮数封顶」的旧行为，既有用例零改动。
   */
  now?: () => number;
}

/**
 * 轮询等核就绪。每轮：被接管 → 'superseded'（立即让位，#176）；进程死 → 'dead'（立即，不等满 timeout）；
 * API 可连 → 'ready'；否则 sleep。满 maxPolls 仍未就绪 → 末轮再判一次 → 'timeout'。
 * 早退使成功路径仅等到 API 绑定（通常 <1s），不加额外延迟。
 */
export async function waitForCoreReady(
  opts: { timeoutMs: number; pollMs: number; alivePollMs?: number },
  deps: CoreReadyDeps
): Promise<CoreReadyOutcome> {
  const pollMs = Math.max(1, opts.pollMs);
  // B4：探活与就绪**解耦成两个节拍**。把 pollMs 调细是为了少空等（就绪判据是本地 TCP connect，近乎免费），
  //   但探活是子进程（Windows `tasklist` ~50-100ms），跟着细节拍走会把 spawn 次数放大同样的倍数——那是拿一个
  //   开销换另一个更大的开销。故 alivePollMs 单独给：缺省 = pollMs（逐字保持旧行为），调用方按需放宽。
  //   注：这里**不**对 alivePollMs 做「不得小于 pollMs」的下夹——下一行的 `Math.max(1, …)` 已把 aliveEvery 兜到
  //   至少 1 轮，任何更小的 alivePollMs 都产生同一结果，夹了也观测不到（复审实测：删掉下夹全量 0 红 = 死代码）。
  const alivePollMs = opts.alivePollMs ?? pollMs;
  const aliveEvery = Math.max(1, Math.round(alivePollMs / pollMs)); // 每 N 轮探一次活（下限 1 轮）
  const maxPolls = Math.max(1, Math.ceil(opts.timeoutMs / pollMs));
  // timeoutMs 必须是**时间**预算，不能只是轮数封顶。`maxPolls` 假设每轮成本 ≈ pollMs，而 isReady 是 TCP connect
  //   （`probeTcpReachable` 自带 1000ms 上限）、isAlive 是子进程——单轮真实成本可以远超 pollMs。pollMs 越细，
  //   这个假设错得越离谱：500ms→50ms 使单轮固定开销被摊 24 次变成摊 241 次，connect 打满时实测墙钟从 38.9s
  //   膨胀到 254.9s（复审实测）。故以单调时钟的 deadline 为主判据，maxPolls 退居为「时钟不前进时」的兜底
  //   （注入式假 sleep 的单测正是这种情形，故既有用例行为不变）。
  const now = deps.now ?? Date.now;
  const deadline = now() + opts.timeoutMs;
  // supersede 先于一切判定：被更新的 start/stop 接管后，本腿继续等就绪/重试毫无意义且有害（抢适配器/撞端口），立即让位。
  // isReady（异步 TCP）先于 isAlive（子进程探活）：成功路径（API 早绑）即返回，绝不触发探活。
  // 顺序安全：API 监听随核进程而生灭，端口可连 ⟹ 核存活（端口不会在核死后仍被本核监听）。
  for (let i = 0; i < maxPolls && now() < deadline; i++) {
    if (deps.isSuperseded?.()) return 'superseded';
    if (await deps.isReady()) return 'ready';
    // i=0 必探（`0 % N === 0`）：核瞬死的检出延迟不因细化就绪节拍而变差。
    if (i % aliveEvery === 0 && !(await deps.isAlive())) return 'dead';
    await deps.sleep(pollMs);
  }
  if (deps.isSuperseded?.()) return 'superseded';
  if (await deps.isReady()) return 'ready';
  if (!(await deps.isAlive())) return 'dead';
  return 'timeout';
}
