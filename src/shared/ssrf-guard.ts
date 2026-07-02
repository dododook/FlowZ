/**
 * SSRF guard 纯逻辑（P1：从 SubscriptionService 抽出，便于独立单测覆盖 IPv6-mapped/CGNAT/link-local 绕过）。
 *
 * 零 Electron 依赖；`dns.lookup` 由调用方注入（assertHostAllowed 的 lookup 参数），便于测试与解耦。
 * `net.isIP` 为纯 stdlib 分类函数（无 I/O），仅 main 侧消费，安全。
 *
 * 与 `shared/system-dns.isPrivateIpv4`（仅判 RFC1918 三段选 LAN resolver）**语义正交**：
 * 本模块是 SSRF 防护，覆盖回环/link-local/CGNAT/IPv4-mapped 防绕过，故意更严，勿合并。
 */
import { isIP } from 'net';
import { FAKEIP_INET4_RANGE, FAKEIP_INET6_RANGE } from './fakeip-filter';
import { cidrOverlapsAny } from './ip';

/**
 * 单个字面 IP 是否属内网/回环/link-local/CGNAT 等不可达外网的危险段。
 * 覆盖 IPv4：0/8、127/8、10/8、172.16/12、192.168/16、169.254/16(含云元数据 169.254.169.254)、100.64/10(CGNAT)；
 * IPv6：::1、::、fc00::/7(ULA)、fe80::/10(link-local，含 fe80–febf)、以及 IPv4-mapped(::ffff:x.x.x.x，
 *   点分/hex、压缩/展开各种写法统一规范化后取低 32 位递归判 IPv4)。
 * 仅接受 net.isIP 认定的字面 IP；非 IP 返回 false（调用方对域名先做 DNS 解析再逐 IP 套用本判定）。
 */
export function isPrivateIp(ip: string): boolean {
  const h = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const kind = isIP(h);
  if (kind === 4) {
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return true; // 形似但 isIP 已认定为 4，保守拒
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a === 0 || a === 127) return true; // 通配 / 本机回环
    if (a === 10) return true; // 私网
    if (a === 192 && b === 168) return true; // 私网
    if (a === 172 && b >= 16 && b <= 31) return true; // 私网
    if (a === 169 && b === 254) return true; // link-local / 云元数据 169.254.169.254
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (kind === 6) {
    if (h === '::1' || h === '::') return true; // 回环 / 通配
    // 规范化展开成 8 段 16-bit 数值（处理 :: 压缩、点分内嵌 IPv4）。isIP 已确认合法。
    const seg = expandIpv6(h);
    if (seg) {
      // IPv4-mapped（::ffff:x.x.x.x）：前 5 段 0、第 6 段 ffff → 取低 32 位拼回 IPv4 递归判定。
      // 覆盖点分/hex、压缩/展开全部写法（如 ::ffff:7f00:1 / 0:0:0:0:0:ffff:127.0.0.1），防绕过。
      if (
        seg[0] === 0 &&
        seg[1] === 0 &&
        seg[2] === 0 &&
        seg[3] === 0 &&
        seg[4] === 0 &&
        seg[5] === 0xffff
      ) {
        const a = seg[6] >> 8;
        const b = seg[6] & 0xff;
        const c = seg[7] >> 8;
        const d = seg[7] & 0xff;
        return isPrivateIp(`${a}.${b}.${c}.${d}`);
      }
      // fe80::/10（link-local）：首段 16-bit 高 10 位为 1111111010，即 0xfe80–0xfebf（含 fe90/fea0/feb0）。
      if (seg[0] >= 0xfe80 && seg[0] <= 0xfebf) return true;
    }
    // fc00::/7（ULA）：首字节 fc/fd。这里是已确认的字面 IPv6，不会误伤主机名
    // （主机名先经 DNS 解析成数值 IP 再进本判定）。
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    return false;
  }
  return false; // 非字面 IP
}

/**
 * 是否 FlowZ FakeIP 假地址（FAKEIP_INET4_RANGE=198.18.0.0/15 / FAKEIP_INET6_RANGE=2001:2::/48）。
 * TUN+FakeIP 下系统 DNS 解析公网订阅域名会返回假 IP；它不是真内网——核连接时按域名反查真实解析。
 * **由 fakeip-filter 常量派生（单一真值）**：裸 IP 视为 /32(v4)·/128(v6) 与假段做家族感知交集，改 FAKEIP_INET*_RANGE
 * 本判定自动跟随、不漂移（旧版手抄 0x2001/0x0db8 是双真值——改回私网段忘同步即静默撞墙）。
 * 现两段均在私网空间外、isPrivateIp 本就不拦 → SSRF 豁免对其为冗余兜底；保留是为「未来改回私网假段」时让豁免真实生效
 * （那时 isFlowzFakeIp 经常量自动认出该段、exemptFakeIp 正确放行经代理订阅，避免旧 fc00::/18 被 fc00::/7 误拒的撞墙复发）。
 */
export function isFlowzFakeIp(ip: string): boolean {
  const h = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (!isIP(h)) return false; // 仅字面 IP（CIDR/主机名 → false）
  // 裸 IP → /32·/128 主机与假段家族感知交集；跨族恒不相交由 cidrsOverlap 保证
  return cidrOverlapsAny(h, [FAKEIP_INET4_RANGE, FAKEIP_INET6_RANGE]);
}

/**
 * 把一个 isIP 已认定合法的 IPv6 字符串规范化展开成 8 个 16-bit 段数值。
 * 处理 `::` 压缩与末尾内嵌点分 IPv4（如 ::ffff:127.0.0.1）。非法/解析失败返回 null。
 */
function expandIpv6(h: string): number[] | null {
  // 末尾内嵌点分 IPv4 → 转成两段 16-bit hex，统一按纯 hex 处理。
  let s = h;
  const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = [v4[1], v4[2], v4[3], v4[4]].map((x) => parseInt(x, 10));
    if (o.some((n) => n > 255)) return null;
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    s = s.slice(0, s.length - v4[0].length) + hi + ':' + lo;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 ? (parts[1] ? parts[1].split(':') : []) : null;
  let segs: string[];
  if (tail === null) {
    segs = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    segs = [...head, ...Array(fill).fill('0'), ...tail];
  }
  if (segs.length !== 8) return null;
  const out = segs.map((x) => parseInt(x || '0', 16));
  if (out.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return out;
}

/** 注入的 DNS 解析（all:true）。由 main 侧传 `(h) => dnsPromises.lookup(h, { all: true })`。 */
export type DnsLookupAll = (host: string) => Promise<Array<{ address: string }>>;

/**
 * H1（DNS rebinding）核心：对订阅/Provider URL 的 hostname 做 SSRF guard。
 * - 限 http(s)（调用方保证）；字面 localhost 直接拒。
 * - hostname 是字面 IP → 直接套 isPrivateIp。
 * - hostname 是域名 → lookup(all) 解析后逐 IP 套 isPrivateIp，任一命中内网即拒
 *   （拦「域名解析到 127.0.0.1 / 169.254.169.254 / 10.x」的 rebinding 绕过）。
 * 命中即 throw（错误只含 hostname，不回显完整 url，防 token 泄露）。
 *
 * 残余风险（TOCTOU rebinding）：guard 校验「此刻」解析结果；Electron net.fetch 不暴露
 * pin-IP 钩子，fetch 内部会再次解析，理论上存在两次 lookup 间被改写的窗口。本取舍优先拒绝内网解析结果。
 */
export async function assertHostAllowed(
  urlObj: URL,
  lookup: DnsLookupAll,
  // 仅「经代理（proxied socks session）」时豁免 FlowZ FakeIP：经代理出口是远程节点、本机内网不可达，系统 DNS
  // 把公网域名解析成 FakeIP（核分配、连接时按域名反查真实）可安全豁免；直连/字面 IP 不豁免（防本机内网 SSRF）。
  exemptFakeIp = false
): Promise<void> {
  const host = urlObj.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost') {
    throw new Error(`订阅地址指向本机/内网/link-local，已拒绝: ${urlObj.hostname}`);
  }
  if (isIP(host)) {
    // 字面 IP 无「域名反查真实」语义——字面 FakeIP 也按内网拒（不豁免），防 https://[fc00::57] 直连内网绕过。
    if (isPrivateIp(host)) {
      throw new Error(`订阅地址指向本机/内网/link-local，已拒绝: ${urlObj.hostname}`);
    }
    return;
  }
  // 域名：解析后逐 IP 判定（DNS rebinding 防护）。
  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(host);
  } catch (e: any) {
    throw new Error(
      `订阅地址解析失败，已拒绝: ${urlObj.hostname}（${e?.code ?? e?.message ?? e}）`
    );
  }
  if (resolved.length === 0) {
    throw new Error(`订阅地址无法解析到任何 IP，已拒绝: ${urlObj.hostname}`);
  }
  for (const r of resolved) {
    // 仅经代理时豁免 FakeIP（核按域名 socks5h 重解析真实，本机内网不可达）；直连不豁免（域名真实解析内网仍须拦）。
    if (exemptFakeIp && isFlowzFakeIp(r.address)) continue;
    if (isPrivateIp(r.address)) {
      throw new Error(
        `订阅地址解析到本机/内网/link-local，已拒绝: ${urlObj.hostname} → ${r.address}`
      );
    }
  }
}
