/**
 * app 在「无窗口」时是否应该退出，还是继续以托盘方式常驻——window-all-closed 的唯一判定点。
 *
 * macOS 恒不退出（红灯关窗/无窗口不退应用，是硬性平台惯例——真正退出走 Cmd+Q / Dock 菜单，不受任何
 * 应用内设置影响）。其余平台：minimizeToTray=false → 退出；minimizeToTray=true 但托盘图标创建失败
 * （hasTray=false）→ 仍需退出兜底，否则留下一个无窗口、无托盘图标、用户无法唤出的僵尸进程
 * （createTray() 失败会被静默吞掉，见 TrayManager.hasTray() 的注释）。
 */
export function shouldQuitOnAllWindowsClosed(
  platform: NodeJS.Platform,
  minimizeToTray: boolean,
  hasTray: boolean
): boolean {
  if (platform === 'darwin') return false;
  return !minimizeToTray || !hasTray;
}
