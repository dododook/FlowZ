/**
 * console-forward 单测（GAP-1c）。钉住：滑动窗口限频（放行/丢弃 + 剪枝旧时刻）、单条截断。
 */
import { admitConsoleMessage, truncateConsoleMessage } from '../console-forward';

describe('admitConsoleMessage', () => {
  it('窗口内未超上限 → 放行并记入 recent', () => {
    let times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = admitConsoleMessage(times, 1000 + i, 1000, 10);
      expect(r.admit).toBe(true);
      times = r.recent;
    }
    expect(times).toHaveLength(5);
  });

  it('达到上限 → 丢弃，且不计入 recent（防风暴期计数无界增长）', () => {
    let times: number[] = [];
    for (let i = 0; i < 3; i++) times = admitConsoleMessage(times, 1000, 1000, 3).recent;
    expect(times).toHaveLength(3);
    const r = admitConsoleMessage(times, 1000, 1000, 3);
    expect(r.admit).toBe(false);
    expect(r.recent).toHaveLength(3); // 未增长
  });

  it('窗口外旧时刻被剪枝，额度恢复', () => {
    const old = [0, 1, 2]; // 都远早于 now
    const r = admitConsoleMessage(old, 5000, 1000, 3);
    expect(r.admit).toBe(true);
    expect(r.recent).toEqual([5000]); // 旧的全剪掉，只剩本次
  });

  it('边界：now-t === windowMs 视为窗口外（严格小于）', () => {
    const r = admitConsoleMessage([0], 1000, 1000, 10);
    expect(r.recent).toEqual([1000]); // t=0 被剪（1000-0 不 < 1000）
  });
});

describe('truncateConsoleMessage', () => {
  it('不超上限 → 原样返回', () => {
    expect(truncateConsoleMessage('short', 100)).toBe('short');
  });

  it('超上限 → 截断 + 省略标记', () => {
    const msg = 'x'.repeat(50);
    const out = truncateConsoleMessage(msg, 10);
    expect(out.startsWith('x'.repeat(10))).toBe(true);
    expect(out).toContain('+40 chars');
    expect(out.length).toBeLessThan(msg.length);
  });
});
