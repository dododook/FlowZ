/**
 * WarpService 单测（设备移除特性）。覆盖：
 * - register 产出含 warpDevice = { deviceId, token }（破「token 用后即弃」——token 随 draft 回渲染）。
 * - unregister 据 HTTP 状态码经 classifyDeregisterResult 返 done/drop/retry，且**捕获 4xx/5xx 不抛**。
 *
 * mock node `https`（参考 ClashApiClient.test 的 fake req/res 驱动）：仅 mock request，crypto 用真实
 * （register 内 generateKeyPairSync('x25519') 需真实 keypair）。日志红线由「unregister 不打 token」靠代码保证，
 * 此处验返回值语义即可。
 */
import { EventEmitter } from 'events';

const mockRequest = jest.fn();
jest.mock('https', () => ({
  ...jest.requireActual('https'),
  request: (...args: any[]) => mockRequest(...args),
}));

import { WarpService } from '../WarpService';
import { WARP_API_BASE } from '../../../shared/warp';

class FakeRes extends EventEmitter {
  statusCode = 200;
  setEncoding = jest.fn();
}
class FakeReq extends EventEmitter {
  written: unknown[] = [];
  write = jest.fn((p?: unknown) => {
    this.written.push(p);
  });
  end = jest.fn();
  destroy = jest.fn((err?: Error) => {
    this.emit('error', err ?? new Error('socket hang up'));
  });
}

interface Call {
  options: any;
  req: FakeReq;
  res: FakeRes;
}

/** 安装 https.request mock：每次调用按 responders 队列取一个驱动（statusCode + body）。 */
function installHttps(
  responders: Array<{ statusCode: number; body?: string; networkError?: Error }>
): Call[] {
  const calls: Call[] = [];
  mockRequest.mockReset();
  const queue = [...responders];
  mockRequest.mockImplementation((options: any, cb?: (res: FakeRes) => void): FakeReq => {
    const req = new FakeReq();
    const res = new FakeRes();
    calls.push({ options, req, res });
    const r = queue.shift();
    if (r) res.statusCode = r.statusCode;
    process.nextTick(() => {
      if (r?.networkError) {
        req.emit('error', r.networkError);
        return;
      }
      if (cb) cb(res);
      if (r?.body) res.emit('data', r.body);
      res.emit('end');
    });
    return req;
  });
  return calls;
}

const REG_OK = JSON.stringify({
  id: 'device-abc-123',
  token: 'secret-token-xyz',
  account: { id: 'acct1', license: 'lic1', warp_plus: false },
  config: {
    client_id: Buffer.from([1, 2, 3]).toString('base64'),
    interface: { addresses: { v4: '172.16.0.2', v6: '2606:4700:110::1' } },
    peers: [{ public_key: 'PEERPUB', endpoint: { host: 'engage.cloudflareclient.com:2408' } }],
  },
});

describe('WarpService.register → draft.warpDevice', () => {
  it('产出 draft.warpDevice = { deviceId, token }（不再丢弃凭据）', async () => {
    installHttps([{ statusCode: 200, body: REG_OK }]);
    const draft = await new WarpService().register();
    expect(draft.warpDevice).toEqual({ deviceId: 'device-abc-123', token: 'secret-token-xyz' });
    // 其余字段照旧
    expect(draft.peerPublicKey).toBe('PEERPUB');
    expect(draft.meta.deviceId).toBe('device-abc-123');
    expect(draft.reserved).toEqual([1, 2, 3]);
  });

  it('响应缺 token → warpDevice.token 退化为空串（后续删除按「无凭据」跳过入队）', async () => {
    const noToken = JSON.parse(REG_OK);
    delete noToken.token;
    installHttps([{ statusCode: 200, body: JSON.stringify(noToken) }]);
    const draft = await new WarpService().register();
    expect(draft.warpDevice).toEqual({ deviceId: 'device-abc-123', token: '' });
  });
});

describe('WarpService.unregister', () => {
  it('204 → done，且发 DELETE /{version}/reg/{deviceId} + Bearer', async () => {
    const calls = installHttps([{ statusCode: 204 }]);
    const r = await new WarpService().unregister('device-abc-123', 'tok');
    expect(r).toBe('done');
    expect(calls[0].options.method).toBe('DELETE');
    expect(calls[0].options.path).toBe('/v0a2158/reg/device-abc-123');
    expect(calls[0].options.headers.Authorization).toBe('Bearer tok');
    // TLS1.2 指纹钉死
    expect(calls[0].options.minVersion).toBe('TLSv1.2');
    expect(calls[0].options.maxVersion).toBe('TLSv1.2');
  });

  it('404 → done（别处已销）', async () => {
    installHttps([{ statusCode: 404 }]);
    expect(await new WarpService().unregister('d', 't')).toBe('done');
  });

  it('401 → drop（token 死）——4xx 不抛、捕获状态码分类', async () => {
    installHttps([{ statusCode: 401, body: 'Not authorized' }]);
    await expect(new WarpService().unregister('d', 't')).resolves.toBe('drop');
  });

  it('403 + body code 1020（WAF/版本串失效）→ retry（集成回归：body 须传入分类，否则误判 drop）', async () => {
    // 真实场景：CF 版本串过期时注销返 403 携带 body {"code":1020}。若 unregister 丢弃 body 只传 status，
    // 会命中 403→drop 永久误放弃所有设备注销。修复后 requestStatus 保留截断 body 喂 classifyDeregisterResult → retry。
    installHttps([{ statusCode: 403, body: '{"success":false,"errors":[{"code":1020}]}' }]);
    expect(await new WarpService().unregister('d', 't')).toBe('retry');
  });

  it('403 无 1020 body（纯 token 死）→ drop（与上条区分：仅 1020 才豁免 drop）', async () => {
    installHttps([{ statusCode: 403, body: '{"errors":[{"code":1012}]}' }]);
    expect(await new WarpService().unregister('d', 't')).toBe('drop');
  });

  it('500 → retry', async () => {
    installHttps([{ statusCode: 500 }]);
    expect(await new WarpService().unregister('d', 't')).toBe('retry');
  });

  it('网络异常 → retry（无 HTTP 状态）', async () => {
    installHttps([{ statusCode: 0, networkError: new Error('ECONNRESET') }]);
    expect(await new WarpService().unregister('d', 't')).toBe('retry');
  });

  it('缺 deviceId / token → drop（无凭可注销，不发网络）', async () => {
    const calls = installHttps([]);
    expect(await new WarpService().unregister('', 't')).toBe('drop');
    expect(await new WarpService().unregister('d', '')).toBe('drop');
    expect(calls.length).toBe(0); // 未发任何请求
  });
});

// 别名占用，避免 import 未用告警（断言常量稳定）。
describe('常量', () => {
  it('WARP_API_BASE 固定 CF 域名', () => {
    expect(WARP_API_BASE).toBe('https://api.cloudflareclient.com');
  });
});
