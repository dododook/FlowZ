/**
 * macOS `route -n monitor` 输出行解析（纯函数，无副作用）。
 *
 * 用途：DnsInterfaceWatcher 长驻 `route -n monitor`，逐行喂本函数判定「是否值得触发一次 DNS reconcile 的网络变更」。
 * 命中 → 去抖后调 SystemDnsManager.reconcileDns()，把启动后新出现/换网后未受控的网络服务也接管为受控 DNS。
 *
 * route monitor 的每条消息块以 `got message of size N on <ts>` 起头，后跟一行 `RTM_<TYPE>: <描述>`，再跟若干
 * 缩进的地址/标志明细行。我们只在「接口状态变化 / 地址增删 / 默认路由变化」上触发——这些才意味着链路/解析器可能
 * 已变（插坞站、切 Wi-Fi、VPN 起落）。纯统计行（"got message of size"）与其它噪音/明细行返回 false。
 *
 * 不变量：① 纯函数、无副作用、不抛（畸形/空行/非字符串 → false）；② 只看类型，不解析地址（解析地址非本判定所需，
 * 且各平台/本地化输出差异大，徒增误判面）。设计见 docs/design/dns-takeover-dynamic-interface.md §四 4.2。
 */

/**
 * route monitor 中「值得触发 reconcile」的消息类型：
 * - RTM_IFINFO：接口 up/down（插拔网卡、Wi-Fi 开关、坞站以太网上下线）。
 * - RTM_NEWADDR / RTM_DELADDR：接口地址增删（DHCP 续约换 IP、IPv6 SLAAC 增删、VPN 虚拟地址起落）。
 * - RTM_ADD / RTM_DELETE：路由增删（尤其默认路由切换 = 出口/解析器可能整体易主）。
 *
 * 注：RTM_IFINFO2 / RTM_NEWADDR2 等带数字后缀的变体也命中（前缀匹配），覆盖 macOS 不同版本的 sysctl 风格变体。
 */
const TRIGGER_RTM_TYPES = [
  'RTM_IFINFO',
  'RTM_NEWADDR',
  'RTM_DELADDR',
  'RTM_ADD',
  'RTM_DELETE',
] as const;

/**
 * 判定单行 `route -n monitor` 输出是否表示「值得触发 DNS reconcile 的网络变更」。
 *
 * 命中：行内出现上述 RTM_ 触发类型（位于行首或紧跟空白后，形如 `RTM_IFINFO: ...`）。
 * 不命中：纯统计行（"got message of size ..."）、地址/标志明细行、空行、畸形行、非字符串。
 *
 * @param line route monitor 的单行文本（可含前后空白）。
 * @returns true=值得 reconcile；false=噪音/无关/非法。永不抛。
 */
export function isDnsReconcileTriggerLine(line: string): boolean {
  if (typeof line !== 'string') return false;
  const trimmed = line.trim();
  if (!trimmed) return false;

  // "got message of size N on <ts>" 是每条消息块的统计头 —— 高频噪音，显式排除（防 RTM_ 前缀误判时的兜底）。
  if (trimmed.startsWith('got message of size')) return false;

  // 取首 token（RTM 类型行形如 `RTM_IFINFO: <flags>`；冒号/空白分隔）。明细行首 token 是地址族/标志名，不会以 RTM_ 起。
  const firstToken = trimmed.split(/[\s:]/, 1)[0];
  // 前缀匹配：覆盖 RTM_IFINFO2 / RTM_NEWADDR2 等带数字后缀的版本变体；非触发类型（RTM_GET/RTM_LOSING/RTM_MISS 等）不命中。
  return TRIGGER_RTM_TYPES.some((t) => firstToken === t || firstToken.startsWith(t));
}
