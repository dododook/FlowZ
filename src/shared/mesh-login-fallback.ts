/**
 * 组网登录期「出口让位」判定（纯谓词，便于单测；单一真值防漂移）。
 *
 * 场景（缺陷 1）：选中出口为账号制 Tailscale 且承载全隧道时，proxy-selector.default = 该 TS endpoint。若隧道
 * 尚未 Running（未登录/未授权/netmap 未同步），浏览器授权页与引导期控制平面流量被导向这个「尚未连上的出口」→
 * 授权页打不开 → 授权永不完成 → 整条引导链死锁。治法：在隧道就绪前把默认路由临时让位 'direct'
 * （hotSwitchSelector→direct，零重启，域名无关，TUN/系统代理统一），Running 后切回。
 *
 * 何时**不**让位：
 *  - 用户关了该开关（meshLoginFallbackDirect===false）→ 宁可授权失败也不在引导期直连（无泄漏窗口）；
 *  - direct 模式：默认本就 direct，无「→代理」出口，不适用；
 *  - 选中出口已「回退直连」（off-mesh 或只承载子网段的组网节点，meshSelectedExitFallsBackToDirect）：final 已 →direct，
 *    浏览器流量本就直连，无死锁；
 *  - 选中非 Tailscale（如 WireGuard/普通代理）：不走账号制交互登录，无此死锁形态；
 *  - authKey 形态 TS：静态凭据起核即认证，无交互登录死锁；
 *  - 隧道已就绪（Running）：出口已可用，正常经代理，不让位。
 */
export interface MeshLoginFallbackInput {
  /** 开关：config.meshLoginFallbackDirect !== false（默认开）。 */
  fallbackEnabled: boolean;
  /** 当前是否 direct 代理模式（default 本就 direct，不适用让位）。 */
  proxyModeDirect: boolean;
  /** 选中出口是否已「回退直连」（meshSelectedExitFallsBackToDirect：off-mesh / 仅子网段组网节点）。 */
  selectedExitFallsBackDirect: boolean;
  /** 选中出口是否为 Tailscale 协议。 */
  selectedIsTailscale: boolean;
  /** 选中 TS 是否配置了 authKey（静态凭据，无交互登录）。 */
  selectedHasAuthKey: boolean;
  /** 选中 TS 隧道是否已就绪（STATUS backendState=Running）。 */
  selectedTunnelReady: boolean;
}

/**
 * 是否应让默认路由让位直连（引导期）。全部条件与 default=proxy-selector→未连上 TS 出口这一死锁形态一一对应。
 */
export function meshLoginFallbackShouldEngage(input: MeshLoginFallbackInput): boolean {
  return (
    input.fallbackEnabled &&
    !input.proxyModeDirect &&
    !input.selectedExitFallsBackDirect &&
    input.selectedIsTailscale &&
    !input.selectedHasAuthKey &&
    !input.selectedTunnelReady
  );
}
