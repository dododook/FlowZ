/**
 * unlock-http 传输层单测（node env）：mock electron `net.request`，用 EventEmitter 驱动 redirect/response/data/
 * end/close/error 事件流（照 update-network.test.ts 的 electron mock 范式）。覆盖：无事件→8s 超时；redirect 超跳→
 * too_many_redirects；oversize→truncated 收口；error 后不二次 settle；提前 close 兜底（L4）；followRedirect 抛出
 * 路径 abort（L3）。全 mock，零网络。
 */
import { EventEmitter } from 'events';

const mockRequest = jest.fn();
jest.mock('electron', () => ({
  net: { request: (...a: unknown[]) => mockRequest(...a) },
}));

import { fetchUnlock } from '../unlock-http';
import { REQ_TIMEOUT_MS, MAX_BODY_BYTES, MAX_REDIRECTS } from '../unlock-endpoints';

class FakeReq extends EventEmitter {
  aborted = false;
  ended = false;
  followed = 0;
  headers: Record<string, string> = {};
  followThrows?: Error;
  setHeader(k: string, v: string): void {
    this.headers[k] = v;
  }
  write(): void {}
  end(): void {
    this.ended = true;
  }
  abort(): void {
    this.aborted = true;
  }
  followRedirect(): void {
    if (this.followThrows) throw this.followThrows;
    this.followed++;
  }
}

class FakeRes extends EventEmitter {
  constructor(
    public statusCode: number,
    public headers: Record<string, string[]> = {}
  ) {
    super();
  }
}

const sess = {} as never; // net.request 的 session 选项被 mock 忽略

beforeEach(() => mockRequest.mockReset());

describe('fetchUnlock', () => {
  it('正常响应 → status/headers/body（redirectChain 空）', async () => {
    const req = new FakeReq();
    mockRequest.mockReturnValue(req);
    const p = fetchUnlock(sess, { url: 'https://x/' });
    const res = new FakeRes(200, { 'content-type': ['text/html'] });
    req.emit('response', res);
    res.emit('data', Buffer.from('hi'));
    res.emit('end');
    const r = await p;
    expect(r.status).toBe(200);
    expect(r.headers).toEqual({ 'content-type': ['text/html'] });
    expect(r.body).toBe('hi');
    expect(r.truncated).toBe(false);
    expect(r.redirectChain).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it('无任何事件 → 8s 超时 abort + status:0 error:timeout', async () => {
    jest.useFakeTimers();
    try {
      const req = new FakeReq();
      mockRequest.mockReturnValue(req);
      const p = fetchUnlock(sess, { url: 'https://x/' });
      jest.advanceTimersByTime(REQ_TIMEOUT_MS);
      const r = await p;
      expect(r.status).toBe(0);
      expect(r.error).toBe('timeout');
      expect(req.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('redirect 超跳（>MAX_REDIRECTS）→ too_many_redirects + abort', async () => {
    const req = new FakeReq();
    mockRequest.mockReturnValue(req);
    const p = fetchUnlock(sess, { url: 'https://x/' });
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      req.emit('redirect', 302, 'GET', `https://x/r${i}`);
    }
    const r = await p;
    expect(r.error).toBe('too_many_redirects');
    expect(r.redirectChain).toHaveLength(MAX_REDIRECTS + 1);
    expect(req.followed).toBe(MAX_REDIRECTS); // 前 5 跳 follow，第 6 跳超限 abort
    expect(req.aborted).toBe(true);
  });

  it('oversize → 截断收口 truncated:true + abort（按字节上限，N1）', async () => {
    const req = new FakeReq();
    mockRequest.mockReturnValue(req);
    const p = fetchUnlock(sess, { url: 'https://x/' });
    const res = new FakeRes(200);
    req.emit('response', res);
    res.emit('data', Buffer.from('a'.repeat(MAX_BODY_BYTES + 10)));
    const r = await p;
    expect(r.truncated).toBe(true);
    expect(r.status).toBe(200);
    expect(Buffer.byteLength(r.body, 'utf8')).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(req.aborted).toBe(true);
  });

  it('end settle 后 error/后续事件不二次 settle（settled 守卫）', async () => {
    const req = new FakeReq();
    mockRequest.mockReturnValue(req);
    const p = fetchUnlock(sess, { url: 'https://x/' });
    const res = new FakeRes(200);
    req.emit('response', res);
    res.emit('data', Buffer.from('hello'));
    res.emit('end'); // settle → 200 / 'hello'
    res.emit('error', new Error('late-res-error')); // 应被守卫忽略
    req.emit('error', new Error('late-req-error')); // 应被守卫忽略
    const r = await p;
    expect(r.status).toBe(200);
    expect(r.body).toBe('hello');
    expect(r.error).toBeUndefined();
  });

  it('提前 close → 兜底收口用已收 body，不空等满 8s（L4）', async () => {
    const req = new FakeReq();
    mockRequest.mockReturnValue(req);
    const p = fetchUnlock(sess, { url: 'https://x/' });
    const res = new FakeRes(200);
    req.emit('response', res);
    res.emit('data', Buffer.from('partial'));
    res.emit('close'); // 提前断连
    const r = await p;
    expect(r.status).toBe(200);
    expect(r.body).toBe('partial');
    expect(r.error).toBeUndefined();
  });

  it('followRedirect 抛出 → abort + 收口 error（L3）', async () => {
    const req = new FakeReq();
    req.followThrows = new Error('request already ended');
    mockRequest.mockReturnValue(req);
    const p = fetchUnlock(sess, { url: 'https://x/' });
    req.emit('redirect', 302, 'GET', 'https://x/r1');
    const r = await p;
    expect(r.error).toBe('request already ended');
    expect(req.aborted).toBe(true); // L3：抛出路径也 abort
    expect(r.redirectChain).toEqual([{ status: 302, location: 'https://x/r1' }]);
  });

  it('request error → status:0 + error 收口', async () => {
    const req = new FakeReq();
    mockRequest.mockReturnValue(req);
    const p = fetchUnlock(sess, { url: 'https://x/' });
    req.emit('error', new Error('econnrefused'));
    const r = await p;
    expect(r.status).toBe(0);
    expect(r.error).toBe('econnrefused');
  });

  // X1（§12.2）传输分诊：超时/失败收口带 phase/bytes，区分「从未连上（网络层拦截）」与「连上停滞（MTU/tarpit）」。
  it('X1：无响应超时 → phase=connect bytes=0（从未连上/网络层拦截形态）', async () => {
    jest.useFakeTimers();
    try {
      const req = new FakeReq();
      mockRequest.mockReturnValue(req);
      const p = fetchUnlock(sess, { url: 'https://x/' });
      jest.advanceTimersByTime(REQ_TIMEOUT_MS);
      const r = await p;
      expect(r.error).toBe('timeout');
      expect(r.phase).toBe('connect');
      expect(r.bytes).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('X1：响应头已到但 body 停滞超时 → phase=headers bytes=0（连上停滞/MTU 黑洞形态）', async () => {
    jest.useFakeTimers();
    try {
      const req = new FakeReq();
      mockRequest.mockReturnValue(req);
      const p = fetchUnlock(sess, { url: 'https://x/' });
      const res = new FakeRes(200);
      req.emit('response', res); // 头到 → phase 转 headers；不 emit data/end → body 停滞至超时
      jest.advanceTimersByTime(REQ_TIMEOUT_MS);
      const r = await p;
      expect(r.error).toBe('timeout');
      expect(r.phase).toBe('headers');
      expect(r.bytes).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('X1：正常响应 → phase=body bytes=已收字节数', async () => {
    const req = new FakeReq();
    mockRequest.mockReturnValue(req);
    const p = fetchUnlock(sess, { url: 'https://x/' });
    const res = new FakeRes(200);
    req.emit('response', res);
    res.emit('data', Buffer.from('hello')); // 5 字节
    res.emit('end');
    const r = await p;
    expect(r.phase).toBe('body');
    expect(r.bytes).toBe(5);
  });
});
