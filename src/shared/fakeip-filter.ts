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
 *
 * 选段硬约束——两族假段必须被 Chrome Local Network Access（LNA）同判 public：
 * Chromium 按 `services/network/public/cpp/ip_address_space_util.cc` 的 NonPublicAddressSpaceMap 分类地址空间
 * （已核对 149.0.7827.200 / 150.0.7871.46 / main 三版一致）：v6 侧 `2001:db8::/32`、`3fff::/20`（RFC 3849/9637
 * 文档段）、`fc00::/7`、`fe80::/10`、`fec0::/10` → kLocal；**不在表内 = kPublic**。该映射 2025-09-01 由
 * "[LNA] Add additional IP address space mappings"（WICG/local-network-access#15）加入。若两族假段地址空间分裂
 * （如 v4 public + v6 local），任一 public initiator（骑真实 IP / v4 假 IP 的文档或 Service Worker）取 local
 * 假 IP 子资源即被整批拦截："Permission was denied for this request to access the `local` address space" /
 * net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS（YouTube 真机复现：HAR 证实文档骑 v6 假 IP、跨域子资源
 * 100% 被拦）。两族统一为 public 后，fake 世界与真实互联网同属 public 空间，LNA 结构性不触发，且对过渡残留
 * （陈旧 SW/连接池/DNS 缓存里的 public initiator）免疫。
 *
 * - v4 `198.18.0.0/15`：RFC 2544 基准测试段，刻意在私网空间之外（不与任何 LAN 旁路 v4 段相交）；
 *   不在 NonPublicAddressSpaceMap → kPublic。
 * - v6 `2001:2::/48`：RFC 5180 IPv6 benchmarking 段，IANA 永久保留、全网不可路由 → 不与真实主机撞 IP；
 *   不在 NonPublicAddressSpaceMap → kPublic。文档段 2001:db8::/32 不可用——它在表内判 kLocal（见上）。
 *   与 LAN 旁路 fc00::/7(ULA) 不相交，护栏对其退化为 no-op；TUN 抓 v6 后照样反查域名喂代理。
 *
 * 假设登记：若未来 Chromium 把 benchmarking 段（198.18.0.0/15 / 2001:2::/48）也收进 local 表（其加文档段的
 * 「完备性」理由同样适用于它们），本选段需重估。
 */
export const FAKEIP_INET4_RANGE = '198.18.0.0/15';
export const FAKEIP_INET6_RANGE = '2001:2::/48';
