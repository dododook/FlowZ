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
import type { IpInfoSnapshot } from '../../../shared/types';

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
      }
    );
    return { svc, snapshots };
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

  beforeEach(() => {
    installHttp();
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
    expect(c.options.timeout).toBe(5000);
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

  it('queryViaProxy：PROXY_CHAIN 首跳 trace 成功即返回，不再试 ip-api/ipify', async () => {
    const { svc } = makeService();
    responders = [respondOk(TRACE_OK)];
    const snap = await svc.refreshProxy();
    expect(snap.proxy).toEqual({ ip: '104.28.210.15', countryCode: 'US' });
    expect(calls.length).toBe(1); // 首跳成功即短路
    expect(hostOf(calls[0].options)).toBe('cloudflare.com');
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
});
