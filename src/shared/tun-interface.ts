/**
 * Windows TUN 接口名（wintun 适配器名）单一真值。
 *
 * 背景（issue #159）：Windows 服务模式硬杀 sing-box 后 wintun 适配器滞留，重启撞同名网卡 → open 卡死。
 * 修复需「起核前等自家 TUN 网卡释放」，而判据不能用 IP（172.19.0.1 是 FlowZ 默认地址，外部 sing-box /
 * 用户手动核 / 自家孤儿核都可能同址 → 误等/误删）。故给 Windows TUN 下发固定可辨的 interface_name，
 * 释放门控/清理只认本名。buildInbounds 下发的名字与 ProxyManager 等待的名字必须同源，否则等错网卡。
 *
 * 仅 Windows 用：macOS 的 utun 设备名由内核分配（sing-box 未必认自定义名），Linux 无此释放竞态——两者不设。
 */
import type { UserConfig } from './types';

/** FlowZ 专属 Windows TUN 接口名（缺省）。与外部 sing-box 默认 tun0 / 其它 VPN 网卡区分。 */
export const FLOWZ_WIN_TUN_INTERFACE = 'flowz-tun0';

/**
 * 解析 Windows TUN 接口名：尊重用户自定义 `tunConfig.interfaceName`（去空白后非空才用），否则回落 FlowZ 专属名。
 * buildInbounds（下发 interface_name）与 ProxyManager（适配器释放门控）共用，保证两侧锚定同一名字。
 */
export function resolveWinTunInterfaceName(config: UserConfig): string {
  const custom = config.tunConfig?.interfaceName?.trim();
  // 校验自定义名：仅字母数字/连字符/下划线、长度 1–32（Windows 接口名约束）。非法 → 回落缺省：脏名既可能令 sing-box
  // check/启动 FATAL，也会使 Get-NetAdapter -Name 永远匹配不到 → 释放门控对真实滞留网卡失效。校验后下发与门控同名、安全。
  if (custom && /^[A-Za-z0-9_-]{1,32}$/.test(custom)) return custom;
  return FLOWZ_WIN_TUN_INTERFACE;
}
