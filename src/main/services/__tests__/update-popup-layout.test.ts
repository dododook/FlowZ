/**
 * 更新弹窗纯布局逻辑单测（无 electron 依赖）：态→高度、平台→角落定位。
 */
import { UPDATE_POPUP_WIDTH, popupHeightFor, popupPosition } from '../update-popup-layout';

describe('popupHeightFor', () => {
  it('四态各有确定高度，remind 最高、progress/done 同高', () => {
    expect(popupHeightFor('remind')).toBe(160);
    expect(popupHeightFor('error')).toBe(152);
    expect(popupHeightFor('progress')).toBe(116);
    expect(popupHeightFor('done')).toBe(116);
    // remind 承载动作+链接（无内联更新说明）→ 仍高于 progress
    expect(popupHeightFor('remind')).toBeGreaterThan(popupHeightFor('progress'));
  });
});

describe('popupPosition', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const W = UPDATE_POPUP_WIDTH;
  const H = 116;

  it('始终贴右缘（内缩 16）', () => {
    const mac = popupPosition(workArea, W, H, 'darwin');
    const win = popupPosition(workArea, W, H, 'win32');
    const expectedX = 1920 - W - 16;
    expect(mac.x).toBe(expectedX);
    expect(win.x).toBe(expectedX);
  });

  it('mac 贴顶（通知区惯例）', () => {
    expect(popupPosition(workArea, W, H, 'darwin').y).toBe(16);
  });

  it('Win/Linux 贴底（toast 惯例）', () => {
    const expectedY = 1080 - H - 16;
    expect(popupPosition(workArea, W, H, 'win32').y).toBe(expectedY);
    expect(popupPosition(workArea, W, H, 'linux').y).toBe(expectedY);
  });

  it('尊重非零 workArea 原点（多屏/任务栏偏移）', () => {
    const wa = { x: 100, y: 40, width: 1000, height: 800 };
    const win = popupPosition(wa, W, H, 'win32');
    expect(win.x).toBe(100 + 1000 - W - 16);
    expect(win.y).toBe(40 + 800 - H - 16);
    expect(popupPosition(wa, W, H, 'darwin').y).toBe(40 + 16);
  });

  it('自定义 inset 生效 + 坐标取整', () => {
    const p = popupPosition({ x: 0, y: 0, width: 1000.5, height: 800 }, W, H, 'win32', 8);
    expect(p.x).toBe(Math.round(1000.5 - W - 8));
    expect(Number.isInteger(p.x)).toBe(true);
    expect(Number.isInteger(p.y)).toBe(true);
  });
});
