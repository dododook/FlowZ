/**
 * LAN 设备识别簇（sing-box 1.14 「邻居解析」/Neighbor Resolution）的共享校验 + 平台门控 ——
 * 主进程构建（route/dns/inbounds builder）与渲染层表单（rule-dialog / network-settings）共用单一真值。
 *
 * 能力来自 sing-box 1.14（字段在 1.14.0-alpha.32 真机 `sing-box check` 验过被接受，见 [[singbox-1.14-features]] §D）：
 *   1. route / DNS rule item `source_mac_address` / `source_hostname`（Listable[string]）——按源设备 MAC /
 *      主机名（DHCP 租约）分流。**仅 Linux/macOS（及 Android/macOS 图形客户端）支持**——此平台门控由 sing-box
 *      源码 build tag 坐实（非 `check`：`check` 是 config 解析、跨平台不 FATAL，证不了 Windows 排除）：解析
 *      「源 IP→MAC/主机名」的邻居解析器 `route/neighbor_resolver_{linux,darwin}.go` 各带 `//go:build linux|darwin`
 *      真实现，`neighbor_resolver_stub.go`（`//go:build !linux && !darwin`）的 `newNeighborResolver` 直接
 *      `return nil, os.ErrInvalid`、无 windows 实现；`route/router.go` 对 `os.ErrInvalid` 静默跳过 → Windows 上
 *      解析器不存在、这两类规则永不匹配且不报错（静默死规则）→ 故必须 UI/生成层 fail-closed。
 *      · MAC：内核走 Go `net.ParseMAC`，仅接受 EUI-48 三种写法（冒号 / 连字符 / Cisco 点分），其余 FATAL。
 *        route 规则的 MAC 在 `check` 期不校验（运行期按字符串匹配），但 UI/构建仍按内核 parser 校验，杜绝脏值。
 *   2. local DNS server `neighbor_domain`（Listable[string]）——对单标签短名（host 部分无 `.`）走邻居解析，
 *      正向解析局域网设备短名→IP。**每条必须以 `.` 开头**（内核 init 报 `neighbor_domain entry must start with '.'`）；
 *      `.` 匹配任意单标签名（如 `nas`）。
 *   3. TUN `include_mac_address` / `exclude_mac_address`（Listable[string]，互斥）——按 MAC 限/排进 TUN。
 *      **仅 Linux + auto_route + auto_redirect**（内核 init 直接报 unsupported / parse MAC FATAL）。
 *      故构建期须：① 平台=Linux；② 同时发射 `auto_route` + `auto_redirect`；③ 仅发 include/exclude 之一；
 *      ④ 每个 MAC 合法（脏 MAC 会让 `check`/启动 FATAL）。
 *
 * 这些字段同属 sing-box 的 `shared/neighbor` 邻居解析子系统，故 FlowZ 也收敛到本模块单一真值。
 */

/**
 * MAC 地址（EUI-48）是否合法 —— 严格对齐 Go `net.ParseMAC` 接受、且 FlowZ 关心的三种 6-octet 写法：
 *   · 冒号分隔   `00:11:22:33:44:55`
 *   · 连字符分隔 `00-11-22-33-44-55`
 *   · Cisco 点分 `0011.2233.4455`（3 组 4 hex）
 * 大小写不敏感。拒：无分隔符 `001122334455`、段数/位数错、非 hex（均经内核实证 FATAL）。
 * （net.ParseMAC 亦接受 EUI-64/20-octet InfiniBand 等更长形态，但 LAN 设备恒为 48-bit，FlowZ 只放行 48-bit。）
 */
export function isValidMacAddress(value: string | undefined): boolean {
  const v = (value || '').trim();
  if (!v) return false;
  const colon = /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/; // 全冒号 00:11:22:33:44:55
  const dash = /^[0-9a-fA-F]{2}(-[0-9a-fA-F]{2}){5}$/; // 全连字符 00-11-22-33-44-55
  const cisco = /^[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}$/; // Cisco 点分 0011.2233.4455
  return colon.test(v) || dash.test(v) || cisco.test(v); // 同一分隔符贯穿（混用拒绝）
}

// 主机名（DHCP 租约名）：单标签或多标签 DNS 主机名形状（字母数字 + 连字符，标签不以连字符首尾、≤63）。
// 用于 source_hostname 校验。宽松（内核按字符串匹配、不强约束），仅挡明显脏值（空格 / 控制符 / 过长）。
const HOSTNAME_RE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** 源设备主机名（source_hostname）是否合法。 */
export function isValidSourceHostname(value: string | undefined): boolean {
  const v = (value || '').trim();
  if (!v || v.length > 253) return false;
  return HOSTNAME_RE.test(v);
}

/**
 * neighbor_domain 单条目归一化：内核要求每条以 `.` 开头（否则 init FATAL）。
 * 用户可填 `lan` / `.lan` / `nas.local` → 统一加前导 `.`；已带 `.` 原样。空串返 null（调用方过滤）。
 * 多个前导点收敛为一个（`..lan`→`.lan`）。
 */
export function normalizeNeighborDomain(value: string | undefined): string | null {
  let v = (value || '').trim();
  if (!v) return null;
  v = v.replace(/^\.+/, ''); // 去全部前导点
  if (!v) return '.'; // 纯点 → `.`（匹配任意单标签名，内核合法）
  return `.${v}`;
}

/** neighbor_domain 条目是否（归一化后）合法：去点后至少 1 字符、且为合法域名后缀字符。 */
export function isValidNeighborDomain(value: string | undefined): boolean {
  const norm = normalizeNeighborDomain(value);
  if (!norm) return false;
  if (norm === '.') return true; // 单点匹配任意单标签名
  // 去前导点后按域名后缀形状校验（容许多标签如 .home.arpa）
  return HOSTNAME_RE.test(norm.slice(1));
}

/**
 * 当前平台是否支持 source_mac_address / source_hostname（route + DNS rule）。
 * 内核：仅 Linux/macOS（及 Android/macOS 图形客户端）。FlowZ = 桌面 → linux/darwin 支持，win32 不支持。
 * 接受 Node 的 process.platform 取值。
 */
export function isSourceDeviceMatchSupported(
  platform: NodeJS.Platform | string | undefined
): boolean {
  const p = (platform || '').toLowerCase();
  return p === 'linux' || p === 'darwin';
}

/**
 * 当前平台是否支持 TUN include/exclude_mac_address。
 * 内核硬限界：**仅 Linux**（且运行期需 auto_route + auto_redirect + nftables）。
 * win32/darwin 一律不支持（发射即 FATAL）。
 */
export function isTunMacFilterSupported(platform: NodeJS.Platform | string | undefined): boolean {
  return (platform || '').toLowerCase() === 'linux';
}

/** TUN MAC 过滤模式：限定仅这些 MAC 进 TUN（include）/ 排除这些 MAC（exclude）。互斥。 */
export type TunMacFilterMode = 'include' | 'exclude';
