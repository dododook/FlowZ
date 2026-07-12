/**
 * IpInfoService 单测。
 *
 * 第一部分 parseTrace：Cloudflare /cdn-cgi/trace 纯文本（多行 key=value）解析。
 *   仅取 ip + countryCode（不取 colo）；ip 经 net.isIP 校验、loc 经 /^[A-Z]{2}$/ 且 !=XX 校验。
 *   异常/劫持/截断响应须返 null 走 fallback，绝不返回脏 IP。
 *
 * 第二部分 传输层（httpText / fetchEndpoint / viaProbe / bare / queryDirectChain）：mock node `http.get`，
 *   用受控的 fake req/res（EventEmitter）逐个驱动事件，覆盖 httpText 四件套兜底（statusCode!==200 / oversize /
 *   timeout / close 提前关闭）+ 正常 200，以及 fetchEndpoint 按 ep.parse 分发（json→parseJson / trace→parseTrace）、
 *   viaProbe absolute-form 请求形态、bare 直连、queryDirectChain 主用 ipip 且不含 trace 端点。
 *   这些方法均私有，经公开 API（refresh / refreshProxy）触达。
 */
import { EventEmitter } from 'events';
import * as http from 'http';

jest.mock('http');

import { parseTrace, IpInfoService } from '../IpInfoService';
import type { IpInfoSnapshot, ProxyExitBlock } from '../../../shared/types';

// 真实 ~196B trace 响应样本（含 fl/h/ip/ts/visit_scheme/uag/colo/sliver/http/loc/tls/sni/warp/gateway/rbi/kex）
const REAL_SAMPLE = `fl=123abc
h=cloudflare.com
ip=104.28.210.15
ts=1718200000.123
visit_scheme=http
uag=node
colo=LAX
sliver=none
http=http/1.1
loc=US
tls=off
sni=off
warp=off
gateway=off
rbi=off
kex=none`;

describe('parseTrace', () => {
  it('解析真实样本：取出 ip + countryCode，且不含 colo', () => {
    const r = parseTrace(REAL_SAMPLE);
    expect(r).not.toBeNull();
    expect(r!.ip).toBe('104.28.210.15');
    expect(r!.countryCode).toBe('US');
    // colo 不进结果：IpInfo 无 colo 字段，且解析只返回 ip + countryCode
    expect(r as unknown as Record<string, unknown>).not.toHaveProperty('colo');
    expect(r!.country).toBeUndefined();
  });

  it('忽略空行 + 首尾空白，仍正确解析', () => {
    const body = '\n\n  ip=1.2.3.4  \n\n loc=jp \n\n';
    const r = parseTrace(body);
    expect(r).not.toBeNull();
    expect(r!.ip).toBe('1.2.3.4');
    expect(r!.countryCode).toBe('JP'); // loc 小写 → 大写
  });

  it('解析 IPv6 ip', () => {
    const r = parseTrace('ip=2606:4700:4700::1111\nloc=US');
    expect(r).not.toBeNull();
    expect(r!.ip).toBe('2606:4700:4700::1111');
    expect(r!.countryCode).toBe('US');
  });

  it('缺 ip 行 → 返 null（走 fallback）', () => {
    expect(parseTrace('fl=123abc\nloc=US\ncolo=LAX')).toBeNull();
  });

  it('ip 非法（劫持页假值/格式错误）→ 返 null', () => {
    expect(parseTrace('ip=not-an-ip\nloc=US')).toBeNull();
    expect(parseTrace('ip=999.999.999.999\nloc=US')).toBeNull();
    expect(parseTrace('ip=\nloc=US')).toBeNull();
  });

  it('loc=XX（CF 未知地区）→ countryCode undefined，ip 仍取', () => {
    const r = parseTrace('ip=104.28.210.15\nloc=XX');
    expect(r).not.toBeNull();
    expect(r!.ip).toBe('104.28.210.15');
    expect(r!.countryCode).toBeUndefined();
  });

  it('loc 非法格式（非两位字母）→ countryCode undefined', () => {
    expect(parseTrace('ip=1.2.3.4\nloc=USA')!.countryCode).toBeUndefined();
    expect(parseTrace('ip=1.2.3.4\nloc=U1')!.countryCode).toBeUndefined();
    expect(parseTrace('ip=1.2.3.4')!.countryCode).toBeUndefined(); // 缺 loc
  });

  it('劫持/portal HTML 页（无合法 ip= 行）→ 返 null', () => {
    const html =
      '<!DOCTYPE html>\n<html><head><title>Login</title></head>\n<body>ip=login</body></html>';
    expect(parseTrace(html)).toBeNull();
  });

  it('截断响应（ip 行被切断成非法值）→ 返 null', () => {
    // 响应在 ip 值中途被截断，得到非法 IP
    expect(parseTrace('fl=123\nh=cloudflare.com\nip=104.28.21')).toBeNull();
  });

  it('截断在 ip 行之前（连 ip 行都没有）→ 返 null', () => {
    expect(parseTrace('fl=123\nh=cloudflare.com\nts=171820000')).toBeNull();
  });

  it('value 含 = 时只按首个 = 切分', () => {
    const r = parseTrace('ip=1.2.3.4\nkex=a=b=c\nloc=US');
    expect(r).not.toBeNull();
    expect(r!.ip).toBe('1.2.3.4');
    expect(r!.countryCode).toBe('US');
  });

  it('空 body → 返 null', () => {
    expect(parseTrace('')).toBeNull();
    expect(parseTrace('\n\n  \n')).toBeNull();
  });

  it('CRLF 行尾：split("\\n")+trim 吃掉 \\r，ip 干净无 \\r、countryCode 正确', () => {
    const r = parseTrace('ip=1.2.3.4\r\nloc=US\r\n');
    expect(r).not.toBeNull();
    expect(r!.ip).toBe('1.2.3.4'); // 不带尾随 \r
    expect(r!.ip).not.toContain('\r');
    expect(r!.countryCode).toBe('US'); // 不是 'US\r' → 通过 /^[A-Z]{2}$/ 校验
  });

  it('CRLF：value 含 \\r 经 trim 清除（含 IPv6）', () => {
    const r = parseTrace('fl=123\r\nip=2606:4700:4700::1111\r\nloc=us\r\ncolo=LAX\r\n');
    expect(r).not.toBeNull();
    expect(r!.ip).toBe('2606:4700:4700::1111');
    expect(r!.ip).not.toContain('\r');
    expect(r!.countryCode).toBe('US');
  });
});

// ============================================================================
// 传输层（httpText / fetchEndpoint / viaProbe / bare / queryDirectChain）
// ============================================================================

/** 受控 fake response：EventEmitter + statusCode + setEncoding(no-op) + resume(记录调用)。 */
class FakeRes extends EventEmitter {
  statusCode = 200;
  resumed = false;
  setEncoding = jest.fn();
  resume = jest.fn(() => {
    this.resumed = true;
  });
}

/** 受控 fake request：EventEmitter + destroy（带 error 参数即模拟 node 行为 emit 'error'）。 */
class FakeReq extends EventEmitter {
  destroyed = false;
  destroyError: Error | null = null;
  destroy = jest.fn((err?: Error) => {
    this.destroyed = true;
    if (err) {
      this.destroyError = err;
      // node 真实行为：destroy(err) 会在 req 上 emit 'error'（带参 destroy 不发 end/close）
      this.emit('error', err);
    }
  });
}

interface Call {
  options: http.RequestOptions;
  req: FakeReq;
  res: FakeRes;
}

/** 安全读取请求 Host 头（RequestOptions.headers 类型含 string[] 分支）。生产代码只用对象形态。 */
function hostOf(options: http.RequestOptions): string | undefined {
  const h = options.headers;
  if (!h || Array.isArray(h)) return undefined;
  return (h as Record<string, unknown>).Host as string | undefined;
}

/**
 * 一次 http.get 调用的「驱动器」：statusCode 在 cb(res) 之前设好（生产代码在 cb 内即读 statusCode），
 * drive 在 cb(res) 之后 emit 事件（此时 res 的 data/end/close、req 的 error/timeout 监听已挂好）。
 * 链式调用按序消费驱动器队列，逐个端点精确控制走到哪个分支。
 */
interface Responder {
  statusCode: number;
  drive: (call: Call) => void;
}

/** 正常 200 + 完整 body：emit data*N + end。 */
function respondOk(body: string): Responder {
  return {
    statusCode: 200,
    drive: ({ res }) => {
      res.emit('data', body);
      res.emit('end');
    },
  };
}

/** statusCode !== 200：cb 内即 res.resume 排空 + done(null)，不发 data/end。 */
function respondStatus(code: number): Responder {
  return { statusCode: code, drive: () => {} };
}

/** oversize：分块累计 > 8192 触发 req.destroy(Error('oversize')) → req emit 'error' → done(null)。 */
function respondOversize(): Responder {
  return {
    statusCode: 200,
    drive: ({ res }) => {
      res.emit('data', 'a'.repeat(5000));
      res.emit('data', 'b'.repeat(5000)); // 累计 10000 > 8192 → destroy('oversize')
    },
  };
}

/** timeout：req emit 'timeout' → req.destroy() + done(null)。 */
function respondTimeout(): Responder {
  return { statusCode: 200, drive: ({ req }) => req.emit('timeout') };
}

/** error：req emit 'error' → done(null)（如 ECONNREFUSED）。 */
function respondReqError(): Responder {
  return { statusCode: 200, drive: ({ req }) => req.emit('error', new Error('ECONNREFUSED')) };
}

/** close 兜底：200 但不发 end，直接 res emit 'close' → done(null)，promise 不挂死。 */
function respondCloseNoEnd(): Responder {
  return {
    statusCode: 200,
    drive: ({ res }) => {
      res.emit('data', 'partial'); // 收到部分 body 后连接被对端提前关闭
      res.emit('close');
    },
  };
}

describe('IpInfoService 传输层', () => {
  const mockGet = http.get as unknown as jest.Mock;
  let responders: Responder[];
  let calls: Call[];

  /** 安装 http.get mock：每次调用记录 options、构造 fake req/res，异步执行 cb(res) 后由当前 responder 驱动。 */
  function installHttp() {
    responders = [];
    calls = [];
    mockGet.mockReset();
    mockGet.mockImplementation(
      (options: http.RequestOptions, cb?: (res: FakeRes) => void): FakeReq => {
        const req = new FakeReq();
        const res = new FakeRes();
        const call: Call = { options, req, res };
        calls.push(call);
        const responder = responders.shift();
        if (responder) res.statusCode = responder.statusCode; // cb 内即读 statusCode，须先设好
        // cb(res) 异步触发（贴近真实 http.get），让 httpText 先挂好 req 的 error/timeout 监听
        process.nextTick(() => {
          if (cb) cb(res);
          if (responder) responder.drive(call);
        });
        return req;
      }
    );
  }

  /** 构造一个 service：默认 running + 探针端口可用；onUpdate 收集快照。
   *  默认 maxAttempts=1/delay=0 → 还原「单次探测」行为，传输层用例的固定 responder 队列不受重试影响；
   *  需测重试的用例显式传 maxAttempts>1。 */
  function makeService(opts?: {
    ports?: { direct: number; proxy: number } | null;
    running?: boolean;
    maxAttempts?: number;
    retryDelayMs?: number;
    postConnectMaxAttempts?: number;
    postConnectRetryDelayMs?: number;
    directMaxAttempts?: number;
    directRetryDelayMs?: number;
    proxyExitBlock?: () => ProxyExitBlock | null;
  }) {
    const snapshots: IpInfoSnapshot[] = [];
    const svc = new IpInfoService(
      () => (opts?.ports === undefined ? { direct: 18080, proxy: 18081 } : opts.ports),
      () => opts?.running ?? true,
      (s) => snapshots.push(s),
      {
        maxAttempts: opts?.maxAttempts ?? 1,
        retryDelayMs: opts?.retryDelayMs ?? 0,
        // post-connect 预算默认与常规分开（首连专用更宽退避）；用例显式传，delay 取 0 免实时间等待。
        postConnectMaxAttempts: opts?.postConnectMaxAttempts ?? 1,
        postConnectRetryDelayMs: opts?.postConnectRetryDelayMs ?? 0,
        // direct 链预算默认还原单跳（同 maxAttempts）；测 B 宽预算的用例显式传。
        directMaxAttempts: opts?.directMaxAttempts ?? 1,
        directRetryDelayMs: opts?.directRetryDelayMs ?? 0,
      },
      opts?.proxyExitBlock
    );
    return { svc, snapshots };
  }

  /** 按 host 路由 responder（多 host 交错场景，如 direct+proxy 并测）：reset mock，每 host 一个 responder。 */
  function routeByHost(map: Record<string, Responder>): void {
    mockGet.mockReset();
    mockGet.mockImplementation(
      (options: http.RequestOptions, cb?: (res: FakeRes) => void): FakeReq => {
        const req = new FakeReq();
        const res = new FakeRes();
        const call: Call = { options, req, res };
        calls.push(call);
        const responder = map[hostOf(options) ?? ''];
        if (responder) res.statusCode = responder.statusCode;
        process.nextTick(() => {
          if (cb) cb(res);
          if (responder) responder.drive(call);
        });
        return req;
      }
    );
  }

  const IPIP_OK = JSON.stringify({
    ret: 'ok',
    data: { ip: '1.2.3.4', location: ['中国', '北京'] },
  });
  const IPAPI_OK = JSON.stringify({
    status: 'success',
    query: '5.6.7.8',
    country: 'United States',
    countryCode: 'US',
  });
  const TRACE_OK = 'ip=104.28.210.15\nloc=US\ncolo=LAX';
  const TRACE_OK2 = 'ip=5.5.5.5\nloc=JP\ncolo=NRT'; // 第二出口样本：验 visible 重探探到「新」proxy IP

  beforeEach(() => {
    installHttp();
  });

  describe('TS 出口无效直判 gate（proxyBlocked 短路，不空转探测）', () => {
    it('proxyExitBlock 非空 → refreshProxy 短路不探测，落 proxyBlocked 终态（proxy null / loading false / error 空）', async () => {
      // responders 为空：若 gate 失效真去探测会失败落 error='fetch_failed'；断言 error 空 + proxyBlocked 证明短路生效。
      responders = [];
      const { svc } = makeService({ proxyExitBlock: () => 'ts-no-exit-device' });
      const snap = await svc.refreshProxy();
      expect(snap.proxy).toBeNull();
      expect(snap.proxyBlocked).toBe('ts-no-exit-device');
      expect(snap.loading).toBe(false);
      expect(snap.error).toBeUndefined();
    });
    it('markProxyBlocked → 立即落 proxyBlocked 终态（翻转对账用）', () => {
      const { svc } = makeService();
      svc.markProxyBlocked('ts-exit-device-offline');
      const snap = svc.getSnapshot();
      expect(snap.proxyBlocked).toBe('ts-exit-device-offline');
      expect(snap.proxy).toBeNull();
      expect(snap.loading).toBe(false);
      expect(snap.error).toBeUndefined();
    });
  });

  describe('出口伴测 hook（onProxyProbeSuccess：代理出口探测成功后触发，供伴测更新节点延迟）', () => {
    /** 注入 onProxyProbeSuccess 的 service；hook 记录 manual + 触发时刻可见的 proxy 快照（验「onUpdate 之后」）。 */
    function hookHarness(opts?: {
      running?: boolean;
      proxyExitBlock?: () => ProxyExitBlock | null;
    }) {
      const snapshots: IpInfoSnapshot[] = [];
      const hookCalls: Array<{ manual: boolean; proxyAtCall: IpInfoSnapshot['proxy'] }> = [];
      const svc = new IpInfoService(
        () => ({ direct: 18080, proxy: 18081 }),
        () => opts?.running ?? true,
        (s) => snapshots.push(s),
        {
          maxAttempts: 1,
          retryDelayMs: 0,
          postConnectMaxAttempts: 1,
          postConnectRetryDelayMs: 0,
          directMaxAttempts: 1,
          directRetryDelayMs: 0,
        },
        opts?.proxyExitBlock,
        (ctx) =>
          hookCalls.push({
            manual: ctx.manual,
            proxyAtCall: snapshots[snapshots.length - 1]?.proxy,
          })
      );
      return { svc, hookCalls };
    }

    it('refreshProxy 成功 → hook 调用一次(manual=false)，且在 onUpdate 之后（proxy IP 已在快照）', async () => {
      const { svc, hookCalls } = hookHarness();
      routeByHost({ 'cloudflare.com': respondOk(TRACE_OK) });
      await svc.refreshProxy();
      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0].manual).toBe(false);
      expect(hookCalls[0].proxyAtCall).toEqual({ ip: '104.28.210.15', countryCode: 'US' });
    });

    it('refreshProxy 探测失败 → hook 不调用（p==null 分支）', async () => {
      const { svc, hookCalls } = hookHarness();
      // 三个代理端点均 503 失败（须显式映射：未映射 host 的 FakeRes 默认 200 不 emit end 会挂死）。
      routeByHost({
        'cloudflare.com': respondStatus(503),
        'ip-api.com': respondStatus(503),
        'api.ipify.org': respondStatus(503),
      });
      await svc.refreshProxy();
      expect(hookCalls).toHaveLength(0);
    });

    it('refreshProxy 直判无效(blocked) → 短路、hook 不调用', async () => {
      const { svc, hookCalls } = hookHarness({ proxyExitBlock: () => 'ts-no-exit-device' });
      routeByHost({ 'cloudflare.com': respondOk(TRACE_OK) });
      await svc.refreshProxy();
      expect(hookCalls).toHaveLength(0);
    });

    it('doRefresh(visible=true) proxy 腿成功 → hook 调用(manual=true)', async () => {
      const { svc, hookCalls } = hookHarness();
      routeByHost({ 'myip.ipip.net': respondOk(IPIP_OK), 'cloudflare.com': respondOk(TRACE_OK) });
      await svc.refresh(true, true);
      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0].manual).toBe(true);
    });

    it('doRefresh proxy 腿失败(保留旧值) → hook 不调用', async () => {
      const { svc, hookCalls } = hookHarness();
      // direct(ipip) 成功、三个代理端点 503 失败 → proxyProbed=false（须显式映射失败，未映射会挂死）。
      routeByHost({
        'myip.ipip.net': respondOk(IPIP_OK),
        'cloudflare.com': respondStatus(503),
        'ip-api.com': respondStatus(503),
        'api.ipify.org': respondStatus(503),
      });
      await svc.refresh(true, false);
      expect(hookCalls).toHaveLength(0);
    });

    it('S3（§13.2 GAP-B）：doRefresh 期间 markProxyConnecting（gen 递增）→ 跨代半让位：只合并 direct、保留检测中 proxy 面、不触发伴测', async () => {
      const { svc, hookCalls } = hookHarness();
      routeByHost({ 'myip.ipip.net': respondOk(IPIP_OK), 'cloudflare.com': respondOk(TRACE_OK) });
      const p = svc.refresh(true); // doRefresh 起、两链 http.get 已同步发出、await 中
      svc.markProxyConnecting(); // 跨代：probeGeneration++ + 置 proxy=null/loading=true（新会话接管 proxy 面）
      await p;
      const snap = svc.getSnapshot();
      // 半让位：保留 markProxyConnecting 的「检测中」proxy 面，不写探到的 proxy IP（TRACE_OK 104.28.210.15）
      expect(snap.loading).toBe(true);
      expect(snap.proxy).toBeNull();
      // direct 腿仍合并（停核路径主产出，不被让位丢弃）
      expect(snap.direct).toEqual({ ip: '1.2.3.4', country: '中国 北京', countryCode: 'cn' });
      // 伴测不触发（断陈旧 doRefresh → cross-attribution 第二腿）
      expect(hookCalls).toHaveLength(0);
    });
  });

  // --- httpText 四件套兜底 + 正常 200 ----------------------------------------

  it('正常 200 + 完整 body：httpText 返回文本，端点解析出 IP', async () => {
    // 核心未运行 → 走 bare 直连链，第一跳 ipip 即成功（带 countryCode=cn）
    const { svc, snapshots } = makeService({ running: false });
    responders = [respondOk(IPIP_OK)];
    const snap = await svc.refresh(true);
    expect(snap.direct).toEqual({ ip: '1.2.3.4', country: '中国 北京', countryCode: 'cn' });
    expect(snap.error).toBeUndefined();
    expect(snapshots[snapshots.length - 1].direct).toEqual(snap.direct);
  });

  it('statusCode !== 200：res.resume 排空 + done(null) → 端点返 null（不发 data/end）', async () => {
    const { svc } = makeService({ running: false });
    // direct 链只测国内端点 ipip（绝不 fallback 国外）→ ipip 403 → direct null + error
    responders = [respondStatus(403)];
    const snap = await svc.refresh(true);
    expect(snap.direct).toBeNull();
    expect(snap.error).toBe('fetch_failed');
    expect(calls.length).toBe(1); // 仅 ipip 一跳
    expect(calls[0].res.resume).toHaveBeenCalled(); // 触发 res.resume（排空丢弃释放 socket）
  });

  it('oversize：body 累计 > 8192 → req.destroy(Error("oversize")) → done(null)', async () => {
    const { svc } = makeService({ running: false });
    // ipip oversize → null；后续 ipapi/ipify 正常失败（status），全链 null
    responders = [respondOversize(), respondStatus(404), respondStatus(404)];
    const snap = await svc.refresh(true);
    expect(snap.direct).toBeNull();
    expect(snap.error).toBe('fetch_failed');
    // 第一跳触发了带 oversize error 的 destroy
    expect(calls[0].req.destroy).toHaveBeenCalled();
    expect(calls[0].req.destroyError?.message).toBe('oversize');
  });

  it('timeout：req emit timeout → req.destroy() + done(null)', async () => {
    const { svc } = makeService({ running: false });
    responders = [respondTimeout(), respondStatus(404), respondStatus(404)];
    const snap = await svc.refresh(true);
    expect(snap.direct).toBeNull();
    expect(snap.error).toBe('fetch_failed');
    // timeout 分支 destroy()（无 error 参数）
    expect(calls[0].req.destroy).toHaveBeenCalled();
    expect(calls[0].req.destroyError).toBeNull();
  });

  it('close 兜底：200 但无 end 直接 close → done(null)，promise 正常 resolve 不挂死', async () => {
    const { svc } = makeService({ running: false });
    responders = [respondCloseNoEnd(), respondStatus(404), respondStatus(404)];
    // 若 close 不兜底 done(null)，refresh 永不 resolve → 此 await 超时；能 resolve 即证明不挂死
    const snap = await svc.refresh(true);
    expect(snap.direct).toBeNull();
    expect(snap.error).toBe('fetch_failed');
  });

  it('req error（ECONNREFUSED）→ done(null)', async () => {
    const { svc } = makeService({ running: false });
    responders = [respondReqError(), respondStatus(404), respondStatus(404)];
    const snap = await svc.refresh(true);
    expect(snap.direct).toBeNull();
    expect(snap.error).toBe('fetch_failed');
  });

  // --- fetchEndpoint 按 ep.parse 分发 ---------------------------------------

  it('fetchEndpoint：json 端点 → 走 parseJson（ip-api success 结构；经 proxy 链 CF 失败 fallback 到 ip-api）', async () => {
    const { svc } = makeService(); // running + ports → proxy 链（direct 链只 ipip，已不走 ip-api）
    // proxy 链 PROXY_CHAIN=[CF_TRACE, IPAPI, IPIFY]：CF trace 503 → ip-api success → parseJson 出 country/countryCode
    responders = [respondStatus(503), respondOk(IPAPI_OK)];
    const snap = await svc.refreshProxy();
    expect(snap.proxy).toEqual({ ip: '5.6.7.8', country: 'United States', countryCode: 'US' });
  });

  it('fetchEndpoint：trace 端点（EP_CF_TRACE）→ 走 parseTrace（proxy 链首跳）', async () => {
    const { svc } = makeService(); // running + ports → 走探针链
    // direct 链：ipip 直接成功（带 cn）→ 只 1 跳；proxy 链：trace 首跳成功
    // doRefresh 并发跑 direct+proxy 两条链，responder 队列按 http.get 调用顺序消费。
    // 两条链各自串行，但相互交错——用「按 host 路由」responder 更稳。
    mockGet.mockReset();
    const byHost: Record<string, Responder> = {
      'myip.ipip.net': respondOk(IPIP_OK),
      'cloudflare.com': respondOk(TRACE_OK),
    };
    mockGet.mockImplementation(
      (options: http.RequestOptions, cb?: (res: FakeRes) => void): FakeReq => {
        const req = new FakeReq();
        const res = new FakeRes();
        const call: Call = { options, req, res };
        calls.push(call);
        const host = hostOf(options) ?? '';
        const responder = byHost[host];
        if (responder) res.statusCode = responder.statusCode;
        process.nextTick(() => {
          if (cb) cb(res);
          if (responder) responder.drive(call);
        });
        return req;
      }
    );
    const snap = await svc.refresh(true);
    // direct = ipip（json→parseJson），proxy = trace（trace→parseTrace 出 countryCode=US，无 country）
    expect(snap.direct).toEqual({ ip: '1.2.3.4', country: '中国 北京', countryCode: 'cn' });
    expect(snap.proxy).toEqual({ ip: '104.28.210.15', countryCode: 'US' });
    expect(snap.proxy!.country).toBeUndefined(); // trace 不派生国家名
    expect(snap.error).toBeUndefined();
  });

  // --- viaProbe absolute-form 请求形态 / bare 直连 --------------------------

  it('viaProbe：经探针端口、absolute-form path、Host/Connection 头、timeout', async () => {
    const { svc } = makeService(); // running + ports
    // refreshProxy 只测代理链，首跳 trace 成功
    responders = [respondOk(TRACE_OK)];
    await svc.refreshProxy();
    const c = calls[0];
    // absolute-form：发往 127.0.0.1:proxyPort，path 为完整 URL，带 Host 头
    expect(c.options.hostname).toBe('127.0.0.1');
    expect(c.options.port).toBe(18081);
    expect(c.options.path).toBe('http://cloudflare.com/cdn-cgi/trace');
    expect(c.options.headers).toMatchObject({ Host: 'cloudflare.com', Connection: 'close' });
    expect(c.options.timeout).toBe(6000); // 单请求超时（REQ_TIMEOUT_MS，用户定 6s）
  });

  it('bare：直连目标 host:80、origin-form path（核心未运行）', async () => {
    const { svc } = makeService({ running: false });
    responders = [respondOk(IPIP_OK)];
    await svc.refresh(true);
    const c = calls[0];
    expect(c.options.hostname).toBe('myip.ipip.net'); // 直连目标域名（非 127.0.0.1）
    expect(c.options.port).toBe(80);
    expect(c.options.path).toBe('/json'); // origin-form（非 absolute-form）
    expect(c.options.headers).toMatchObject({ Host: 'myip.ipip.net', Connection: 'close' });
  });

  // --- queryDirectChain：主用 ipip，链不含 trace 端点 -----------------------

  it('queryDirectChain：本地出口只测国内端点 ipip，失败也绝不 fallback 到国外端点（透明分流会劫走误标境外）', async () => {
    const { svc } = makeService({ running: false, maxAttempts: 2, retryDelayMs: 0 });
    // ipip 两跳全 503（maxAttempts=2 重试）；绝不触达 ip-api/ipify/cloudflare（旧实现会 fallback 被劫持）
    responders = [respondStatus(503), respondStatus(503)];
    const snap = await svc.refresh(true);
    const hosts = calls.map((c) => hostOf(c.options));
    expect(hosts.every((h) => h === 'myip.ipip.net')).toBe(true); // 全是 ipip（含重试）
    expect(hosts).not.toContain('ip-api.com');
    expect(hosts).not.toContain('api.ipify.org');
    expect(hosts).not.toContain('cloudflare.com');
    expect(snap.direct).toBeNull(); // 国内端点失败 → 暂无，不显错误境外 IP
  });

  it('queryDirectChain：ipip 成功但缺 countryCode（境外直连出口/国内库无码）→ 返回 ipip 的 IP，不取 ip-api 增补', async () => {
    const { svc } = makeService({ running: false });
    responders = [respondOk(JSON.stringify({ ip: '9.9.9.9' }))]; // 只 ipip，只给 ip → 缺 countryCode
    const snap = await svc.refresh(true);
    expect(snap.direct?.ip).toBe('9.9.9.9'); // 用 ipip 的 IP（正确直连出口）
    expect(snap.direct?.countryCode).toBeUndefined(); // 缺码由渲染端 Globe 兜底，不取被劫持的 ip-api 码
    expect(calls.length).toBe(1); // 不 fallback
    expect(hostOf(calls[0].options)).toBe('myip.ipip.net');
  });

  it('B：running 路径 direct 探测用 directMaxAttempts 宽预算（起核初期 ipip 首跳失败 → 重试后成功取到本地出口）', async () => {
    const { svc } = makeService({ directMaxAttempts: 2, directRetryDelayMs: 0 }); // running + ports
    // direct(ipip)首跳 503、重试成功；proxy(cloudflare trace)成功。按 host + ipip 调用次序路由。
    mockGet.mockReset();
    let ipipN = 0;
    mockGet.mockImplementation(
      (options: http.RequestOptions, cb?: (res: FakeRes) => void): FakeReq => {
        const req = new FakeReq();
        const res = new FakeRes();
        const call: Call = { options, req, res };
        calls.push(call);
        const host = hostOf(options) ?? '';
        let responder: Responder | undefined;
        if (host === 'myip.ipip.net') {
          responder = ipipN++ === 0 ? respondStatus(503) : respondOk(IPIP_OK);
        } else if (host === 'cloudflare.com') {
          responder = respondOk(TRACE_OK);
        }
        if (responder) res.statusCode = responder.statusCode;
        process.nextTick(() => {
          if (cb) cb(res);
          if (responder) responder.drive(call);
        });
        return req;
      }
    );
    const snap = await svc.refresh(true);
    expect(snap.direct).toEqual({ ip: '1.2.3.4', country: '中国 北京', countryCode: 'cn' }); // ipip 重试成功
    const ipipCalls = calls.filter((c) => hostOf(c.options) === 'myip.ipip.net').length;
    expect(ipipCalls).toBe(2); // 首跳 503 + 重试成功（directMaxAttempts=2 生效；默认 1 则不会重试）
  });

  it('B 对照：directMaxAttempts=1 → ipip 首跳失败【不】重试 → 本地出口 null（与上例对照证明注入真生效，非走模块默认）', async () => {
    // 与上例同 mock（ipip 首跳 503、次跳本可成功）但 directMaxAttempts=1：若构造函数忽略注入而用模块默认（4），
    // 会重试到次跳成功 → direct=IPIP_OK / ipipCalls=2，本断言即失败 → 抓住「注入被忽略」回归。
    const { svc } = makeService({ directMaxAttempts: 1, directRetryDelayMs: 0 });
    mockGet.mockReset();
    let ipipN = 0;
    mockGet.mockImplementation(
      (options: http.RequestOptions, cb?: (res: FakeRes) => void): FakeReq => {
        const req = new FakeReq();
        const res = new FakeRes();
        const call: Call = { options, req, res };
        calls.push(call);
        const host = hostOf(options) ?? '';
        let responder: Responder | undefined;
        if (host === 'myip.ipip.net') {
          responder = ipipN++ === 0 ? respondStatus(503) : respondOk(IPIP_OK);
        } else if (host === 'cloudflare.com') {
          responder = respondOk(TRACE_OK);
        }
        if (responder) res.statusCode = responder.statusCode;
        process.nextTick(() => {
          if (cb) cb(res);
          if (responder) responder.drive(call);
        });
        return req;
      }
    );
    const snap = await svc.refresh(true);
    expect(snap.direct).toBeNull(); // 单跳预算：首跳 503 即放弃，不重试
    expect(calls.filter((c) => hostOf(c.options) === 'myip.ipip.net').length).toBe(1); // 仅 1 跳
  });

  it('#2：running 下本地出口(direct)失败但代理出口(proxy)成功 → snapshot 无 error（本地出口不污染降级）', async () => {
    const { svc } = makeService(); // running + ports，direct/proxy 默认单跳
    mockGet.mockReset();
    mockGet.mockImplementation(
      (options: http.RequestOptions, cb?: (res: FakeRes) => void): FakeReq => {
        const req = new FakeReq();
        const res = new FakeRes();
        const call: Call = { options, req, res };
        calls.push(call);
        const host = hostOf(options) ?? '';
        let responder: Responder | undefined;
        if (host === 'myip.ipip.net') {
          responder = respondStatus(503); // 本地出口探测失败
        } else if (host === 'cloudflare.com') {
          responder = respondOk(TRACE_OK); // 代理出口探测成功
        }
        if (responder) res.statusCode = responder.statusCode;
        process.nextTick(() => {
          if (cb) cb(res);
          if (responder) responder.drive(call);
        });
        return req;
      }
    );
    const snap = await svc.refresh(true);
    expect(snap.direct).toBeNull(); // 本地出口暂无（IPIP 失败、不 fallback）
    expect(snap.proxy).toEqual({ ip: '104.28.210.15', countryCode: 'US' }); // 代理出口正常
    expect(snap.error).toBeUndefined(); // ★ direct 失败【不】触发全局 error → 导流脊不误显降级
  });

  it('#361：running 下【非 visible/被动】刷新代理出口探测失败 → 保留旧 proxy 值 + error（同节点手刷/TTL 不清有效旧 IP）', async () => {
    // 非 visible 路径（被动 TTL/同节点刷新）复用 refresh(true)→doRefresh 保留旧值语义（L361-363），与 visible 手动
    // 重探（头部清出口→失败落检测超时，见 §9 / V2）及 doRefreshProxy 切节点语义（清旧值）均不同。被动路径不闪、保留旧值。
    const { svc } = makeService(); // running + ports，direct/proxy 默认单跳
    // 1) seed：direct + proxy 均成功 → 旧 proxy = {104.28.210.15, US}
    routeByHost({ 'myip.ipip.net': respondOk(IPIP_OK), 'cloudflare.com': respondOk(TRACE_OK) });
    const seed = await svc.refresh(true);
    expect(seed.proxy).toEqual({ ip: '104.28.210.15', countryCode: 'US' });
    expect(seed.error).toBeUndefined();
    // 2) 二次手刷：proxy 链 3 端点全 503（探测失败）、direct(ipip) 仍成功
    routeByHost({
      'myip.ipip.net': respondOk(IPIP_OK),
      'cloudflare.com': respondStatus(503),
      'ip-api.com': respondStatus(503),
      'api.ipify.org': respondStatus(503),
    });
    const snap = await svc.refresh(true);
    expect(snap.proxy).toEqual({ ip: '104.28.210.15', countryCode: 'US' }); // ★ 保留旧值（doRefresh 不清）
    expect(snap.error).toBe('fetch_failed'); // 代理失败 → 标降级
    expect(snap.direct).toEqual({ ip: '1.2.3.4', country: '中国 北京', countryCode: 'cn' }); // direct 不受影响
  });

  it('queryViaProxy：PROXY_CHAIN 首跳 trace 成功即返回，不再试 ip-api/ipify', async () => {
    const { svc } = makeService();
    responders = [respondOk(TRACE_OK)];
    const snap = await svc.refreshProxy();
    expect(snap.proxy).toEqual({ ip: '104.28.210.15', countryCode: 'US' });
    expect(calls.length).toBe(1); // 首跳成功即短路
    expect(hostOf(calls[0].options)).toBe('cloudflare.com');
  });

  // Z2（§12.4.3 GAP②）：probeGeneration supersede——markProxyConnecting 递增代号，入队时捕获的陈旧代任务被超代后
  // 让位（在途不写快照 / 排队者头部零探测直返），只留末次切换真正探测，杜绝快切 N 次的串行冗余探测。
  describe('Z2：探测代 supersede（快切防串行冗余）', () => {
    it('在飞刷新被超代 → 让位不写快照，末代真值胜出（不被陈旧结果覆盖）', async () => {
      const { svc, snapshots } = makeService({ maxAttempts: 1 });
      responders = [respondOk(TRACE_OK), respondOk(TRACE_OK2)];
      svc.markProxyConnecting(); // gen=1
      const pA = svc.refreshProxy(); // taskA 捕获 gen=1，同步跑到 http.get 挂起（shift TRACE_OK）
      svc.markProxyConnecting(); // gen=2 → taskA 被超代
      const pB = svc.refreshProxy(); // taskB 捕获 gen=2，排在 taskA 后
      await Promise.all([pA, pB]);
      // taskA 探到 TRACE_OK 但因超代让位不写；末快照 = taskB 的 TRACE_OK2 出口
      expect(svc.getSnapshot().proxy).toEqual({ ip: '5.5.5.5', countryCode: 'JP' });
      // 全程无任一快照写入 taskA 的 104.28.210.15（陈旧 in-flight 结果被让位丢弃）
      expect(snapshots.some((s) => s.proxy?.ip === '104.28.210.15')).toBe(false);
    });

    it('排在超代之后的陈旧任务头部零探测直返（不新增 http.get）', async () => {
      const { svc } = makeService({ maxAttempts: 1 });
      responders = [respondOk(TRACE_OK), respondOk(TRACE_OK2)];
      svc.markProxyConnecting(); // gen=1
      const pBlock = svc.refreshProxy(); // taskBlock gen=1 → 在飞（shift TRACE_OK）
      svc.markProxyConnecting(); // gen=2
      const pStale = svc.refreshProxy(); // taskStale gen=2 排 taskBlock 后
      svc.markProxyConnecting(); // gen=3 → taskStale 将被超代
      const pFinal = svc.refreshProxy(); // taskFinal gen=3 排 taskStale 后
      await Promise.all([pBlock, pStale, pFinal]);
      // taskStale 头部 gen(2)!==3 → 零 http.get；总调用 = taskBlock(1) + taskFinal(1)，taskStale 贡献 0
      expect(calls.length).toBe(2);
      expect(svc.getSnapshot().proxy).toEqual({ ip: '5.5.5.5', countryCode: 'JP' }); // 末代 taskFinal 写入
    });
  });

  it('重试：代理首轮全失败、次轮成功 → 取到 IP 不报错，且过程出现「获取中」(loading)', async () => {
    // maxAttempts=2：第 1 轮 PROXY_CHAIN 3 端点全 503 失败 → 间隔后第 2 轮首跳 trace 成功。
    const { svc, snapshots } = makeService({ maxAttempts: 2, retryDelayMs: 0 });
    responders = [respondStatus(503), respondStatus(503), respondStatus(503), respondOk(TRACE_OK)];
    const snap = await svc.refreshProxy();
    expect(snap.proxy).toEqual({ ip: '104.28.210.15', countryCode: 'US' }); // 重试后取到
    expect(snap.error).toBeUndefined(); // 不报错（不闪「获取失败」）
    expect(snapshots.some((s) => s.loading === true)).toBe(true); // 重试期间显「获取中」
  });

  it('重试耗尽仍失败 → proxy 保持空 + error（由界面显友好提示，非「获取失败」字样）', async () => {
    const { svc } = makeService({ maxAttempts: 2, retryDelayMs: 0 });
    // 两轮各 3 端点全失败（6 个 503）
    responders = Array.from({ length: 6 }, () => respondStatus(503));
    const snap = await svc.refreshProxy();
    expect(snap.proxy).toBeNull();
    expect(snap.error).toBe('fetch_failed');
  });

  it('markProxyConnecting：立即置 loading=true 并广播（消除启动瞬间闪「代理出口暂不可用」）', () => {
    const { svc, snapshots } = makeService();
    expect(svc.getSnapshot().loading).not.toBe(true);
    svc.markProxyConnecting();
    expect(svc.getSnapshot().loading).toBe(true); // 同步置「获取中」
    expect(snapshots[snapshots.length - 1].loading).toBe(true); // 已广播给渲染端
  });

  // --- 首连 post-connect 更宽退避（item 1：TS/组网首连隧道未就绪兜底）-----------

  it('refreshProxyPostConnect：用 postConnect 预算重试（首连隧道几秒后就绪 → 取到真出口，不闪「暂不可用」）', async () => {
    // 常规 maxAttempts=1（单次即放弃）；postConnect 预算 4 轮 → 隧道在第 4 轮才就绪也能取到。
    const { svc, snapshots } = makeService({
      maxAttempts: 1,
      postConnectMaxAttempts: 4,
      postConnectRetryDelayMs: 0,
    });
    // 前 3 轮（每轮 PROXY_CHAIN 3 端点全 503=隧道未就绪）= 9 个 503，第 4 轮首跳 trace 成功。
    responders = [...Array.from({ length: 9 }, () => respondStatus(503)), respondOk(TRACE_OK)];
    const snap = await svc.refreshProxyPostConnect();
    expect(snap.proxy).toEqual({ ip: '104.28.210.15', countryCode: 'US' }); // 隧道就绪后取到
    expect(snap.error).toBeUndefined(); // 不落 error（界面不闪「暂不可用」）
    expect(snapshots.some((s) => s.loading === true)).toBe(true); // 全程「检测中」转圈
  });

  it('refreshProxyPostConnect：宽预算耗尽仍失败 → proxy 空 + error（隧道终未就绪才放弃）', async () => {
    const { svc } = makeService({ postConnectMaxAttempts: 2, postConnectRetryDelayMs: 0 });
    // 两轮各 3 端点全失败（6 个 503）→ 重试耗尽。
    responders = Array.from({ length: 6 }, () => respondStatus(503));
    const snap = await svc.refreshProxyPostConnect();
    expect(snap.proxy).toBeNull();
    expect(snap.error).toBe('fetch_failed');
  });

  it('常规 refreshProxy 不受 postConnect 宽预算影响（仍用 maxAttempts，不拖累手动刷新/切节点）', async () => {
    // postConnect 给 4 轮，但常规 refreshProxy 用 maxAttempts=1 → 单次失败即放弃（不会多探）。
    const { svc } = makeService({
      maxAttempts: 1,
      postConnectMaxAttempts: 4,
      postConnectRetryDelayMs: 0,
    });
    // 仅给 1 轮 PROXY_CHAIN 的 3 个 503；若误用宽预算会要求更多 responder（队列空=null responder）。
    responders = [respondStatus(503), respondStatus(503), respondStatus(503)];
    const snap = await svc.refreshProxy();
    expect(snap.proxy).toBeNull();
    expect(snap.error).toBe('fetch_failed');
    expect(calls.length).toBe(3); // 只探了 1 轮（3 端点），未走宽预算的多轮重试
  });

  // --- §9 可见「检测中」重探（visible 档：清当前出口→检测中→结果/超时/出口无效）------------------
  const PROXY_HOSTS = ['cloudflare.com', 'ip-api.com', 'api.ipify.org'];

  it('V1：visible+running 成功 → 首广播清 proxy(检测中)+保留 direct+updatedAt 不推进；终广播探到新 proxy', async () => {
    const { svc, snapshots } = makeService(); // running + ports
    routeByHost({ 'myip.ipip.net': respondOk(IPIP_OK), 'cloudflare.com': respondOk(TRACE_OK) });
    await svc.refresh(true); // seed 旧 direct+proxy
    const seededUpdatedAt = svc.getSnapshot().updatedAt;
    const base = snapshots.length;
    // 可见重探：proxy 探到「新」出口 5.5.5.5、direct 不变
    routeByHost({ 'myip.ipip.net': respondOk(IPIP_OK), 'cloudflare.com': respondOk(TRACE_OK2) });
    await svc.refresh(true, true);
    const first = snapshots[base];
    expect(first.proxy).toBeNull(); // 清出口 → pickStatusBarExit !info → 检测中
    expect(first.loading).toBe(true);
    expect(first.direct).toEqual({ ip: '1.2.3.4', country: '中国 北京', countryCode: 'cn' }); // direct 保留
    expect(first.updatedAt).toBe(seededUpdatedAt); // 清值不推 updatedAt（同 markProxyConnecting）
    const last = snapshots[snapshots.length - 1];
    expect(last.proxy).toEqual({ ip: '5.5.5.5', countryCode: 'JP' }); // 探到新出口
    expect(last.loading).toBe(false);
  });

  it('V2：visible+running 探测全失败 → 检测超时（终态 proxy:null+error，旧 proxy 已丢）；direct 保留', async () => {
    const { svc, snapshots } = makeService();
    routeByHost({ 'myip.ipip.net': respondOk(IPIP_OK), 'cloudflare.com': respondOk(TRACE_OK) });
    await svc.refresh(true); // seed
    const base = snapshots.length;
    routeByHost({
      'myip.ipip.net': respondOk(IPIP_OK),
      'cloudflare.com': respondStatus(503),
      'ip-api.com': respondStatus(503),
      'api.ipify.org': respondStatus(503),
    });
    const snap = await svc.refresh(true, true);
    expect(snapshots[base].proxy).toBeNull(); // 首广播已清（检测中）
    expect(snapshots[base].loading).toBe(true);
    expect(snap.proxy).toBeNull(); // 终态：旧 proxy 丢（不保留）= 用户要的可见失败
    expect(snap.error).toBe('fetch_failed');
    expect(snap.direct).toEqual({ ip: '1.2.3.4', country: '中国 北京', countryCode: 'cn' }); // direct 不受影响
  });

  it('V3a：visible+!running direct 成功 → 首广播清 direct(检测中)、终广播探到新 direct', async () => {
    const { svc, snapshots } = makeService({ running: false });
    responders = [respondOk(IPIP_OK)];
    await svc.refresh(true); // seed direct（裸 fetch ipip）
    const base = snapshots.length;
    responders = [
      respondOk(JSON.stringify({ ret: 'ok', data: { ip: '8.8.8.8', location: ['中国', '上海'] } })),
    ];
    const snap = await svc.refresh(true, true);
    expect(snapshots[base].direct).toBeNull(); // 清 direct → 检测中
    expect(snapshots[base].loading).toBe(true);
    expect(snap.direct?.ip).toBe('8.8.8.8'); // 探到新 direct
    expect(snap.proxy).toBeNull();
  });

  it('V3b：visible+!running direct 失败 → 检测超时（direct:null+error，旧值丢）', async () => {
    const { svc, snapshots } = makeService({ running: false });
    responders = [respondOk(IPIP_OK)];
    await svc.refresh(true); // seed
    const base = snapshots.length;
    responders = [respondStatus(503)];
    const snap = await svc.refresh(true, true);
    expect(snapshots[base].direct).toBeNull();
    expect(snap.direct).toBeNull();
    expect(snap.error).toBe('fetch_failed');
  });

  it('V4：visible+gate blocked → 首广播 proxyBlocked 保持(invalid 抢占、不闪检测中)+proxy 腿零请求+终态 blocked', async () => {
    const { svc, snapshots } = makeService({ proxyExitBlock: () => 'ts-no-exit-device' }); // running + ports
    routeByHost({ 'myip.ipip.net': respondOk(IPIP_OK) }); // 只 direct；proxy 腿不该被打
    const base = snapshots.length;
    const snap = await svc.refresh(true, true);
    expect(snapshots[base].proxy).toBeNull();
    expect(snapshots[base].proxyBlocked).toBe('ts-no-exit-device'); // 清值取 gate 实时值 → invalid，不闪假检测中
    const proxyCalls = calls.filter((c) => PROXY_HOSTS.includes(hostOf(c.options) ?? '')).length;
    expect(proxyCalls).toBe(0); // proxy 腿零请求（block 短路）
    expect(snap.proxyBlocked).toBe('ts-no-exit-device');
    expect(snap.proxy).toBeNull();
    expect(snap.error).toBeUndefined();
  });

  it('V5：visible+gate 已解除但快照残留 blocked → 首广播清 proxyBlocked(可进检测中真探测)', async () => {
    const { svc, snapshots } = makeService({ proxyExitBlock: () => null }); // gate 已解除
    svc.markProxyBlocked('ts-no-exit-device'); // 快照残留陈旧 blocked
    const base = snapshots.length;
    routeByHost({ 'myip.ipip.net': respondOk(IPIP_OK), 'cloudflare.com': respondOk(TRACE_OK) });
    const snap = await svc.refresh(true, true);
    expect(snapshots[base].proxyBlocked).toBeUndefined(); // 实时读 gate=null → 清陈旧 blocked
    expect(snapshots[base].proxy).toBeNull();
    expect(snapshots[base].loading).toBe(true); // → detecting
    expect(snap.proxy).toEqual({ ip: '104.28.210.15', countryCode: 'US' }); // 正常探到
  });

  it('V6：doRefresh lateBlock（探测中 gate 翻非空）→ shouldAbort 中止 + 落 blocked 终态(非 error，不冲掉并发 markProxyBlocked)', async () => {
    let n = 0;
    // 前 2 次 null（L343 block 读 + attempt0 shouldAbort），第 3 次起非空（attempt1 shouldAbort 中止）
    const gate = (): 'ts-exit-device-offline' | null =>
      ++n >= 3 ? 'ts-exit-device-offline' : null;
    const { svc } = makeService({
      maxAttempts: 2,
      retryDelayMs: 0,
      directMaxAttempts: 1,
      proxyExitBlock: gate,
    });
    routeByHost({
      'myip.ipip.net': respondOk(IPIP_OK),
      'cloudflare.com': respondStatus(503),
      'ip-api.com': respondStatus(503),
      'api.ipify.org': respondStatus(503),
    });
    const snap = await svc.refresh(true); // 非 visible：lateBlock 修复对任意 doRefresh 生效
    expect(snap.proxyBlocked).toBe('ts-exit-device-offline'); // 落 blocked 终态
    expect(snap.error).toBeUndefined(); // 非 error（区分「出口无效」与「探测失败」）
    expect(snap.proxy).toBeNull();
    const proxyCalls = calls.filter((c) => PROXY_HOSTS.includes(hostOf(c.options) ?? '')).length;
    expect(proxyCalls).toBe(3); // 仅 attempt0 的 3 端点；attempt1 被 shouldAbort 中止（未发起）
  });

  it('V7：非 visible refresh(true) 回归锚 → 首广播 direct/proxy 均保留旧值(被动不闪；防清值泛化到被动路径)', async () => {
    const { svc, snapshots } = makeService();
    routeByHost({ 'myip.ipip.net': respondOk(IPIP_OK), 'cloudflare.com': respondOk(TRACE_OK) });
    await svc.refresh(true); // seed
    const base = snapshots.length;
    routeByHost({ 'myip.ipip.net': respondOk(IPIP_OK), 'cloudflare.com': respondOk(TRACE_OK2) });
    await svc.refresh(true); // 非 visible
    const first = snapshots[base];
    expect(first.loading).toBe(true);
    expect(first.direct).toEqual({ ip: '1.2.3.4', country: '中国 北京', countryCode: 'cn' }); // 保留
    expect(first.proxy).toEqual({ ip: '104.28.210.15', countryCode: 'US' }); // 保留旧 proxy（不清）
  });
});
