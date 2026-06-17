/**
 * 系统代理 bypass（忽略代理列表）纯逻辑——默认清单 + 解析 + 按平台格式化。
 * 仅作用于**系统代理模式**（OS proxy 例外列表）；TUN 模式的直连由 sing-box route 规则负责。
 * 机制（保存原列表→开启写入→关闭还原）由 SystemProxyManager 负责，对齐 Clash 系。可单测、无 electron 依赖。
 */

/**
 * 默认 bypass 清单（业内聚合清单，含私网/保留段 + Apple 连通性 + 国内会被代理打断的 App/网银）。
 * 用户可在设置里编辑（逗号分隔）；缺省取此。注：非 ClashX 出厂 9 条原版，是社区聚合的「业内」广覆盖清单。
 */
export const DEFAULT_SYSTEM_PROXY_BYPASS: readonly string[] = [
  // 私网 / 保留 / 特殊用途网段
  '10.0.0.0/8',
  '100.64.0.0/10', // CGNAT / 运营商 NAT（亦 Tailscale tailnet 段）
  '127.0.0.0/8',
  '169.254.0.0/16', // link-local
  '172.16.0.0/12',
  '192.0.0.0/24', // IETF 协议分配
  '192.88.99.0/24', // 6to4 anycast（已废弃）
  '192.168.0.0/16',
  '224.0.0.0/4', // 组播
  '233.252.0.0/24', // MCAST-TEST-NET
  '240.0.0.0/4', // 保留
  'fc00::/7', // IPv6 ULA
  'fe80::/10', // IPv6 link-local
  // 本地 / mDNS
  'localhost',
  '*.local',
  // Apple 连通性 / captive / 端上服务（代理会打断）
  'sequoia.apple.com',
  'seed-sequoia.siri.apple.com',
  'captive.apple.com',
  'e.crashlytics.com',
  // 国内会被代理打断的连通性探测 / App / 网银（二进制协议 / cert-pin / 地域校验）
  'www.baidu.com',
  'passenger.t3go.cn',
  'yunbusiness.ccb.com',
  'wxh.wo.cn',
  'gate.lagou.com',
  'www.abchina.com.cn',
  'login-service.mobile-bank.psbc.com',
  'mobile-bank.psbc.com',
];

/** 解析用户输入（逗号/分号/换行分隔）→ 去空白去重的条目数组。 */
export function parseBypassList(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[,;\n\r]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

/** 取生效 bypass 清单：用户已设则用其（解析/去重后），否则默认清单。 */
export function effectiveBypassList(userList: string[] | undefined): string[] {
  if (userList && userList.length) {
    return Array.from(new Set(userList.map((s) => s.trim()).filter(Boolean)));
  }
  return [...DEFAULT_SYSTEM_PROXY_BYPASS];
}

/** 是否 IPv4 CIDR 字面量（用于 Windows 通配转换；v6/域名不在此列）。 */
export function isIpv4Cidr(s: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(s.trim());
}

/**
 * IPv4 CIDR → Windows ProxyOverride 通配模式（Windows 代理例外不支持 CIDR，仅前缀通配）。
 * 仅处理八位对齐前缀（/8→a.* /16→a.b.* /24→a.b.c.*）+ /12（172.16/12 等，枚举第二段 base..base+15）。
 * 其余前缀（/10 CGNAT、/4 组播/保留等）Windows 无法干净通配 → 返回 []（跳过；域名/精确项另行保留）。
 */
export function ipv4CidrToWindowsPatterns(cidr: string): string[] {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return [];
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((x) => x > 255)) return [];
  const prefix = Number(m[5]);
  if (prefix === 8) return [`${o[0]}.*`];
  if (prefix === 16) return [`${o[0]}.${o[1]}.*`];
  if (prefix === 24) return [`${o[0]}.${o[1]}.${o[2]}.*`];
  if (prefix === 12) {
    const base = o[1] & 0xf0; // /12 第二段对齐到 16 的倍数，覆盖 base..base+15
    const out: string[] = [];
    for (let i = base; i < base + 16 && i <= 255; i++) out.push(`${o[0]}.${i}.*`);
    return out;
  }
  return [];
}

/**
 * macOS networksetup -setproxybypassdomains 参数（接受 CIDR(v4/v6) + 域名 + *.通配，原样下发）。
 */
export function formatBypassForMac(list: string[]): string[] {
  return Array.from(new Set(list.map((s) => s.trim()).filter(Boolean)));
}

/**
 * Windows ProxyOverride 串（分号分隔）：IPv4 CIDR→通配、v6 CIDR 跳过（Win 例外不擅长 v6 通配）、
 * 域名/通配/精确项原样、补 `<local>`。真机待验（输出/匹配语义）。
 */
export function formatBypassForWindows(list: string[]): string {
  const out: string[] = [];
  for (const raw of list) {
    const t = raw.trim();
    if (!t) continue;
    if (isIpv4Cidr(t)) {
      out.push(...ipv4CidrToWindowsPatterns(t));
    } else if (t.includes(':') && t.includes('/')) {
      continue; // IPv6 CIDR：Windows 代理例外跳过
    } else {
      out.push(t); // 域名 / *.x / localhost / 纯 IP
    }
  }
  if (!out.includes('<local>')) out.push('<local>');
  return Array.from(new Set(out)).join(';');
}

/** Linux gsettings ignore-hosts 数组（接受 CIDR + 域名，原样去重）。 */
export function formatBypassForLinux(list: string[]): string[] {
  return Array.from(new Set(list.map((s) => s.trim()).filter(Boolean)));
}
