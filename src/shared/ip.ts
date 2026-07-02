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
 * outer 是否（按前缀）**包含** inner（v4/v6 家族感知；跨族/非法恒 false）。区别于 cidrsOverlap 的双向相交：
 * 仅当 inner ⊆ outer 才 true。供「某片段是否属于某原始条目的自有残余」等需方向性的判定（v4Contains/v6Contains 内部复用）。
 */
export function cidrContains(outer: string, inner: string): boolean {
  const o4 = parseIpv4Cidr(outer);
  const i4 = parseIpv4Cidr(inner);
  if (o4 && i4) return v4Contains(o4, i4);
  const o6 = parseIpv6Cidr(outer);
  const i6 = parseIpv6Cidr(inner);
  if (o6 && i6) return v6Contains(o6, i6);
  return false;
}

/**
 * 把 cidrs 按"与 ranges 任一相交"分两组（v4+v6）。FakeIP 护栏用：剔除会吃掉假 IP 段（198.18.0.0/15 ·
 * 2001:db8::/32）的旁路/私网直连条目，防假 IP 被当私网直连、绕过 fakeip 反查致服务端收不到域名（v6 撞墙根因）。
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

// ---- CIDR 差集（carve）：从宽段中"挖掉"更窄的子段，返回覆盖补集的最小前缀集 ----
// 用途：Windows bypassLAN 内核排除表须为 engaged 组网(WG/Tailscale) force-route 段"开洞"（让该段进 TUN 走
// 组网），但**不能整条剔除宽段**——整剔 192.168/16 会连本机网关子网一起脱离排除 → 触发 Windows WinTun
// DHCP/网关查询死循环。故用算术差集只挖掉 mesh 段、保留其余（含网关子网）仍被排除。CIDR 天然层级（两段
// 要么无交、要么一含另一），据此递归二分。

/** outer 是否（按前缀）包含 inner（v4；网络地址均已规范化）。 */
function v4Contains(outer: [number, number], inner: [number, number]): boolean {
  if (outer[1] > inner[1]) return false;
  const mask = outer[1] === 0 ? 0 : (0xffffffff << (32 - outer[1])) >>> 0;
  return (inner[0] & mask) >>> 0 === outer[0];
}
/** base ∖ carve（v4）：carve 无交→[base]；carve 覆盖 base→[]；carve 严格更窄→二分 base、含 carve 半递归、另一半整留。 */
function excludeV4(base: [number, number], carve: [number, number]): Array<[number, number]> {
  if (!v4Contains(base, carve)) return v4Contains(carve, base) ? [] : [base];
  if (base[1] === carve[1]) return []; // 等价（carve==base）
  const childPfx = base[1] + 1;
  const blockSize = 2 ** (32 - childPfx);
  const left: [number, number] = [base[0], childPfx];
  const right: [number, number] = [(base[0] + blockSize) >>> 0, childPfx];
  return [...excludeV4(left, carve), ...excludeV4(right, carve)];
}
function fmtV4(net: number, prefix: number): string {
  return `${(net >>> 24) & 255}.${(net >>> 16) & 255}.${(net >>> 8) & 255}.${net & 255}/${prefix}`;
}

/** outer 是否（按前缀）包含 inner（v6）。 */
function v6Contains(outer: [bigint, number], inner: [bigint, number]): boolean {
  if (outer[1] > inner[1]) return false;
  const mask = outer[1] === 0 ? 0n : V6_FULL ^ ((1n << BigInt(128 - outer[1])) - 1n);
  return (inner[0] & mask) === outer[0];
}
/** base ∖ carve（v6）：同 excludeV4 语义。 */
function excludeV6(base: [bigint, number], carve: [bigint, number]): Array<[bigint, number]> {
  if (!v6Contains(base, carve)) return v6Contains(carve, base) ? [] : [base];
  if (base[1] === carve[1]) return [];
  const childPfx = base[1] + 1;
  const blockSize = 1n << BigInt(128 - childPfx);
  const left: [bigint, number] = [base[0], childPfx];
  const right: [bigint, number] = [base[0] + blockSize, childPfx];
  return [...excludeV6(left, carve), ...excludeV6(right, carve)];
}
function fmtV6(net: bigint, prefix: number): string {
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((net >> BigInt(i * 16)) & 0xffffn).toString(16));
  // 压缩最长的连续 0 段为 ::（至少 2 组才压缩，符合 RFC5952）。
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === '0') {
      curStart = curStart < 0 ? i : curStart;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  const addr =
    bestLen < 2
      ? groups.join(':')
      : `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLen).join(':')}`;
  return `${addr}/${prefix}`;
}

/**
 * CIDR 差集（家族感知）：返回覆盖 (∪base) ∖ (∪carve) 的 CIDR 列表。v4 carve 只作用于 v4 base、v6 只作用于 v6。
 * base 中无法解析为 v4/v6 CIDR 的条目**原样保留**（不被任何 carve 影响）；无法解析的 carve 条目忽略。
 * 输出为规范化 CIDR（网络地址 + 前缀）。供 Windows bypassLAN 排除表对 engaged mesh 段开洞（保网关子网仍排除）。
 */
export function subtractCidrs(base: string[], carve: string[]): string[] {
  const carveV4: Array<[number, number]> = [];
  const carveV6: Array<[bigint, number]> = [];
  for (const c of carve) {
    const p4 = parseIpv4Cidr(c);
    if (p4) {
      carveV4.push(p4);
      continue;
    }
    const p6 = parseIpv6Cidr(c);
    if (p6) carveV6.push(p6);
  }
  const out: string[] = [];
  for (const b of base) {
    const b4 = parseIpv4Cidr(b);
    if (b4) {
      let pieces: Array<[number, number]> = [b4];
      for (const cv of carveV4) {
        pieces = pieces.flatMap((p) => excludeV4(p, cv));
        if (pieces.length === 0) break;
      }
      for (const [net, pfx] of pieces) out.push(fmtV4(net, pfx));
      continue;
    }
    const b6 = parseIpv6Cidr(b);
    if (b6) {
      let pieces: Array<[bigint, number]> = [b6];
      for (const cv of carveV6) {
        pieces = pieces.flatMap((p) => excludeV6(p, cv));
        if (pieces.length === 0) break;
      }
      for (const [net, pfx] of pieces) out.push(fmtV6(net, pfx));
      continue;
    }
    out.push(b); // 无法解析（域名等）→ 原样保留
  }
  return out;
}
