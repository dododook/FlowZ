import { resolveMainSessionViaProxy } from '../update-proxy';

describe('resolveMainSessionViaProxy（代理运行 AND mainSessionViaProxy 未关）', () => {
  it.each([
    [true, undefined, true], // 代理运行 + 默认(未设=开) → 经代理
    [true, true, true], // 代理运行 + 显式开 → 经代理
    [true, false, false], // 代理运行 + 显式关 → 直连
    [false, true, false], // 代理未运行 → 直连(自举,即便开关开)
    [false, undefined, false],
    [false, false, false],
  ])('running=%s gate=%s → %s', (running, gate, expected) => {
    expect(resolveMainSessionViaProxy(running, gate)).toBe(expected);
  });
});
