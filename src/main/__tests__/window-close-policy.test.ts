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
