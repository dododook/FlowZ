import { isIpv4 } from './ip';

/**
 * 节点域名解析器（#57 resolve-ahead）实际启用的 IP-DoH 上游 IP：AliDNS 223.5.5.5 + DNSPod 1.12.12.12。
 * 单一真值——node-domain-resolver 的 DoH URL、route 直连放行、Windows TUN route_exclude 全派生自此，
 * 杜绝「新增/更换 DoH 上游 IP，却漏同步到 exclude → 该上游连接命中 TUN CIDR 回流死循环」（#57 类回环）。
 * 不变量：这两个 IP【必须】∈ BOOTSTRAP_DIRECT_DNS_IPS（单测护栏断言），否则其 :443 DoH 不被直连放行。
 */
export const DOH_ALIDNS_IP = '223.5.5.5';
export const DOH_DNSPOD_IP = '1.12.12.12';
export const DOH_UPSTREAM_IPS: readonly string[] = [DOH_ALIDNS_IP, DOH_DNSPOD_IP];

/**
 * sing-box route 在 hijack-dns 之前「直连放行」的国内 bootstrap DNS IP（:53/:443）。单一真值：
 *   - generateRouteConfig 的引导直连规则（C 段）引用，保证核心 DNS 自举不被 hijack 成 FakeIP；
 *   - SystemDnsManager 受控 DNS IP 的选择守卫引用——受控 IP 绝不能落在此列表，否则其 :53 查询被该
 *     直连规则放行、逃逸 hijack-dns，DNS 接管失效（见 docs/design/dns-ipv6-takeover.md）；
 *   - singbox-inbounds-builder 的 Windows TUN route_exclude 引用（防 WFP 进程匹配失效时回流死循环）。
 * 含 DoH 上游 IP（DOH_UPSTREAM_IPS：223.5.5.5 + 1.12.12.12）+ AliDNS 备 + DNSPod/114 公共 DNS。
 */
export const BOOTSTRAP_DIRECT_DNS_IPS: readonly string[] = [
  DOH_ALIDNS_IP, // 223.5.5.5（AliDNS IP-DoH 上游）
  '223.6.6.6',
  DOH_DNSPOD_IP, // 1.12.12.12（DNSPod IP-DoH 上游，#57）
  '119.29.29.29',
  '119.28.28.28',
  '114.114.114.114',
];

/**
 * TUN 模式下 FlowZ 强制接管的「受控系统 DNS IP」。on-link 的 LAN/ISP DNS 不进 TUN → hijack-dns 看不到，
 * 故 TUN 启动时把系统 DNS 改为此 IP，使其经 TUN 默认路由被 hijack（真进 sing-box → FakeIP/远程解析）。
 * 选择三要求：① 非 on-link（经 TUN 默认路由）② 不在 BOOTSTRAP_DIRECT_DNS_IPS（否则被直连规则放行、逃逸 hijack）
 * ③ 真实可路由（崩溃未还原也降级为真 DNS、不断网）。8.8.8.8 三者皆满足；223.5.5.5 因②不可用。
 * 单测护栏断言此 IP 不在 BOOTSTRAP_DIRECT_DNS_IPS。
 */
export const CONTROLLED_TUN_DNS_IP = '8.8.8.8';

/** 某 IP 是否在 bootstrap-direct 直连放行列表（受控 DNS IP 选择守卫 / 单测护栏用）。 */
export function isBootstrapDirectDnsIp(ip: string): boolean {
  return BOOTSTRAP_DIRECT_DNS_IPS.includes(ip.trim());
}

/**
 * 用户自定义 DNS 地址解析（供主进程生成 sing-box dns server + 渲染端校验共用）。
 * 支持 https:// (DoH) / tls:// (DoT) / udp:// / 裸 IP 字面量；裸域名（无 scheme）语义歧义，判非法。
 */
export interface ParsedDnsServer {
  type: 'https' | 'tls' | 'udp';
  /** 主机名或 IP（IPv6 去方括号） */
  server: string;
  port: number;
  /** 仅 https，默认 /dns-query */
  path?: string;
  /** server 是否为域名（决定 sing-box 是否需要 domain_resolver 引导解析） */
  isDomain: boolean;
}

// 严格 IPv4（每段 0-255），避免 999.1.1.1 等被误收
// 仅当两端**配对**方括号时脱（'[::1]' → '::1'）；单边畸形（'[::1' / '::1]'）原样返回，使下游 isIpv6Literal
// 据实拒之（残留单边括号含非 hex 字符 → 正则不过）。与 config-helpers.stripHostBrackets 同口径，杜绝两处分歧。
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isIpv4Literal(host: string): boolean {
  return isIpv4(host);
}

/**
 * 粗判 IPv6 字面量：去方括号后至少两个冒号（排除 "8.8.8.8:53" 这类带端口裸输入）。
 * 形态二选一：
 *  (1) 纯 hex+冒号（canonical：'::1' / '2001:db8::1'）；
 *  (2) IPv4-mapped/embedded 末段点分（'::ffff:1.2.3.4' / '::1.2.3.4'）——前缀仍是 hex+冒号，
 *      仅末段为严格 IPv4 点分四段。这样 R3-1 的 target()（含 '.' 仍按 ':' 判 IPv6）与本判定一致：
 *      builders 的 isIpv4Host||isIpv6Host 闸门接纳该地址 → hostToExcludeCidr 产 '<addr>/128'（合法 CIDR）、
 *      nodeDomains 当字面量排除，均正确；同时 isIpLiteral 据此正确把它当 IP（spoof 守卫拒、域名预解析跳过）。
 * 真 IPv4（无冒号）/真域名（无冒号或含非 hex 段且无 IPv4 末段）仍判 false。
 */
export function isIpv6Literal(host: string): boolean {
  const h = stripBrackets(host);
  if ((h.match(/:/g)?.length ?? 0) < 2) return false;
  // (1) canonical 纯 hex+冒号
  if (/^[0-9a-fA-F:]+$/.test(h)) return true;
  // (2) IPv4-mapped/embedded：'<hex+冒号前缀>:<点分 IPv4>'，前缀纯 hex+冒号、末段严格 IPv4
  const lastColon = h.lastIndexOf(':');
  const prefix = h.slice(0, lastColon + 1); // 含末尾冒号
  const lastSeg = h.slice(lastColon + 1);
  return /^[0-9a-fA-F:]+$/.test(prefix) && isIpv4(lastSeg);
}

/** 主机字符串是否 IP 字面量（v4 严格 + v6 去括号≥2 冒号）。节点域名预解析跳过判定亦复用，避免多处 v6 判定漂移。 */
export function isIpLiteral(host: string): boolean {
  return isIpv4Literal(host) || isIpv6Literal(host);
}

/**
 * 解析用户 DNS 地址字符串。无法识别（含裸域名、空串、非法）返回 null，调用方据此回退默认 + 提示。
 */
export function parseDnsServerSpec(spec: string | undefined | null): ParsedDnsServer | null {
  if (!spec) return null;
  const s = spec.trim();
  if (!s) return null;

  const fromUrl = (
    type: ParsedDnsServer['type'],
    defaultPort: number,
    withPath: boolean
  ): ParsedDnsServer | null => {
    try {
      const u = new URL(s);
      const host = stripBrackets(u.hostname);
      if (!host) return null;
      const port = u.port ? parseInt(u.port, 10) : defaultPort;
      if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
      const result: ParsedDnsServer = { type, server: host, port, isDomain: !isIpLiteral(host) };
      if (withPath) {
        result.path = u.pathname && u.pathname !== '/' ? u.pathname : '/dns-query';
      }
      return result;
    } catch {
      return null;
    }
  };

  if (s.startsWith('https://')) return fromUrl('https', 443, true);
  if (s.startsWith('tls://')) return fromUrl('tls', 853, false);
  if (s.startsWith('udp://')) return fromUrl('udp', 53, false);

  // 裸 IP 字面量（无 scheme、无端口）→ UDP:53；去 IPv6 方括号
  if (isIpv4Literal(s) || isIpv6Literal(s)) {
    return { type: 'udp', server: stripBrackets(s), port: 53, isDomain: false };
  }

  // 裸域名 / IP:port / 非法：无法判定或格式不完整，判非法（回退默认 + 提示）
  return null;
}
