import { resolveMainSessionViaProxy, resolveUpdateProxyTarget } from '../update-proxy';

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

describe('resolveUpdateProxyTarget（viaProxy + 端口闸单一真值）', () => {
  it.each([
    // running, gate, port, expectedViaProxy, expectedPort
    [true, undefined, 52330, true, 52330], // 默认开 + 端口可用 → 经代理
    [true, true, 52330, true, 52330], // 显式开 + 端口可用 → 经代理
    [true, false, 52330, false, 52330], // 显式关 → 直连（端口仍透传）
    [false, true, 52330, false, 52330], // 代理未运行 → 直连
    [true, true, 0, false, 0], // 端口闸：端口=0 → 强制直连（不 pin 无效口）
    [true, true, -1, false, -1], // 端口闸：负端口 → 直连
    [true, true, null, false, 0], // 端口未就绪(null) → 0 → 直连
    [true, true, undefined, false, 0], // 端口 undefined → 0 → 直连
    [false, true, 0, false, 0], // 未运行 + 无端口 → 直连
  ])(
    'running=%s gate=%s port=%s → viaProxy=%s port=%s',
    (running, gate, port, expViaProxy, expPort) => {
      expect(resolveUpdateProxyTarget(running, gate, port)).toEqual({
        viaProxy: expViaProxy,
        port: expPort,
      });
    }
  );

  it('viaProxy=true ⟹ port>0（自洽不变量）', () => {
    for (const port of [1, 1080, 52330, 65535]) {
      const t = resolveUpdateProxyTarget(true, true, port);
      expect(t.viaProxy).toBe(true);
      expect(t.port).toBeGreaterThan(0);
    }
  });
});
