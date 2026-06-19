/**
 * IPv4 字面量判定（严格：每段 0-255）。
 *
 * 收敛 dns.ts 与 ProxyManager 的 host 分类为单一真值，杜绝「同 host 在 DNS 分类 vs route 生成
 * 判定不一致」——原 ProxyManager.isIpv4Host 用宽松正则 `[0-9]{1,3}`，会把 999.1.1.1 误判为 IPv4，
 * 与 dns.ts 的严格判定冲突。合法 IP(≤255)两者一致，仅非法>255 段输入分类被纠正。
 *
 * 刻意不收纳（语义各异、各自单一消费者，按「适度独立优于错误抽象」保留原处）：
 * - rules.isStrictIpv4：sing-box netip 校验（禁前导零，更严）
 * - system-dns.isPrivateIpv4：私网 range 判定（非形状）
 * - system-proxy-bypass.isIpv4Cidr：CIDR 形状
 * - ssrf-guard.isPrivateIp：SSRF 防护（含回环/link-local/IPv4-mapped）
 */
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** 主机字符串是否为严格 IPv4 字面量（每段 0-255）。 */
export function isIpv4(host: string): boolean {
  return IPV4_RE.test(host);
}

/** IPv4 CIDR "a.b.c.d[/n]" → [网络地址(uint32), 前缀]；非法/IPv6 → null。无 /n 视为 /32。 */
function parseIpv4Cidr(cidr: string): [number, number] | null {
  const [ipPart, prefixPart] = cidr.trim().split('/');
  const prefix = prefixPart === undefined ? 32 : Number(prefixPart);
  if (!isIpv4(ipPart) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const o = ipPart.split('.').map(Number);
  const ipInt = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [(ipInt & mask) >>> 0, prefix];
}

/** 两个 IPv4 CIDR 是否有交集（按较短前缀比对网络地址）。任一非 IPv4 CIDR → false。 */
export function ipv4CidrsOverlap(a: string, b: string): boolean {
  const pa = parseIpv4Cidr(a);
  const pb = parseIpv4Cidr(b);
  if (!pa || !pb) return false;
  const minPrefix = Math.min(pa[1], pb[1]);
  if (minPrefix === 0) return true; // 0.0.0.0/0 覆盖一切
  const mask = (0xffffffff << (32 - minPrefix)) >>> 0;
  const na = (pa[0] & mask) >>> 0;
  const nb = (pb[0] & mask) >>> 0;
  return na === nb;
}

/** IPv6 字面量（含 :: 压缩）→ 128-bit BigInt；非法 → null。 */
function ipv6ToBigInt(addr: string): bigint | null {
  const a = addr.trim();
  if (!a.includes(':') || !/^[0-9a-fA-F:]+$/.test(a)) return null;
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null; // 无 :: 必须满 8 组
  const fill = 8 - head.length - tail.length;
  if (fill < (halves.length === 2 ? 1 : 0)) return null; // :: 至少省 1 组
  const groups = [...head, ...new Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) {
    if (g.length === 0 || g.length > 4) return null;
    const n = parseInt(g, 16);
    if (Number.isNaN(n)) return null;
    v = (v << 16n) | BigInt(n);
  }
  return v;
}

const V6_FULL = (1n << 128n) - 1n;
/** IPv6 CIDR "addr/n" → [网络地址(BigInt), 前缀]；非法/IPv4 → null。无 /n 视为 /128。 */
function parseIpv6Cidr(cidr: string): [bigint, number] | null {
  const [ipPart, prefixPart] = cidr.trim().split('/');
  const prefix = prefixPart === undefined ? 128 : Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
  const v = ipv6ToBigInt(ipPart);
  if (v === null) return null;
  const mask = prefix === 0 ? 0n : V6_FULL ^ ((1n << BigInt(128 - prefix)) - 1n);
  return [v & mask, prefix];
}

/** 两个 IPv6 CIDR 是否有交集（按较短前缀比对网络地址）。任一非 IPv6 CIDR → false。 */
export function ipv6CidrsOverlap(a: string, b: string): boolean {
  const pa = parseIpv6Cidr(a);
  const pb = parseIpv6Cidr(b);
  if (!pa || !pb) return false;
  const minPrefix = Math.min(pa[1], pb[1]);
  if (minPrefix === 0) return true;
  const mask = V6_FULL ^ ((1n << BigInt(128 - minPrefix)) - 1n);
  return (pa[0] & mask) === (pb[0] & mask);
}

/** 两个 CIDR 是否相交（按地址族自动分派 v4/v6；跨族恒不相交）。 */
export function cidrsOverlap(a: string, b: string): boolean {
  return ipv4CidrsOverlap(a, b) || ipv6CidrsOverlap(a, b);
}

/**
 * target CIDR 是否与候选集任一 CIDR 有交集（v4+v6 家族感知）。供路由规则与组网(WG/Tailscale)force-route
 * 段的重叠提醒、FakeIP 段护栏共用（main 的 config-gen warn + renderer 的内联 hint/列表角标）。
 */
export function cidrOverlapsAny(target: string, candidates: string[]): boolean {
  return candidates.some((c) => cidrsOverlap(target, c));
}

/**
 * 把 cidrs 按"与 ranges 任一相交"分两组（v4+v6）。FakeIP 护栏用：剔除会吃掉假 IP 段（198.18.0.0/15 ·
 * fc00::/18）的旁路/私网直连条目，防假 IP 被当私网直连、绕过 fakeip 反查致服务端收不到域名（v6 撞墙根因）。
 */
export function partitionCidrsByOverlap(
  cidrs: string[],
  ranges: string[]
): { overlapping: string[]; disjoint: string[] } {
  const overlapping: string[] = [];
  const disjoint: string[] = [];
  for (const c of cidrs) {
    if (ranges.length > 0 && cidrOverlapsAny(c, ranges)) overlapping.push(c);
    else disjoint.push(c);
  }
  return { overlapping, disjoint };
}
