/**
 * 桌面通知（用户态系统通知）统一出口。跨平台：Electron `Notification` 已封装 macOS=UNUserNotificationCenter /
 * Windows=Action Center toast / Linux=libnotify，本模块无任何平台分支 → 三端行为一致。
 *
 * 设计：
 * - **应用级总开关**（config.desktopNotifications，默认开）：用户可整体关闭，setDesktopNotificationsEnabled 同步。
 * - **isSupported 守卫 + try/catch**：不支持/异常静默降级，绝不抛、绝不阻塞调用方主流程。
 * - **不含节点身份**：通知会进系统通知中心/锁屏可见，正文只放应用自生成的通用文案/错误信息，不写节点名/域名/IP。
 * - macOS 现状 adhoc 未公证：通知可弹（provisional 授权），但授权态可能随重建变动；持久稳定需 Developer ID + 公证。
 */
import { Notification } from 'electron';

let enabled = true;

/** 同步应用级总开关（config.desktopNotifications，缺省/非 false 视为开）。启动加载 + CONFIG_CHANGED 调用。 */
export function setDesktopNotificationsEnabled(value: boolean | undefined): void {
  enabled = value !== false;
}

/** 当前应用级开关（供测试/诊断）。 */
export function isDesktopNotificationsEnabled(): boolean {
  return enabled;
}

/**
 * 发一条桌面通知。应用级关 / 系统不支持 / 异常 → 静默不发，绝不抛。
 * @param title   标题（品牌/分类，建议语言中性如 'FlowZ'）
 * @param body    正文（应用自生成文案/错误信息，**不得含节点名等身份**）
 * @param onClick 可选：点击通知的回调（如打开设置/浏览器）
 */
export function notifyUser(title: string, body: string, onClick?: () => void): void {
  if (!enabled) return;
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    if (onClick) n.on('click', onClick);
    n.show();
  } catch {
    /* 通知失败不影响主流程 */
  }
}
