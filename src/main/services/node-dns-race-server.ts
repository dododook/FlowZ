/**
 * 本地节点域名解析 race DNS server（issue #147 §3/§6/§8）。主进程内嵌 UDP server（127.0.0.1:动态口）：
 * 内核 Do53 query → raceForward（多上游 DoH/UDP/system 并发 race）→ 命中上游完整响应透传回内核（回填 id）。
 *
 * fail-open（§8）：
 *  - 第一层（存活）：raceForward 内部全 FAIL → buildServfail（绝不挂着不回，内核拿得到答案）；
 *  - 第二层（进程死）：socket 'error'/'close' → watchdog re-listen（非主动关闭时）；启动探活失败由调用方降级 config。
 * scope 仅节点域名解析，不碰系统 DNS。
 */
import * as dgram from 'dgram';
import {
  raceForward,
  type UpstreamQueryFn,
  DEFAULT_RACE_BUDGET_MS,
} from '../../shared/node-dns-race';
import type { ResolvedUpstreams, ResolveUpstream } from '../../shared/node-resolver-upstreams';
import { decodeDnsQuestion, buildAnswerResponse } from '../../shared/dns-wire';

const TYPE_A = 1;
const TYPE_AAAA = 28;
const PER_UPSTREAM_TIMEOUT_MS = 1500;

type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

/** 单上游一次查询（无 timeout 包装）：DoH(https) fetch / UDP dgram / system 解析。dot 暂不支持（FAIL，由他者兜，二期）。 */
async function queryOneUpstream(
  up: ResolveUpstream,
  query: Uint8Array,
  signal: AbortSignal
): Promise<Uint8Array> {
  if (up.kind === 'doh' && !up.dot) {
    const url = `https://${up.ip}:${up.port ?? 443}${up.path || '/dns-query'}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' },
      body: Buffer.from(query),
      signal,
    });
    if (!resp.ok) throw new Error(`doh ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  }
  if (up.kind === 'udp') {
    return udpQuery(up.ip as string, up.port ?? 53, query, signal);
  }
  if (up.kind === 'system') {
    return systemQuery(query);
  }
  throw new Error(`unsupported upstream kind: ${up.kind}${up.dot ? ' (dot)' : ''}`);
}

/** UDP 明文查询：发 query 到 ip:port，收首个响应。signal 触发即取消。 */
function udpQuery(
  ip: string,
  port: number,
  query: Uint8Array,
  signal: AbortSignal
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      fn();
    };
    const onAbort = () => finish(() => reject(new Error('aborted')));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    sock.on('message', (msg, rinfo) => {
      // 硬化（review M2）：只接受来自该上游 IP:port 的响应，且响应 id 必须 == query id（前 2 字节）——
      // 防 off-path UDP 注入伪造响应污染解析。不匹配 → 忽略继续等真响应（超时由上层 budget 兜）。
      if (rinfo.address !== ip || rinfo.port !== port) return;
      if (msg.length >= 2 && query.length >= 2 && (msg[0] !== query[0] || msg[1] !== query[1])) {
        return;
      }
      finish(() => resolve(new Uint8Array(msg)));
    });
    sock.on('error', (e) => finish(() => reject(e)));
    sock.send(query, port, ip, (e) => {
      if (e) finish(() => reject(e));
    });
  });
}

/** system 上游：用 OS 解析器（dns.promises）按 qtype 解析 → 构造 wire 响应。仅 A（IPv4）；AAAA/其它 → FAIL（他者兜，二期）。 */
async function systemQuery(query: Uint8Array): Promise<Uint8Array> {
  const q = decodeDnsQuestion(query);
  if (!q) throw new Error('system: bad query');
  if (q.qtype !== TYPE_A) {
    if (q.qtype === TYPE_AAAA) throw new Error('system: AAAA 二期'); // 让 Tier1 兜
    throw new Error('system: unsupported qtype');
  }
  const dns = require('dns').promises;
  try {
    const ips: string[] = await dns.resolve4(q.qname);
    return buildAnswerResponse(
      query,
      ips.map((ip) => ({
        type: TYPE_A,
        rdata: Uint8Array.from(ip.split('.').map((x) => parseInt(x, 10))),
      }))
    );
  } catch (e) {
    // ENOTFOUND/NODATA = 域名无 A → 空解析（NOERROR AN=0），非故障；其它（SERVFAIL 等）→ throw=FAIL。
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NOTFOUND') {
      return buildAnswerResponse(query, []);
    }
    throw e;
  }
}

/** 默认上游查询 fn（带单上游 timeout，跟随 race 层 signal 取消）。 */
export function makeDefaultUpstreamQuery(perUpstreamMs = PER_UPSTREAM_TIMEOUT_MS): UpstreamQueryFn {
  return async (up, query, signal) => {
    const ctrl = new AbortController();
    const onParent = () => ctrl.abort();
    if (signal.aborted) throw new Error('aborted');
    signal.addEventListener('abort', onParent, { once: true });
    const timer = setTimeout(() => ctrl.abort(), perUpstreamMs);
    try {
      return await queryOneUpstream(up, query, ctrl.signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onParent);
    }
  };
}

export interface NodeDnsRaceServerOpts {
  /** 注入上游查询（单测 mock；默认真实 DoH/UDP/system）。 */
  queryFn?: UpstreamQueryFn;
  totalBudgetMs?: number;
  log?: LogFn;
}

/**
 * 本地 race DNS server。start() 绑 127.0.0.1:动态口 → 返回端口（供 config 的 dns server 引用）。
 * 内核每次 Lookup 节点域名 → 经此 race 多上游 → 多 A 透传给内核 DialSerial。
 */
export class NodeDnsRaceServer {
  private socket: dgram.Socket | null = null;
  private port = 0;
  private upstreams: ResolvedUpstreams = { tier1: [], tier2: [], directIps: [] };
  private closing = false;
  private readonly queryFn: UpstreamQueryFn;
  private readonly totalBudgetMs: number;
  private readonly log: LogFn;

  constructor(opts: NodeDnsRaceServerOpts = {}) {
    this.queryFn = opts.queryFn ?? makeDefaultUpstreamQuery();
    this.totalBudgetMs = opts.totalBudgetMs ?? DEFAULT_RACE_BUDGET_MS;
    this.log = opts.log ?? (() => {});
  }

  getPort(): number {
    return this.port;
  }

  isRunning(): boolean {
    return !!this.socket && this.port > 0;
  }

  /** 运行期更新上游（档位/自定义变更后热更，无需重启 server）。 */
  setUpstreams(u: ResolvedUpstreams): void {
    this.upstreams = u;
  }

  /** 绑定 127.0.0.1:动态口。已运行则直接返回当前端口。失败 reject（调用方据此降级 config）。 */
  async start(upstreams: ResolvedUpstreams): Promise<number> {
    this.upstreams = upstreams;
    this.closing = false;
    if (this.socket) return this.port;
    return this.listen();
  }

  private listen(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      let settled = false;
      sock.on('message', (msg, rinfo) => void this.handle(msg, rinfo));
      sock.on('error', (e) => {
        this.log('warn', `[dns-race] socket error: ${e.message}`);
        if (!settled) {
          settled = true;
          reject(e);
          return;
        }
        this.onSocketDown();
      });
      sock.bind(0, '127.0.0.1', () => {
        settled = true;
        this.socket = sock;
        this.port = (sock.address() as { port: number }).port;
        this.log('info', `[dns-race] listening 127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
  }

  /** watchdog：非主动关闭时 socket 异常 → 重建（fail-open 第二层）。 */
  private onSocketDown(): void {
    if (this.closing) return;
    this.socket = null;
    this.listen().catch((e) =>
      this.log('error', `[dns-race] re-listen 失败: ${(e as Error).message}`)
    );
  }

  private async handle(msg: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    try {
      const resp = await raceForward(new Uint8Array(msg), this.upstreams, {
        query: this.queryFn,
        totalBudgetMs: this.totalBudgetMs,
        log: this.log,
      });
      this.socket?.send(resp, rinfo.port, rinfo.address);
    } catch (e) {
      // 绝不崩；最坏不回（内核 query 自然超时重试）。raceForward 内部已对全 FAIL 返 SERVFAIL，此 catch 仅兜极端异常。
      this.log('warn', `[dns-race] handle 异常: ${(e as Error).message}`);
    }
  }

  stop(): void {
    this.closing = true;
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.port = 0;
  }
}
