import type { ServerConfig, Protocol } from './types';

/** sing-box endpoint 协议（顶层 endpoints[]、非 outbound）：WireGuard / Tailscale。单一真值，杜绝多处枚举漂移。 */
export const ENDPOINT_PROTOCOLS: readonly Protocol[] = ['wireguard', 'tailscale'];
export function isEndpointProtocol(protocol: string | undefined): boolean {
  return !!protocol && ENDPOINT_PROTOCOLS.includes(protocol.toLowerCase() as Protocol);
}

/** 账号制协议（连控制面、无 server address/port）：当前仅 Tailscale。供连接闸门/校验豁免 address/port。 */
export function isAccountBasedProtocol(protocol: string | undefined): boolean {
  return protocol?.toLowerCase() === 'tailscale';
}

/** WG allowedIPs 里的 catch-all（全量代理用，不进 force-route——0/0 路由由 selector/final 接管）。 */
const CATCH_ALL = new Set(['0.0.0.0/0', '::/0']);

/** Tailscale tailnet 自身段（CGNAT）。tailnet peer 的 IP 都在此；不在 bypass-LAN 私网表，故必须 force-route。 */
export const TAILNET_CGNAT = '100.64.0.0/10';

/**
 * 该 endpoint 节点应被「强制路由到自身 tag」的具体 CIDR（userspace；优先于 bypass-LAN、独立于全局选中）。
 * 单一真值：节点路由由其配置 CIDR 决定，不再有独立「绕过局域网排除段」。
 *   - WireGuard：allowedIPs 去掉 0/0、::/0（catch-all 是全量代理语义、由 selector/final 接管）。
 *   - Tailscale：tailnet 段 100.64.0.0/10（自动，必需）+ routes（用户填的 advertised 子网）。
 * 非 endpoint 协议返回 []。重复/空白去除。
 */
export function endpointForcedRouteCidrs(server: ServerConfig): string[] {
  const p = server.protocol?.toLowerCase();
  let raw: string[] = [];
  if (p === 'wireguard') {
    raw = (server.wireguardSettings?.allowedIPs || []).filter((c) => !CATCH_ALL.has(c.trim()));
  } else if (p === 'tailscale') {
    raw = [TAILNET_CGNAT, ...(server.tailscaleSettings?.routes || [])];
  } else {
    return [];
  }
  return Array.from(new Set(raw.map((c) => c.trim()).filter(Boolean)));
}
