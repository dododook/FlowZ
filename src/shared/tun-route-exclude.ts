/**
 * TUN「连入来源排除」纯逻辑：本机作服务端被 off-subnet 私网连入时（如经 ZeroTier→路由器 DNAT），
 * 回包目的地落在本机直连子网之外 → 被 TUN 捕获 → 用户态栈误当新连接重拨 → 连接断（且重连仍断）。
 *
 * 第一性原理（承 docs/design/flowz-tun-lan-exclusion-scenarios.md 的 spike 复查）：
 *  - 这**不是**「排除本机自己所在子网」——sing-tun 的策略路由（Linux suppress_prefixlength / darwin 最长前缀）
 *    本就把本机直连子网留在物理网卡、不进 TUN。真正会断的是**off-subnet 的连入来源**（本机路由不到、
 *    只能靠默认路由的地址）。FlowZ 无法自动探测「谁会从哪个 off-subnet 私网段连进来」→ 只能由用户显式声明。
 *  - 声明的网段追加进 sing-box 的 `route_exclude_address`（内核层就不把该段交给 TUN），使回包走物理网卡。
 *  - ⚠️ **双向语义**：排除一个段会让该段的出/入两个方向都绕过 TUN——不仅是"回包"。故声明的段也不再能经
 *    代理/自定义规则出网（对私网连入源通常正是想要直连，影响有限，但须知晓；见 UI tooltip + 设计 §9）。
 *
 * 本模块算「用户声明段的最终生效集」：先规范化（裸 IP 补 /32|/128、拒 catch-all/过宽前缀，见 normalizeTunExcludeCidr），
 * 再减 组网 force-route 段（mesh 优先，否则误伤组网）减 fakeip 段；macOS 额外减「本机物理 LAN 段」——
 * 排除物理 LAN 会触发 NetworkExtension 反向路由拦截、drop 从 TUN 发回该段的回包（singbox-inbounds-builder.ts
 * 已有真机踩坑注释）。纯函数、无 electron；调用方追加 extra 进排除清单并按 dropped* 记 warn。
 */

import { partitionCidrsByOverlap, cidrOverlapsAny, subtractCidrs } from './ip';
import { isValidIpCidr } from './rules';
import { dedupe } from './collections';

// 前缀下限：拒绝比此更宽的排除段，防"整/半地址空间排出 TUN → 代理静默失效"。
// v4=8 允许 10.0.0.0/8 等私网整段（合法最宽），拒 /0-/7（含 0.0.0.0/0 与 0/1+128/1 半空间攻击）。
// v6=7 允许 fc00::/7（ULA 全段，合法最宽），拒 /0-/6（含 ::/0）。
const V4_MIN_PREFIX = 8;
const V6_MIN_PREFIX = 7;

/**
 * 规范化 + 严格校验单个「连入来源排除」条目，返回规范 CIDR 或 null（非法/过宽）。
 *  - trim；空 → null。
 *  - **裸 IP（无 `/`）补掩码**：v4→/32、v6→/128（route_exclude_address 要求带掩码，否则 sing-box check FATAL
 *    `netip.ParsePrefix: no '/'`——既有其它生产者都经 hostToExcludeCidr 补掩码，本字段亦须补齐）。
 *  - 严格校验（复用 rules.isValidIpCidr：段≤255/前缀合法/禁前导零，sing-box netip 口径）。
 *  - **拒 catch-all / 过宽前缀**（V4_MIN_PREFIX / V6_MIN_PREFIX），防排空 TUN。
 */
export function normalizeTunExcludeCidr(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  const isV6 = t.includes(':');
  const cidr = t.includes('/') ? t : `${t}/${isV6 ? 128 : 32}`;
  if (!isValidIpCidr(cidr)) return null;
  const prefix = Number(cidr.slice(cidr.indexOf('/') + 1));
  if (!Number.isInteger(prefix)) return null;
  if (prefix < (isV6 ? V6_MIN_PREFIX : V4_MIN_PREFIX)) return null;
  return cidr;
}

export interface UserTunExcludeInput {
  /** 目标平台（macOS 触发物理 LAN guard；其余平台忽略 ownLanCidrs）。 */
  platform: NodeJS.Platform;
  /** 用户声明的连入来源网段（原始输入，可能含非字符串/空白/非法/过宽/重复，内部统一规范化+校验+去重）。 */
  userCidrs: unknown[];
  /** 当前生效（engaged）的组网(WG/Tailscale) force-route 段：与之相交的用户段剔除，让 mesh 路由优先。 */
  meshCidrs: string[];
  /** fakeip 段：与之相交的用户段剔除，否则假 IP 被排除出 TUN → 绕过 fakeip 反查、服务端收不到域名。 */
  fakeipRanges: string[];
  /** 本机物理 LAN 段（仅 macOS 用作 guard；非 macOS 传空即可）。排除物理 LAN 会致 NE 反向路由 drop TUN 回包。 */
  ownLanCidrs: string[];
}

export interface UserTunExcludeResult {
  /** 追加进 route_exclude_address 的最终生效段（已规范化+减 mesh/fakeip，macOS 已减物理 LAN；去重）。 */
  extra: string[];
  /** 因非字符串/形状/范围非法/过宽/catch-all 被规范化剔除的原始条目数（供告警；不含去重）。 */
  droppedInvalid: number;
  /** 因与组网 force-route 段相交被剔除（该段应走组网节点，不能同时又直连绕过）。 */
  droppedMeshOverlap: string[];
  /** 因与 fakeip 段相交被剔除。 */
  droppedFakeipOverlap: string[];
  /** 仅 macOS：因与本机物理 LAN 段相交被剔除（NE 反向路由会 drop TUN 回包，见模块注释）。 */
  droppedOwnLanMac: string[];
}

/**
 * 计算用户声明的 TUN 排除段的最终生效集 + 各类被剔除项（供告警）。
 * 减法顺序：先规范化（裸IP补掩码/拒非法过宽），再减 mesh（组网优先），再减 fakeip，macOS 最后减物理 LAN。
 * 空的 mesh/fakeip/ownLan 数组天然 no-op。
 */
export function computeUserTunExclude(input: UserTunExcludeInput): UserTunExcludeResult {
  // 规范化 + 严格校验 + 去重。非法/过宽/非字符串条目剔除并计数（防裸 IP FATAL / catch-all 排空 TUN）。
  const normalized: string[] = [];
  let droppedInvalid = 0;
  for (const raw of input.userCidrs) {
    const c = normalizeTunExcludeCidr(raw as string);
    if (c === null) droppedInvalid++;
    else normalized.push(c);
  }
  const valid = dedupe(normalized);

  const mesh = partitionCidrsByOverlap(valid, input.meshCidrs);
  const fakeip = partitionCidrsByOverlap(mesh.disjoint, input.fakeipRanges);

  let extra = fakeip.disjoint;
  let droppedOwnLanMac: string[] = [];
  if (input.platform === 'darwin') {
    const lan = partitionCidrsByOverlap(extra, input.ownLanCidrs);
    extra = lan.disjoint;
    droppedOwnLanMac = lan.overlapping;
  }

  return {
    extra,
    droppedInvalid,
    droppedMeshOverlap: mesh.overlapping,
    droppedFakeipOverlap: fakeip.overlapping,
    droppedOwnLanMac,
  };
}

export interface WinBypassExcludeInput {
  /** bypassLAN 的 IP CIDR 条目（bypassLanCidrs(effectiveBypassLan(config))，宽私网/保留段）。 */
  bypassCidrs: string[];
  /** 当前生效（engaged）的组网 force-route 段（meshForcedRouteCidrs(meshForceRoutedServers(...))，与 route-builder 块 0c 同口径）。 */
  engagedMeshCidrs: string[];
  /** 本机所有非回环接口连接网段（getOwnLanCidrs()）——carve guard：mesh 段与本机物理子网相交则不 carve（保网关排除）。 */
  ownLanCidrs: string[];
  /** fakeip 段：与之相交的 bypass 条目整条剔除（保持现状语义，防假 IP 被排除出 TUN）。 */
  fakeipRanges: string[];
}

export interface WinBypassExcludeResult {
  /** 追加进 route_exclude_address 的 bypassLAN 派生段（减 fakeip、对 engaged mesh 段 carve 开洞）。 */
  exclude: string[];
  /** 实际被 carve 开洞（挖出 TUN 排除表、进 TUN 走组网）的 engaged mesh 段。 */
  carvedMeshCidrs: string[];
  /** 因与保护段（本机物理子网 / 回环·链路本地·多播）相交、为保「必须仍排除」段而**未** carve 的 mesh 段（供 warn；该段仍绕过 TUN、其组网远端对等不可达）。 */
  meshSkippedOwnLan: string[];
}

// carve 恒不得挖走的「特殊用途保护段」：回环 + 链路本地 + 多播。组网隧道（WG/Tailscale）承载这些无意义，
// 一旦被超宽 mesh 段（如 wg-quick 半隧道 0.0.0.0/1·128.0.0.0/1，stripCatchAll 只剥 0/0 不剥 /1）carve 进 TUN，
// 会破坏本地发现（SSDP/mDNS）、DHCP 广播、链路本地寻址。故恒不 carve、保留排除：
//  · 回环 127/8·::1/128——与 mac/Linux 分支硬编码恒排除的不变量对齐；
//  · 链路本地 169.254/16·fe80::/10、多播 224/4——本就在默认 bypass 清单，隧道不应承载。
// 物理子网 guard 另经 ownLanCidrs 传入（Windows WinTun 不排网关→DHCP 死循环）。
const WIN_BYPASS_CARVE_GUARD = [
  '127.0.0.0/8',
  '::1/128',
  '169.254.0.0/16',
  'fe80::/10',
  '224.0.0.0/4',
];

/**
 * Windows bypassLAN 内核排除表：对 engaged 组网段做**算术差集 carve**，修复「宽私网段整体排除出 TUN → 落在其中
 * 的组网 force-route 段（如 tailnet 100.64.0.0/10、WG allowedIPs 私网段）接不到 route.rules → 组网整体架空」缺口。
 *
 * 为什么不能像「连入来源排除」那样整条剔除：bypass 条目是 /8·/12·/16 宽段，整剔会连**本机网关子网**一起脱离排除
 * → 触发 Windows WinTun DHCP/网关查询死循环硬约束。故只用算术差集挖掉 mesh 段、其余（含网关/回环）仍排除。
 *
 * 分流：① 只考虑【确实落在某 bypass 排除条目内】的 mesh 段（不相交的段本就不被排除、无需开洞，计入会产生假
 * 「已开洞」日志 + 无谓重格式化）；② 与「保护段」（本机物理子网 ownLanCidrs **或**回环）相交的段不 carve
 * （carve 会连网关/回环一起放出）、保留排除并记入 meshSkippedOwnLan；③ 其余算术差集 carve。无可 carve 段 →
 * 原样返回（与旧行为字节等价：无组网 / 组网段不在排除表时零变化）。
 */
export function computeWinBypassExclude(input: WinBypassExcludeInput): WinBypassExcludeResult {
  // 1. fakeip 整条剔除（保持现状语义，防假 IP 被排除出 TUN → 绕过 fakeip 反查、服务端收不到域名）。
  const afterFakeip = partitionCidrsByOverlap(input.bypassCidrs, input.fakeipRanges).disjoint;
  // 2. 只对【落在某 bypass 排除条目内】的 engaged mesh 段考虑 carve（不相交=本就不被排除，无需开洞）。
  const relevantMesh = dedupe(input.engagedMeshCidrs).filter((m) =>
    cidrOverlapsAny(m, afterFakeip)
  );
  // 3. 分流：与保护段（物理子网 + 回环/链路本地/多播）相交的段不 carve（开洞会连网关/回环/本地发现段一起放出）
  //    → meshSkippedOwnLan；其余 carve。
  const { overlapping: meshSkippedOwnLan, disjoint: carveMesh } = partitionCidrsByOverlap(
    relevantMesh,
    [...input.ownLanCidrs, ...WIN_BYPASS_CARVE_GUARD]
  );
  // 4. 无可 carve 段 → 原样返回（Windows 排除表零变化，与旧行为字节等价）。
  if (carveMesh.length === 0) {
    return { exclude: afterFakeip, carvedMeshCidrs: [], meshSkippedOwnLan };
  }
  // 5. 算术差集：只挖掉 engaged mesh 段，其余（含网关子网/回环）仍排除。
  return {
    exclude: subtractCidrs(afterFakeip, carveMesh),
    carvedMeshCidrs: carveMesh,
    meshSkippedOwnLan,
  };
}
