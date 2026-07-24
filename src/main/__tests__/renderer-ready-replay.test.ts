/**
 * replayConfigOnRendererReady 纯逻辑 DI 单测（#325）。钉住协议保证：收到 RENDERER_READY 恰重放一次终态 config、
 * 中止态不发、读失败只 warn 不抛、二次 RENDERER_READY（reload）再重放。运行期 webContents/时序副作用由真机验。
 * 循 mount-health-gate.test.ts 的纯逻辑 DI 模式。
 */
import { replayConfigOnRendererReady } from '../renderer-ready-replay';

type Cfg = { tag: string };

function makeDeps(overrides: Partial<Parameters<typeof replayConfigOnRendererReady<Cfg>>[0]> = {}) {
  const send = jest.fn<void, [Cfg]>();
  const warn = jest.fn<void, [string]>();
  const isAborted = jest.fn<boolean, []>().mockReturnValue(false);
  const loadConfig = jest.fn<Promise<Cfg>, []>().mockResolvedValue({ tag: 'terminal' });
  return {
    deps: { loadConfig, send, isAborted, warn, ...overrides },
    send,
    warn,
    isAborted,
    loadConfig,
  };
}

describe('replayConfigOnRendererReady', () => {
  it('T4 收到 RENDERER_READY → 恰一次 send，payload 为 loadConfig 返回的终态 config', async () => {
    const { deps, send, warn } = makeDeps();
    await replayConfigOnRendererReady(deps);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ tag: 'terminal' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('T5 已中止（isQuitting / wc destroyed）→ 不 send、不读 config', async () => {
    const { deps, send, loadConfig } = makeDeps({ isAborted: jest.fn().mockReturnValue(true) });
    await replayConfigOnRendererReady(deps);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('T5b await 期间转入中止（读 config 后 wc 已销毁）→ 不 send', async () => {
    // 第一次查（读前）false 放行，第二次查（await 后）true 拦截 → 不得向已销毁 wc send。
    const isAborted = jest.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { deps, send, warn } = makeDeps({ isAborted });
    await replayConfigOnRendererReady(deps);
    expect(send).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('T6 loadConfig reject → 调 warn、不 send、不抛（绝不打断 mount gate）', async () => {
    const { deps, send, warn } = makeDeps({
      loadConfig: jest.fn().mockRejectedValue(new Error('read fail')),
    });
    await expect(replayConfigOnRendererReady(deps)).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('read fail');
  });

  it('T7 二次 RENDERER_READY（reload）→ 再次重放（幂等，每次挂载都发）', async () => {
    const { deps, send } = makeDeps();
    await replayConfigOnRendererReady(deps);
    await replayConfigOnRendererReady(deps);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
