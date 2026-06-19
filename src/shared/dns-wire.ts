/**
 * 极小 DNS wire（application/dns-message, RFC 1035）编解码 —— 纯函数、无 I/O、可逐字节单测。
 *
 * 用途（#57 resolve-ahead）：FlowZ 主进程在生成 sing-box 配置前，用 DoH（POST application/dns-message）
 * 把节点服务器域名并发解析为 IP。选 wire 而非各家 JSON API：universal、与现有 dns-bootstrap 同协议、
 * 易固定包字节断言。仅需 A（IPv4）记录——v1 不解析 AAAA（与关 IPv6 时 ipv4_only 一致）。
 *
 * 解码绝不抛：非法 / 截断 / RCODE!=0 / 无 A → 返回 []，由调用方回退（域名 / 系统 DNS / 不进 map）。
 */

const TYPE_A = 0x0001;
const CLASS_IN = 0x0001;

/**
 * 组装 A 记录查询包：固定 header（RD=1，QDCOUNT=1）+ QNAME + QTYPE=A + QCLASS=IN。
 * id 默认 0（DoH 经 HTTPS 单请求单响应，无需用 id 复用匹配）；可显式传 id 便于固定字节单测。
 */
export function encodeDnsQuery(domain: string, id = 0): Uint8Array {
  const labels = domain.replace(/\.$/, '').split('.');
  const enc = new TextEncoder();
  const labelBytes = labels.map((l) => {
    const b = enc.encode(l);
    if (b.length === 0 || b.length > 63) {
      throw new Error(`invalid DNS label length: "${l}"`);
    }
    return b;
  });

  // header(12) + Σ(1+label) + 1(root) + QTYPE(2) + QCLASS(2)
  const qnameLen = labelBytes.reduce((n, b) => n + 1 + b.length, 0) + 1;
  const buf = new Uint8Array(12 + qnameLen + 4);
  const view = new DataView(buf.buffer);

  view.setUint16(0, id & 0xffff); // ID
  view.setUint16(2, 0x0100); // flags: QR=0 Opcode=0 RD=1
  view.setUint16(4, 1); // QDCOUNT
  view.setUint16(6, 0); // ANCOUNT
  view.setUint16(8, 0); // NSCOUNT
  view.setUint16(10, 0); // ARCOUNT

  let off = 12;
  for (const b of labelBytes) {
    buf[off++] = b.length;
    buf.set(b, off);
    off += b.length;
  }
  buf[off++] = 0; // root label
  view.setUint16(off, TYPE_A);
  view.setUint16(off + 2, CLASS_IN);
  return buf;
}

/** 越界即抛（顶层 catch 兜成 []）；处理 QNAME / NAME 的标签序列与压缩指针（0xC0）。 */
function skipName(buf: Uint8Array, offset: number): number {
  let off = offset;
  // 循环上限 = buf 长度，杜绝构造畸形包导致死循环（无 root、自指指针等）。
  for (let guard = 0; guard <= buf.length; guard++) {
    if (off >= buf.length) throw new RangeError('name out of bounds');
    const len = buf[off];
    if (len === 0) return off + 1; // root，名字结束
    if ((len & 0xc0) === 0xc0) return off + 2; // 压缩指针占 2 字节，名字到此结束
    off += 1 + len;
  }
  throw new RangeError('malformed name');
}

/**
 * 从 DNS 响应抽出全部 A 记录 IPv4（点分十进制）。任何异常/截断/RCODE!=0/无 A → []。
 * 不做去重/排序，按报文出现顺序返回（调用方取首个）。
 */
export function decodeDnsAnswers(resp: Uint8Array): string[] {
  try {
    if (resp.length < 12) return [];
    const view = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
    const flags = view.getUint16(2);
    if ((flags & 0x000f) !== 0) return []; // RCODE != 0（SERVFAIL/NXDOMAIN/…）→ 无可用答案
    const qd = view.getUint16(4);
    const an = view.getUint16(6);

    let off = 12;
    // 跳过 question 段：每条 = QNAME + QTYPE(2) + QCLASS(2)
    for (let i = 0; i < qd; i++) {
      off = skipName(resp, off);
      off += 4;
    }

    const ips: string[] = [];
    for (let i = 0; i < an; i++) {
      off = skipName(resp, off);
      if (off + 10 > resp.length) throw new RangeError('answer header out of bounds');
      const type = view.getUint16(off);
      const klass = view.getUint16(off + 2);
      const rdlength = view.getUint16(off + 8);
      const rdata = off + 10;
      if (rdata + rdlength > resp.length) throw new RangeError('rdata out of bounds');
      if (type === TYPE_A && klass === CLASS_IN && rdlength === 4) {
        ips.push(`${resp[rdata]}.${resp[rdata + 1]}.${resp[rdata + 2]}.${resp[rdata + 3]}`);
      }
      off = rdata + rdlength;
    }
    return ips;
  } catch {
    return [];
  }
}
