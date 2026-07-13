/**
 * 更新弹窗纯布局逻辑单测（无 electron 依赖）：态→高度、平台→角落定位、发布说明预览截断。
 */
import {
  UPDATE_POPUP_WIDTH,
  popupHeightFor,
  popupPosition,
  previewReleaseNotes,
} from '../update-popup-layout';

describe('popupHeightFor', () => {
  it('四态各有确定高度，remind 最高、progress/done 同高', () => {
    expect(popupHeightFor('remind')).toBe(184);
    expect(popupHeightFor('error')).toBe(152);
    expect(popupHeightFor('progress')).toBe(116);
    expect(popupHeightFor('done')).toBe(116);
    // remind 承载动作+说明 → 应高于 progress
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

describe('previewReleaseNotes', () => {
  it('空/undefined → 空串', () => {
    expect(previewReleaseNotes('')).toBe('');
    expect(previewReleaseNotes(undefined as unknown as string)).toBe('');
  });

  it('按行截前 maxLines 行', () => {
    const raw = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8';
    expect(previewReleaseNotes(raw, 3)).toBe('l1\nl2\nl3');
  });

  it('超 maxChars 截断补省略号', () => {
    const raw = 'x'.repeat(500);
    const out = previewReleaseNotes(raw, 6, 100);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(101);
  });

  it('去首尾空白', () => {
    expect(previewReleaseNotes('  hi  \n\n', 6)).toBe('hi');
  });

  it('不在 surrogate pair 中间截断（末尾无孤立 high surrogate）', () => {
    // '🚀' = 2 code units；构造边界恰落在 emoji 中间的场景。
    const raw = `${'a'.repeat(99)}🚀tail`;
    const out = previewReleaseNotes(raw, 6, 100); // 第 100 个 code unit = 🚀 的 high surrogate
    const last = out.charCodeAt(out.length - 2); // 末字符是 '…'，看其前一字符
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(out.endsWith('…')).toBe(true);
  });
});
