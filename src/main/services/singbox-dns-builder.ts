/**
 * sing-box DNS 配置生成 —— 从 ProxyManager.generateDnsConfig 抽出（SingBoxConfigBuilder 抽取 Phase 2 step 4）。
 * 纯函数：只读 config + 注入实例态（lanResolverForDns 值 / log 回调），不持有任何 ProxyManager 引用。
 * config 字节等价由 config-snapshot 网验证（DNS 进阶分支：自定义上游 / nodeResolver 档位 / bypassFakeIP /
 * enableIPv6 / dns-lan / win32 死环 已锁基线）。
 */

import * as path from 'path';
import type { UserConfig } from '../../shared/types';
import { parseDnsServerSpec, type ParsedDnsServer } from '../../shared/dns';
import { ruleConditions } from '../../shared/rules';
import { normalizeNeighborDomain, isSourceDeviceMatchSupported } from '../../shared/neighbor';
import { effectiveRegionRouting, REGION_LOCAL_GEO } from '../../shared/region-routing';
import { planCustomRule, customRuleFileBase, usesFakeIp } from './custom-rule-files';
import { getCustomRulesDir } from '../utils/paths';
import {
  findBuiltin,
  getRuleSetRuntimeDir as getRuntimeRulesDir,
  isValidSrsFile,
} from './builtin-geo-rulesets';
import type { SingBoxDnsConfig, SingBoxDnsServer, SingBoxDnsRule } from './singbox-config-types';
import {
  isIpv4Host,
  isIpv6Host,
  getNodeResolverTag,
  effectiveCustomRules,
  DOMESTIC_BANK_AND_STOCK_DOMAINS,
} from './singbox-config-helpers';
// fake-ip-filter 默认清单（captive→真实本地解析、ntp→真实 DoH）。单一真值在 shared，renderer 设置页可编辑清单 seed 共用。
// 启动必经规则、刻意硬编码不依赖远程 rule_set（防 404 FATAL）。用户编辑后存 config.fakeIpFilterList。
import {
  FAKEIP_FILTER_CAPTIVE_DOMAINS,
  FAKEIP_FILTER_NTP_SUFFIXES,
  FAKEIP_FILTER_NTP_STUN_KEYWORDS,
  FAKEIP_INET4_RANGE,
  FAKEIP_INET6_RANGE,
} from '../../shared/fakeip-filter';

/** 日志回调：注入 ProxyManager.logToManager（source 默认 'ProxyManager'）。 */
type DnsLogFn = (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', message: string) => void;

/** 域名 → [精确域名, `.域名`(后缀匹配)]：同时覆盖 exact 与 subdomain（sing-box domain_suffix 语义）。 */
const withDotPrefix = (d: string): string[] => [d, `.${d}`];

// P4b 内部预留 tag：tailscale 按名解析 DNS server 的固定 tag。不与节点 tag 撞车（节点 tag=节点显示名，
// 不会取此前缀；与 ProxyManager.usedTags 内置保留 tag 同理为内部固定 tag）。
const TS_NAME_DNS_TAG = 'dns-tailscale';

/**
 * 「选中的 mesh tailscale 节点」的 endpoint tag，供按名解析 DNS server 引用。直接读 buildIdToTagMap 产出的
 * idToTagMap（id→唯一 tag 单一真值），不再复刻去重循环——杜绝与 ProxyManager 侧推导漂移（tag 须逐字节一致，
 * 否则 sing-box FATAL）。非选中 / 选中节点非 tailscale → null。
 */
function selectedTailscaleEndpointTag(
  config: UserConfig,
  idToTagMap: Map<string, string>
): string | null {
  const selectedId = config.selectedServerId;
  if (!selectedId) return null;
  const selected = config.servers.find((s) => s.id === selectedId);
  if (!selected || selected.protocol.toLowerCase() !== 'tailscale') return null;
  return idToTagMap.get(selectedId) ?? null;
}

/** 内网 / 反向解析后缀（非 .local 组播）：内网域 .lan / .home.arpa + 反查 .arpa。 */
const INTERNAL_DNS_SUFFIXES = ['.arpa', '.lan', '.home.arpa'];

export function buildDnsConfig(
  config: UserConfig,
  selectedServerTag: string,
  lanResolverForDns: string | null,
  // id→唯一 tag 映射（buildIdToTagMap 单一真值）：tailscale 按名解析的 endpoint tag 直接读它，免重抄去重循环。
  idToTagMap: Map<string, string>,
  log: DnsLogFn
): SingBoxDnsConfig {
  const proxyMode = (config.proxyMode || 'smart').toLowerCase();

  // 获取用户 DNS 配置，不存在则使用默认值
  const userDnsConfig = config.dnsConfig || {
    domesticDns: 'https://doh.pub/dns-query',
    foreignDns: 'https://dns.google/dns-query',
    enableFakeIp: false,
  };

  // 决定是否开启 FakeIP。
  // 在 TUN 模式下强制开启 FakeIP。
  // 原因：很多第三方机场的节点防滥用严格，如果收到纯 IP 地址而非域名，会直接拒绝连接并抛出无效证书或拦截页面。
  // 配合我们刚刚修复的 macOS gvisor strict_route DHCP DNS 劫持逻辑，
  // FakeIP 现在能够 100% 完美的用内部 cache 把假 IP 还原成真域名丢给代理节点。
  // 从而完美避开机场对纯 IP 请求的无情封杀！
  // 单一真值：与 custom-rule-files.usesFakeIp 同源（外化判定一致，避免漂移）
  const enableFakeIp = usesFakeIp(config);

  // 用户自定义 DNS：解析 domesticDns/foreignDns（https DoH / tls DoT / udp / 裸 IP），非法或空回退默认并告警。
  const DEFAULT_DOMESTIC: ParsedDnsServer = {
    type: 'https',
    server: 'doh.pub',
    port: 443,
    path: '/dns-query',
    isDomain: true,
  };
  const DEFAULT_FOREIGN: ParsedDnsServer = {
    type: 'https',
    server: 'dns.google',
    port: 443,
    path: '/dns-query',
    isDomain: true,
  };
  const domestic = parseDnsServerSpec(userDnsConfig.domesticDns) ?? DEFAULT_DOMESTIC;
  const foreign = parseDnsServerSpec(userDnsConfig.foreignDns) ?? DEFAULT_FOREIGN;
  if (userDnsConfig.domesticDns && !parseDnsServerSpec(userDnsConfig.domesticDns)) {
    log('warn', `国内 DNS 无法解析，已回退默认 doh.pub: ${userDnsConfig.domesticDns}`);
  }
  if (userDnsConfig.foreignDns && !parseDnsServerSpec(userDnsConfig.foreignDns)) {
    log('warn', `境外 DNS 无法解析，已回退默认 dns.google: ${userDnsConfig.foreignDns}`);
  }
  // 由解析结果构造 dns server：域名型 DNS 需 domain_resolver 引导解析；DoH 带 path；remote 走代理 detour。
  const buildUserDns = (tag: string, p: ParsedDnsServer, detour?: string): SingBoxDnsServer => ({
    tag,
    type: p.type,
    server: p.server,
    server_port: p.port,
    ...(p.type === 'https' ? { path: p.path || '/dns-query' } : {}),
    ...(p.isDomain ? { domain_resolver: 'dns-bootstrap' } : {}),
    ...(detour ? { detour } : {}),
  });

  // sing-box 1.13+ 新格式：每个 server 必须有显式 type 字段
  //
  // 关键架构说明：
  // - 在 TUN 下，Windows 的系统 DNS (svchost) 发出的解析请求会被 TUN 劫持。如果该系统 DNS 配置为公共 IP，
  //   此时 type: 'local' (调用系统 getaddrinfo) 就会进入死循环。
  // - 为了彻底解决这个问题，同时避免 UDP 53 屏蔽（之前使用 223.5.5.5 UDP 的缺陷），
  //   我们引入一个坚不可摧的 DoH IP Bootstrap (dns-bootstrap)：向 223.5.5.5:443 直接发 DoH 包。
  //   它绕过 TUN 不是靠 DNS detour，而是靠 route 规则把 223.5.5.5:443 直连放行（见 generateRouteConfig）。
  //   关键路径（节点域名 / doh.pub / default_domain_resolver）均以它为 resolver，免疫 UDP 53 限速/劫持/投毒。
  const dnsServers: SingBoxDnsServer[] = [
    {
      // 引导解析：专门用于解析代理节点的 IP 解析器（UDP，最稳健）
      tag: 'dns-bootstrap-udp',
      type: 'udp',
      server: '223.5.5.5',
      server_port: 53,
    },
    {
      // 引导解析（DoH over IP）：关键路径的解析器。server 已是 IP，无需 domain_resolver。
      // 相比 UDP 53，对运营商的 UDP 53 限速/劫持/投毒免疫，避免节点域名解析失败导致断流。
      tag: 'dns-bootstrap',
      type: 'https',
      server: '223.5.5.5',
      server_port: 443,
      path: '/dns-query',
    },
    {
      // 节点域名解析器可选档（#57，DNSPod IP-DoH）：向 1.12.12.12:443 直接发 DoH 包。
      // 与 dns-bootstrap 同为 IP-based DoH（免疫 UDP 53 限速/劫持）、靠 route 把 1.12.12.12:443 直连放行绕过 TUN。
      // 仅当用户把节点域名解析器切到「DNSPod」或 system 档（TUN 下 rule ctx 防递归）时被引用；
      // 恒加进 servers——未被引用的 server sing-box 不会主动连接，零成本，避免按档增删 server 破坏热切换 tag 稳定性。
      tag: 'dns-node',
      type: 'https',
      server: '1.12.12.12',
      server_port: 443,
      path: '/dns-query',
    },
    {
      // 兼容性和兜底的系统 DNS
      tag: 'dns-local',
      type: 'local',
    },
    // 国内直连 DNS（用户可自定义，默认 doh.pub DoH）
    buildUserDns('dns-domestic', domestic),
    // 远程代理 DNS（用户可自定义，默认 dns.google DoH）。必须走代理 detour，
    // 否则在境内直接发起会因 GFW 拦截/污染导致 FakeIP 映射失败或 TTL 极短产生大量无效解析。
    buildUserDns('dns-remote', foreign, selectedServerTag),
  ];

  // P6 局域网网关：local DNS server 邻居解析（sing-box 1.14 neighbor_domain）——对这些后缀的单标签短名
  // （如 nas.lan）走局域网邻居解析（主机名→IP），实现「按局域网设备短名访问」。内核硬限界（实证 alpha.32）：
  //   · 每条须以 '.' 开头（normalizeNeighborDomain 归一化，否则 init FATAL）；· 仅 type:'local' server 支持；
  //   · 平台限 Linux/macOS（与 source_mac/hostname 同 neighbor 子系统）。
  // 仅当用户配置了 neighborDomains 且平台支持时附到 dns-local（缺省=空，配置字节零变化、snapshot 零回归）。
  if (isSourceDeviceMatchSupported(process.platform)) {
    const neighborDomains = Array.from(
      new Set(
        (config.tunConfig?.neighborDomains || [])
          .map((d) => normalizeNeighborDomain(d))
          .filter((d): d is string => !!d)
      )
    );
    if (neighborDomains.length > 0) {
      const local = dnsServers.find((s) => s.tag === 'dns-local');
      if (local) {
        local.neighbor_domain = neighborDomains;
        log('info', `local DNS 邻居解析后缀: ${neighborDomains.join(', ')}`);
      }
    }
  }

  if (enableFakeIp) {
    dnsServers.push({
      // FakeIP 服务器：返回虚假 IP，由 sniff 识别真实域名
      tag: 'fakeip',
      type: 'fakeip',
      inet4_range: FAKEIP_INET4_RANGE,
      // §B：关 IPv6(enableIPv6=false)时不给 FakeIP 分配 v6 段 → fakeip 对 AAAA 无段可分配即返空（真机实测，见
      // docs/design E-1：无需改规则 query_type）；配合下方 strategy=ipv4_only → 客户端拿不到任何 v6，杜绝
      // "双栈站 + 节点无 v6"时浏览器试 v6 失败致 ERR_CONNECTION_CLOSED。
      // 注：v6 段 fc00::/18 在 ULA 保留半区，与 LAN 旁路 fd00::/8 不相交（system-proxy-bypass），故假 v6 不会被当私网吃成直连。
      ...(config.enableIPv6 ? { inet6_range: FAKEIP_INET6_RANGE } : {}),
    });
  }

  // 方案B：DNS 接管把系统 DNS 改成公网 8.8.8.8 后，dns-local(type:local) 解不了内网域名(.lan/.home.arpa/内网域)、
  // 反查(.arpa) 与 captive portal。接管激活且读到内网 LAN 解析器(私网 IPv4)时，建 dns-lan(udp:53 指向它)，把这些
  // 域名重定向到它解析；其 :53 由 generateRouteConfig rule C 直连放行(防被 hijack-dns 抢走成环)。
  const lanResolver = lanResolverForDns;
  if (lanResolver) {
    dnsServers.push({ tag: 'dns-lan', type: 'udp', server: lanResolver, server_port: 53 });
  }
  // Q1 死循环防护（**仅 Windows**）：Win TUN 的 strict_route(WFP) 把所有 :53 逼进 TUN；type:local 经 svchost(Win DNS
  // 客户端，不在 route 直连进程白名单)发出的查询 → 进 TUN → hijack-dns → 命中 dns-local 规则 → 又 svchost → ∞。
  // **死环源于 strict_route + type:local 本身，与系统 DNS 是否被改无关**（Win setDns 已收敛 no-op，见 SystemDnsManager）。
  // macOS 安全(dns-local→mDNSResponder，在直连白名单，查询不被 hijack)；Linux 不接管。故仅 Win 下把会落 type:local 的
  // unicast 域名改路由：银行公网→dns-domestic、内网/反查/captive→dns-lan(有 LAN 解析器)否则 dns-domestic。
  // .local 走 mDNS/LLMNR 组播(不发 unicast)，留 dns-local。
  // 注：winLoopRisk 暂以 takeoverSystemDns 开关为代理键(默认 on)；理想是解耦为「Win+TUN」恒判(死环与开关无关)，
  // 待真机 nslookup 实证后再改（见 docs/design/dns-ipv6-takeover.md §A）。
  const dnsTakeoverActive =
    config.proxyModeType === 'tun' && config.dnsConfig?.takeoverSystemDns !== false;
  const winLoopRisk = process.platform === 'win32' && dnsTakeoverActive;
  // 内网/反查/captive 解析器：优先 dns-lan(直连放行的 LAN IP)；无则 Win 退 dns-domestic(避免 type:local 死环、
  // 内网域名 NXDOMAIN 但不挂)，非 Win 退 dns-local(系统解析器=真实 LAN，正常)。
  const internalResolverTag = lanResolver ? 'dns-lan' : winLoopRisk ? 'dns-domestic' : 'dns-local';
  // 银行/U盾公网域名解析器：仅 Win 改 dns-domestic 绕死环；其余 dns-local（mac 经 mDNSResponder 直连解公网正常）。
  const bankResolverTag = winLoopRisk ? 'dns-domestic' : 'dns-local';

  const dnsConfig: SingBoxDnsConfig = {
    servers: dnsServers,
    rules: [],
    // 默认使用国内 DNS 解析
    final: 'dns-domestic',
    // §B strategy 随 enableIPv6 收敛:
    //  - 开 IPv6 → prefer_ipv4(允许 AAAA,IPv6-only 目标/CDN v6 优选可达;有 v6 时 v6 可能被系统选用)。
    //  - 关 IPv6 → ipv4_only(抑制 AAAA,客户端只拿 A)→ 杜绝"双栈站 + 节点无 v6"时浏览器试 v6 失败致
    //    ERR_CONNECTION_CLOSED(#57:TUN 本地握手骗过 Happy Eyeballs、不回落 v4)。关 IPv6 即明示放弃 v6,
    //    IPv6-only 目标不可达是该选择的预期代价(故不再有当初移除 ipv4_only 的顾虑——那是 v6 开着时的副作用)。
    strategy: config.enableIPv6 ? 'prefer_ipv4' : 'ipv4_only',
    // 关 FakeIP：补 reverse_mapping，让无 SNI/ECH 的连接也能用 DNS 反查域名做路由匹配（不改节点收 IP 事实，见设计 T3）。
    // 开 FakeIP 时不加（FakeIP 本身已提供域名↔假 IP 的双向映射）。
    ...(enableFakeIp ? {} : { reverse_mapping: true }),
    // P2b 乐观 DNS 缓存（1.14 顶层 dns.optimistic）：仅开关 true 时下发，关时省略保持配置字节不变（snapshot 零回归）。
    // 过期先返旧值后台刷新降尾延迟（schema 实证：dns.optimistic 接受 boolean）。
    ...(userDnsConfig.optimisticCache === true ? { optimistic: true } : {}),
    // P2c DNS 查询超时（1.14 顶层 dns.timeout，Go duration 字符串）：仅有效正毫秒时下发 "<n>ms"，未设/非法省略用核默认。
    // sanitize（ConfigManager.validateConfig）已保证落盘值为 1..60000 的有限正整数；此处再防御性校验避免 emit "0ms"/NaN。
    ...(typeof userDnsConfig.dnsTimeoutMs === 'number' &&
    Number.isFinite(userDnsConfig.dnsTimeoutMs) &&
    userDnsConfig.dnsTimeoutMs > 0
      ? { timeout: `${Math.round(userDnsConfig.dnsTimeoutMs)}ms` }
      : {}),
  };
  const dnsRules: SingBoxDnsRule[] = [];

  // 代理服务器域名必须使用真实 DNS 解析（避免 FakeIP 劫持产生死循环）。
  // #57 rule1 全量化：遍历【全部】节点的 address + tlsSettings.serverName（过滤 IP 字面量），而非仅当前选中节点——
  //   修热切换 query 侧缺口：原先只含 selectedServer，热切换到其它节点后该节点域名查询会落 FakeIP/dns-local。
  // 去掉过宽的 domain_keyword（exact domain + suffix 已对节点域名全覆盖，keyword 易误伤同名子串）。
  // server 取 getNodeResolverTag(config,'rule')：auto 忠实回 dns-domestic（doh.pub DoH，与基线一致，
  //   不随 dial 的 dns-bootstrap 统一）；dnspod=dns-node；TUN+system 强制 dns-node 防递归。
  const nodeDomains = Array.from(
    new Set(
      config.servers.flatMap((s) => {
        const ds: string[] = [];
        if (s.address) ds.push(s.address);
        if (s.tlsSettings?.serverName) ds.push(s.tlsSettings.serverName);
        return ds;
      })
    )
  ).filter((d) => !!d && !isIpv4Host(d) && !isIpv6Host(d));
  if (nodeDomains.length) {
    // 观测：超大订阅下 rule1 域名规模（不设上限，trie 匹配千级无压力；异常膨胀时据此定位）。
    log('info', `DNS rule1 节点域名规则: ${nodeDomains.length} 个域名`);
    dnsRules.push({
      domain: nodeDomains,
      domain_suffix: nodeDomains.flatMap((d) => [d, `.${d}`]),
      server: getNodeResolverTag(config, 'rule'),
    } as SingBoxDnsRule);
  }

  // 处理基础 DNS 服务的地址解析，确保它们走引导解析器（含用户自定义的 DoH 域名）
  const bootstrapDomains = ['doh.pub', 'dns.google', 'cloudflare-dns.com', 'one.one.one.one'];
  if (domestic.isDomain) bootstrapDomains.push(domestic.server);
  if (foreign.isDomain) bootstrapDomains.push(foreign.server);
  dnsRules.push({
    domain: Array.from(new Set(bootstrapDomains)),
    server: 'dns-bootstrap-udp',
  } as SingBoxDnsRule);

  // 解决 mDNS 和本地反向解析导致的 context deadline exceeded 超时问题。
  // 方案B + Q1：内网/反查 → internalResolverTag、银行 → bankResolverTag、.local 恒 dns-local（组播安全）。
  // 三者全为 dns-local（即非 dns-lan、非 Win+takeover）→ 合并回原单条规则，byte-diff 零变化（Linux baseline/系统代理/
  // 关接管均走此路）。否则拆三条（mac/Win 有 LAN 解析器，或 Win+takeover 无 LAN 解析器）。
  if (internalResolverTag === 'dns-local' && bankResolverTag === 'dns-local') {
    dnsRules.push({
      domain_suffix: ['.local', ...INTERNAL_DNS_SUFFIXES, ...DOMESTIC_BANK_AND_STOCK_DOMAINS],
      server: 'dns-local',
    } as SingBoxDnsRule);
  } else {
    dnsRules.push({ domain_suffix: ['.local'], server: 'dns-local' } as SingBoxDnsRule);
    dnsRules.push({
      domain_suffix: [...DOMESTIC_BANK_AND_STOCK_DOMAINS],
      server: bankResolverTag,
    } as SingBoxDnsRule);
    dnsRules.push({
      domain_suffix: INTERNAL_DNS_SUFFIXES,
      server: internalResolverTag,
    } as SingBoxDnsRule);
  }

  // fake-ip-filter 默认清单（仅 FakeIP 开启时有意义；config.fakeIpFilter === false 可关）：NTP/STUN/Captive 等
  // 在 FakeIP 下会坏的域名 → 在 fakeip catch-all 之前命中、改走真实解析器，绕过 FakeIP。内联硬编码、无下载依赖。
  if (enableFakeIp && config.fakeIpFilter !== false) {
    if (config.fakeIpFilterList === undefined) {
      // 默认（未编辑）：与历史逐字节一致。captive→internalResolverTag（接入网/LAN 解析器反映真实本地网络，
      // 否则系统误判断网/锁屏登录卡死）；ntp/stun→dns-domestic（真实 DoH，校时与 P2P 需真实 IP）。
      dnsRules.push({
        domain: FAKEIP_FILTER_CAPTIVE_DOMAINS,
        server: internalResolverTag,
      } as SingBoxDnsRule);
      dnsRules.push({
        domain_suffix: FAKEIP_FILTER_NTP_SUFFIXES.flatMap(withDotPrefix),
        domain_keyword: FAKEIP_FILTER_NTP_STUN_KEYWORDS,
        server: 'dns-domestic',
      } as SingBoxDnsRule);
    } else {
      // 用户编辑过的清单：内置 captive 域名仍→internalResolverTag（保 captive 检测正确）；其余→dns-domestic 真实解析。
      // ntp/stun 关键字（裸子串、非域名清单项）始终兜底保留。
      const captiveSet = new Set<string>(FAKEIP_FILTER_CAPTIVE_DOMAINS);
      const captive = config.fakeIpFilterList.filter((d) => captiveSet.has(d));
      const others = config.fakeIpFilterList.filter((d) => !captiveSet.has(d));
      if (captive.length > 0) {
        dnsRules.push({ domain: captive, server: internalResolverTag } as SingBoxDnsRule);
      }
      if (others.length > 0) {
        dnsRules.push({
          domain_suffix: others.flatMap(withDotPrefix),
          server: 'dns-domestic',
        } as SingBoxDnsRule);
      }
      dnsRules.push({
        domain_keyword: FAKEIP_FILTER_NTP_STUN_KEYWORDS,
        server: 'dns-domestic',
      } as SingBoxDnsRule);
    }
  }

  // 处理自定义规则中的 bypassFakeIP（仅 domain / domainSuffix / domainKeyword 三类域名规则有效）。
  // 可外化规则（smart/global + 已落盘 <base>.dns.json）→ 引用其 <base>-dns rule_set，值不进 DNS 配置
  // （改值原子替换文件 → fswatch 热重载、零重启）；inline / direct 模式 / 文件缺失降级 → 仍按值提取合并（现状）。
  // 用户路由仅 smart 生效（effectiveCustomRules）：global/direct 下 route 侧不 emit 自定义规则，其 bypassFakeIP DNS 也不应注入
  const dnsCustomRules = effectiveCustomRules(config);
  if (dnsCustomRules.length && enableFakeIp) {
    const bypassDomains: string[] = []; // type 'domain'
    const bypassSuffixes: string[] = []; // type 'domainSuffix'
    const bypassKeywords: string[] = []; // type 'domainKeyword'
    const dnsTags: string[] = [];
    const externalize = proxyMode !== 'direct'; // direct 不外化（route 侧 generateCustomRules 不执行）；此处 dnsCustomRules 已 smart-only
    for (const rule of dnsCustomRules) {
      if (!rule.enabled || !rule.bypassFakeIP) continue;
      if (externalize) {
        const plan = planCustomRule(rule);
        if (plan.kind !== 'inline' && plan.dnsRules) {
          const base = customRuleFileBase(rule.id);
          const dnsPath = path.join(getCustomRulesDir(), `${base}.dns.json`);
          if (require('fs').existsSync(dnsPath)) {
            if (!dnsTags.includes(`${base}-dns`)) dnsTags.push(`${base}-dns`);
            continue; // 已外化：域名值走文件，不在此提取
          }
        }
      }
      // inline / direct / 文件缺失降级：取所有 domain/domainSuffix/domainKeyword 条件的值并集
      for (const cond of ruleConditions(rule)) {
        const vals = (cond.values || []).map((v) => v.trim()).filter(Boolean);
        if (vals.length === 0) continue;
        if (cond.type === 'domain') {
          bypassDomains.push(...vals);
        } else if (cond.type === 'domainSuffix') {
          bypassSuffixes.push(...vals.map((d) => (d.startsWith('*.') ? d.slice(2) : d)));
        } else if (cond.type === 'domainKeyword') {
          bypassKeywords.push(...vals);
        }
      }
    }

    if (bypassDomains.length || bypassSuffixes.length || bypassKeywords.length) {
      const bypassRule: Record<string, unknown> = { server: 'dns-bootstrap' };
      if (bypassDomains.length) bypassRule.domain = bypassDomains;
      if (bypassSuffixes.length) {
        bypassRule.domain_suffix = bypassSuffixes.flatMap(withDotPrefix);
      }
      if (bypassKeywords.length) bypassRule.domain_keyword = bypassKeywords;
      dnsRules.push(bypassRule as unknown as SingBoxDnsRule);
    }
    // 外化规则的域名匹配走 rule_set 引用（与上面 inline 合并规则相邻，OR 语义等价）
    if (dnsTags.length) {
      dnsRules.push({ rule_set: dnsTags, server: 'dns-bootstrap' } as unknown as SingBoxDnsRule);
    }
  }

  // 智能分流/全局代理模式下的 DNS 规则
  if (proxyMode === 'smart' || proxyMode === 'global') {
    if (enableFakeIp) {
      // [原版 Fork 核心精髓：Clash-style 全局 FakeIP]
      // 让所有的 A/AAAA（IPv4/IPv6）解析无脑走 FakeIP 返回 198.18 的伪装 IP。
      // 等浏览器连过来以后，Sing-box 靠伪装 IP 查缓存恢复域名，然后交给下面的 Route 引擎。
      // Route 引擎看到域名，如果命中 geosite-cn，就走 direct 出口，走 direct 时再真正发起本地 DNS 查询拿到淘宝的真实 IP。
      // 如果查不到 cn 规则，自然落入 proxy，连同域名一起完好无损发给代理节点！极其稳如泰山！
      dnsRules.push({
        query_type: ['A', 'AAAA'],
        server: 'fakeip',
      } as SingBoxDnsRule);
    } else {
      // 如果实在没开 FakeIP（比如系统代理模式），那就用 geosite 规则让它各自拿正确的 IP 吧（但也容易被墙污染）
      if (proxyMode === 'smart') {
        // 地区分流的 DNS 解析器划分，镜像 route 侧 localOut/foreignOut/final 的 reverse 翻转（单一真值同源）：
        //   geo tag 复用 region-routing（与 route 侧 REGION_LOCAL_GEO 同源）：cn=['geosite-cn']（逐字节=今日）/
        //     ir=['geosite-category-ir'] / ru=['geosite-category-ru']。
        //   · 正向（reverse=false）：region-local（国内）域名→dns-domestic（国内直连解析最优 IP）、其余 fallthrough
        //     →dns-remote、final=dns-domestic（=今日行为，逐字节不变）。
        //   · 反向（reverse=true，如「回国」）：region-local（国内）域名→dns-remote（经回国节点解析国内最优 IP，
        //     避免境外直接解国内域名拿到不可达/慢的 IP）、其余→dns-domestic、final 同步翻为 dns-remote。
        //   与 route 侧 localOut=reverse?proxy:direct / foreignOut=reverse?direct:proxy / final 翻转一一对应。
        const region = effectiveRegionRouting(config);
        // #7 fail-closed：引用 region geo rule_set 前镜像 route 侧「本地 .srs 缺失即跳过」——DNS 侧无末尾悬空剪枝，
        //   悬空 rule_set 会令 sing-box `initialize rule-set` FATAL。geosite-cn 随包恒在、ir/ru 的 .srs 亦随包
        //   （resources/data），缺失（损坏/未 seed）时跳过该 region-local 规则：所有域名 fallthrough 到 final，
        //   次优但不崩（route 侧同款 fail-closed，重下资源后自动恢复）。
        const runtimeDir = getRuntimeRulesDir();
        const localGeo = REGION_LOCAL_GEO[region.region].geosite.filter((tag) => {
          const fileName = findBuiltin(tag)?.fileName ?? `${tag}.srs`;
          return isValidSrsFile(path.join(runtimeDir, fileName));
        });
        // region-local 与其余侧各自的解析器（reverse 翻转）。
        const localResolver = region.reverse ? 'dns-remote' : 'dns-domestic';
        const fallthroughResolver = region.reverse ? 'dns-domestic' : 'dns-remote';
        if (localGeo.length > 0) {
          dnsRules.push({
            // 单 tag 与历史一致序列化为标量字符串（保 cn 逐字节）；多 tag 走数组。
            rule_set: localGeo.length === 1 ? localGeo[0] : localGeo,
            server: localResolver,
          } as SingBoxDnsRule);
        }

        // 此处移除了 rule_set: 'geosite-geolocation-!cn'，因为 1.12 的 singbox 在
        // dns block 里跑规则集会导致某些内置不支持的匹配失效或报错，一律 fallthrough（正向 dns-remote / 反向 dns-domestic）
        dnsRules.push({
          server: fallthroughResolver,
        } as SingBoxDnsRule);

        // final 兜底解析器同步翻转：反向时未命中任何规则的查询应走 dns-remote（回国节点）。仅 smart 非-FakeIP +
        //   region.enabled + reverse 才翻（正向/关地区分流/FakeIP 路径 final 保持 dns-domestic 逐字节不变）。
        if (region.enabled && region.reverse) {
          dnsConfig.final = 'dns-remote';
        }
      } else {
        dnsRules.push({
          query_type: ['A', 'AAAA'],
          server: 'dns-remote',
        } as SingBoxDnsRule);
      }
    }
  }

  // P4b ⭐tailnet 按名解析（仅选中此 mesh tailscale 节点为主出口时生效）：注入 tailscale DNS server +
  // preferred_by 规则。preferred_by 让 tailnet search domain / MagicDNS 短名自动归位到此节点解析——
  // 替代硬编码后缀。与 doh.pub/google **并存**：仅 preferred_by 命中的 tailnet 名走 dns-tailscale，
  // 其余域名规则/final 不变（preferred_by 规则置于尾部 catch-all 之前，不影响既有分流字节）。
  // accept_search_domain 与 preferred_by 强联动：accept_search_domain 提供短名解析能力，preferred_by 决定
  // 哪些名字优先归它——故二者同开同关（resolveByName 一个开关同时拉起 server.accept_search_domain + 规则）。
  const tsResolveNode = (() => {
    const selectedId = config.selectedServerId;
    if (!selectedId) return null;
    const sel = config.servers.find((s) => s.id === selectedId);
    if (!sel || sel.protocol.toLowerCase() !== 'tailscale') return null;
    if (!sel.tailscaleSettings?.resolveByName) return null;
    return sel;
  })();
  if (tsResolveNode) {
    const epTag = selectedTailscaleEndpointTag(config, idToTagMap);
    if (epTag) {
      dnsServers.push({
        tag: TS_NAME_DNS_TAG,
        type: 'tailscale',
        // tailscale DNS server 必填：引用该 mesh 节点的 endpoint tag（缺失则 sing-box FATAL）。
        endpoint: epTag,
        accept_search_domain: true,
        ...(tsResolveNode.tailscaleSettings?.acceptDefaultResolvers
          ? { accept_default_resolvers: true }
          : {}),
      });
      // preferred_by 规则须置于「全量 catch-all（smart/global 的 fallthrough / FakeIP query_type 全匹配）」**之前**，
      // 否则无条件 catch-all 先短路、preferred_by 永不命中。故 unshift 到规则链最前（tailnet 名为具体名优先归位，
      // 高优先合理；非 tailnet 名不被 preferred_by 命中，照常 fallthrough 既有规则，字节不变）。
      dnsRules.unshift({
        preferred_by: [TS_NAME_DNS_TAG],
        action: 'route',
        server: TS_NAME_DNS_TAG,
      } as SingBoxDnsRule);
      log('info', `Tailscale 按名解析已启用：tailnet 名 → ${TS_NAME_DNS_TAG}(endpoint=${epTag})`);
    } else {
      log('warn', 'Tailscale 按名解析已开启，但未能定位选中节点的 endpoint tag，已跳过');
    }
  }

  dnsConfig.rules = dnsRules;
  return dnsConfig;
}
