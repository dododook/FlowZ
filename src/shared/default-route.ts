/** 解析 macOS `route -n get default` 的输出，取出网关 IPv4。无 gateway 行 → null。纯函数，供安全网捕获默认路由。 */
export function parseDefaultGateway(routeGetOutput: string): string | null {
  for (const line of routeGetOutput.split('\n')) {
    const m = line.match(/^\s*gateway:\s*(\d+\.\d+\.\d+\.\d+)\s*$/);
    if (m) return m[1];
  }
  return null;
}

/**
 * 解析 `echo 'show State:/Network/Global/IPv4' | scutil` 的输出，取 configd 维护的**当前**默认网关 Router(IPv4)。
 * 关键：configd 的 State 反映 DHCP/网络服务的当前网关，**不受路由表被 sing-tun 删除影响**——故停核补回时用它，
 * 即便会话中途换网（192.168.5.1 → 192.168.x.x）也准确，避免回填起核时的陈旧网关。无 Router 行 → null。
 */
export function parseScutilRouter(scutilOutput: string): string | null {
  for (const line of scutilOutput.split('\n')) {
    const m = line.match(/^\s*Router\s*:\s*(\d+\.\d+\.\d+\.\d+)\s*$/);
    if (m) return m[1];
  }
  return null;
}
