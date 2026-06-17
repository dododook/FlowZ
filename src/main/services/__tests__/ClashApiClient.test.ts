/**
 * ClashApiClient 单测。覆盖 request / getJson / destroyAgent 三方法的核心不变量。
 *
 * mock node `http`（参考 IpInfoService.test.ts 的 fake req/res 驱动模式）：
 * - request：'close' 收口防 Promise 悬挂 / Bearer 头 / timeout 走 destroy / resume 丢弃响应体 / 2xx vs 非 2xx
 * - getJson：900ms 默认超时 / JSON.parse 成功 / 非 200 → null / 解析失败 → null / Bearer 头
 * - destroyAgent：destroy 旧 agent + 重建新 agent（maxSockets:2 keepAlive）
 */
import { EventEmitter } from 'events';
import * as http from 'http';

// 部分 mock：保留真实 http.Agent（ClashApiClient 构造需 new http.Agent 拿真实 keepAlive/maxSockets），
// 仅 mock request（受控 fake req/res 驱动）。IpInfoService.test 用全 jest.mock('http') 因它不 new Agent。
const mockRequest = jest.fn();
jest.mock('http', () => ({
  ...jest.requireActual('http'),
  request: (...args: any[]) => mockRequest(...args),
}));

import { ClashApiClient } from '../ClashApiClient';

/** 受控 fake response：EventEmitter + statusCode + setEncoding/resume 记录。 */
class FakeRes extends EventEmitter {
  statusCode = 200;
  setEncoding = jest.fn();
  resumed = false;
  resume = jest.fn(() => {
    this.resumed = true;
  });
}

/** 受控 fake request：EventEmitter + write/end/destroy 记录。
 * destroy(err) 带参 → emit 'error'；destroy() 无参 → 拟真 node abort（请求未完成时 emit 'error'
 * 'socket hang up'）——生产代码 timeout→destroy() 无参，Promise 靠 req 'error' 收口到 {ok:false,0}。 */
class FakeReq extends EventEmitter {
  written: unknown[] = [];
  ended = false;
  destroyed = false;
  destroyError: Error | null = null;
  write = jest.fn((payload?: unknown) => {
    this.written.push(payload);
  });
  end = jest.fn(() => {
    this.ended = true;
  });
  destroy = jest.fn((err?: Error) => {
    this.destroyed = true;
    if (err) {
      this.destroyError = err;
      this.emit('error', err);
    } else {
      // 拟真 node：destroy() 无参 + 请求未完成 → emit 'error'（socket hang up）→ 生产 req.on('error') 收口
      const abortErr = new Error('socket hang up');
      this.destroyError = abortErr;
      this.emit('error', abortErr);
    }
  });
}

interface Call {
  options: http.RequestOptions;
  req: FakeReq;
  res: FakeRes;
}

describe('ClashApiClient', () => {
  let calls: Call[];
  let responders: Array<{
    statusCode?: number;
    drive: (call: Call) => void;
  }>;

  /**
   * 安装 http.request mock：记录 options + 构造 fake req/res。
   * 时序：statusCode 在 cb(res) **之前**设好（生产代码在 cb 内同步即读 statusCode），
   * 事件驱动 drive 在 cb 之后（此时 res 的 close/data/end、req 的 timeout/error 监听已挂好）。
   */
  function installHttp() {
    calls = [];
    responders = [];
    mockRequest.mockReset();
    mockRequest.mockImplementation(
      (options: http.RequestOptions, cb?: (res: FakeRes) => void): FakeReq => {
        const req = new FakeReq();
        const res = new FakeRes();
        const call: Call = { options, req, res };
        calls.push(call);
        const responder = responders.shift();
        if (responder && responder.statusCode !== undefined) {
          res.statusCode = responder.statusCode; // cb 前设好
        }
        process.nextTick(() => {
          if (cb) cb(res);
          if (responder) responder.drive(call);
        });
        return req;
      }
    );
  }

  beforeEach(() => {
    installHttp();
  });

  /** secret=非空 的 client（测 Bearer 头）。 */
  function clientWithSecret(secret = 's3cret') {
    return new ClashApiClient(() => secret);
  }

  // ==========================================================================
  // request（'close' 收口 / Bearer / timeout / resume 丢体 / 状态码）
  // ==========================================================================

  describe('request', () => {
    it('2xx + end + close → ok:true + 200，Bearer 头 + Content-Type/Length（带 body）', async () => {
      const c = clientWithSecret();
      responders.push({
        drive: ({ res }) => {
          res.emit('data', 'ignored');
          res.emit('end');
          res.emit('close');
        },
      });
      const r = await c.request('/proxies/x', 'PUT', { name: 'node-a' });
      expect(r).toEqual({ ok: true, status: 200 });
      const opts = calls[0].options;
      expect(opts.host).toBe('127.0.0.1');
      expect(opts.port).toBe(9090);
      expect(opts.path).toBe('/proxies/x');
      expect(opts.method).toBe('PUT');
      expect(opts.headers).toMatchObject({
        'Content-Type': 'application/json',
        Authorization: 'Bearer s3cret',
      });
      // body 经 JSON.stringify 写入
      expect(calls[0].req.written).toEqual([JSON.stringify({ name: 'node-a' })]);
      expect(calls[0].req.ended).toBe(true);
    });

    it('无 body → 不写 Content-Type/Length、不 write（仅 end）', async () => {
      const c = clientWithSecret();
      responders.push({ drive: ({ res }) => res.emit('close') });
      await c.request('/restart', 'POST');
      const opts = calls[0].options;
      expect(opts.headers).not.toHaveProperty('Content-Type');
      expect(opts.headers).toMatchObject({ Authorization: 'Bearer s3cret' });
      expect(calls[0].req.written).toEqual([]);
      expect(calls[0].req.ended).toBe(true);
    });

    it('secret=空 → 无 Authorization 头', async () => {
      const c = new ClashApiClient(() => '');
      responders.push({ drive: ({ res }) => res.emit('close') });
      await c.request('/p', 'GET');
      expect(calls[0].options.headers).not.toHaveProperty('Authorization');
    });

    it('getPort 注入 → request 连到自定义控制端口（解 9090 冲突死局）；缺省回退 9090', async () => {
      const c = new ClashApiClient(
        () => '',
        () => 9091
      );
      responders.push({ drive: ({ res }) => res.emit('close') });
      await c.request('/p', 'GET');
      expect(calls[0].options.port).toBe(9091);
      // 缺省 getPort（仅传 secret）→ 9090，兼容旧调用方
      const cDefault = new ClashApiClient(() => '');
      responders.push({ drive: ({ res }) => res.emit('close') });
      await cDefault.request('/p', 'GET');
      expect(calls[1].options.port).toBe(9090);
    });

    it('timeout → req.destroy()（无参，node abort emit error）→ done(ok:false,0)，不悬挂', async () => {
      const c = clientWithSecret();
      responders.push({ drive: ({ req }) => req.emit('timeout') });
      const r = await c.request('/p', 'GET');
      expect(r).toEqual({ ok: false, status: 0 });
      expect(calls[0].req.destroy).toHaveBeenCalled();
      // 拟真 node：destroy() 无参 abort → emit 'error'（生产 req.on('error') 收口到 ok:false）
      expect(calls[0].req.destroyError).not.toBeNull();
    });

    it('req error（ECONNREFUSED）→ done(ok:false,0)，不悬挂', async () => {
      const c = clientWithSecret();
      responders.push({ drive: ({ req }) => req.emit('error', new Error('ECONNREFUSED')) });
      const r = await c.request('/p', 'GET');
      expect(r).toEqual({ ok: false, status: 0 });
    });

    it('close 收口：200 但无 end、直接 close → 不悬挂，resolve(ok:true,200)', async () => {
      const c = clientWithSecret();
      responders.push({ drive: ({ res }) => res.emit('close') }); // 无 end 直接 close
      const r = await c.request('/p', 'GET');
      expect(r).toEqual({ ok: true, status: 200 });
    });

    it('res on close 在 end 之后触发仍 resolve 幂等（只取首次）', async () => {
      const c = clientWithSecret();
      responders.push({
        drive: ({ res }) => {
          res.emit('end');
          res.emit('close');
          res.emit('close'); // 二次 close 不应翻转结果
        },
      });
      const r = await c.request('/p', 'GET');
      expect(r).toEqual({ ok: true, status: 200 });
    });

    it('非 2xx（500）→ ok:false + status:500，close 收口', async () => {
      const c = clientWithSecret();
      responders.push({
        statusCode: 500,
        drive: ({ res }) => res.emit('close'),
      });
      const r = await c.request('/p', 'PUT');
      expect(r).toEqual({ ok: false, status: 500 });
    });

    it('resume 丢弃响应体（request 只关心成败，不消费 body）', async () => {
      const c = clientWithSecret();
      responders.push({
        drive: ({ res }) => {
          res.emit('data', 'chunk1');
          res.emit('data', 'chunk2');
          res.emit('close');
        },
      });
      await c.request('/p', 'GET');
      expect(calls[0].res.resume).toHaveBeenCalled();
    });

    it('res error → done(ok:false,0)', async () => {
      const c = clientWithSecret();
      responders.push({ drive: ({ res }) => res.emit('error', new Error('res stream broken')) });
      const r = await c.request('/p', 'GET');
      expect(r).toEqual({ ok: false, status: 0 });
    });

    it('自定义 timeoutMs 透传到 options.timeout', async () => {
      const c = clientWithSecret();
      responders.push({ drive: ({ res }) => res.emit('close') });
      await c.request('/p', 'GET', undefined, 5000);
      expect(calls[0].options.timeout).toBe(5000);
    });
  });

  // ==========================================================================
  // getJson（900ms 默认 / JSON.parse / 非 200 → null / Bearer）
  // ==========================================================================

  describe('getJson', () => {
    it('200 + 合法 JSON → parse 返回对象，Bearer 头', async () => {
      const c = clientWithSecret();
      responders.push({
        drive: ({ res }) => {
          res.emit('data', '{"now":');
          res.emit('data', '"2024-01-01"}');
          res.emit('end');
        },
      });
      const r = await c.getJson('/version');
      expect(r).toEqual({ now: '2024-01-01' });
      expect(calls[0].options.headers).toMatchObject({ Authorization: 'Bearer s3cret' });
      expect(calls[0].options.method).toBe('GET');
      expect(calls[0].res.setEncoding).toHaveBeenCalledWith('utf8');
    });

    it('默认 900ms 超时', async () => {
      const c = clientWithSecret();
      responders.push({ drive: ({ res }) => res.emit('end') });
      await c.getJson('/x');
      expect(calls[0].options.timeout).toBe(900);
    });

    it('非 200（503）→ resume + resolve(null)', async () => {
      const c = clientWithSecret();
      responders.push({ statusCode: 503, drive: () => {} });
      const r = await c.getJson('/x');
      expect(r).toBeNull();
      expect(calls[0].res.resume).toHaveBeenCalled();
    });

    it('JSON.parse 失败（非法 JSON）→ resolve(null)，不抛', async () => {
      const c = clientWithSecret();
      responders.push({
        drive: ({ res }) => {
          res.emit('data', 'not-json{');
          res.emit('end');
        },
      });
      const r = await c.getJson('/x');
      expect(r).toBeNull();
    });

    it('timeout → req.destroy → req error → resolve(null)', async () => {
      const c = clientWithSecret();
      responders.push({ drive: ({ req }) => req.emit('timeout') });
      const r = await c.getJson('/x');
      expect(r).toBeNull();
      expect(calls[0].req.destroy).toHaveBeenCalled();
    });

    it('req error（核心刚停）→ resolve(null) 静默', async () => {
      const c = clientWithSecret();
      responders.push({ drive: ({ req }) => req.emit('error', new Error('ECONNREFUSED')) });
      const r = await c.getJson('/x');
      expect(r).toBeNull();
    });

    it('secret=空 → 无 Authorization 头', async () => {
      const c = new ClashApiClient(() => '');
      responders.push({ drive: ({ res }) => res.emit('end') });
      await c.getJson('/x');
      expect(calls[0].options.headers).not.toHaveProperty('Authorization');
    });

    it('自定义 timeoutMs 透传', async () => {
      const c = clientWithSecret();
      responders.push({ drive: ({ res }) => res.emit('end') });
      await c.getJson('/x', 3000);
      expect(calls[0].options.timeout).toBe(3000);
    });
  });

  // ==========================================================================
  // destroyAgent（destroy + 重建）
  // ==========================================================================

  describe('destroyAgent', () => {
    it('destroy 旧 agent + 重建新 agent（后续 request 用新 agent）', async () => {
      const c = clientWithSecret();
      const agentBefore = (c as any).agent as http.Agent;
      const destroySpy = jest.spyOn(agentBefore, 'destroy');
      c.destroyAgent();
      expect(destroySpy).toHaveBeenCalledTimes(1);
      const agentAfter = (c as any).agent as http.Agent;
      expect(agentAfter).not.toBe(agentBefore); // 新实例
      // 新 agent 仍 keepAlive + maxSockets:2
      expect((agentAfter as any).keepAlive).toBe(true);
      expect((agentAfter as any).maxSockets).toBe(2);
    });

    it('destroy 抛错被吞（不冒泡），仍重建新 agent', () => {
      const c = clientWithSecret();
      const agentBefore = (c as any).agent as http.Agent;
      jest.spyOn(agentBefore, 'destroy').mockImplementation(() => {
        throw new Error('already destroyed');
      });
      expect(() => c.destroyAgent()).not.toThrow();
      expect((c as any).agent).not.toBe(agentBefore); // 仍重建
    });

    it('destroyAgent 后 request 仍可用（新 agent 承接）', async () => {
      const c = clientWithSecret();
      c.destroyAgent();
      responders.push({ drive: ({ res }) => res.emit('close') });
      const r = await c.request('/p', 'GET');
      expect(r).toEqual({ ok: true, status: 200 });
      expect(calls[0].options.agent).toBe((c as any).agent);
    });
  });
});
