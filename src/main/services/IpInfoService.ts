/**
 * 出口 IP 信息服务：测出「本地直连出口 IP」与「代理出口 IP」，经 EVENT_IP_INFO_UPDATED 推渲染端。
 *
 * 取数走 ProxyManager 的探针 inbound（probe-direct-in / probe-proxy-in，见 ProxyManager.getProbePorts）：
 * 这两个本地 HTTP inbound 在 route.rules 头部被钉死分别走 direct / proxy-selector，因此无论「接管方式
 * (系统代理/TUN/手动)」与「分流策略(全局/智能/直连)」如何组合，都能稳定测出真实出口 IP。代理未运行时，
 * direct 退回主进程裸 fetch（此时无 TUN，必直连），proxy 置 null。
 *
 * 事件驱动刷新（无周期轮询）：省第三方配额、不持续暴露行为。60s TTL + in-flight 去重；失败保留旧值。
 */
import * as http from 'http';
import { isIP } from 'net';
import type { IpInfo, IpInfoSnapshot } from '../../shared/types';

const TTL_MS = 60_000;
const REQ_TIMEOUT_MS = 5000; // 单个探测请求超时上限（httpText）——重试不会无限阻塞
// 出口 IP 启动初期隧道/DNS 未就绪 → 首测易失败。重试至 MAX_PROBE_ATTEMPTS 上限、每次间隔 RETRY_DELAY_MS，
// 期间保持 loading（界面显「获取中」）；全部失败才报错（界面友好提示，不闪「获取失败」）。
//
// 收敛重试预算（#86-122 复审 #10）：原 3 次重试 × 链内 3 端点串行 × 5s 超时 ≈ 最坏 45s，全失败时经
// enqueue 串行链堵住后续 refreshProxy（切节点连点会叠加）。每次 attempt 内 queryViaProxy/queryDirectChain
// 已串行多端点容错，第 3 轮边际收益低却贡献 1/3 最坏延迟 → 降到 2 轮：最坏 ~45s→~30s，成功路径零影响
// （成功首跳即返回，不触发重试/超时）；startup 初期仍有 2 轮 × 多端点 + 间隔重试覆盖隧道抖动。
// 真机复核项：2 轮对启动初期隧道/DNS 未就绪的探测成功率是否仍足够（不足则回调或注入提高）。
const MAX_PROBE_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1000;

// 首连（post-connect）专用更宽退避：TS/组网节点首连时隧道（DERP/peer 握手、路由下发）需数秒才就绪，
// 常规 2 轮 ×1s 在隧道起来前就耗尽 → 闪「代理出口暂不可用」。仅 refreshProxyPostConnect 路径用此预算，
// 全程 loading=true（界面持续转圈），重试耗尽才落 error；手动刷新 / 切节点 / 常规 TTL 探测不受影响。
const POST_CONNECT_MAX_PROBE_ATTEMPTS = 4;
const POST_CONNECT_RETRY_DELAY_MS = 4000;

// 本地直连出口（direct 链，仅国内端点 myip.ipip.net）专用预算：起核初期其解析器 dns-bootstrap（223.5.5.5 IP-DoH）
// 易撞 use-of-closed 暂态 → 用更宽重试预算等 DNS 就绪，避免重试耗尽时本地出口空缺（旧实现此时会 fallback 到被
// 透明分流劫持的国外端点 → 误标境外，已废）。成功路径零影响（IPIP 首跳成功即返回，不触发重试）。
// 取温和的 3×1s（≈3s）而非更宽：doRefresh 与 proxy 探测并发、共用一次 onUpdate，过宽预算会让 IPIP 偶发首失时
// 把已成功的代理出口也拖到 direct 重试耗尽才一次性刷新（常规手动/TTL 刷新同样付代价）；3s 既覆盖起核 DNS 抖动、又限拖累。
const DIRECT_MAX_PROBE_ATTEMPTS = 3;
const DIRECT_RETRY_DELAY_MS = 1000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface ProbeEndpoint {
  host: string;
  path: string;
  /** 响应体解析方式：'json'（ip-api/ipip/ipify）/ 'trace'（Cloudflare /cdn-cgi/trace 纯文本 key=value）。 */
  parse: 'json' | 'trace';
}
// 本地出口主用国内接口：旁路由/软路由透明分流会把国外目标劫持走境外出口，导致 ip-api 把本地出口误标为
// 境外节点 IP；国内接口走真实大陆出口，是这类环境下唯一能测对本地出口的办法（也更快、不触 ip-api 限流）。
const EP_IPIP: ProbeEndpoint = { host: 'myip.ipip.net', path: '/json', parse: 'json' };
const EP_IPAPI: ProbeEndpoint = {
  host: 'ip-api.com',
  path: '/json/?fields=status,query,country,countryCode',
  parse: 'json',
};
const EP_IPIFY: ProbeEndpoint = { host: 'api.ipify.org', path: '/?format=json', parse: 'json' };
// Cloudflare trace：纯文本 key=value，apex 域 :80 absolute-form 实测直出 200 无重定向（陈先生定 apex 非 www）。
// 仅用于代理出口链（境外节点访问准确、低延迟）；绝不进直连链——旁路由透明分流会把它劫走代理误标直连出口。
const EP_CF_TRACE: ProbeEndpoint = {
  host: 'cloudflare.com',
  path: '/cdn-cgi/trace',
  parse: 'trace',
};
// 代理出口：trace 为主（境外节点访问快、对任意国家给 ISO loc→countryCode 国旗）；ip-api / ipify 限流无关联兜底降级。
const PROXY_CHAIN: ProbeEndpoint[] = [EP_CF_TRACE, EP_IPAPI, EP_IPIFY];

/** ipip 无 ISO 国别码：中国→cn（港澳台细分），其余 undefined（渲染端 Globe 兜底）。 */
function ccFromIpipLocation(loc: readonly string[]): string | undefined {
  if (loc[0] !== '中国') return undefined;
  if (loc[1] === '香港') return 'hk';
  if (loc[1] === '澳门') return 'mo';
  if (loc[1] === '台湾') return 'tw';
  return 'cn';
}

/**
 * 解析 Cloudflare /cdn-cgi/trace 纯文本响应（多行 `key=value`）。仅取 ip + countryCode（不取 colo）：
 *  - ip：经 net.isIP 校验（!==0 才算合法 IPv4/IPv6），劫持页/portal 的假响应或截断响应 → 校验失败返 null 走 fallback；
 *  - loc：大写后须匹配 /^[A-Z]{2}$/ 且 != 'XX'（CF 对未知地区返 XX）才作 countryCode，否则 undefined（渲染端 Globe 兜底）。
 * 国家名不在此派生（trace 不给国家名）→ 渲染端由 countryCode 经 Intl.DisplayNames 派生。
 */
export function parseTrace(body: string): IpInfo | null {
  const kv: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue; // 忽略空行
    const i = t.indexOf('=');
    if (i <= 0) continue; // 无 '=' 或以 '=' 开头（无 key）→ 跳过
    kv[t.slice(0, i)] = t.slice(i + 1).trim();
  }
  const ip = kv['ip'];
  if (!ip || isIP(ip) === 0) return null; // 防劫持页/截断响应假响应
  const loc = kv['loc']?.toUpperCase();
  const countryCode = loc && /^[A-Z]{2}$/.test(loc) && loc !== 'XX' ? loc : undefined;
  return { ip, countryCode };
}

export class IpInfoService {
  private snapshot: IpInfoSnapshot = { direct: null, proxy: null, updatedAt: 0 };
  private inflight: Promise<void> | null = null;

  /**
   * @param getProbePorts 取当前探针端口（代理未运行/分配失败时 null）
   * @param isRunning sing-box 是否在运行
   * @param onUpdate 快照更新时回调（广播给渲染端）
   */
  // 探针重试上限 / 间隔（默认取模块常量；可经构造选项注入，供单测设 maxAttempts=1/delay=0 还原单次行为）。
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  // 首连专用更宽预算（仅 refreshProxyPostConnect 用）：覆盖 TS/组网首连隧道未就绪的几秒窗口。
  private readonly postConnectMaxAttempts: number;
  private readonly postConnectRetryDelayMs: number;
  // 本地直连出口（direct 链）专用预算：起核初期 IPIP 解析器 dns-bootstrap 易撞 use-of-closed 暂态，宽预算等就绪。
  private readonly directMaxAttempts: number;
  private readonly directRetryDelayMs: number;

  constructor(
    private readonly getProbePorts: () => { direct: number; proxy: number } | null,
    private readonly isRunning: () => boolean,
    private readonly onUpdate: (snap: IpInfoSnapshot) => void,
    options?: {
      maxAttempts?: number;
      retryDelayMs?: number;
      postConnectMaxAttempts?: number;
      postConnectRetryDelayMs?: number;
      directMaxAttempts?: number;
      directRetryDelayMs?: number;
    }
  ) {
    this.maxAttempts = options?.maxAttempts ?? MAX_PROBE_ATTEMPTS;
    this.retryDelayMs = options?.retryDelayMs ?? RETRY_DELAY_MS;
    this.postConnectMaxAttempts =
      options?.postConnectMaxAttempts ?? POST_CONNECT_MAX_PROBE_ATTEMPTS;
    this.postConnectRetryDelayMs = options?.postConnectRetryDelayMs ?? POST_CONNECT_RETRY_DELAY_MS;
    this.directMaxAttempts = options?.directMaxAttempts ?? DIRECT_MAX_PROBE_ATTEMPTS;
    this.directRetryDelayMs = options?.directRetryDelayMs ?? DIRECT_RETRY_DELAY_MS;
  }

  getSnapshot(): IpInfoSnapshot {
    return { ...this.snapshot };
  }

  /**
   * 代理启动/切节点瞬间立即置「检测中」(loading=true) 并【清旧 proxy 出口值】，由调用方在 running 翻转 / 切节点同刻调用。
   * 清旧值（修出口陈旧根因）：旧 proxy 值是【上一个节点/上一会话】的出口，切节点或重连后保留即误导（实测：切到
   * Tailscale 仍显上一个 hk01 香港 IP）。清为 null + loading → 网络卡显「检测中」(#53)；随后 refresh/refreshProxy 探到
   * 真值显新 IP、探测失败显「暂不可用」，绝不残留旧节点 IP。本地出口(direct)不动（切节点不变）。
   * 注：仅 start/switch 路径调本方法；TTL/手动刷新不调它 → 同节点瞬态抖动仍由 doRefresh 保留旧值（不受影响）。
   */
  markProxyConnecting(): void {
    this.snapshot = { ...this.snapshot, proxy: null, loading: true };
    this.onUpdate(this.getSnapshot());
  }

  /** 把刷新任务排到当前在途之后（链式），避免 force/proxy 刷新被 in-flight 去重静默吞掉。 */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const prev = this.inflight;
    const task = (async () => {
      if (prev) await prev.catch(() => {});
      await fn();
    })();
    this.inflight = task;
    return task.finally(() => {
      if (this.inflight === task) this.inflight = null;
    });
  }

  /** 取出口 IP；命中 TTL 直接返回缓存；force 排队重测，非 force 复用在途。 */
  async refresh(force = false): Promise<IpInfoSnapshot> {
    if (!force && !this.snapshot.error && Date.now() - this.snapshot.updatedAt < TTL_MS) {
      return this.getSnapshot();
    }
    // 非强制：有在途则复用其结果（去重正确）；强制：链式排队，不被在途吞掉
    if (!force && this.inflight) {
      await this.inflight.catch(() => {});
      return this.getSnapshot();
    }
    await this.enqueue(() => this.doRefresh());
    return this.getSnapshot();
  }

  /**
   * 仅重测代理出口（切节点场景）：本地直连出口不因切节点改变（direct 出站绑物理网卡），无需重测。
   * 链式排到在途之后（不复用，避免切节点的代理 IP 被旧的全量刷新结果吞掉）。proxy-only 也推进 updatedAt。
   */
  async refreshProxy(): Promise<IpInfoSnapshot> {
    await this.enqueue(() => this.doRefreshProxy());
    return this.getSnapshot();
  }

  /**
   * 首连专用代理出口探测（post-connect 兜底）：用更宽的 postConnect 退避预算（默认 4 轮 ×4s）重试，
   * 覆盖 TS/组网首连时隧道（DERP/peer 握手、路由下发）需几秒才就绪的窗口——全程 loading=true（界面持续
   * 转圈），重试耗尽才落 error（暂不可用）。仅 proxyManager 'started' 后的首探走此路径；常规手动刷新 /
   * 切节点 / TTL 探测仍走 refreshProxy（常规预算），不被拖累。事件驱动 re-probe（隧道一就绪即触发的
   * refreshProxy）会经 enqueue 链式排到本次首探之后，隧道就绪后第一时间出真值。
   */
  async refreshProxyPostConnect(): Promise<IpInfoSnapshot> {
    await this.enqueue(() => this.doRefreshProxy(true));
    return this.getSnapshot();
  }

  /** 探测重试：成功即返回；失败按 retryDelayMs 间隔重试至 attempts 上限；全失败返 null。
   *  期间不改 loading（调用方保持 loading=true → 界面持续「获取中」），避免启动初期隧道未就绪时闪失败。
   *  attempts/retryDelayMs 缺省取常规预算；post-connect 首探显式传更宽预算（不影响常规/并发刷新路径）。 */
  private async withRetry<T>(
    fn: () => Promise<T | null>,
    attempts: number = this.maxAttempts,
    retryDelayMs: number = this.retryDelayMs
  ): Promise<T | null> {
    for (let i = 0; i < attempts; i++) {
      const r = await fn();
      if (r) return r;
      if (i < attempts - 1) await delay(retryDelayMs);
    }
    return null;
  }

  /** postConnect=true：首连专用更宽退避（仅探代理出口）；否则常规预算。 */
  private async doRefreshProxy(postConnect = false): Promise<void> {
    const ports = this.getProbePorts();
    if (!this.isRunning() || !ports) {
      this.snapshot = { ...this.snapshot, proxy: null, updatedAt: Date.now(), loading: false };
      this.onUpdate(this.getSnapshot());
      return;
    }
    this.snapshot = { ...this.snapshot, loading: true };
    this.onUpdate(this.getSnapshot());
    const p = await this.withRetry(
      () => this.queryViaProxy(ports.proxy),
      postConnect ? this.postConnectMaxAttempts : this.maxAttempts,
      postConnect ? this.postConnectRetryDelayMs : this.retryDelayMs
    );
    this.snapshot = {
      ...this.snapshot,
      // 切节点专用路径：探测失败清旧值(null)而非保留——旧值是【上一个节点】的出口，切节点后保留即误导
      //（如切到没真出网的 TS 节点仍显旧节点 IP）。重试耗尽仍失败 = 新出口确无 → 显「暂不可用」才正确。
      proxy: p ?? null,
      updatedAt: Date.now(),
      loading: false,
      error: p ? undefined : 'fetch_failed',
    };
    this.onUpdate(this.getSnapshot());
  }

  private async doRefresh(): Promise<void> {
    this.snapshot = { ...this.snapshot, loading: true };
    this.onUpdate(this.getSnapshot());

    const ports = this.getProbePorts();
    const running = this.isRunning();

    let direct = this.snapshot.direct;
    let proxy = this.snapshot.proxy;
    let failed = false;

    if (running && ports) {
      // 启动初期隧道/DNS 未就绪 → withRetry 重试（期间 loading 仍 true，界面「获取中」），不闪失败。
      const [d, p] = await Promise.all([
        this.withRetry(
          () => this.queryDirectChain((ep) => this.viaProbe(ports.direct, ep)),
          this.directMaxAttempts,
          this.directRetryDelayMs
        ),
        this.withRetry(() => this.queryViaProxy(ports.proxy)),
      ]);
      // 本地出口(direct)探测失败【不】污染全局 error/degraded：它走 direct 出站、与代理路径无关；direct 链改
      // 单端点 IPIP-only 后失败更频繁，旧的 direct↔全局 error 强耦合会让导流脊误显「外网降级」、即便代理出口正常。
      // IPIP 单点暂态失败只表现为本地出口「暂不可用」(direct 保留旧值/null)，绝不连累 degraded（#2 修复）。
      if (d) direct = d;
      // 代理出口(proxy)探测失败【保留旧值】仅标记失败（黄点/降级=代理路径信号）：doRefresh 也服务同节点手动刷新/
      // TTL 过期，瞬态抖动不清有效旧 IP（review MED）。切节点的清旧值由 doRefreshProxy（专用路径）负责，不在此泛化。
      if (p) proxy = p;
      else failed = true;
    } else if (running) {
      // 核心在跑但探针端口分配失败：不能裸 fetch——TUN 下裸 fetch 会被捕获走代理出口，误标为本地出口。
      // 保留旧 direct + 旧 proxy，仅标记失败。
      failed = true;
    } else {
      // 核心未运行：direct 走主进程裸 fetch（无 TUN，必直连）；proxy 不可测
      const d = await this.withRetry(() => this.queryDirect());
      if (d) direct = d;
      else failed = true;
      proxy = null;
    }

    this.snapshot = {
      direct,
      proxy,
      updatedAt: Date.now(),
      loading: false,
      error: failed ? 'fetch_failed' : undefined,
    };
    this.onUpdate(this.getSnapshot());
  }

  /** 经探针 HTTP 代理端口 absolute-form 请求端点，按 ep.parse 解析。 */
  private viaProbe(proxyPort: number, ep: ProbeEndpoint): Promise<IpInfo | null> {
    return this.fetchEndpoint(ep, {
      hostname: '127.0.0.1',
      port: proxyPort,
      path: `http://${ep.host}${ep.path}`,
      headers: { Host: ep.host, Connection: 'close' },
    });
  }

  /** 主进程裸直连请求端点，按 ep.parse 解析。 */
  private bare(ep: ProbeEndpoint): Promise<IpInfo | null> {
    return this.fetchEndpoint(ep, {
      hostname: ep.host,
      port: 80,
      path: ep.path,
      headers: { Host: ep.host, Connection: 'close' },
    });
  }

  /** 传输（httpText）+ 解析分发（ep.parse: json → parseJson / trace → parseTrace）。传输失败或解析失败均返 null。 */
  private async fetchEndpoint(
    ep: ProbeEndpoint,
    options: http.RequestOptions
  ): Promise<IpInfo | null> {
    const body = await this.httpText(options);
    if (body === null) return null;
    return ep.parse === 'trace' ? parseTrace(body) : parseJson(body);
  }

  /**
   * 本地【直连出口】解析——**单端点**（非「链」，名沿用历史；保留函数封装作「direct 只信国内端点」规矩的单一
   * 锚点 + 单测点，并为将来加国内备用端点留位）。
   *
   * 【只用国内端点 myip.ipip.net】，**绝不** fallback 到国外端点（ip-api/ipify/Cloudflare）：上层旁路由/软路由的
   * 透明分流会把国外端点劫持走代理出口 → 本地出口被误标为境外（真机实证：起核初期 IPIP 的 dns-bootstrap 撞
   * use-of-closed → 旧实现 fallback 到 ip-api → 直连出口显示软路由代理 IP，刷新才恢复）。与 EP_CF_TRACE「绝不进
   * 直连链」同规矩。IPIP 暂态失败交 withRetry 重试（DIRECT_* 宽预算，等 dns-bootstrap 就绪即成功）；成功但缺国别码
   * （境外直连出口、国内库无 ISO 码）由渲染端 Globe 兜底——不取 ip-api 增补（同样会被劫持给错码/错 IP）。
   * EP_IPAPI/EP_IPIFY 仅服务 proxy 链（代理出口本就走国外端点测）。
   *
   * 取舍：去掉国外 fallback 后，无上层透明分流的环境下若 IPIP 持续不可达（ISP 封/服务故障/人在境外）→ 本地出口
   * 暂无（旧实现此时有 ip-api/ipify 兜底）。即以「反劫持正确性」换「单点可用性」——宽预算 + IPIP 国内稳定性覆盖
   * 常态暂态；持续不可达属已知权衡。
   */
  private async queryDirectChain(
    fetch: (ep: ProbeEndpoint) => Promise<IpInfo | null>
  ): Promise<IpInfo | null> {
    return fetch(EP_IPIP);
  }

  /** 代理出口：经探针端口依次尝试 PROXY_CHAIN，首个成功即返回。 */
  private async queryViaProxy(proxyPort: number): Promise<IpInfo | null> {
    for (const ep of PROXY_CHAIN) {
      const r = await this.viaProbe(proxyPort, ep);
      if (r) return r;
    }
    return null;
  }

  /** 主进程裸直连（核心未运行时的本地出口）。 */
  private queryDirect(): Promise<IpInfo | null> {
    return this.queryDirectChain((ep) => this.bare(ep));
  }

  /**
   * 传输层：取响应体纯文本。保留原有兜底（提前关闭/oversize destroy/timeout/error 均返 null，防 promise 永挂
   * 死整条刷新链——review P1）；新增 statusCode!==200 即返 null（顺手对所有端点加固：301/403/5xx 直接降级，
   * 不再单靠 parse 失败兜底）。
   */
  private httpText(options: http.RequestOptions): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: string | null) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };

      const req = http.get({ ...options, timeout: REQ_TIMEOUT_MS }, (res) => {
        if (res.statusCode !== 200) {
          res.resume(); // 排空丢弃，释放 socket
          done(null);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        // 任何提前关闭（含下面 oversize destroy）都兜底 done(null)，防 promise 永挂死整条刷新链
        res.on('close', () => done(null));
        res.on('data', (c) => {
          body += c;
          // 防异常大响应（如劫持页/portal/WAF 的大 HTML）。必须带 error 参数，否则 destroy() 不发
          // error/end 事件 → done 永不调用 → enqueue 的 inflight 永挂、IP 卡永久转圈（review P1）。
          if (body.length > 8192) req.destroy(new Error('oversize'));
        });
        res.on('end', () => done(body));
      });

      req.on('error', () => done(null));
      req.on('timeout', () => {
        req.destroy();
        done(null);
      });
    });
  }
}

/** JSON 端点解析（ip-api / ipip / ipify）。解析失败或字段缺失返 null（走 fallback）。 */
function parseJson(body: string): IpInfo | null {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    // ip-api：{status:'success', query, country, countryCode}
    if (j && j.status === 'success' && typeof j.query === 'string') {
      return {
        ip: j.query,
        country: typeof j.country === 'string' ? j.country : undefined,
        countryCode: typeof j.countryCode === 'string' ? j.countryCode : undefined,
      };
    }
    // ipip：{ret:'ok', data:{ip, location:[国,省,市,区,ISP]}}
    if (j && j.ret === 'ok' && j.data && typeof j.data === 'object') {
      const d = j.data as { ip?: unknown; location?: unknown };
      if (typeof d.ip === 'string') {
        const raw = Array.isArray(d.location)
          ? d.location.filter((s): s is string => typeof s === 'string')
          : [];
        const parts = raw.filter((s) => s.length > 0);
        return {
          ip: d.ip,
          country: parts.length ? parts.join(' ') : undefined,
          countryCode: ccFromIpipLocation(raw),
        };
      }
    }
    // ipify：{ip}
    if (j && typeof j.ip === 'string') {
      return { ip: j.ip };
    }
    return null;
  } catch {
    return null;
  }
}
