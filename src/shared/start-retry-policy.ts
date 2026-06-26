import type { ServerConfig } from './types';
import { meshUsesSystemInterface } from './endpoint-routes';

export interface StartRetryBudget {
  /** retry 次数（总尝试 = maxRetries + 1） */
  maxRetries: number;
  /** 基础退避（毫秒） */
  delay: number;
  /** 指数退避 vs 恒定间隔 */
  exponentialBackoff: boolean;
}

/**
 * 起核重试预算（双 TUN 竞态自愈，mesh redesign R3）。
 *
 * system_interface（reverseMesh）节点在 TUN 模式下会建第二张内核 TUN。配置变更重启时主 TUN +
 * 这张接口同时 stop→start，旧两张接口在内核侧释放慢，start 腿会撞「TUN 初始化未完成」启动期退出
 * （macOS 双 utun 抢占）。默认 2 次 + 指数退避（~6s 窗口）太短打不过释放 → 卡停需手动重启
 * （真机 app.log 实证）。
 *
 * 含 system 节点时放宽为多次 + 恒定短间隔（非指数）。释放靠两条：① 每个失败腿在抛 CoreStartRetryError 前
 * best-effort stopCore 停掉起不来的核（ProxyManager.startSingBoxProcess 失败分支，跨平台；win32 另有顶部
 * waitForOwnTunAdapterReleased 门控）；② 恒定短间隔的多次重试给内核留足异步回收双 utun/适配器的时间 → start
 * 自愈。次数/间隔以 Mac 真机释放时序校准。
 */
export function resolveStartRetryBudget(
  isTunMode: boolean,
  servers: ServerConfig[] | undefined
): StartRetryBudget {
  const hasSystemInterfaceNode =
    isTunMode && (servers || []).some((s) => meshUsesSystemInterface(s));
  return hasSystemInterfaceNode
    ? { maxRetries: 10, delay: 3000, exponentialBackoff: false }
    : { maxRetries: 2, delay: 2000, exponentialBackoff: true };
}
