/**
 * GFW DNS 投毒 decoy IP 集（R3 防御层，§14.4）—— GFW 对被墙域名注入的伪造应答指向**有限已知 IP 段**
 * （Facebook/Twitter/Dropbox + 历史单点）。node-dns-race 命中这些 IP 的应答判 POISONED、弃之不抢跑
 * （first-clean-wins），令干净上游胜出。纯字节匹配、零 I/O、可逐字节单测。
 *
 * 来源：GFWatch（USENIX Security '21 "How Great is the Great Firewall?"，https://gfwatch.org）+ 社区维护清单
 * + 本机实测样本（§14.1-B：31.13.95.169 / 185.45.7.x / 45.114.11.25 / 157.240.17.35 / 202.160.128.16 / 2a03:2880::/29）。
 *
 * 定位：**防御网非权威**——漏一个 decoy 只是不过滤（R1 FakeIP 影子规则才是 P6/P7 治本）；命中即弃是 fail-safe。
 * 池会演化，随 geo 资源同节奏维护（R3 日志计数提供漂移信号，R27）。
 */

/** CIDR 前缀：bytes = 网络字节（v4=4 / v6=16），prefixLen = 前缀位数。 */
interface DecoyCidr {
  bytes: Uint8Array;
  prefixLen: number;
}

function parseV4(cidr: string): DecoyCidr {
  const [ip, len] = cidr.split('/');
  return {
    bytes: Uint8Array.from(ip.split('.').map((n) => parseInt(n, 10) & 0xff)),
    prefixLen: parseInt(len, 10),
  };
}

/** 展开 :: 到 16 字节。仅解析本文件内的固定字面量（无需覆盖全部 v6 边角格式）。 */
function parseV6(cidr: string): DecoyCidr {
  const [ip, len] = cidr.split('/');
  const bytes = new Uint8Array(16);
  const [head, tail] = ip.split('::');
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const tailGroups = tail !== undefined ? tail.split(':').filter(Boolean) : [];
  const fill = 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array(Math.max(0, fill)).fill('0'), ...tailGroups];
  for (let i = 0; i < 8; i++) {
    const v = parseInt(groups[i] || '0', 16) & 0xffff;
    bytes[i * 2] = (v >> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return { bytes, prefixLen: parseInt(len, 10) };
}

// Facebook（含 face:b00c v6）/ Twitter / Dropbox 段 + 历史单点 + 本机实测样本。
const V4_DECOY_CIDRS: readonly DecoyCidr[] = [
  '31.13.0.0/16',
  '66.220.0.0/16',
  '69.63.0.0/16',
  '69.171.0.0/16',
  '157.240.0.0/16',
  '173.252.0.0/16',
  '179.60.192.0/22',
  '185.60.216.0/22',
  '104.244.40.0/21', // Twitter
  '199.59.148.0/22', // Twitter
  '202.160.128.0/22', // 实测 202.160.128.16
  '162.125.0.0/16', // Dropbox
  '185.45.7.0/24', // 实测 chat.openai 185.45.7.x
  '45.114.11.0/24', // 实测 gemini 45.114.11.25
  '8.7.198.45/32', // 历史单点
  '46.82.174.68/32',
  '59.24.3.173/32',
  '93.46.8.89/32',
  '203.98.7.65/32',
].map(parseV4);

const V6_DECOY_CIDRS: readonly DecoyCidr[] = ['2a03:2880::/29'].map(parseV6); // Facebook（face:b00c）

function inCidr(ip: Uint8Array, cidr: DecoyCidr): boolean {
  if (ip.length !== cidr.bytes.length) return false;
  let bits = cidr.prefixLen;
  for (let i = 0; i < ip.length && bits > 0; i++) {
    const take = Math.min(8, bits);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((ip[i] & mask) !== (cidr.bytes[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

/** ip 原始网络字节（4=IPv4 / 16=IPv6）是否命中任一 GFW decoy 段。非 4/16 字节 → false（不误杀）。 */
export function isDecoyIp(ip: Uint8Array): boolean {
  const set = ip.length === 4 ? V4_DECOY_CIDRS : ip.length === 16 ? V6_DECOY_CIDRS : null;
  return set ? set.some((c) => inCidr(ip, c)) : false;
}
