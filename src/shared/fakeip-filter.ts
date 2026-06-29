/**
 * FakeIP 例外域名（走真实解析、绕过 FakeIP）单一真值。
 * renderer（设置页可编辑清单的 seed / 恢复默认）+ main（singbox-dns-builder 生成 DNS 规则）共用，避免多处漂移。
 *
 * 这些域名用假 IP 会坏：连通性探测/Captive Portal（误判断网、锁屏登录卡死）、NTP 校时（拿不到真实 IP）。
 */

/** 连通性探测 / Captive Portal 域名：解析须走「内网解析器」反映真实本地网络（exact domain 匹配）。 */
export const FAKEIP_FILTER_CAPTIVE_DOMAINS = [
  'captive.apple.com', // Apple 连通性探测
  'connectivitycheck.gstatic.com', // Android 连通性探测
  'connectivitycheck.android.com',
  'msftconnecttest.com', // Windows NCSI
  'www.msftconnecttest.com',
  'msftncsi.com',
  'www.msftncsi.com',
  'dns.msftncsi.com',
  'detectportal.firefox.com', // Firefox captive 检测
  'network-test.debian.org',
  'connect.rom.miui.com', // 小米连通性
];

/** NTP 校时域名：走真实 DNS（domain_suffix 匹配 pool.ntp.org 等区域子域）。 */
export const FAKEIP_FILTER_NTP_SUFFIXES = [
  'ntp.org', // pool.ntp.org 及各区域子域
  'time.windows.com',
  'time.apple.com',
  'time.cloudflare.com',
  'time.nist.gov',
  'time.android.com',
];

/** NTP/STUN 关键字（裸子串匹配；始终生效的兜底，非用户可编辑域名清单项）。误伤面极小的 ntp/stun，刻意不含 turn。 */
export const FAKEIP_FILTER_NTP_STUN_KEYWORDS = ['ntp', 'stun'];

/** 设置页可编辑清单的默认 seed / 恢复默认源：captive + ntp 域名（关键字另由 dns-builder 始终兜底）。 */
export const DEFAULT_FAKEIP_FILTER_DOMAINS = [
  ...FAKEIP_FILTER_CAPTIVE_DOMAINS,
  ...FAKEIP_FILTER_NTP_SUFFIXES,
];

/**
 * FakeIP 假 IP 段（单一真值）：dns-builder 分配给 fakeip server；旁路/force-route 护栏据此排除，防假 IP 被当私网直连。
 * - v4 `198.18.0.0/15`：RFC 2544 基准段，刻意在私网空间之外（不与任何 LAN 旁路 v4 段相交），浏览器 Chrome LNA 判为 public。
 * - v6 `2001:db8::/32`：RFC 3849 文档保留段，在全局单播 2000::/3 内——浏览器 Chrome Local Network Access 判为 **public**，
 *   故 https 公网页面取该段子资源不被当「public→private 降级」拦截（旧 fc00::/18 在 ULA=private，会触发
 *   net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS，YouTube 图片/字体等跨源资源加载失败）。文档段永不路由公网、
 *   不与真实目标撞 IP，TUN 抓 v6 后照样反查域名喂代理。与 LAN 旁路 fc00::/7(ULA) 不相交，护栏对其退化为 no-op。
 */
export const FAKEIP_INET4_RANGE = '198.18.0.0/15';
export const FAKEIP_INET6_RANGE = '2001:db8::/32';
