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
 * remind（图标+标题+当前版本+动作行+文字链，无内联说明）；error 含 2 行错误文本+动作行；
 * progress/done 仅图标行+进度条+计数行。纯函数便于随规格演进钉测试。
 * headroom 约定：固定值在 Linux 自然内容高之上留 ~15px 余量（progress/done 实测 ~15.5、error ~30），
 * 吸收 Win/Mac CJK 字体（PingFang/微软雅黑 vs Noto）行高差异——宁多留（margin-top:auto 吸成极小内部
 * 间距、不可见）不裁切（overflow:hidden 会切底部行）。remind 自然高 146.5(Linux/Xvfb 实测)→160。
 */
export function popupHeightFor(phase: UpdatePopupPhase): number {
  switch (phase) {
    case 'remind':
      return 160;
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
