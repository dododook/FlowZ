import type { ServerConfig, Protocol, UserConfig } from './types';
import { dedupe, dedupeTrim } from './collections';
import { isWarpServer } from './warp';
import { isDirectSelection } from './direct-selection';

/** sing-box endpoint 协议（顶层 endpoints[]、非 outbound）：WireGuard / Tailscale。单一真值，杜绝多处枚举漂移。 */
export const ENDPOINT_PROTOCOLS: readonly Protocol[] = ['wireguard', 'tailscale'];
export function isEndpointProtocol(protocol: string | undefined): boolean {
  return !!protocol && ENDPOINT_PROTOCOLS.includes(protocol.toLowerCase() as Protocol);
}

/** 账号制协议（连控制面、无 server address/port）：当前仅 Tailscale。供连接闸门/校验豁免 address/port。 */
export function isAccountBasedProtocol(protocol: string | undefined): boolean {
  return protocol?.toLowerCase() === 'tailscale';
}

/**
 * Tailscale 单节点硬限：已存在一个 Tailscale 节点时该「槽位」即被占用。
 * 同一设备的所有 Tailscale 账号共用同一段网络地址（100.64.0.0/10 tailnet），多个会互相顶掉，故全局只许一个。
 * editingId 排除自身——编辑现有 TS 节点不算「再加一个」，必须放行。
 * 纯函数（仅看协议字段）：UI 主拦截点（use-server-actions）+ ConfigManager 兜底归一共用，可离线单测。
 */
export function tailscaleSlotTaken(servers: ServerConfig[], editingId?: string): boolean {
  return servers.some((s) => s.protocol?.toLowerCase() === 'tailscale' && s.id !== editingId);
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
 * Tailscale v6 tailnet 段（固定 ULA 前缀，Tailscale 官方把所有 tailnet v6 地址分配于此）。tailnet peer 的 v6 IP
 * 都在此；**⊂ bypass-LAN 的 `fc00::/7`（v6 ULA 全段）** → Windows 下会被 bypassLAN 内核排除出 TUN，须与 v4 tailnet
 * 同样 force-route + Windows carve 开洞（`subtractCidrs` v6-aware 自动挖 fd7a 洞），否则 enableIPv6 开启时 v6 tailnet
 * 流量去 exit 而非走 tailnet（缺此段的原 bug）。FakeIP 假 v6 段 `2001:2::/48` 在 benchmarking 保留段、不占 ULA，与此零相交。
 */
export const TAILNET_ULA_V6 = 'fd7a:115c:a1e0::/48';

// System 模式内核接口固定名（下发 sing-box system_interface_name）。出口托管 MeshExitRouteManager
// 按此名在内核接口装/清 exit 拆半默认路由 + 精确定位（见 mesh-exit-route.ts）。WG 端点名选项待证，
// 取不到则按隧道 IP 反查（uncertainties #1）。
export const TS_SYSTEM_INTERFACE_NAME = 'flowz-ts';
export const WG_SYSTEM_INTERFACE_NAME = 'flowz-wg';

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
    // 与 WireGuard 分支对齐：剥 catch-all（0/0），TS 全隧道走 exitNode，routes 不该承载 0.0.0.0/0。
    // 两族 tailnet 段恒发（v4 CGNAT + v6 ULA）：v6 段实际生效由全局 enableIPv6 门控——关闭时 AAAA 抑制、无 v6 流量，
    // force-route 规则携 v6 ip_cidr 无害；开启时确保 v6 tailnet peer（fd7a:115c:a1e0::/48）走 tailnet 而非 exit（原缺此段=bug）。
    raw = [TAILNET_CGNAT, TAILNET_ULA_V6, ...stripCatchAll(server.tailscaleSettings?.routes)];
  } else {
    return [];
  }
  return dedupeTrim(raw);
}

/**
 * 组网节点（WireGuard / WARP / Tailscale）是否允许作外网出口（「允许访问外网」开关）。
 * 缺省 true（向后兼容 + 新建默认开）；仅显式 false 关闭。非组网协议恒 true（该语义不适用）。
 * 单一真值：Layer A(allowed_ips)、Tailscale exit_node 门控、D4 final 兜底、UI 角标共用。
 */
export function meshAllowsInternet(server: ServerConfig): boolean {
  const p = server.protocol?.toLowerCase();
  if (p === 'wireguard') return server.wireguardSettings?.allowInternet !== false;
  // Tailscale：allowInternet 由 exit_node 派生（把表单单一真值 tailscale-form `allowInternet=!!exitNode` 下沉到谓词层，
  // §H.5/P0b）。治 S-b：quick-join 硬编码 `allowInternet:true` 但无 exit_node 时不再误判「承载全隧道」→ 公网从「进
  // tsnet 无出口的黑洞」变「回退 direct」（安全），且不为其装 OS 出口路由；与「无出口设备」警示语义严格镜像。
  // 存量 tailscaleSettings.allowInternet 字段谓词层忽略（向后兼容、不迁移）。
  if (p === 'tailscale') return !!server.tailscaleSettings?.exitNode?.trim();
  return true;
}

/**
 * 组网节点是否「始终路由其内网段」(force-route 常驻)。缺省 true（向后兼容 + 新建默认开=网段恒可达）；仅显式
 * false 关闭=「仅出网」语义：网段只在节点 engaged（被选中/被规则指向）时才路由。与 allowInternet 正交——
 * allowInternet 控 0/0 全隧道出网，本开关控 specific 段是否常驻。**只 gate route.rules，绝不碰 allowed_ips。**
 */
export function meshAlwaysRoutesSubnets(server: ServerConfig): boolean {
  const p = server.protocol?.toLowerCase();
  if (p === 'wireguard') return server.wireguardSettings?.alwaysRouteSubnets !== false;
  if (p === 'tailscale') return server.tailscaleSettings?.alwaysRouteSubnets !== false;
  return true;
}

/**
 * 该组网节点的 force-route 段本轮是否应发射（route-builder 块 0c 的 gate）。纯函数 + 注入式，全矩阵可单测：
 *   - alwaysRouteSubnets ON（默认/旧配置）→ 恒发射（现状，网段恒可达）。
 *   - OFF（仅出网）→ 仅当节点 engaged：被选中为主出口（selectedServerId），或被某条 enabled 规则/应用分流
 *     显式指向（ruleTargetedServerIds，由 route-builder 从 effectiveCustomRules/AppRules 的 targetServerId 汇集）。
 * 注意：本谓词只决定「是否把内网段 force-route 到自身 tag」，**不影响 peer.allowed_ips**——故 OFF 节点被选中时
 * 网段仍可达（隧道接受 + 此时本谓词返回 true → 发 force-route 覆盖 bypass-LAN）。
 */
export function shouldForceRouteSubnets(
  server: ServerConfig,
  selectedServerId: string | null | undefined,
  ruleTargetedServerIds: ReadonlySet<string>
): boolean {
  if (meshAlwaysRoutesSubnets(server)) return true;
  if (server.id === selectedServerId) return true;
  return ruleTargetedServerIds.has(server.id);
}

/**
 * 收集「显式指向某节点」的规则目标 id：仅 `enabled && action==='proxy' && targetServerId`——与全库 targetServerId
 * 消费口径一致（`targetServerId` 仅 action==='proxy' 时有效，见 Rule/AppRule 注释；非 proxy 的陈旧 targetServerId 不算）。
 * 守卫单一真值：route-builder 块 0c 的 engaged 判定 + warn/shadow 同步过滤共用。backend 传 effective 规则、UI 传
 * config 原始规则（结构兼容 `{enabled?, action?, targetServerId?}`，类型在各侧已知）。
 */
export function collectRuleTargetedServerIds(
  rules: ReadonlyArray<{ enabled?: boolean; action?: string; targetServerId?: string }> | undefined
): Set<string> {
  const ids = new Set<string>();
  for (const r of rules ?? []) {
    if (r.enabled && r.action === 'proxy' && r.targetServerId) ids.add(r.targetServerId);
  }
  return ids;
}

/**
 * custom-endpoint（`customSettings.isEndpoint`）的 raw JSON（`customSettings.outbound`）是否含「独立承载流量」语义键：
 *   - `system` / `system_interface`：绑内核接口（WG system:true / Tailscale system_interface），广播路由入内核，独立于选中即导流。
 *   - `allowed_ips`：WireGuard cryptokey routing（常嵌于 peers[]），broad / 0.0.0.0/0 = 全隧道。
 *   - `routes` / `route_address` / `route_exclude_address`：路由 / 排除段（tailscale-ish 及通用路由键）。
 *   - `accept_routes` / `advertise_routes` / `exit_node`：Tailscale 承流/子网路由键（装 tailnet/子网路由入内核）。
 * 深度扫（递归任意嵌套，含 peers[].allowed_ips），命中任一即真。保守方向：过度纳入只多一次重启、绝不错跳——
 * 漏纳入才致其 edit/delete 被免重启、旧参数残留继续导流 → 泄漏。纯只读、无副作用，可离线单测。
 */
const CARRY_TRAFFIC_KEYS = new Set<string>([
  'system',
  'system_interface',
  'allowed_ips',
  'routes',
  'route_address',
  'route_exclude_address',
  'accept_routes',
  'advertise_routes',
  'exit_node',
]);
export function customEndpointCarriesTraffic(raw: unknown): boolean {
  if (Array.isArray(raw)) return raw.some((v) => customEndpointCarriesTraffic(v));
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (CARRY_TRAFFIC_KEYS.has(k)) return true;
      if (customEndpointCarriesTraffic(v)) return true;
    }
  }
  return false;
}

/**
 * issue #176 P2-A：「被引用节点」id 集——其定义变化会影响运行核实际行为、故必须随之重启（或订阅自动刷新须 apply）。
 *   = {选中节点} ∪ {所有启用规则(custom/app)目标}，按 detour（前置代理链）传递闭包展开
 *   ＋ 保守纳入全部 endpoint 协议节点（WireGuard/Tailscale 可能 force-route 子网/mesh，独立于选中即承载流量）。
 * 其余「纯代理」节点仅作 selector 惰性成员、不承载任何流量，增删改不改变运行核行为 → 不在此集 → 可免重启。
 * 安全方向：**过度纳入只会多一次重启、绝不错跳**（漏纳入才会错误免重启致运行核用旧前置参数 → 流量错误/泄漏）。
 *   故 endpoint 一律纳入、detour 取全闭包、direct 哨兵剔除、悬空 detour 忽略。
 * 注：custom-endpoint（`customSettings.isEndpoint`）不被 isEndpointProtocol 纳入，其 `endpointForcedRouteCidrs`
 *   恒返 []（route-builder 不为其发 force-route）——但 raw JSON 会原样进运行核 endpoints[]，若含 `system` / broad
 *   `allowed_ips` / route-ish 键（customEndpointCarriesTraffic 命中），该端点即便未被选中也独立承载流量 → 其
 *   edit/delete 必须 force-restart（否则被 defer、旧参数残留继续导流=泄漏）→ 保守纳入引用集。无此类键者仍按未引用免重启。
 * 单一真值：ProxyManager（canSkip/getPendingNodeChanges）与 SubscriptionScheduler（自动刷新被引用节点变更判定）共用。
 */
export function referencedServerIds(c: UserConfig): Set<string> {
  const byId = new Map(c.servers.map((s) => [s.id, s]));
  const R = new Set<string>();
  const stack: string[] = [];
  const seed = (id?: string | null): void => {
    if (id && !isDirectSelection(id)) stack.push(id);
  };
  seed(c.selectedServerId);
  for (const r of c.customRules || []) if (r.enabled) seed(r.targetServerId);
  for (const a of c.appRules || []) if (a.enabled) seed(a.targetServerId);
  for (const s of c.servers) {
    if (isEndpointProtocol(s.protocol)) {
      stack.push(s.id); // 保守纳入全部原生 endpoint 协议（WireGuard/Tailscale）
    } else if (
      s.customSettings?.isEndpoint &&
      customEndpointCarriesTraffic(s.customSettings?.outbound)
    ) {
      stack.push(s.id); // custom-endpoint raw JSON 带承载流量语义键 → 保守纳入（见函数头注）
    }
  }
  while (stack.length) {
    const id = stack.pop() as string;
    if (R.has(id)) continue; // 成环/重复保护
    R.add(id);
    const s = byId.get(id);
    if (s?.detour && byId.has(s.detour)) stack.push(s.detour); // detour 前置链传递闭包
  }
  return R;
}

/**
 * 本轮「实际会发射 force-route」的组网节点（与块 0c `shouldForceRouteSubnets` 同口径）：alwaysRouteSubnets ON、
 * 或被选中、或被规则显式指向。供「自定义规则与组网段重叠」warn / 「网段被覆盖」shadow 角标与**发射端同口径**，
 * 杜绝对「仅出网且未 engaged」节点虚报覆盖/被覆盖（非组网协议恒保留，对 cidr/shadow 计算无副作用）。
 *
 * 注（advisory 边界，非路由层）：backend 调用方传 effective 规则（已按 proxyMode/appRoutingEnabled mode-gate），
 * UI 调用方传 config 原始规则——故 global/direct 模式下 UI 的 ruleTargetedServerIds 估计可能偏宽（把失效规则也算
 * engaged），极窄场景下角标指向略有偏差。仅影响提醒角标、不影响实际 route.rules / allowed_ips（backend 自洽）；
 * 不在 UI 复制 backend mode-gate 以免脆弱重复，作为已知 advisory 近似。
 */
export function meshForceRoutedServers(
  servers: ServerConfig[] | undefined,
  selectedServerId: string | null | undefined,
  ruleTargetedServerIds: ReadonlySet<string>
): ServerConfig[] {
  return (servers ?? []).filter((s) =>
    shouldForceRouteSubnets(s, selectedServerId, ruleTargetedServerIds)
  );
}

/**
 * Phase 2：组网节点是否启用 system 内核接口（reverseMesh=反向可达/被访问，WG `system:true` /
 * Tailscale `system_interface:true`）。缺省 false=userspace gVisor 栈（Phase 1）。**纯用户意图**：
 * 「reverseMesh ⟹ helper 提权已就位」由上层校验/连接闸门 + ProxyManager emit 门控强制（见 server-completeness
 * 与 buildOutbounds 的 allowSystemInterface），故本函数在 config 构建期可等同 effective system 态。
 */
export function meshUsesSystemInterface(server: ServerConfig): boolean {
  const p = server.protocol?.toLowerCase();
  if (p === 'wireguard') {
    // WARP（Cloudflare anycast 出口）不支持组网/反向可达，恒 gVisor——内核接口对它无意义：它不是子网路由器、
    // 不可被反向访问。且 WARP system:true 会与主 TUN / 另一 System 接口抢内核 utun 资源 →
    // `post-start endpoint/wireguard[Cloudflare WARP]: Connect: resource busy` FATAL（真机实证，多网卡时必现）。
    // 用 isWarpServer 鲁棒判定（含旧/导入的无 warpDevice 标记 WARP，按端点域名兜底）→ 无论 reverseMesh 一律否决。
    if (isWarpServer(server)) return false;
    return server.wireguardSettings?.reverseMesh === true;
  }
  if (p === 'tailscale') return server.tailscaleSettings?.reverseMesh === true;
  return false;
}

/**
 * 平台是否支持组网 System 内核接口模式（reverseMesh）。**Windows 禁 System**：Windows 上 sing-box 的 tsnet 给
 * flowz-ts 自装 exit 0/0 metric=0、抢直连/bootstrap DNS 致全网瘫，且无 macOS 的 ifscope 作用域可隔离 → System
 * 不可靠；故 Windows 一律强制 gVisor（userspace 栈零提权、不建内核接口、出口经 tsnet 内部转发不依赖 OS 路由）。
 * macOS/Linux 支持 System。接受 process.platform / window.electron.platform 取值，是「Windows 禁 System」的**单一
 * 真值谓词**——ProxyManager.systemInterfaceAvailable、start-retry 预算、UI AccessModeField、MeshExitRouteManager
 * 共用，避免散落多处平台判断漂移（同 neighbor.ts 的能力谓词模式）。
 */
export function meshSystemSupportedOnPlatform(
  platform: NodeJS.Platform | string | undefined
): boolean {
  return (platform || '').toLowerCase() !== 'win32';
}

/** 测速可行性能力位（path-aware）：主核 probe 池是否可用（=代理运行且池就绪）。 */
export interface SpeedTestCaps {
  mainCorePool?: boolean;
}

/**
 * 节点是否参与测速（path-aware，§16.1）。
 *  - TS-exit（exitNode 非空 && 非 reverseMesh）：**仅主核池路径**可测（caps.mainCorePool）——主核 tsnet 认证态活着、
 *    TS tag 已是 probe-selector 成员；临时核路径建不出第二 tsnet 实例，维持排除。
 *  - TS-mesh-only（无 exitNode）：meshAllowsInternet=false → 公网黑洞必假超时 → 恒排除。
 *  - reverseMesh(system 内核接口)：非选中时 dial 走 OS default = 测出直连假好值 → 恒排除。
 *  - custom endpoint：raw-JSON 无 gate 真值 → 恒排除。
 * 缺省 caps（不传/临时核口径）：TS 一律不可测——与 ProxyManager.buildSpeedTestOutbound 的 null 分支同口径。
 * WireGuard（非 reverseMesh）仍可测。
 */
export function isSpeedTestable(server: ServerConfig, caps?: SpeedTestCaps): boolean {
  const p = server.protocol?.toLowerCase();
  if (p === 'tailscale') {
    return (
      caps?.mainCorePool === true &&
      meshAllowsInternet(server) && // ⟺ !!exitNode（本文件 :92）
      !meshUsesSystemInterface(server) // reverseMesh 排除（假好值）
    );
  }
  if (meshUsesSystemInterface(server)) return false;
  if (p === 'custom' && server.customSettings?.isEndpoint) return false;
  return true;
}

/**
 * 该组网节点是否承载「全隧道默认出口」（全部出网流量经它）= 允许外网（**与接入模式正交**）。
 *  - WireGuard/WARP：gVisor 用裸 {0/0,::/0}；**system WG 用预折半 {0/1,128/1,::/1,8000::/1}**（见
 *    wireguardPeerAllowedIps）——cryptokey 覆盖等同 0/0，但 sing-box 装的是折半 ifscope 路由（像主 TUN 的
 *    BuildAutoRouteRanges 产物）、不装裸 default → 不触发删 macOS 全局 default（裸 0/0 会删、停核断网，monitor 实证）。
 *  - Tailscale：exit_node ≠ 0/0，出口由 MeshExitRouteManager 以 ifscope 托管、不碰全局 default。
 * 单一真值：Layer A(allowed_ips) / D4/D7 选中兜底 / TS exit_node 门控 / UI「可作出口」共用。
 */
export function meshNodeCarriesFullTunnel(server: ServerConfig): boolean {
  return meshAllowsInternet(server);
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
  // 全隧道意图 → specific ∪ {0/0,::/0}。system WG 也用裸 0/0（cryptokey 需要）——预折半已证伪：sing-tun 落内核前
  // 把 0/1+128/1 合并回裸 0/0（netstat 实证），照样撞 en0 default 的 EEXIST、被 setRoutes 善后删掉（tun_darwin.go
  // :451），且 unsetRoutes 停核不回填 → 断网。该断网由 ProxyManager 的「全局 default 存/停核补回」安全网兜底。
  // off/空 → specific（空则 null，空 allowed_ips=FATAL，调用方据 null 跳过发射）。
  if (meshNodeCarriesFullTunnel(server)) {
    return dedupe([...specific, ...FULL_TUNNEL_CIDRS]);
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
  return dedupe(servers.flatMap((s) => endpointForcedRouteCidrs(s)));
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
