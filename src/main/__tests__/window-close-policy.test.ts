import { shouldQuitOnAllWindowsClosed } from '../window-close-policy';

describe('shouldQuitOnAllWindowsClosed', () => {
  it('macOS 恒不退出，不受 minimizeToTray/hasTray 影响（红灯关窗/无窗口不退应用是硬性平台惯例）', () => {
    expect(shouldQuitOnAllWindowsClosed('darwin', true, true)).toBe(false);
    expect(shouldQuitOnAllWindowsClosed('darwin', false, false)).toBe(false);
  });

  it('Windows/Linux：minimizeToTray=true 且托盘图标存在 → 常驻，不退出', () => {
    expect(shouldQuitOnAllWindowsClosed('win32', true, true)).toBe(false);
    expect(shouldQuitOnAllWindowsClosed('linux', true, true)).toBe(false);
  });

  it('Windows/Linux：minimizeToTray=false → 退出，不管托盘图标是否存在', () => {
    expect(shouldQuitOnAllWindowsClosed('win32', false, true)).toBe(true);
    expect(shouldQuitOnAllWindowsClosed('linux', false, false)).toBe(true);
  });

  it('Windows/Linux：minimizeToTray=true 但托盘图标创建失败 → 仍需退出兜底（防无窗口无托盘的僵尸进程）', () => {
    expect(shouldQuitOnAllWindowsClosed('win32', true, false)).toBe(true);
    expect(shouldQuitOnAllWindowsClosed('linux', true, false)).toBe(true);
  });
});

// #251 revert-to-hide：close 处理器 shouldQuit=true → destroy+退出；false → window.hide() 保活。
// 锁定「keepAlive == !shouldQuitOnAllWindowsClosed」映射（复用既有 policy 函数、零新判定），四象限全覆盖。
describe('关窗保活映射（keepAlive == !shouldQuitOnAllWindowsClosed）', () => {
  const cases: Array<[NodeJS.Platform, boolean, boolean, boolean]> = [
    // [platform, minimizeToTray, hasTray, expectKeepAlive(=hide)]
    ['darwin', true, true, true], // macOS 恒保活（hide）
    ['darwin', false, false, true], // macOS 无视设置恒保活
    ['win32', true, true, true], // 有托盘 + minimizeToTray → 保活
    ['linux', true, true, true],
    ['win32', false, true, false], // minimizeToTray=false → 真退出（destroy）
    ['linux', false, false, false],
    ['win32', true, false, false], // 托盘创建失败兜底 → 退出
    ['linux', true, false, false],
  ];
  it.each(cases)(
    '%s minimizeToTray=%s hasTray=%s → keepAlive=%s',
    (platform, minimizeToTray, hasTray, keepAlive) => {
      const shouldQuit = shouldQuitOnAllWindowsClosed(platform, minimizeToTray, hasTray);
      expect(!shouldQuit).toBe(keepAlive);
    }
  );
});
