/**
 * update-popup-layout.ts — 更新弹窗的纯布局/文案计算（无 electron 依赖，便于单测）。
 *
 * 与 update-asset / update-install-script 同族：把可判定的纯逻辑从 UpdateService 抽离，process 与 electron
 * 由调用方注入。窗口尺寸按四态固定；角落停靠按平台（mac 右上=通知区惯例 / Win·Linux 右下=toast 惯例）；
 * 发布说明预览截断（弹窗 CSS 再做 2 行 ellipsis 视觉截断，这里只防超长载荷）。
 */
import type { UpdatePopupPhase } from '../../shared/types/update';

/** 弹窗固定宽度（现 360 放不下 remind 态的动作行 + 说明）。 */
export const UPDATE_POPUP_WIDTH = 380;

/**
 * 各态窗口内容高度（px，内容驱动的固定值）：
 * remind 最高（图标+标题+当前版本+2 行说明+动作行+文字链）；error 含 2 行错误文本+动作行；
 * progress/done 仅图标行+进度条+计数行。实现期可按真机微调，纯函数便于随规格演进钉测试。
 */
export function popupHeightFor(phase: UpdatePopupPhase): number {
  switch (phase) {
    case 'remind':
      return 184;
    case 'error':
      return 152;
    case 'progress':
    case 'done':
      return 116;
  }
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 角落停靠坐标：始终贴右缘，mac 贴顶（通知区惯例）、其余贴底（toast 惯例），workArea 内缩 inset。
 * 纯函数——workArea 由 screen.getPrimaryDisplay().workArea 注入，便于单测钉平台差异。
 */
export function popupPosition(
  workArea: Rect,
  width: number,
  height: number,
  platform: NodeJS.Platform,
  inset = 16
): { x: number; y: number } {
  const x = workArea.x + workArea.width - width - inset;
  const y =
    platform === 'darwin' ? workArea.y + inset : workArea.y + workArea.height - height - inset;
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * 发布说明预览：取前 maxLines 行、总长截 maxChars 字符（超出补省略号），去尾空白。
 * GitHub releaseNotes 可能很长/含 markdown——弹窗只展示概要，完整日志走「查看更新日志」外链。
 */
export function previewReleaseNotes(raw: string, maxLines = 6, maxChars = 400): string {
  const lines = (raw || '').split('\n').slice(0, maxLines).join('\n').trim();
  if (lines.length <= maxChars) return lines;
  let cut = lines.slice(0, maxChars);
  // 防在 surrogate pair 中间截断（末字符为孤立 high surrogate → 渲染 �）：多退一个 code unit。
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}
