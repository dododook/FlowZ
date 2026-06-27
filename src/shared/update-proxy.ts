/**
 * 更新链路（应用/资源/订阅/核心）「经代理」生效求值（单一真值）。
 *
 * = 代理运行中 `AND` `mainSessionViaProxy` 未显式关闭（默认开）。代理未运行 → 直连（自举友好：
 * 启动期代理未起时更新检查/资源拉取走直连，不卡死）。详见 docs/design/update-network-unification.md §6。
 */
export function resolveMainSessionViaProxy(
  proxyRunning: boolean,
  mainSessionViaProxy: boolean | undefined
): boolean {
  return proxyRunning && mainSessionViaProxy !== false;
}
