/**
 * 「Tailscale 出口名不副实」警示判定（纯函数，首页行内注脚用；§H）。
 *
 * 取代旧 §G「未选中就劝设为出口」（那是稳态噪音——用户显式选了别的出口/直连时反被劝）。这里只在【选中了 TS 当
 * 全局出口、却出不了公网】时给有效提示：
 *  - no-exit-device：选中 TS + 已登录 + 非 direct 模式 + 未配 exit_node → 公网并不经 TS（P0b 后回退 direct；S-b
 *    的 quick-join allowInternet:true 无 exit_node 亦归此），提示「已设为出口但未选出口设备」。**按 exit_node 直判、
 *    不信 allowInternet**（覆盖 S-b）。配置级问题，断开态也成立（截图 2 即断开）。
 *  - exit-device-offline：选中 TS + 已登录 + 已配 exit_node + 代理运行 + 该 exit 设备 peer offline → 公网可能出不去。
 *    仅代理运行时判（静态 snapshot 判 offline 会误报）。
 *
 * 未选中 TS / 未登录（含 NeedsLogin 让位期）/ direct 模式 / exit_node 为无法匹配的自定义值 → none（不误报，且与
 * 出口让位 reconcileLoginFallback + 登录 toast/角标天然互斥：让位/登录 UI 在 loggedIn=false 期，本警示在 loggedIn 期）。
 */
import type { ServerConfig } from './types';
import type { TailscaleStatusPeer } from './tailscale-status';

export type TsExitWarning = 'none' | 'no-exit-device' | 'exit-device-offline';

export interface TsExitWarningInput {
  /** 当前选中的全局出口节点（config.selectedServerId 对应）。 */
  selectedServer: ServerConfig | undefined;
  /** 该出口的综合登录态（tailscaleLoginStates，缓存驱动，代理关时也有值）。 */
  loggedIn: boolean;
  /** 分流策略是否为全局直连（proxyMode==='direct'）。 */
  proxyModeDirect: boolean;
  /** 主核是否运行（peers 新鲜度门——offline 判定须实时 STATUS 流）。 */
  proxyRunning: boolean;
  /** 该 TS 的对端列表（store.tailscalePeers[id]）。 */
  peers: TailscaleStatusPeer[] | undefined;
}

export function deriveTsExitWarning(i: TsExitWarningInput): TsExitWarning {
  const s = i.selectedServer;
  if (!s || s.protocol?.toLowerCase() !== 'tailscale') return 'none'; // 未选中 TS 出口 → 永不提示（§G 方向反转）
  if (i.proxyModeDirect) return 'none'; // 显式全直连（与 meshSelectedExitFallsBackToDirect 同口径）
  if (!i.loggedIn) return 'none'; // 未登录：需登录角标 / 登录 toast / 出口让位已 own，不叠加
  const exitNode = s.tailscaleSettings?.exitNode?.trim();
  if (!exitNode) return 'no-exit-device'; // 核心态：无 exit_node（S-a/S-b 统一，不信 allowInternet）→ 公网不经 TS
  if (!i.proxyRunning) return 'none'; // offline 判定须新鲜 STATUS（陈旧 snapshot 会误报）
  // exit_node 值与 peer 匹配（复用 exit-node-field 的 ip/hostName 口径）；匹配到且 offline → 警示，自定义值不匹配 → 不误报。
  const peer = i.peers?.find((p) => p.ip === exitNode || p.hostName === exitNode);
  if (peer && !peer.online) return 'exit-device-offline';
  return 'none';
}
