/**
 * issue #147 三态 race 转发 + wire 辅助单测（纯逻辑，注入 mock 上游查询）。
 * 覆盖：HIT 抢跑 / EMPTY 不抢跑 / 全 EMPTY→空 / 全 FAIL→SERVFAIL / Tier2 兜底 / id 回填 / 畸形→SERVFAIL。
 */
import { encodeDnsQuery, decodeDnsQuestion, classifyDnsResponse } from '../dns-wire';
import { raceForward, type UpstreamQueryFn } from '../node-dns-race';
import type { ResolveUpstream } from '../node-resolver-upstreams';

const U = (id: string, tier: 1 | 2 = 1): ResolveUpstream => ({
  id,
  kind: 'doh',
  tier,
  ip: '0.0.0.0',
});

/** 找 query 首 question 末偏移（header12 + qname + qtype2 + qclass2）。 */
function questionEnd(q: Uint8Array): number {
  let off = 12;
  while (off < q.length && q[off] !== 0) {
    if ((q[off] & 0xc0) === 0xc0) return off + 2 + 4;
    off += 1 + q[off];
  }
  return off + 1 + 4;
}

/** 构造响应 wire：echo question + QR=1；HIT 追加一条 A 记录，NXDOMAIN 置 rcode=3，EMPTY 无 answer。 */
function makeResponse(
  query: Uint8Array,
  kind: 'HIT' | 'EMPTY' | 'NXDOMAIN',
  ip = '1.2.3.4'
): Uint8Array {
  const qEnd = questionEnd(query);
  const base = query.slice(0, qEnd);
  let answer = new Uint8Array(0);
  let an = 0;
  let rcode = 0;
  if (kind === 'HIT') {
    an = 1;
    const p = ip.split('.').map((x) => parseInt(x, 10));
    answer = new Uint8Array([
      0xc0,
      0x0c,
      0x00,
      0x01,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00,
      0x3c,
      0x00,
      0x04,
      p[0],
      p[1],
      p[2],
      p[3],
    ]);
  } else if (kind === 'NXDOMAIN') {
    rcode = 3;
  }
  const out = new Uint8Array(base.length + answer.length);
  out.set(base, 0);
  out.set(answer, base.length);
  const view = new DataView(out.buffer);
  view.setUint16(2, 0x8180 | rcode); // QR=1 RD=1 RA=1 + rcode
  view.setUint16(6, an);
  return out;
}

type Spec = { kind?: 'HIT' | 'EMPTY' | 'NXDOMAIN'; fail?: boolean; delayMs?: number; ip?: string };

function mockQuery(query: Uint8Array, specs: Record<string, Spec>): UpstreamQueryFn {
  return (up, _q, signal) =>
    new Promise<Uint8Array>((resolve, reject) => {
      const s = specs[up.id];
      const t = setTimeout(() => {
        if (!s || s.fail) reject(new Error('upstream fail'));
        else resolve(makeResponse(query, s.kind ?? 'EMPTY', s.ip));
      }, s?.delayMs ?? 0);
      signal.addEventListener('abort', () => clearTimeout(t), { once: true });
    });
}

const QID = 0x4d2;
const makeQ = () => encodeDnsQuery('a.example.com', QID);

describe('raceForward 三态 race', () => {
  it('HIT 抢跑：最快 HIT 上游胜出 + 回填 query id', async () => {
    const q = makeQ();
    const resp = await raceForward(
      q,
      { tier1: [U('ali'), U('dnspod')], tier2: [] },
      {
        query: mockQuery(q, {
          ali: { kind: 'HIT', delayMs: 5, ip: '9.9.9.9' },
          dnspod: { kind: 'HIT', delayMs: 40 },
        }),
      }
    );
    expect(classifyDnsResponse(resp, 1)).toBe('HIT');
    expect(decodeDnsQuestion(resp)?.id).toBe(QID); // id 回填
    // 含 ali 的 ip 9.9.9.9（最快胜出）
    expect(Array.from(resp.slice(-4))).toEqual([9, 9, 9, 9]);
  });

  it('EMPTY 不抢跑：先到的 EMPTY 不胜出，等到后到的 HIT', async () => {
    const q = makeQ();
    const resp = await raceForward(
      q,
      { tier1: [U('ali'), U('dnspod')], tier2: [] },
      {
        query: mockQuery(q, {
          ali: { kind: 'EMPTY', delayMs: 3 },
          dnspod: { kind: 'HIT', delayMs: 25, ip: '8.8.8.8' },
        }),
      }
    );
    expect(classifyDnsResponse(resp, 1)).toBe('HIT');
    expect(Array.from(resp.slice(-4))).toEqual([8, 8, 8, 8]);
  });

  it('全 EMPTY → 返回空解析（NOERROR 无 answer）', async () => {
    const q = makeQ();
    const resp = await raceForward(
      q,
      { tier1: [U('ali'), U('dnspod')], tier2: [] },
      { query: mockQuery(q, { ali: { kind: 'EMPTY' }, dnspod: { kind: 'EMPTY' } }) }
    );
    expect(classifyDnsResponse(resp, 1)).toBe('EMPTY');
    expect(decodeDnsQuestion(resp)?.id).toBe(QID);
  });

  it('NXDOMAIN 也算 EMPTY（正常空解析）', async () => {
    const q = makeQ();
    const resp = await raceForward(
      q,
      { tier1: [U('ali')], tier2: [] },
      { query: mockQuery(q, { ali: { kind: 'NXDOMAIN' } }) }
    );
    expect(classifyDnsResponse(resp, 1)).toBe('EMPTY');
  });

  it('全 FAIL → SERVFAIL（rcode=2），区别于 EMPTY', async () => {
    const q = makeQ();
    const resp = await raceForward(
      q,
      { tier1: [U('ali'), U('dnspod')], tier2: [] },
      { query: mockQuery(q, { ali: { fail: true }, dnspod: { fail: true } }) }
    );
    expect(classifyDnsResponse(resp, 1)).toBe('FAIL'); // SERVFAIL
    const view = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
    expect(view.getUint16(2) & 0x000f).toBe(2); // RCODE=SERVFAIL
    expect(decodeDnsQuestion(resp)?.id).toBe(QID);
  });

  it('Tier1 全 EMPTY → Tier2 兜底 HIT', async () => {
    const q = makeQ();
    const resp = await raceForward(
      q,
      { tier1: [U('ali')], tier2: [U('system', 2)] },
      { query: mockQuery(q, { ali: { kind: 'EMPTY' }, system: { kind: 'HIT', ip: '5.5.5.5' } }) }
    );
    expect(classifyDnsResponse(resp, 1)).toBe('HIT');
    expect(Array.from(resp.slice(-4))).toEqual([5, 5, 5, 5]);
  });

  it('Tier1 有 HIT → 不查 Tier2（Tier2 不抢跑）', async () => {
    const q = makeQ();
    let tier2Called = false;
    const fn: UpstreamQueryFn = (up, _q, signal) =>
      new Promise((resolve, reject) => {
        if (up.id === 'system') {
          tier2Called = true;
          reject(new Error('should not be called'));
          return;
        }
        const t = setTimeout(() => resolve(makeResponse(q, 'HIT', '1.1.1.1')), 2);
        signal.addEventListener('abort', () => clearTimeout(t), { once: true });
      });
    const resp = await raceForward(
      q,
      { tier1: [U('ali')], tier2: [U('system', 2)] },
      { query: fn }
    );
    expect(classifyDnsResponse(resp, 1)).toBe('HIT');
    expect(tier2Called).toBe(false);
  });

  it('畸形 query → SERVFAIL，不抛', async () => {
    const bad = new Uint8Array([0, 1, 2]);
    const resp = await raceForward(
      bad,
      { tier1: [U('ali')], tier2: [] },
      { query: mockQuery(bad, {}) }
    );
    const view = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
    expect(view.getUint16(2) & 0x000f).toBe(2); // SERVFAIL
  });
});

describe('classifyDnsResponse 边界（review 修复）', () => {
  const q = makeQ();
  it('TC=1 截断（NOERROR + 含 A）→ FAIL（不把部分 A 当权威转发）', () => {
    const r = makeResponse(q, 'HIT', '1.2.3.4');
    new DataView(r.buffer, r.byteOffset, r.byteLength).setUint16(2, 0x8380); // QR=1 RD RA TC=1 RCODE=0
    expect(classifyDnsResponse(r, 1)).toBe('FAIL');
  });
  it('A 记录 class≠IN（CH）→ 不判 HIT（class=IN 口径）→ EMPTY', () => {
    const r = makeResponse(q, 'HIT', '1.2.3.4');
    // makeResponse 的 A answer 共 16 字节（name2+type2+class2+ttl4+rdlen2+ip4），class 在 answer 起始 +4。
    const ansStart = r.length - 16;
    new DataView(r.buffer, r.byteOffset, r.byteLength).setUint16(ansStart + 4, 0x0003); // class CH
    expect(classifyDnsResponse(r, 1)).toBe('EMPTY');
  });
});
