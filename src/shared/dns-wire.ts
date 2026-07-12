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
const TYPE_AAAA = 0x001c;
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

/**
 * 从 DNS 响应抽出全部 A(4 字节)/AAAA(16 字节) 记录的 rdata **原始网络字节**（供 R3 decoy 段匹配，§14.4）。
 * 任何异常/截断/RCODE!=0 → []。按报文出现顺序返回。
 */
export function extractAnswerIpBytes(resp: Uint8Array): Uint8Array[] {
  try {
    if (resp.length < 12) return [];
    const view = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
    if ((view.getUint16(2) & 0x000f) !== 0) return []; // RCODE != 0
    const qd = view.getUint16(4);
    const an = view.getUint16(6);
    let off = 12;
    for (let i = 0; i < qd; i++) {
      off = skipName(resp, off);
      off += 4;
    }
    const ips: Uint8Array[] = [];
    for (let i = 0; i < an; i++) {
      off = skipName(resp, off);
      if (off + 10 > resp.length) throw new RangeError('answer header out of bounds');
      const type = view.getUint16(off);
      const klass = view.getUint16(off + 2);
      const rdlength = view.getUint16(off + 8);
      const rdata = off + 10;
      if (rdata + rdlength > resp.length) throw new RangeError('rdata out of bounds');
      if (
        klass === CLASS_IN &&
        ((type === TYPE_A && rdlength === 4) || (type === TYPE_AAAA && rdlength === 16))
      ) {
        ips.push(resp.slice(rdata, rdata + rdlength));
      }
      off = rdata + rdlength;
    }
    return ips;
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────
// issue #147 多源 race 转发器辅助（三态分类 + question 解码 + id 回填 + SERVFAIL）。
// 纯函数、无 I/O、可逐字节单测。供本地 race DNS server 转发内核 query → 上游 → 回包。
// ──────────────────────────────────────────────────────────────────────────

const RCODE_NOERROR = 0;
const RCODE_SERVFAIL = 2;
const RCODE_NXDOMAIN = 3;

export interface DnsQuestion {
  id: number;
  qname: string;
  qtype: number;
  qclass: number;
}

/**
 * 解析 DNS query 首个 question：id（回填响应用）+ qname + qtype（三态分类用）+ qclass。
 * 畸形 / 无 question / 越界 → null（调用方按 FAIL/丢弃处理）。query 一般无压缩指针，遇到即防御性停止。
 */
export function decodeDnsQuestion(wire: Uint8Array): DnsQuestion | null {
  try {
    if (wire.length < 12) return null;
    const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
    const id = view.getUint16(0);
    if (view.getUint16(4) < 1) return null; // QDCOUNT < 1
    let off = 12;
    const labels: string[] = [];
    const dec = new TextDecoder();
    for (let guard = 0; guard <= wire.length; guard++) {
      if (off >= wire.length) return null;
      const len = wire[off];
      if (len === 0) {
        off += 1;
        break;
      }
      if ((len & 0xc0) === 0xc0) {
        off += 2;
        break;
      } // 压缩指针（query 罕见）：防御性停止 qname 解析
      off += 1;
      if (off + len > wire.length) return null;
      labels.push(dec.decode(wire.subarray(off, off + len)));
      off += len;
    }
    if (off + 4 > wire.length) return null;
    return {
      id,
      qname: labels.join('.'),
      qtype: view.getUint16(off),
      qclass: view.getUint16(off + 2),
    };
  } catch {
    return null;
  }
}

export type DnsResponseClass = 'HIT' | 'EMPTY' | 'FAIL';

/**
 * 三态分类（issue #147 §4）：
 *  - HIT  = NOERROR 且 answer 含请求 qtype 的记录（含 CNAME 链末端的目标记录）；
 *  - EMPTY= NOERROR 但无该 qtype 记录（NODATA），或 NXDOMAIN（域名不存在）——「正常空解析」；
 *  - FAIL = SERVFAIL/REFUSED 等非零非 NXDOMAIN RCODE / QR=0 非响应 / 畸形 / 截断——「上游故障」。
 * 供 race 聚合：HIT 抢跑、EMPTY 不抢跑（等所有上游 settle 才下空结论）、全 FAIL→SERVFAIL。
 */
export function classifyDnsResponse(resp: Uint8Array, qtype: number): DnsResponseClass {
  try {
    if (resp.length < 12) return 'FAIL';
    const view = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
    const flags = view.getUint16(2);
    if ((flags & 0x8000) === 0) return 'FAIL'; // QR=0：非响应
    if (flags & 0x0200) return 'FAIL'; // TC=1 截断（仅 UDP 上游可达）：当上游故障，不把部分 A 当权威转发，让他者/SERVFAIL 兜（review M）
    const rcode = flags & 0x000f;
    if (rcode === RCODE_NXDOMAIN) return 'EMPTY';
    if (rcode !== RCODE_NOERROR) return 'FAIL'; // SERVFAIL/REFUSED/…
    const qd = view.getUint16(4);
    const an = view.getUint16(6);
    let off = 12;
    for (let i = 0; i < qd; i++) {
      off = skipName(resp, off);
      off += 4;
    }
    for (let i = 0; i < an; i++) {
      off = skipName(resp, off);
      if (off + 10 > resp.length) return 'FAIL';
      const type = view.getUint16(off);
      const klass = view.getUint16(off + 2);
      const rdlength = view.getUint16(off + 8);
      if (type === qtype && klass === CLASS_IN) return 'HIT'; // class=IN，与 decodeDnsAnswers 同口径（review L）
      off = off + 10 + rdlength;
      if (off > resp.length) return 'FAIL';
    }
    return 'EMPTY'; // NOERROR 无该 qtype 记录（NODATA）
  } catch {
    return 'FAIL';
  }
}

/** 回填 DNS message id（响应 id 必须 == query id，否则内核丢弃）。返回副本，不 mutate 入参。 */
export function setDnsMessageId(wire: Uint8Array, id: number): Uint8Array {
  const out = wire.slice();
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint16(0, id & 0xffff);
  return out;
}

/**
 * 构造 SERVFAIL 响应（全上游 FAIL 时回内核，区别于「域名无记录」的 EMPTY）。
 * 截到首 question 末（丢弃 query 的 OPT/additional），置 QR=1 RA=1 RCODE=2、清 AN/NS/AR。
 */
export function buildServfail(query: Uint8Array): Uint8Array {
  let end = 12;
  try {
    end = skipName(query, 12) + 4; // qname + qtype(2) + qclass(2)
  } catch {
    end = Math.min(query.length, 12);
  }
  if (end > query.length) end = query.length;
  // 固定 ≥12 字节 header（畸形/截断 query 不足时补 0），防 DataView getUint16 越界。
  const want = Math.max(12, end);
  const out = new Uint8Array(want);
  out.set(query.slice(0, Math.min(query.length, want)));
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const reqFlags = view.getUint16(2);
  // QR=1 | Opcode(保留=0) | RD(echo from query) | RA=1 | RCODE=SERVFAIL
  view.setUint16(2, 0x8000 | (reqFlags & 0x0100) | 0x0080 | RCODE_SERVFAIL);
  view.setUint16(4, end >= 16 ? 1 : 0); // QDCOUNT：截到 question 则 1，畸形兜底 0
  view.setUint16(6, 0); // ANCOUNT
  view.setUint16(8, 0); // NSCOUNT
  view.setUint16(10, 0); // ARCOUNT
  return out;
}

/**
 * 构造 NOERROR 响应（system/本地解析得到的 IP → wire）：echo question + A/AAAA answers
 * （name 用压缩指针 0xC00C 指向 question 的 qname）。空 answers → NODATA（EMPTY）。畸形 query → SERVFAIL。
 * 仅 race server 的 system 上游用（DoH/UDP 上游直接透传上游原始响应，不经此）。
 */
export function buildAnswerResponse(
  query: Uint8Array,
  answers: { type: number; rdata: Uint8Array }[]
): Uint8Array {
  let qEnd: number;
  try {
    qEnd = skipName(query, 12) + 4; // qname + qtype(2) + qclass(2)
  } catch {
    return buildServfail(query);
  }
  if (qEnd > query.length || query.length < 12) return buildServfail(query);
  const head = query.slice(0, qEnd);
  const parts: number[] = [];
  for (const a of answers) {
    parts.push(0xc0, 0x0c); // name: 指向 offset 12（question qname）
    parts.push((a.type >> 8) & 0xff, a.type & 0xff); // type
    parts.push(0x00, 0x01); // class IN
    parts.push(0x00, 0x00, 0x00, 0x3c); // ttl 60
    parts.push((a.rdata.length >> 8) & 0xff, a.rdata.length & 0xff); // rdlength
    for (const b of a.rdata) parts.push(b);
  }
  const out = new Uint8Array(head.length + parts.length);
  out.set(head, 0);
  out.set(Uint8Array.from(parts), head.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const reqFlags = view.getUint16(2);
  view.setUint16(2, 0x8000 | (reqFlags & 0x0100) | 0x0080); // QR=1 RD(echo) RA=1 RCODE=0
  view.setUint16(6, answers.length); // ANCOUNT
  view.setUint16(8, 0);
  view.setUint16(10, 0);
  return out;
}
