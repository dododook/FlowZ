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

/** ready=就绪；dead=进程已退出（起核期死）；timeout=进程在但管理 API 未在预期内绑定。 */
export type CoreReadyOutcome = 'ready' | 'dead' | 'timeout';

/** waitForCoreReady 注入依赖（单测可替换为桩）。 */
export interface CoreReadyDeps {
  /** 核进程是否存活。 */
  isAlive: () => boolean;
  /** 管理 API 是否可连（就绪信号）。 */
  isReady: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
}

/**
 * 轮询等核就绪。每轮：进程死 → 'dead'（立即，不等满 timeout）；API 可连 → 'ready'；否则 sleep。
 * 满 maxPolls 仍未就绪 → 末轮再判一次 → 'timeout'。早退使成功路径仅等到 API 绑定（通常 <1s），不加额外延迟。
 */
export async function waitForCoreReady(
  opts: { timeoutMs: number; pollMs: number },
  deps: CoreReadyDeps
): Promise<CoreReadyOutcome> {
  const pollMs = Math.max(1, opts.pollMs);
  const maxPolls = Math.max(1, Math.ceil(opts.timeoutMs / pollMs));
  // isReady（异步 TCP）先于 isAlive（execSync 探活，阻塞 event loop）：成功路径（API 早绑）即返回，绝不触发阻塞探活。
  // 顺序安全：API 监听随核进程而生灭，端口可连 ⟹ 核存活（端口不会在核死后仍被本核监听）。
  for (let i = 0; i < maxPolls; i++) {
    if (await deps.isReady()) return 'ready';
    if (!deps.isAlive()) return 'dead';
    await deps.sleep(pollMs);
  }
  if (await deps.isReady()) return 'ready';
  if (!deps.isAlive()) return 'dead';
  return 'timeout';
}
