/**
 * issue #147 本地 race DNS server 集成测（127.0.0.1 UDP loopback + 注入 mock 上游）。
 * loopback bind/send 不碰宿主网络栈（非 netns/iptables/TUN），安全。
 */
import * as dgram from 'dgram';
import { NodeDnsRaceServer } from '../node-dns-race-server';
import { encodeDnsQuery, classifyDnsResponse, decodeDnsQuestion } from '../../../shared/dns-wire';
import type { ResolvedUpstreams } from '../../../shared/node-resolver-upstreams';

function questionEnd(q: Uint8Array): number {
  let off = 12;
  while (off < q.length && q[off] !== 0) {
    if ((q[off] & 0xc0) === 0xc0) return off + 2 + 4;
    off += 1 + q[off];
  }
  return off + 1 + 4;
}
function makeResponse(query: Uint8Array, kind: 'HIT' | 'EMPTY', ip = '1.2.3.4'): Uint8Array {
  const base = query.slice(0, questionEnd(query));
  let answer = new Uint8Array(0);
  let an = 0;
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
  }
  const out = new Uint8Array(base.length + answer.length);
  out.set(base, 0);
  out.set(answer, base.length);
  const view = new DataView(out.buffer);
  view.setUint16(2, 0x8180);
  view.setUint16(6, an);
  return out;
}

function sendQuery(port: number, query: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const c = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      c.close();
      reject(new Error('client timeout'));
    }, 3000);
    c.on('message', (msg) => {
      clearTimeout(timer);
      c.close();
      resolve(new Uint8Array(msg));
    });
    c.on('error', (e) => {
      clearTimeout(timer);
      c.close();
      reject(e);
    });
    c.send(query, port, '127.0.0.1');
  });
}

const TIER1: ResolvedUpstreams = {
  tier1: [{ id: 'ali', kind: 'doh', tier: 1, ip: '0.0.0.0' }],
  tier2: [],
  directIps: [],
};

describe('NodeDnsRaceServer (loopback)', () => {
  // review M1：afterEach 兜底关 server——失败时（try 外的 expect 抛）也不漏 UDP socket，杜绝 jest open-handle。
  let server: NodeDnsRaceServer | undefined;
  afterEach(() => {
    server?.stop();
    server = undefined;
  });

  it('内核 query → race HIT 透传回内核 + id 回填', async () => {
    server = new NodeDnsRaceServer({
      queryFn: async (_up, query) => makeResponse(query, 'HIT', '7.7.7.7'),
    });
    const port = await server.start(TIER1);
    expect(port).toBeGreaterThan(0);
    expect(server.isRunning()).toBe(true);
    try {
      const q = encodeDnsQuery('a.example.com', 0x1234);
      const resp = await sendQuery(port, q);
      expect(classifyDnsResponse(resp, 1)).toBe('HIT');
      expect(decodeDnsQuestion(resp)?.id).toBe(0x1234);
      expect(Array.from(resp.slice(-4))).toEqual([7, 7, 7, 7]);
    } finally {
      server.stop();
    }
    expect(server.isRunning()).toBe(false);
  });

  it('全上游 FAIL → 回 SERVFAIL（不挂死，内核拿得到答案）', async () => {
    server = new NodeDnsRaceServer({
      queryFn: async () => {
        throw new Error('upstream down');
      },
    });
    const port = await server.start(TIER1);
    try {
      const q = encodeDnsQuery('b.example.com', 0x55);
      const resp = await sendQuery(port, q);
      const view = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
      expect(view.getUint16(2) & 0x000f).toBe(2); // SERVFAIL
      expect(decodeDnsQuestion(resp)?.id).toBe(0x55);
    } finally {
      server.stop();
    }
  });

  it('setUpstreams 热更上游（无需重启）', async () => {
    server = new NodeDnsRaceServer({
      queryFn: async (up, query) =>
        makeResponse(query, 'HIT', up.id === 'dnspod' ? '2.2.2.2' : '1.1.1.1'),
    });
    const port = await server.start(TIER1);
    try {
      server.setUpstreams({
        tier1: [{ id: 'dnspod', kind: 'doh', tier: 1, ip: '0.0.0.0' }],
        tier2: [],
        directIps: [],
      });
      const resp = await sendQuery(port, encodeDnsQuery('c.example.com', 0x9));
      expect(Array.from(resp.slice(-4))).toEqual([2, 2, 2, 2]); // 命中热更后的 dnspod
    } finally {
      server.stop();
    }
  });

  it('watchdog：socket 被动 close → 自动重建且端口不变（review #1）', async () => {
    server = new NodeDnsRaceServer({
      queryFn: async (_up, query) => makeResponse(query, 'HIT', '8.8.8.8'),
    });
    const port = await server.start(TIER1);
    // 模拟 socket 被动 close（非主动 stop）→ 'close' 事件触发 watchdog re-listen。
    (server as unknown as { socket: dgram.Socket }).socket.close();
    await new Promise((r) => setTimeout(r, 150)); // 等 re-listen 完成
    expect(server.isRunning()).toBe(true);
    expect(server.getPort()).toBe(port); // 重绑原端口（对内核透明，已烧进 config 的端口仍有效）
    const resp = await sendQuery(port, encodeDnsQuery('d.example.com', 0xab));
    expect(classifyDnsResponse(resp, 1)).toBe('HIT'); // 重建后仍正常服务
  });

  it('watchdog：stop() 后 socket close 不触发重建（closing 守卫，不留孤儿）', async () => {
    server = new NodeDnsRaceServer({
      queryFn: async (_up, query) => makeResponse(query, 'HIT'),
    });
    await server.start(TIER1);
    server.stop(); // closing=true 先于 close()：'close' 事件回调里 onSocketDown 被 closing 守卫挡
    await new Promise((r) => setTimeout(r, 150)); // 等 'close' 事件可能触发 onSocketDown
    expect(server.isRunning()).toBe(false); // 不重建
    expect(server.getPort()).toBe(0);
    expect((server as unknown as { socket: dgram.Socket | null }).socket).toBeNull();
  });
});
