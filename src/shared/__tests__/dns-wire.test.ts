import { encodeDnsQuery, decodeDnsAnswers } from '../dns-wire';

/** 取查询包（含 header+question），翻成响应：flags→0x8180|rcode、ANCOUNT、追加 answer 记录。 */
function makeResponse(
  query: Uint8Array,
  answerRecords: number[][],
  opts: { rcode?: number; ancount?: number } = {}
): Uint8Array {
  const head = Array.from(query);
  head[2] = 0x81;
  head[3] = 0x80 | ((opts.rcode ?? 0) & 0x0f); // QR=1 RD=1 RA=1 + RCODE
  const an = opts.ancount ?? answerRecords.length;
  head[6] = (an >> 8) & 0xff;
  head[7] = an & 0xff;
  return new Uint8Array([...head, ...answerRecords.flat()]);
}

/** A 记录：NAME=指向 question 名的压缩指针(0xC00C) + TYPE=A + CLASS=IN + TTL + RDLENGTH=4 + IPv4。 */
function aRecord(ip: string): number[] {
  const octets = ip.split('.').map((n) => parseInt(n, 10));
  return [0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x01, 0x2c, 0x00, 0x04, ...octets];
}

/** AAAA 记录（type 28, rdlength 16）——应被 A 抽取忽略。 */
function aaaaRecord(): number[] {
  return [
    0xc0,
    0x0c,
    0x00,
    0x1c,
    0x00,
    0x01,
    0x00,
    0x00,
    0x01,
    0x2c,
    0x00,
    0x10,
    ...new Array(16).fill(0),
  ];
}

/** CNAME 记录（type 5）——A 抽取应跳过、继续解析后续 A。 */
function cnameRecord(): number[] {
  // rdata = 压缩指针(2 字节) 指回 question 名，作为别名目标（内容不影响 A 抽取）
  return [0xc0, 0x0c, 0x00, 0x05, 0x00, 0x01, 0x00, 0x00, 0x01, 0x2c, 0x00, 0x02, 0xc0, 0x0c];
}

describe('encodeDnsQuery — A 记录查询包', () => {
  it('example.com 逐字节固定', () => {
    const q = encodeDnsQuery('example.com', 0);
    expect(Array.from(q)).toEqual([
      // header: id=0, flags=0x0100(RD), QD=1, AN/NS/AR=0
      0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      // QNAME: 7 "example"
      0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65,
      // 3 "com"
      0x03, 0x63, 0x6f, 0x6d,
      // root
      0x00,
      // QTYPE=A, QCLASS=IN
      0x00, 0x01, 0x00, 0x01,
    ]);
  });

  it('id 写入 header、尾部去掉根点', () => {
    const q = encodeDnsQuery('a.example-argo.com.', 0xbeef);
    expect((q[0] << 8) | q[1]).toBe(0xbeef);
    // QDCOUNT=1，最后 4 字节恒为 QTYPE=A + QCLASS=IN
    expect(Array.from(q.slice(-4))).toEqual([0x00, 0x01, 0x00, 0x01]);
  });

  it('超长 label(>63) 抛错（不静默截断）', () => {
    expect(() => encodeDnsQuery(`${'x'.repeat(64)}.com`)).toThrow();
  });
});

describe('decodeDnsAnswers — 抽 IPv4 A 记录', () => {
  it('单 A 记录', () => {
    const q = encodeDnsQuery('example.com');
    const resp = makeResponse(q, [aRecord('93.184.216.34')]);
    expect(decodeDnsAnswers(resp)).toEqual(['93.184.216.34']);
  });

  it('多 A 记录按报文顺序返回', () => {
    const q = encodeDnsQuery('cdn.example.com');
    const resp = makeResponse(q, [aRecord('1.1.1.1'), aRecord('2.2.2.2'), aRecord('3.3.3.3')]);
    expect(decodeDnsAnswers(resp)).toEqual(['1.1.1.1', '2.2.2.2', '3.3.3.3']);
  });

  it('CNAME + A 混合：跳过 CNAME 返回 A', () => {
    const q = encodeDnsQuery('alias.example.com');
    const resp = makeResponse(q, [cnameRecord(), aRecord('5.6.7.8')]);
    expect(decodeDnsAnswers(resp)).toEqual(['5.6.7.8']);
  });

  it('AAAA-only → []（v1 不解析 v6）', () => {
    const q = encodeDnsQuery('v6.example.com');
    const resp = makeResponse(q, [aaaaRecord()]);
    expect(decodeDnsAnswers(resp)).toEqual([]);
  });

  it('RCODE!=0（SERVFAIL）→ []', () => {
    const q = encodeDnsQuery('fail.example.com');
    const resp = makeResponse(q, [], { rcode: 2, ancount: 0 });
    expect(decodeDnsAnswers(resp)).toEqual([]);
  });

  it('ANCOUNT=0 → []', () => {
    const q = encodeDnsQuery('empty.example.com');
    expect(decodeDnsAnswers(makeResponse(q, []))).toEqual([]);
  });

  it('截断响应（rdata 不全）→ []，绝不抛', () => {
    const q = encodeDnsQuery('trunc.example.com');
    const full = makeResponse(q, [aRecord('9.9.9.9')]);
    const cut = full.slice(0, full.length - 2); // 砍掉最后 2 字节 IPv4
    expect(decodeDnsAnswers(cut)).toEqual([]);
  });

  it('过短报文（< 12 字节 header）→ []', () => {
    expect(decodeDnsAnswers(new Uint8Array([0x00, 0x01, 0x02]))).toEqual([]);
  });

  it('round-trip：encode 的 question 段可被响应复用解析', () => {
    const q = encodeDnsQuery('b.trycloudflare.com');
    const resp = makeResponse(q, [aRecord('104.16.0.1')]);
    expect(decodeDnsAnswers(resp)).toEqual(['104.16.0.1']);
  });
});
