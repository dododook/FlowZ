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

/**
 * 更新链路会话目标求值（viaProxy + 有效 update-in 端口），单一真值。把易漂移的「端口闸」收口到一处：
 * = `resolveMainSessionViaProxy` 决定经代理；端口不可用(<=0) → 强制直连（不 pin 无效口）。返回的 viaProxy
 * 与 port 自洽（viaProxy=true ⟹ port>0）。UpdateNetwork.resolveSessionForMainUpdate（返回 Session 的四链路）
 * 与 icon-protocol（需裸 {viaProxy,port} 喂 SSRF guard）共用，避免端口闸规则在两处分叉。
 */
export function resolveUpdateProxyTarget(
  proxyRunning: boolean,
  mainSessionViaProxy: boolean | undefined,
  updateInPort: number | null | undefined
): { viaProxy: boolean; port: number } {
  let viaProxy = resolveMainSessionViaProxy(proxyRunning, mainSessionViaProxy);
  const port = updateInPort ?? 0;
  if (viaProxy && port <= 0) viaProxy = false;
  return { viaProxy, port };
}
