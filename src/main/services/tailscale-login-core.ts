/**
 * 按需瞬态登录核（Phase 2）：纯逻辑部分。
 *
 * 「登录专用 sing-box」与运行中主核并存、零提权、无 TUN/clash_api/监听端口，仅为拉起一个 tailscale
 * endpoint 拿交互登录 URL（核自身 stdout 打印 `endpoint/tailscale[<tag>]: Waiting for authentication: <url>`）。
 * PoC（Mac 真机 sing-box 1.13.13）已验：无 inbound 即合法（check exit 0）、瞬态与主核并存无冲突。
 *
 * 本模块只放**纯函数**（config 生成 + 双写防护判定），便于单测、与 ProxyManager 的进程生命周期解耦。
 * 进程 spawn/kill/stdout 解析住 ProxyManager（复用其 singboxPath / spawn / Notification / 事件通道）。
 */

import type { ServerConfig, UserConfig } from '../../shared/types';
import {
  tailscaleStateDir,
  pollTailscaleLoginSuccess,
  type PollLoginResult,
} from './tailscale-state';

/** 登录专用 config 的最小形状（无 inbound / 无 clash_api / 无 route，仅 tailscale endpoint + direct）。 */
export interface TailscaleLoginConfig {
  log: { level: 'info'; timestamp: true };
  endpoints: Array<Record<string, unknown>>;
  outbounds: Array<{ type: 'direct'; tag: 'direct' }>;
}

/**
 * 生成登录专用 config：仅含该节点的 tailscale endpoint（state_directory 复用 tailscale-state，与主核一致）
 * + 一个 direct outbound。**auth_key 永不写入**（有 authKey 就不需要交互登录，此路径专为无 key 节点）。
 *
 * log.level 强制 info + timestamp:true（不读用户 logLevel/隐私）→ 一并解决 P2（登录捕获不再受日志等级摆布）。
 * 不含 inbound/clash_api/route：PoC 验过无 inbound 合法；瞬态无监听端口故与主核并存无冲突。
 *
 * controlUrl/hostname 等身份字段从 tailscaleSettings 透传（与 buildTailscaleEndpoint 同语义），
 * 但**只透传登录相关的少量字段**——瞬态核只为拿 URL + 落 state，不承载路由/出口，故不带 exit_node/
 * advertise_routes/system_interface 等运行期字段（带了也无害，但保持最小、零提权、零接口创建意图）。
 */
export function buildTailscaleLoginConfig(server: ServerConfig): TailscaleLoginConfig {
  const ts = server.tailscaleSettings || {};
  const endpoint: Record<string, unknown> = {
    type: 'tailscale',
    tag: server.name,
    state_directory: tailscaleStateDir(server.id),
  };
  // auth_key 故意不写入：本核只服务交互登录（无 key）；有 key 的节点直接连即可，无需此路径。
  const controlUrl = ts.controlUrl?.trim();
  if (controlUrl) endpoint.control_url = controlUrl;
  const hostname = ts.hostname?.trim();
  if (hostname) endpoint.hostname = hostname;
  const ephemeral = ts.ephemeral === true;
  if (ephemeral) endpoint.ephemeral = true;

  return {
    log: { level: 'info', timestamp: true },
    endpoints: [endpoint],
    outbounds: [{ type: 'direct', tag: 'direct' }],
  };
}

/**
 * 双写防护判定（关键正确性）：该节点的 tailscale endpoint **是否已在运行中的主核里**。
 *
 * 两个 sing-box 进程同时写同一 state_directory（tailscaled.state 等）会冲突 → 若主核已带该 endpoint，
 * 则**不要**再起瞬态核。主核带该 endpoint 的条件 = buildOutbounds 的就绪门控（singbox-outbound-builder
 * 行 732-740）：核在运行 且（节点被选中 OR 已就绪 authKey||stateExists）。
 *
 * 返回 true（已在主核）时，调用方拒绝起瞬态核——此时该节点要么已登录（state 已落盘），要么主核路径
 * 已在出 URL（Phase 1 的选中即触发登录）。
 *
 * @param isRunning 主核是否在运行（ProxyManager 进程存活）
 * @param runningConfig 主核当前运行配置（this.currentConfig）；null=未运行
 * @param stateExists 该节点 state 目录是否存在（注入，便于单测；运行期传 tailscaleStateExists(serverId)）
 */
export function tailscaleEndpointInRunningCore(
  serverId: string,
  isRunning: boolean,
  runningConfig: UserConfig | null,
  stateExists: boolean
): boolean {
  if (!isRunning || !runningConfig) return false;
  const server = runningConfig.servers.find(
    (s) => s.id === serverId && s.protocol?.toLowerCase() === 'tailscale'
  );
  if (!server) return false; // 节点不在运行配置里 → 主核没带它的 endpoint
  // buildOutbounds 发射门控：选中 OR 就绪（authKey || state 目录存在）。
  const hasAuthKey = !!server.tailscaleSettings?.authKey?.trim();
  const selected = runningConfig.selectedServerId === serverId;
  const ready = hasAuthKey || stateExists;
  return selected || ready;
}

/** runLoginPollLifecycle 的注入依赖（全可替换 → 单测不碰真实进程/文件系统/定时器）。 */
export interface LoginLifecycleHooks {
  /** 轮询登录成功（默认 pollTailscaleLoginSuccess）；注入可控成功/超时/取消。 */
  poll: () => Promise<PollLoginResult>;
  /** 登录成功 → 发 AUTH_OK 事件（serverId/nodeName 已闭包绑定）。 */
  onSuccess: () => void;
  /** 收尾杀瞬态核（成功/超时/取消都调一次，幂等）。 */
  kill: () => void;
}

/**
 * 瞬态登录核的轮询生命周期编排（纯逻辑、可注入）：轮询 → 成功则发 AUTH_OK，无论成功/超时/取消都收尾杀核。
 * 与 ProxyManager 的进程持有解耦，便于单测「成功杀进程 / 超时杀进程 / 取消杀进程」三路径。
 * poll 自身已失败安全（check try/catch），此处 catch 兜底防 unhandled rejection 后仍杀核。
 */
export async function runLoginPollLifecycle(hooks: LoginLifecycleHooks): Promise<PollLoginResult> {
  let result: PollLoginResult = 'cancelled';
  try {
    result = await hooks.poll();
    if (result === 'success') hooks.onSuccess();
  } finally {
    hooks.kill();
  }
  return result;
}

/** 默认 poll：对某 serverId 轮询其 state 目录直到登录成功/超时/取消（瞬态核被杀=取消）。 */
export function makeLoginPoll(
  stateExists: () => boolean,
  isCancelled: () => boolean
): () => Promise<PollLoginResult> {
  return () => pollTailscaleLoginSuccess({ check: stateExists, isCancelled });
}
