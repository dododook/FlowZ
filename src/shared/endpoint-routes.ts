import type { ServerConfig, Protocol, UserConfig } from './types';

/** sing-box endpoint 协议（顶层 endpoints[]、非 outbound）：WireGuard / Tailscale。单一真值，杜绝多处枚举漂移。 */
export const ENDPOINT_PROTOCOLS: readonly Protocol[] = ['wireguard', 'tailscale'];
export function isEndpointProtocol(protocol: string | undefined): boolean {
  return !!protocol && ENDPOINT_PROTOCOLS.includes(protocol.toLowerCase() as Protocol);
}

/** 账号制协议（连控制面、无 server address/port）：当前仅 Tailscale。供连接闸门/校验豁免 address/port。 */
export function isAccountBasedProtocol(protocol: string | undefined): boolean {
  return protocol?.toLowerCase() === 'tailscale';
}

/** 全网段（catch-all / 全隧道）：IPv4 0.0.0.0/0 + IPv6 ::/0。单一真值——force-route 剥离、allowInternet=on
 * 注入 peer.allowed_ips、表单显示/录入剥离 均复用此清单，杜绝多处字面量漂移。 */
export const FULL_TUNNEL_CIDRS = ['0.0.0.0/0', '::/0'] as const;
const CATCH_ALL = new Set<string>(FULL_TUNNEL_CIDRS);

/** 从 CIDR 列表剥离全网段（catch-all），仅留具体段；逐项 trim 比对。allowedIPs 显示/force-route 共用。 */
export function stripCatchAll(cidrs: string[] | undefined): string[] {
  return (cidrs || []).filter((c) => !CATCH_ALL.has(c.trim()));
}

/** CIDR 列表是否含任一全网段（catch-all）= 全隧道意图。wg-quick 导入据此推断 allowInternet。 */
export function hasCatchAll(cidrs: string[] | undefined): boolean {
  return (cidrs || []).some((c) => CATCH_ALL.has(c.trim()));
}

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
    raw = stripCatchAll(server.wireguardSettings?.allowedIPs);
  } else if (p === 'tailscale') {
    raw = [TAILNET_CGNAT, ...(server.tailscaleSettings?.routes || [])];
  } else {
    return [];
  }
  return Array.from(new Set(raw.map((c) => c.trim()).filter(Boolean)));
}

/**
 * 组网节点（WireGuard / WARP / Tailscale）是否允许作外网出口（「允许访问外网」开关）。
 * 缺省 true（向后兼容 + 新建默认开）；仅显式 false 关闭。非组网协议恒 true（该语义不适用）。
 * 单一真值：Layer A(allowed_ips)、Tailscale exit_node 门控、D4 final 兜底、UI 角标共用。
 */
export function meshAllowsInternet(server: ServerConfig): boolean {
  const p = server.protocol?.toLowerCase();
  if (p === 'wireguard') return server.wireguardSettings?.allowInternet !== false;
  if (p === 'tailscale') return server.tailscaleSettings?.allowInternet !== false;
  return true;
}

/**
 * WireGuard peer.allowed_ips（Layer A，栈内 cryptokey routing，**永不碰系统 main 表**）：
 *   - allowInternet=on  → dedup(specific ∪ {0.0.0.0/0, ::/0})（两族全给，不按地址族裁剪，v6 取舍交全局 enableIPv6）
 *   - allowInternet=off → specific（仅承载列表网段）；**specific 为空 → 返回 null**（空 allowed_ips 会让 sing-box
 *     FATAL，sing-box 1.13.13 实测 `missing allowed ips for peer 0` → 调用方据 null 跳过发射该 endpoint）。
 * specific 复用 endpointForcedRouteCidrs（WG=allowedIPs 去 catch-all、trim 去重）。
 */
export function wireguardPeerAllowedIps(server: ServerConfig): string[] | null {
  const specific = endpointForcedRouteCidrs(server);
  if (meshAllowsInternet(server)) {
    return Array.from(new Set([...specific, ...FULL_TUNNEL_CIDRS]));
  }
  return specific.length > 0 ? specific : null;
}

/**
 * 组网节点是否「关外网且无可路由网段」→ 不可发射/不可用（空 allowed_ips=FATAL，必须在生成期拦截，否则连累
 * 整份 sing-box 配置 FATAL）。仅 WireGuard/WARP 可能命中（off + 无具体段）；Tailscale off 仍达 tailnet
 * (auto 100.64.0.0/10) 故恒可发射、不算 unroutable。供 buildOutbounds 跳过发射 + 渲染侧连接闸门置灰共用。
 */
export function isMeshNodeUnroutable(server: ServerConfig): boolean {
  if (server.protocol?.toLowerCase() === 'wireguard') {
    return wireguardPeerAllowedIps(server) === null;
  }
  return false;
}

/**
 * D4：global 模式选中「关闭外网的组网节点」时 route.final 应兜底回 'direct'（而非 proxy-selector）。
 * 否则非具体段流量会被送进该节点的用户态 WG 栈、因 allowed_ips 不含 0/0 被 cryptokey routing 丢弃 → 黑洞断网。
 * 具体段仍由 force-route（排在 final 之前）经组网节点；用户其余流量直连保上网。仅 global 命中（smart/direct 不适用）。
 */
export function meshGlobalFinalFallsBackToDirect(config: UserConfig): boolean {
  if ((config.proxyMode || 'smart').toLowerCase() !== 'global') return false;
  const selected = config.servers?.find((s) => s.id === config.selectedServerId);
  return !!selected && isEndpointProtocol(selected.protocol) && !meshAllowsInternet(selected);
}

/**
 * 全部节点的 mesh force-route 段并集（去重）。供「路由规则与组网段重叠」提醒共用：
 * main 的 config-gen warn + renderer 的内联 hint/列表角标。用全量 servers（非仅 emitted）以覆盖潜在重叠。
 */
export function meshForcedRouteCidrs(servers: ServerConfig[]): string[] {
  return Array.from(new Set(servers.flatMap((s) => endpointForcedRouteCidrs(s))));
}
