/**
 * safeRedirectFetch 单测（node env）：真实 assertHostAllowed + 注入 lookup/fetchImpl。
 * 覆盖：首跳 + 逐跳 redirect SSRF 复检、重定向上限、协议非法、drainBody、signal 透传、
 * FakeIP 豁免（仅经代理）、fetchImpl 网络错误原样冒泡（非 SafeFetchError）。
 */
import { safeRedirectFetch, SafeFetchError } from '../safe-redirect-fetch';

interface FakeResp {
  status: number;
  headers: { get(n: string): string | null };
  body?: { cancel: jest.Mock };
}

function makeResp(status: number, location?: string): FakeResp {
  const h = new Map<string, string>();
  if (location) h.set('location', location);
  return {
    status,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    body: { cancel: jest.fn().mockResolvedValue(undefined) },
  };
}

const PUBLIC = [{ address: '93.184.216.34' }];
const INTERNAL = [{ address: '10.0.0.5' }];
const META = [{ address: '169.254.169.254' }];
const FAKEIP6 = [{ address: '2001:2::57' }]; // FlowZ FakeIP（IPv6 2001:2::/48 benchmarking 保留段）：isFlowzFakeIp 豁免、Chrome LNA 判 public
const REAL_ULA6 = [{ address: 'fc00::57' }]; // 真实 ULA（fc00::/7）：isPrivateIp 判内网、非 FakeIP，直连不豁免

const base = {
  userAgent: 'TestUA',
  exemptFakeIp: false,
};

async function expectReason(p: Promise<unknown>, reason: SafeFetchError['reason']): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(SafeFetchError);
  expect((caught as SafeFetchError).reason).toBe(reason);
}

describe('safeRedirectFetch', () => {
  it('首跳公网 → 返回终态响应，下发 redirect:manual + UA', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(makeResp(200));
    const lookup = jest.fn().mockResolvedValue(PUBLIC);
    const r = await safeRedirectFetch<FakeResp>({
      ...base,
      fetchImpl,
      url: 'https://cdn.example.com/x',
      lookup,
    });
    expect(r.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cdn.example.com/x',
      expect.objectContaining({ redirect: 'manual', headers: { 'User-Agent': 'TestUA' } })
    );
  });

  it('首跳解析到内网 → SafeFetchError(ssrf)，不发起 fetch', async () => {
    const fetchImpl = jest.fn();
    const lookup = jest.fn().mockResolvedValue(INTERNAL);
    await expectReason(
      safeRedirectFetch<FakeResp>({
        ...base,
        fetchImpl,
        url: 'https://evil.example.com/x',
        lookup,
      }),
      'ssrf'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('首跳 SSRF 消息透传 assertHostAllowed 原文（含「本机/内网」）', async () => {
    const fetchImpl = jest.fn();
    const lookup = jest.fn().mockResolvedValue(META); // 云元数据
    await expect(
      safeRedirectFetch<FakeResp>({ ...base, fetchImpl, url: 'https://meta.example.com/x', lookup })
    ).rejects.toThrow(/本机\/内网/);
  });

  it('30x 跳到内网 → SafeFetchError(ssrf)（逐跳复检 Location）', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(makeResp(302, 'https://inner.example.com/y'));
    const lookup = jest
      .fn()
      .mockResolvedValueOnce(PUBLIC) // 首跳：公网
      .mockResolvedValueOnce(INTERNAL); // 重定向目标：内网
    await expectReason(
      safeRedirectFetch<FakeResp>({ ...base, fetchImpl, url: 'https://cdn.example.com/x', lookup }),
      'ssrf'
    );
  });

  it('30x 跳到公网 → 续跳返回终态，drain 上一跳 body', async () => {
    const first = makeResp(301, 'https://cdn2.example.com/z');
    const fetchImpl = jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(makeResp(200));
    const lookup = jest.fn().mockResolvedValue(PUBLIC);
    const r = await safeRedirectFetch<FakeResp>({
      ...base,
      fetchImpl,
      url: 'https://cdn.example.com/x',
      lookup,
    });
    expect(r.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(first.body!.cancel).toHaveBeenCalled(); // 上一跳 body 已 drain
  });

  it('30x 跳到内网（抛错路径）→ 仍 drain 当前跳 body（防 socket 泄漏）', async () => {
    const first = makeResp(302, 'https://inner.example.com/y');
    const fetchImpl = jest.fn().mockResolvedValueOnce(first);
    const lookup = jest
      .fn()
      .mockResolvedValueOnce(PUBLIC) // 首跳：公网
      .mockResolvedValueOnce(INTERNAL); // 重定向目标：内网 → 抛 ssrf
    await expectReason(
      safeRedirectFetch<FakeResp>({ ...base, fetchImpl, url: 'https://cdn.example.com/x', lookup }),
      'ssrf'
    );
    expect(first.body!.cancel).toHaveBeenCalled(); // 被拒的那一跳 body 也已释放
  });

  it('相对 Location 以当前 URL 为基准解析', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(makeResp(302, '/sub/path'))
      .mockResolvedValueOnce(makeResp(200));
    const lookup = jest.fn().mockResolvedValue(PUBLIC);
    await safeRedirectFetch<FakeResp>({
      ...base,
      fetchImpl,
      url: 'https://cdn.example.com/a/b',
      lookup,
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://cdn.example.com/sub/path',
      expect.anything()
    );
  });

  it('重定向超过上限 → SafeFetchError(too-many-redirects)，消息含「重定向次数超过上限」', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(makeResp(302, 'https://loop.example.com/next'));
    const lookup = jest.fn().mockResolvedValue(PUBLIC);
    await expectReason(
      safeRedirectFetch<FakeResp>({
        ...base,
        fetchImpl,
        url: 'https://loop.example.com/x',
        lookup,
        maxRedirects: 2,
      }),
      'too-many-redirects'
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3); // hop 0,1,2；hop=2 时 hop>=max 抛
    await expect(
      safeRedirectFetch<FakeResp>({
        ...base,
        fetchImpl: jest.fn().mockResolvedValue(makeResp(302, 'https://loop.example.com/next')),
        url: 'https://loop.example.com/x',
        lookup,
      })
    ).rejects.toThrow(/重定向次数超过上限/);
  });

  it('重定向目标非 http(s) → SafeFetchError(redirect-protocol)', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(makeResp(302, 'ftp://x/y'));
    const lookup = jest.fn().mockResolvedValue(PUBLIC);
    await expectReason(
      safeRedirectFetch<FakeResp>({ ...base, fetchImpl, url: 'https://cdn.example.com/x', lookup }),
      'redirect-protocol'
    );
  });

  it('exemptFakeIp=true → 豁免 FlowZ FakeIP（IPv6 2001:2::/48，经代理出口）', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(makeResp(200));
    const lookup = jest.fn().mockResolvedValue(FAKEIP6);
    const r = await safeRedirectFetch<FakeResp>({
      ...base,
      exemptFakeIp: true,
      fetchImpl,
      url: 'https://sub.example.com/x',
      lookup,
    });
    expect(r.status).toBe(200); // FakeIP 豁免，不拒
  });

  it('exemptFakeIp=false → 真内网(fc00:: ULA) 视作内网拒（直连不豁免）', async () => {
    const fetchImpl = jest.fn();
    const lookup = jest.fn().mockResolvedValue(REAL_ULA6);
    await expectReason(
      safeRedirectFetch<FakeResp>({ ...base, fetchImpl, url: 'https://sub.example.com/x', lookup }),
      'ssrf'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('signal 透传到 fetchImpl', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(makeResp(200));
    const lookup = jest.fn().mockResolvedValue(PUBLIC);
    const ctrl = new AbortController();
    await safeRedirectFetch<FakeResp>({
      ...base,
      fetchImpl,
      url: 'https://cdn.example.com/x',
      lookup,
      signal: ctrl.signal,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cdn.example.com/x',
      expect.objectContaining({ signal: ctrl.signal })
    );
  });

  it('fetchImpl 网络错误 → 原样冒泡（非 SafeFetchError）', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const lookup = jest.fn().mockResolvedValue(PUBLIC);
    let caught: unknown;
    try {
      await safeRedirectFetch<FakeResp>({
        ...base,
        fetchImpl,
        url: 'https://cdn.example.com/x',
        lookup,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(SafeFetchError);
    expect((caught as Error).message).toBe('ECONNREFUSED');
  });
});
