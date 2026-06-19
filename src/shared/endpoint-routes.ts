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
 * Phase 2：组网节点是否启用 system 内核接口（reverseMesh=反向可达/被访问，WG `system:true` /
 * Tailscale `system_interface:true`）。缺省 false=userspace gVisor 栈（Phase 1）。**纯用户意图**：
 * 「reverseMesh ⟹ helper 提权已就位」由上层校验/连接闸门 + ProxyManager emit 门控强制（见 server-completeness
 * 与 buildOutbounds 的 allowSystemInterface），故本函数在 config 构建期可等同 effective system 态。
 */
export function meshUsesSystemInterface(server: ServerConfig): boolean {
  const p = server.protocol?.toLowerCase();
  if (p === 'wireguard') return server.wireguardSettings?.reverseMesh === true;
  if (p === 'tailscale') return server.tailscaleSettings?.reverseMesh === true;
  return false;
}

/**
 * 该组网节点是否承载「全隧道默认出口」(0/0)。= 允许外网 **且非** system 内核接口。
 * 结论A：system:true 恒 specific-only（内核接口若装 0/0 默认路由 → 跨平台环路/冲突，#3756/#3858），
 * 故 system 节点即便 allowInternet=on 也不承载 0/0、永不当全局出口。单一真值：Layer A 注入 0/0、
 * D4/D7 选中兜底、Tailscale exit_node 门控、UI「可作出口」判定共用，避免「allowsInternet 但其实不出网」漂移。
 */
export function meshNodeCarriesFullTunnel(server: ServerConfig): boolean {
  return meshAllowsInternet(server) && !meshUsesSystemInterface(server);
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
  // Phase 2 system:true（内核接口）：L1=L2=specific-only，恒去 0/0（结论A），不论 allowInternet。
  // sing-box 把 allowed_ips 并集同时当 cryptokey 加密集 + OS 路由集（F4 不可拆）→ 含 0/0 会装默认路由致环路。
  // specific 为空 → null（同 off+空，空 allowed_ips=FATAL，调用方据 null 跳过发射）。
  if (meshUsesSystemInterface(server)) {
    return specific.length > 0 ? specific : null;
  }
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
 * D4/D7（+Phase2）：选中「不承载全隧道的组网节点」(WG/Tailscale，allowInternet=off **或** system:true 内核接口
 * 恒 specific-only，见 meshNodeCarriesFullTunnel) 为**主节点**时，「→代理」的用户出口
 * （global 的 route.final；smart 的 geosite-!cn / google 关键词 / final）应整体兜底回 'direct'，而非
 * proxy-selector——proxy-selector.default = 该 off-mesh 节点，非具体段/海外流量进其用户态栈被 cryptokey
 * routing 丢弃（allowed_ips 不含 0/0）→ 黑洞断网。具体段仍由 force-route（排在这些规则之前）经组网节点；
 * 用户其余流量直连保上网。**global 与 smart 同此兜底**（D7 修复：原仅 global 留下 smart 海外黑洞）；direct 模式
 * 本就 final=direct、无「→代理」规则，不适用。
 *
 * 残留（已知较窄，非本兜底覆盖）：用户显式创建的「应用分流·代理·无固定目标」规则仍 default=proxy-selector→
 * off-mesh 节点；该 app 的流量仍会被丢弃。属用户对 off-mesh 主节点显式指定代理的自相矛盾配置，由角标/警告提示，
 * 不在本运行期兜底内（彻底消除需「禁止 off-mesh 作主节点」更大改动，列为后续）。
 */
export function meshSelectedExitFallsBackToDirect(config: UserConfig): boolean {
  if ((config.proxyMode || 'smart').toLowerCase() === 'direct') return false;
  const selected = config.servers?.find((s) => s.id === config.selectedServerId);
  return (
    !!selected && isEndpointProtocol(selected.protocol) && !meshNodeCarriesFullTunnel(selected)
  );
}

/**
 * 全部节点的 mesh force-route 段并集（去重）。供「路由规则与组网段重叠」提醒共用：
 * main 的 config-gen warn + renderer 的内联 hint/列表角标。用全量 servers（非仅 emitted）以覆盖潜在重叠。
 */
export function meshForcedRouteCidrs(servers: ServerConfig[]): string[] {
  return Array.from(new Set(servers.flatMap((s) => endpointForcedRouteCidrs(s))));
}

/**
 * 跨组网节点同网段「被覆盖（shadowed）」检测：按 `servers` 顺序「首声明者占有」（与 route-builder
 * `claimedCidrs` 同一不变量——一条 ip_cidr 只能指向一个 outbound，首条命中即生效）。返回 serverId →
 * 该节点中被更早节点抢占、因而**不会**实际生效的具体段列表（仅含有冲突的节点）。供列表「网段被覆盖」角标
 * 提醒用：用户据此去重/调序/用自定义规则覆盖。route-builder 仅对 emitted 端点应用此规则并 warn；本函数用
 * 全量 servers 给 UI 概览（更早暴露潜在重叠）。
 */
export function meshShadowedCidrs(servers: ServerConfig[]): Map<string, string[]> {
  const claimed = new Set<string>();
  const result = new Map<string, string[]>();
  for (const s of servers) {
    const shadowed: string[] = [];
    for (const c of endpointForcedRouteCidrs(s)) {
      if (claimed.has(c)) shadowed.push(c);
      else claimed.add(c);
    }
    if (shadowed.length > 0) result.set(s.id, shadowed);
  }
  return result;
}
