/**
 * UpdateNetwork 单测（node env）：mock electron session（fromPartition + setProxy）。
 * 覆盖 M1：sessionForOrDirect 在经代理会话 setProxy reject 时回落 direct（绝不返 undefined→default session）；
 * + direct/proxied partition 选择、proxied 端口变化才重设。
 */
const mockFromPartition = jest.fn();
jest.mock('electron', () => ({
  session: { fromPartition: (...a: unknown[]) => mockFromPartition(...a) },
}));

import { UpdateNetwork } from '../UpdateNetwork';

function makeSession() {
  return { setProxy: jest.fn().mockResolvedValue(undefined), fetch: jest.fn() };
}

describe('UpdateNetwork', () => {
  beforeEach(() => mockFromPartition.mockReset());

  it('sessionFor(false) → flowz-update-direct partition + mode:direct', async () => {
    const direct = makeSession();
    mockFromPartition.mockReturnValue(direct);
    const s = await new UpdateNetwork().sessionFor(false, 0);
    expect(mockFromPartition).toHaveBeenCalledWith('flowz-update-direct');
    expect(direct.setProxy).toHaveBeenCalledWith({ mode: 'direct' });
    expect(s).toBe(direct);
  });

  it('sessionFor(true, port) → flowz-update-proxied partition + socks5 pin', async () => {
    const proxied = makeSession();
    mockFromPartition.mockReturnValue(proxied);
    await new UpdateNetwork().sessionFor(true, 52330);
    expect(mockFromPartition).toHaveBeenCalledWith('flowz-update-proxied');
    expect(proxied.setProxy).toHaveBeenCalledWith({ proxyRules: 'socks5://127.0.0.1:52330' });
  });

  it('proxied 同端口复用、端口变化才重设 setProxy', async () => {
    const proxied = makeSession();
    mockFromPartition.mockReturnValue(proxied);
    const un = new UpdateNetwork();
    await un.sessionFor(true, 1111);
    await un.sessionFor(true, 1111);
    expect(proxied.setProxy).toHaveBeenCalledTimes(1); // 同端口复用，不重设
    await un.sessionFor(true, 2222);
    expect(proxied.setProxy).toHaveBeenCalledTimes(2); // 端口变 → 重设
    expect(proxied.setProxy).toHaveBeenLastCalledWith({ proxyRules: 'socks5://127.0.0.1:2222' });
  });

  it('M1：sessionForOrDirect 在经代理会话 setProxy reject 时回落 direct（非抛、非 undefined）', async () => {
    const proxied = {
      setProxy: jest.fn().mockRejectedValue(new Error('setProxy boom')),
      fetch: jest.fn(),
    };
    const direct = makeSession();
    mockFromPartition.mockImplementation((name: string) =>
      name === 'flowz-update-proxied' ? proxied : direct
    );
    const s = await new UpdateNetwork().sessionForOrDirect(true, 52330);
    expect(s).toBe(direct); // 回落 direct，绝不 undefined
    expect(direct.setProxy).toHaveBeenCalledWith({ mode: 'direct' });
  });

  it('sessionForOrDirect(false) 正常返回 direct', async () => {
    const direct = makeSession();
    mockFromPartition.mockReturnValue(direct);
    const s = await new UpdateNetwork().sessionForOrDirect(false, 0);
    expect(s).toBe(direct);
  });
});
