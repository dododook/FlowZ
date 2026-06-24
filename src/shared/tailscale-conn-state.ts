/**
 * Tailscale 单例「连接」卡的状态派生（纯函数，便于单测）。
 *
 * 按认证形态分流（见 docs/design/tailscale-connection-redesign.md）：
 *  - authKey 形态 = 静态凭据，等同 WireGuard，不参与登录态 → 恒 'key-ready'；
 *  - 交互登录形态 = 有登录态，按 loggedIn / authUrl 派生。
 *
 * loggedIn 来源是 app-store.tailscaleLoginStates[id]，已融合「缓存初值 + state 文件兜底 + STATUS 实时校正」
 * （批2），故本函数无需单独处理缓存/state——单一布尔即综合登录态。代理开关不改变状态机（loggedIn 已含两态真值），
 * 仅影响卡片副标题（已连接·实时 IP vs 已登录·上次），由组件层据 proxyRunning 决定文案，不进本派生。
 */
import type { ServerConfig } from './types';

export type TsCardState =
  | 'no-node' // 无 TS 节点 → 显示「连接 Tailscale」入口
  | 'key-ready' // 有 authKey（静态就绪，等同 WG，不显登录态）
  | 'logging-in' // 交互登录进行中（有 authUrl 且尚未登录）
  | 'connected' // 已登录（loggedIn=true，来源缓存/state/STATUS 任一）
  | 'needs-login'; // 交互型未登录（无 loggedIn、无 authUrl）

export function deriveTsCardState(
  tsNode: ServerConfig | undefined,
  loggedIn: boolean | undefined,
  hasAuthUrl: boolean
): TsCardState {
  if (!tsNode) return 'no-node';
  // authKey 形态优先：静态凭据，起核即认证，不进登录态/检测态（与 WG 同质）。
  if (tsNode.tailscaleSettings?.authKey?.trim()) return 'key-ready';
  // 交互登录：有 URL 且尚未登录成功 → 登录中（loggedIn 一旦转 true 即落 'connected'）。
  if (hasAuthUrl && loggedIn !== true) return 'logging-in';
  if (loggedIn === true) return 'connected';
  return 'needs-login';
}
