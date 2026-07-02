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

import { partitionCidrsByOverlap } from './ip';
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
