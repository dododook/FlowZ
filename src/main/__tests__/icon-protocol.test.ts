/**
 * icon-protocol 单测（node env）：mock electron protocol（捕获 handler）+ session.fetch + node dns。
 * 覆盖 M2：flowz-icon:// 首跳 + 逐跳 redirect SSRF guard；协议限制；URL 解码往返。
 * proxyRunning=false → viaProxy 恒 false（direct），cfgMsvpCache 不影响判定，故跨用例无污染。
 */
let capturedHandler: ((req: { url: string }) => Promise<Response>) | null = null;
const mockRegisterSchemes = jest.fn();
jest.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: (...a: unknown[]) => mockRegisterSchemes(...a),
    handle: (_scheme: string, h: (req: { url: string }) => Promise<Response>) => {
      capturedHandler = h;
    },
  },
}));
const mockLookup = jest.fn();
jest.mock('dns', () => ({ promises: { lookup: (...a: unknown[]) => mockLookup(...a) } }));

import { registerIconProtocol } from '../icon-protocol';
import { iconProxySrc } from '../../shared/icon-proxy';

function makeResp(opts: { status?: number; location?: string }): Response {
  const status = opts.status ?? 200;
  const headers = new Map<string, string>();
  if (opts.location) headers.set('location', opts.location);
  return {
    status,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    body: { cancel: jest.fn().mockResolvedValue(undefined) },
  } as unknown as Response;
}

describe('icon-protocol flowz-icon://', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    capturedHandler = null;
    mockFetch = jest.fn();
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([{ address: '1.2.3.4' }]); // 默认公网解析
    registerIconProtocol({
      updateNetwork: { sessionFor: jest.fn().mockResolvedValue({ fetch: mockFetch }) } as never,
      proxyRunningProvider: () => false, // viaProxy 恒 false（direct）
      updateInPortProvider: () => null,
      configProvider: () => Promise.resolve({} as never),
      logManager: { addLog: jest.fn() } as never,
    });
  });

  const call = (realUrl: string) => capturedHandler!({ url: iconProxySrc(realUrl) });

  it('https 公网图标 → 经 session.fetch 拉取，返 200', async () => {
    mockFetch.mockResolvedValue(makeResp({ status: 200 }));
    const r = await call('https://cdn.example.com/icon.png');
    expect(mockFetch).toHaveBeenCalled();
    expect(r.status).toBe(200);
  });

  it('还原后非 http(s) 协议 → 400，不发起 fetch', async () => {
    const r = await capturedHandler!({
      url: `flowz-icon://i/${encodeURIComponent('ftp://x/y')}`,
    });
    expect(r.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('首跳 host 解析到内网 → 403（SSRF），不发起 fetch', async () => {
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([{ address: '10.0.0.5' }]);
    const r = await call('https://evil.example.com/icon.png');
    expect(r.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('M2：30x 重定向到内网 → 403（逐跳 guard 复检 Location）', async () => {
    mockFetch.mockResolvedValueOnce(makeResp({ status: 302, location: 'https://internal.evil/x' }));
    mockLookup.mockReset();
    mockLookup
      .mockResolvedValueOnce([{ address: '1.2.3.4' }]) // 首跳 guard：公网
      .mockResolvedValueOnce([{ address: '169.254.169.254' }]); // 重定向目标：内网（云元数据）
    const r = await call('https://cdn.example.com/icon.png');
    expect(r.status).toBe(403);
  });

  it('M2：30x 到公网 → 续跳拉取成功（200）', async () => {
    mockFetch
      .mockResolvedValueOnce(
        makeResp({ status: 301, location: 'https://cdn2.example.com/icon.png' })
      )
      .mockResolvedValueOnce(makeResp({ status: 200 }));
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([{ address: '1.2.3.4' }]); // 全程公网
    const r = await call('https://cdn.example.com/icon.png');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(r.status).toBe(200);
  });

  it('URL 编解码往返：含 query 的图标 URL 无损还原后拉取', async () => {
    mockFetch.mockResolvedValue(makeResp({ status: 200 }));
    await call('https://raw.example.com/a/b.json?x=1&y=2');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://raw.example.com/a/b.json?x=1&y=2',
      expect.objectContaining({ redirect: 'manual' })
    );
  });
});
