/**
 * sing-box route 在 hijack-dns 之前「直连放行」的国内 bootstrap DNS IP（:53/:443）。单一真值：
 *   - generateRouteConfig 的引导直连规则（C 段）引用，保证核心 DNS 自举不被 hijack 成 FakeIP；
 *   - SystemDnsManager 受控 DNS IP 的选择守卫引用——受控 IP 绝不能落在此列表，否则其 :53 查询被该
 *     直连规则放行、逃逸 hijack-dns，DNS 接管失效（见 docs/design/dns-ipv6-takeover.md）。
 * 含 1.12.12.12（#57 DNSPod IP-DoH 档，与 223.5.5.5 同列直连）。
 */
export const BOOTSTRAP_DIRECT_DNS_IPS: readonly string[] = [
  '223.5.5.5',
  '223.6.6.6',
  '1.12.12.12',
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
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

function stripBrackets(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '');
}

function isIpv4Literal(host: string): boolean {
  return IPV4_RE.test(host);
}

/** 粗判 IPv6 字面量：去方括号后仅含 hex 与冒号，且至少两个冒号（排除 "8.8.8.8:53" 这类带端口裸输入）。 */
function isIpv6Literal(host: string): boolean {
  const h = stripBrackets(host);
  return /^[0-9a-fA-F:]+$/.test(h) && (h.match(/:/g)?.length ?? 0) >= 2;
}

function isIpLiteral(host: string): boolean {
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
