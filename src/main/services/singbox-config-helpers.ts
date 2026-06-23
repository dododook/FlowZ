/**
 * config-gen 共享纯 helper —— 从 ProxyManager 抽出（SingBoxConfigBuilder 抽取 Phase 2）。
 * 全部纯函数、零实例状态：只读 config / host 字符串。ProxyManager 与各 generator 模块
 * （dns / route / ruleselectors / outbound）共用，避免跨模块依赖私有方法。
 */

import { isIpv4 } from '../../shared/ip';
import type {
  UserConfig,
  ServerConfig,
  Rule,
  AppRule,
  CustomAppPreset,
  DnsConfig,
} from '../../shared/types';
import { parseDnsServerSpec, isIpv6Literal } from '../../shared/dns';
import { ruleConditions } from '../../shared/rules';
import { getAppPreset } from '../../shared/app-rules-preset';
import { BUILTIN_GEO_RULESETS } from './builtin-geo-rulesets';
import type { SingBoxConfig, SingBoxRouteRule } from './singbox-config-types';

/**
 * 内置出站/inbound 保留 tag：节点显示名撞这些会致 sing-box tag 冲突 FATAL，故去重时预占。
 * 单一真值——id→tag 映射与「按名解析 tailscale endpoint tag」均以此为基准（杜绝多处重抄漂移）。
 */
const RESERVED_OUTBOUND_TAGS: readonly string[] = [
  'proxy-selector',
  'direct',
  'block',
  'direct-loopback',
  'probe-direct-in',
  'probe-proxy-in',
];

/**
 * 按节点顺序生成「serverId → 唯一 tag（=节点显示名，撞名/撞保留 tag 追加 (n)）」映射。
 * 单一真值：ProxyManager（config-gen）与 dns-builder（tailscale endpoint 按名解析）共用同一份去重规则，
 * 避免两处各自重放循环漂移（tailscale endpoint tag 须与 outbound tag 逐字节一致，否则 sing-box FATAL）。
 */
export function buildIdToTagMap(servers: ServerConfig[]): Map<string, string> {
  const idToTagMap = new Map<string, string>();
  const usedTags = new Set<string>(RESERVED_OUTBOUND_TAGS);
  for (const s of servers) {
    const baseTag = s.name.trim() || '未命名节点';
    let tag = baseTag;
    let count = 1;
    while (usedTags.has(tag)) {
      tag = `${baseTag} (${count})`;
      count++;
    }
    usedTags.add(tag);
    idToTagMap.set(s.id, tag);
  }
  return idToTagMap;
}

/**
 * 国内常见网银 U盾插件及本地证券/炒股软件的专属域名
 * 用于绕过代理，防止被 FakeIP 劫持或因协议不兼容（如二进制协议通过 HTTP 代理）被阻断。
 * DNS（generateDnsConfig 银行域名规则）与 route（generateRouteConfig 强制直连）共用，单一真值。
 */
export const DOMESTIC_BANK_AND_STOCK_DOMAINS = [
  // U盾及网银相关（通常指向 127.0.0.1）
  '.microdone.cn', // 微动（杭州银行、中信银行等地方和股份制网银插件常用）
  '.icbc.com.cn', // 工商银行
  '.boc.cn', // 中国银行
  '.ccb.com', // 建设银行
  '.abchina.com',
  '.abchina.com.cn', // 农业银行
  '.bankcomm.com', // 交通银行
  '.cmbchina.com', // 招商银行
  '.psbc.com', // 邮储银行
  '.spdb.com.cn', // 浦发银行
  '.cebbank.com', // 光大银行
  '.citicbank.com', // 中信银行
  '.pingan.com', // 平安银行
  '.cib.com.cn', // 兴业银行
  '.hxb.com.cn', // 华夏银行
  '.cmbc.com.cn', // 民生银行
  '.hzbank.com.cn', // 杭州银行

  // 证券炒股软件相关（经常使用定制化的 TCP 二进制协议通信，在 SOCKS/HTTP 系统代理模式下会导致握手失败并被代理核心主动断开）
  '.10jqka.com.cn',
  '.thsi.cn', // 同花顺
  '.eastmoney.com',
  '.1234567.com.cn', // 东方财富
  '.gw.com.cn', // 大智慧
  '.tdx.com.cn', // 通达信
];

/** 主机字符串是否为 IPv4 字面量（收敛到 shared/ip.isIpv4 严格判定，与 DNS 分类同源，避免不一致）。 */
export const isIpv4Host = (host: string): boolean => isIpv4(host);

/**
 * 主机字符串是否为 IPv6 字面量（收敛到 shared/dns.isIpv6Literal 单一真值：去方括号 + ≥2 冒号，含
 * IPv4-mapped 末段点分；与 /simplify F3 spoof 守卫同口径）。相比原 `/^[0-9a-fA-F:]+$/ && includes(':')`：
 *  (1) 收紧——原 1 个冒号即放行，把 'dead:beef' 等畸形串误判为 IPv6，现 ≥2 冒号方为 IPv6（拒畸形串）；
 *  (2) 纳入方括号——原带方括号（'[::1]'）因含 '[' ']' 不匹配正则被判 false，现去方括号后正确归类为 IPv6；
 *  (3) 纳入 IPv4-mapped（R4-1）——'::ffff:1.2.3.4'/'::1.2.3.4' 因含 '.' 原被拒，现末段为严格 IPv4 时归类为
 *      IPv6，与 api-client target()（含 ':' 即当 IPv6 包裹）对该地址结论一致 → builders 闸门接纳、CIDR 拼 /128。
 * 真 IPv6（裸 ≥2 冒号）/ 真域名（无冒号）判定不变。
 */
export const isIpv6Host = (host: string): boolean => isIpv6Literal(host);

/**
 * 去 IPv6 字面量方括号：仅当两端**配对**方括号时脱（'[::1]' → '::1'）。畸形输入（单边 '[::1' / '::1]'、
 * 空 '' / '[]'）原样返回——避免把单边括号串截成误判 IP 的形态，让下游 isIp 判定据实拒之。裸地址/域名/IPv4 原样返回。
 */
export const stripHostBrackets = (host: string): string =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

/**
 * IP 字面量 host → 单 IP 排除 CIDR（IPv6 → /128，IPv4 → /32）；**非 IP / 空 / 畸形输入返回 null**，调用方 skip。
 * 防护：'' / '[]' 经 stripHostBrackets → 空串，旧实现会拼出非法 '/32'；域名同理。仅真 IP（v4 严格 / v6 含
 * IPv4-mapped）才产 CIDR，保持「仅真 IP 才排除」语义（当前调用方均已 isIpv4Host||isIpv6Host 预闸，本防护使 helper 自身健壮）。
 * 先脱方括号：节点 address 经 Clash YAML 导入 / 表单输入可能保留 '[::1]' 方括号（ProtocolParser 会脱、这两条路径不脱），
 * 直接拼 '[::1]/128' 是非法 CIDR，故脱括号后再拼（与 isIpv6Host 去括号判定同口径）。
 */
export const hostToExcludeCidr = (host: string): string | null => {
  const bare = stripHostBrackets(host);
  if (isIpv6Host(bare)) return `${bare}/128`;
  if (isIpv4Host(bare)) return `${bare}/32`;
  return null;
};

/**
 * issue #147：有效「off 单上游 id」——优先新模型 nodeResolverSingle；缺失（未迁移 / 旧单测仅设
 * deprecated nodeDomainResolver）→ 回退 legacy 档位映射，保证零行为变化。
 */
function effectiveSingleResolverId(dns: DnsConfig | undefined): string {
  if (dns?.nodeResolverSingle) return dns.nodeResolverSingle;
  const legacy = dns?.nodeDomainResolver ?? 'auto';
  return legacy === 'dnspod' ? 'dnspod' : legacy === 'system' ? 'system' : 'ali';
}

/**
 * 节点域名解析器 → 实际使用的 DNS server tag（#57 起；issue #147 改读新模型 nodeResolverSingle）。
 * 同时供节点 outbound 的 domain_resolver（ctx='dial'）与节点域名 DNS rule1（ctx='rule'）取值，
 * 保证 dial 与 rule1 用同一档（outbound 级统一 tag），不破坏 selector 热切换。
 *
 * issue #147：消费从 deprecated nodeDomainResolver 切到新模型 nodeResolverSingle（off 单上游 id）。
 * 本步产出与旧档位【完全等价】的内置 tag（零行为变化）；race-on(resolveNodeDomainsAhead) 指 dns-node-race
 * 的接入随 buildDnsConfig 生成 race server 一并落（设计 §7 / Task#5），此处暂不区分 on/off。
 *  - ali（默认）→ dial=dns-bootstrap(AliDNS IP-DoH 223.5.5.5) / rule=dns-domestic(doh.pub DoH)。
 *             两路径基线本就不同档，统一会把 rule1 从 doh.pub 悄改成 AliDNS，违反「默认零行为变化」。
 *  - dnspod   → dns-node（DNSPod IP-DoH 1.12.12.12）
 *  - system   → dns-local（系统 DNS）；INV-1：TUN 下 rule ctx 强制 dns-node（IP-DoH）防递归——
 *             节点域名查询若落 dns-local，其上游可能再经 TUN 被 hijack-dns 劫持回 DNS rules 形成软死循环。
 *  - 自定义 id → 自定义 server 生成见 Task#5；当前回退基线 tag（落地中间态）。
 */
/** issue #147：本地 race DNS server 的 tag（race on 时 outbound.domain_resolver / 节点域名 rule1 指它）。单一真值。 */
export const DNS_NODE_RACE_TAG = 'dns-node-race';

export function getNodeResolverTag(
  config: UserConfig | null | undefined,
  ctx: 'dial' | 'rule'
): string {
  // issue #147：race on（resolveNodeDomainsAhead !== false）→ 指本地 race server（多上游并发，dial 与 rule 同 tag）。
  // 仅 race server 就绪时 config 才为 on（ProxyManager 用 raceServerPort 算 effective config；snapshot/preflight/诊断
  // 等未就绪路径恒 off，不引用 dns-node-race，防 FATAL）。off → 单上游（nodeResolverSingle，逃生/降级，与旧档位等价）。
  if (config?.dnsConfig?.resolveNodeDomainsAhead !== false) {
    return DNS_NODE_RACE_TAG;
  }
  const single = effectiveSingleResolverId(config?.dnsConfig);
  if (single === 'dnspod') return 'dns-node';
  if (single === 'system') {
    if (ctx === 'rule' && config?.proxyModeType === 'tun') return 'dns-node'; // INV-1
    return 'dns-local';
  }
  // 'ali' / 自定义（自定义 server 见 Task#5）/ 缺省：忠实保留两路径各自基线解析器，逐字节回现状。
  return ctx === 'dial' ? 'dns-bootstrap' : 'dns-domestic';
}

/**
 * 用户路由规则 gate（单一真值）：自定义路由规则**仅 smart 模式生效**。
 * global = 真·全局（一律走选中节点，忽略用户分流，仅保留功能性强制直连：防环 / LAN·私网 / 网银 U盾 / 节点排除）；
 * direct = 全部直连。对齐业内（Clash/Surge/sing-box GUI）——全局模式即忽略所有用户分流规则。
 * 消费点统一经此（route emit / 规则选择器 / geo 收集 / DNS bypassFakeIP），与 effectiveAppRules 对称。
 */
export function effectiveCustomRules(config: UserConfig): Rule[] {
  if ((config.proxyMode || 'smart').toLowerCase() !== 'smart') return [];
  return config.customRules || [];
}

/**
 * 应用分流总开关 gate：appRoutingEnabled !== true → 空（默认关）；非 smart 模式（global/direct）→ 空。
 * 仅 smart + 显式启用才生效。单一真值点，4 个消费点（route 生成 / 规则选择器 / TUN 排除 / geo 收集）统一经此。
 * global 忽略应用分流（真·全局走选中节点），与 effectiveCustomRules 对称。
 */
export function effectiveAppRules(config: UserConfig): AppRule[] {
  if (config.appRoutingEnabled !== true) return [];
  if ((config.proxyMode || 'smart').toLowerCase() !== 'smart') return [];
  return config.appRules || [];
}

/** 用户自定义国内 DNS 若为 IP（非 DoH 域名），返回 {ip, port} 供 TUN 直连放行/排除集；否则 null。 */
export function getCustomDomesticDnsEndpoint(
  config: UserConfig
): { ip: string; port: number } | null {
  const p = parseDnsServerSpec(config.dnsConfig?.domesticDns);
  return p && !p.isDomain ? { ip: p.server, port: p.port } : null;
}

/**
 * 内置 geo 规则集的单一真值表：tag、运行时文件名、内置源路径。
 * copyRuleSetsToUserData（写入）、generateRouteConfig（引用 path）、RuleResourceManager（页面展示/更新）
 * 共用 builtin-geo-rulesets 模块的 BUILTIN_GEO_RULESETS，避免多处硬编码目录+文件名导致漂移——
 * 改一处而另一处仍指旧路径会让 sing-box 加载本地 rule_set 失败。
 */
export function getLocalGeoRuleSets(): { tag: string; fileName: string; srcPath: string }[] {
  return BUILTIN_GEO_RULESETS.map((b) => ({
    tag: b.tag,
    fileName: b.fileName,
    srcPath: b.bundledPath(),
  }));
}

/**
 * 收集自定义规则中使用的 Geosite 和 GeoIP 类别（同时扫描 customRules 和 appRules）
 */
export function getRequiredGeoCategories(
  customRules: Rule[],
  appRules: AppRule[] = [],
  customAppPresets: CustomAppPreset[] = []
): { geosite: Set<string>; geoip: Set<string> } {
  const geositeCategories = new Set<string>();
  const geoipCategories = new Set<string>();

  // 扫描 geosite / geoip 类型的自定义规则（values 即裸标签，如 'youtube'/'cn'）
  for (const rule of customRules) {
    if (!rule.enabled) continue;
    // 扫所有条件（多条件规则的 logical 内可含 geosite/geoip → 否则其 remote rule_set 不被注入致引用缺失）
    for (const cond of ruleConditions(rule)) {
      if (cond.type === 'geosite') {
        for (const t of cond.values) {
          const tag = t.trim().toLowerCase();
          if (tag) geositeCategories.add(tag);
        }
      } else if (cond.type === 'geoip') {
        for (const t of cond.values) {
          const tag = t.trim().toLowerCase();
          if (tag) geoipCategories.add(tag);
        }
      }
    }
  }

  // 扫描应用分流规则
  for (const appRule of appRules) {
    if (!appRule.enabled) continue;
    const preset = getAppPreset(appRule.appId, customAppPresets);
    if (preset) {
      // 与 customRules 分支同口径：trim + 小写。必须与发射端（singbox-route-builder app 规则
      // `geosite-/geoip-`）+ 本地 .srs 文件名/资源 id（均小写）一致，否则 customAppPresets 含大写 tag 时
      // 所需类别集（决定注入哪些 rule_set）与实际引用的 rule_set tag 错位 → fail-closed 剪枝静默丢规则。
      preset.geositeTags.forEach((tag) => {
        const t = tag.trim().toLowerCase();
        if (t) geositeCategories.add(t);
      });
      if (preset.geoipTags) {
        preset.geoipTags.forEach((tag) => {
          const t = tag.trim().toLowerCase();
          if (t) geoipCategories.add(t);
        });
      }
    }
  }
  return { geosite: geositeCategories, geoip: geoipCategories };
}

/**
 * fail-closed 兜底：剪掉引用「未定义/不可达 rule_set tag」的路由规则及 rule_set 定义。复用三态递归剪枝
 * （string/array/logical）：smart geo 缺失→该方向规则 skip；app 规则只掉 geo 半（进程名规则独立保留）；
 * 自定义规则 AND/OR 合理坍缩。就地改 singboxConfig.route（mutate），无实例状态。返回被丢弃的 rule_set tag。
 */
export function applyRuleSetPrune(
  singboxConfig: SingBoxConfig,
  unreachable: Set<string>
): string[] {
  if (unreachable.size === 0 || !singboxConfig.route) return [];
  const dropped: string[] = [];
  if (singboxConfig.route.rule_set) {
    singboxConfig.route.rule_set = singboxConfig.route.rule_set.filter((rs) => {
      if (rs.tag && unreachable.has(rs.tag)) {
        dropped.push(rs.tag);
        return false;
      }
      return true;
    });
  }
  const pruneRules = (rules: SingBoxRouteRule[]): SingBoxRouteRule[] =>
    rules.filter((rule) => {
      if (Array.isArray(rule.rules)) {
        const before = rule.rules.length;
        rule.rules = pruneRules(rule.rules);
        // logical 规则子条件被剪空 → 整条丢（空 logical 无意义且 sing-box 不接受）
        if (rule.type === 'logical' && rule.rules.length === 0) return false;
        // AND logical 任一子条件被剪掉 → 整条丢（fail-closed：缺失条件无法满足，留剩余子集会以「超集」匹配）。
        // 关键：修「派生的嵌套 AND udp443 reject」——内层 geo logical 被剪空丢弃后，外层 AND 仅剩 {network,port}
        // 否则坍缩成无差别全局 udp443 reject（误伤 Hysteria2/TUIC 握手与全局 QUIC）；与 generateCustomRules
        // 的 AND fail-closed 语义一致（任一子条件丢→整条 skip）。OR / 无 mode 不受影响（少一候选项无害）。
        if (rule.type === 'logical' && rule.mode === 'and' && rule.rules.length < before) {
          return false;
        }
      }
      const rs = rule.rule_set;
      if (typeof rs === 'string') {
        if (unreachable.has(rs)) return false; // 唯一 rule_set 缺失 → 该规则停止生效
      } else if (Array.isArray(rs)) {
        const kept = rs.filter((t) => !unreachable.has(t));
        if (kept.length === 0) return false; // rule_set 全缺失 → 该规则停止生效
        if (kept.length !== rs.length) rule.rule_set = kept; // 部分保留（如 geosite 留、geoip 丢）
      }
      return true;
    });
  // 以 unreachable.size 为闸（已 early-return size===0），不以 dropped.length——fail-closed 下复用此函数剪
  // 「本地缺失、无 rule_set 定义」的悬空 tag 时 dropped 恒为 0，但仍须剪掉引用它的规则（否则悬空引用 FATAL）。
  if (unreachable.size > 0) {
    singboxConfig.route.rules = pruneRules(singboxConfig.route.rules ?? []);
  }
  return dropped;
}
