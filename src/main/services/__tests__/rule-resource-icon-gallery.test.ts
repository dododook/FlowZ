/**
 * RuleResourceManager.fetchIconGalleries 纯逻辑单测（Phase 1b：图标库拉取下沉主进程经 update-in）。
 * 网络层（fetchJson）被 spy 掉，只验：多源 fallback、两库合并、全失败/缺字段的空兜底。
 */
import { RuleResourceManager } from '../RuleResourceManager';

function makeManager(): RuleResourceManager {
  return new RuleResourceManager(
    { loadConfig: jest.fn() } as never,
    jest.fn(),
    jest.fn(),
    jest.fn()
  );
}

describe('RuleResourceManager.fetchIconGalleries', () => {
  it('合并两个图标库的 icons', async () => {
    const mgr = makeManager();
    jest
      .spyOn(mgr as never as { fetchJson: (u: string) => Promise<unknown> }, 'fetchJson')
      .mockImplementation(async (url: string) => {
        if (url.includes('Qure')) return { icons: [{ name: 'a', url: 'ua' }] };
        if (url.includes('edc')) return { icons: [{ name: 'b', url: 'ub' }] };
        throw new Error('unexpected url');
      });
    const icons = await mgr.fetchIconGalleries();
    expect(icons).toEqual([
      { name: 'a', url: 'ua' },
      { name: 'b', url: 'ub' },
    ]);
  });

  it('首选源失败回退到次选源（多 CDN fallback）', async () => {
    const mgr = makeManager();
    const calls: string[] = [];
    jest
      .spyOn(mgr as never as { fetchJson: (u: string) => Promise<unknown> }, 'fetchJson')
      .mockImplementation(async (url: string) => {
        calls.push(url);
        if (url.startsWith('https://cdn.jsdelivr.net')) throw new Error('blocked'); // 每库首源被墙
        if (url.includes('Qure')) return { icons: [{ name: 'a', url: 'ua' }] };
        if (url.includes('edc')) return { icons: [{ name: 'b', url: 'ub' }] };
        return null;
      });
    const icons = await mgr.fetchIconGalleries();
    expect(icons).toEqual([
      { name: 'a', url: 'ua' },
      { name: 'b', url: 'ub' },
    ]);
    // 首源（cdn.jsdelivr）确实被尝试且失败 → 触发回退
    expect(calls.some((u) => u.startsWith('https://cdn.jsdelivr.net'))).toBe(true);
  });

  it('所有源全部失败 → 返回空数组（优雅降级，不抛）', async () => {
    const mgr = makeManager();
    jest
      .spyOn(mgr as never as { fetchJson: (u: string) => Promise<unknown> }, 'fetchJson')
      .mockRejectedValue(new Error('all blocked'));
    await expect(mgr.fetchIconGalleries()).resolves.toEqual([]);
  });

  it('响应缺 icons 字段 → 空数组兜底', async () => {
    const mgr = makeManager();
    jest
      .spyOn(mgr as never as { fetchJson: (u: string) => Promise<unknown> }, 'fetchJson')
      .mockResolvedValue({});
    await expect(mgr.fetchIconGalleries()).resolves.toEqual([]);
  });
});
