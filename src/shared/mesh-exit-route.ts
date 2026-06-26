import type { UserConfig } from './types';
import {
  meshUsesSystemInterface,
  meshNodeCarriesFullTunnel,
  TS_SYSTEM_INTERFACE_NAME,
} from './endpoint-routes';

// 出口默认路由：单条 ifscope `default`（0/0），装在 System 内核接口上、作用域限定该接口（UGScIg）→ 绑该接口的
// dialer 走它出网，与主 TUN / 全局 default 共存（真机实证：sing-box 的 WG ifscope `default` 与全局 default 同表共存）。
// **无需折半**：折半（0/1+128/1）当初只为在「全局表」里压过全局 default 而不删它；ifscope 是接口作用域、不进全局表
// 竞争，单条 0/0 即可。FlowZ 经 helper `route add -ifscope`（只加不删）装它，不会像 sing-box WG 路径那样删全局 default。
export const EXIT_DEFAULT_V4 = ['0.0.0.0/0'];
export const EXIT_DEFAULT_V6 = ['::/0'];

export interface MeshExitRoutePlan {
  /** 内核接口名（flowz-ts）。 */
  iface: string;
  /** 要装的出口路由（单条 ifscope default，按 enableIPv6 含/不含 v6）。 */
  cidrs: string[];
}

/**
 * 出口托管决策（纯函数）：当前选中的全局出口节点是否需要 FlowZ 自装出口路由、装到哪张内核接口。
 *
 * 仅 **TS System + 承载全隧道（exit_node 设了）** 需要——真机实证：sing-box 的 tailscale system_interface
 * 只往内核接口装 tailnet/accept 子网，**不为 exit_node 装出口 0/0 路由**，故绑接口 dialer 拨公网 unreachable；
 * 手动补一条 ifscope `default`（0/0）即通。
 *
 * **不依赖「全局选中」**：TS 可能被【路由规则】指向当出口（非全局出口），这条路由就该常驻就绪；ifscope 作用域
 * 限定接口、不抢全局/主 TUN，对未被选中的 TS 装也无害（只有真有流量绑到该接口时才生效）。故对「System TS +
 * 设了 exit_node（承载全隧道）」恒装，至多一条（单 TS 节点硬限，tailscaleSlotTaken）。
 *
 * 返回 null 的情形：
 *  - 无 TS 节点 / TS 是 gVisor（tsnet 栈内处理 exit，无需 OS 路由）/ TS 无 exit_node（不承载全隧道）。
 *  - WG/WARP 由 sing-box 按 allowed_ips 自装接口作用域路由 → FlowZ 不重复装（本函数只管 TS）。
 */
export function planMeshExitRoute(
  config: UserConfig,
  enableIPv6: boolean
): MeshExitRoutePlan | null {
  const ts = (config.servers || []).find((s) => s.protocol?.toLowerCase() === 'tailscale');
  if (!ts) return null;
  if (!meshUsesSystemInterface(ts)) return null;
  if (!meshNodeCarriesFullTunnel(ts)) return null; // allowInternet（新建表单由 exitNode 派生）
  // 还须 exit_node **实际设了**：meshNodeCarriesFullTunnel 只看 allowInternet，而 buildTailscaleEndpoint 仅在 exitNode
  // 非空时才下发 exit_node。旧/导入配置可能 allowInternet=true 但 exitNode 为空（ConfigManager 不重派生）→ 装了出口
  // 路由却无 exit peer 转发 → 默认流量黑洞且无 direct 兜底。故与 endpoint 下发口径对齐：exitNode 为空则不托管。
  if (!ts.tailscaleSettings?.exitNode?.trim()) return null;
  const cidrs = [...EXIT_DEFAULT_V4, ...(enableIPv6 ? EXIT_DEFAULT_V6 : [])];
  return { iface: TS_SYSTEM_INTERFACE_NAME, cidrs };
}
