/**
 * Tailscale 状态事件 / 快照的跨层共享类型（main 推送 + IPC 返回 + renderer 消费，三方单一真值，防 duck-typing 漂移）。
 *
 * 数据链：sing-box 1.14 管理 API `SubscribeTailscaleStatus` 流 → 主进程解码(userGroups 摊平)→ 本类型 →
 *   ① 实时：EVENT_TAILSCALE_STATUS 事件推送；② 兜底：TAILSCALE_GET_STATUS invoke 拉缓存末帧。
 * 设计见 docs/design/tailscale-peers-exit-node-ui.md。
 */

/** 对端节点的 lean 形态（只含 UI 需要的字段）。 */
export interface TailscaleStatusPeer {
  /** 主机名（如 iStoreOS-Sway）。 */
  hostName: string;
  /** 内网 IP：首个 IPv4(100.x)，无则首个 IP。 */
  ip: string;
  /** 该 peer 在 tailnet 上是否 up（控制面有活跃会话）。 */
  online: boolean;
  /** 是否当前被本节点选中作出口。 */
  exitNode: boolean;
  /** 是否广告了可当出口（出口下拉的候选判据）。 */
  exitNodeOption: boolean;
  /** 近期是否有活跃直连/流量。 */
  active: boolean;
  /** peer 的 tailnet stableID（节点稳定标识，proto field 12）——主进程热重设 exit_node
   *  （SetTailscaleExitNode RPC）用；UI 不消费，可缺（旧核/无 ID 时 undefined）。 */
  stableID?: string;
}

/** 单个 Tailscale endpoint 的状态事件（serverId 维度，与 EVENT_TAILSCALE_STATUS 载荷一致）。 */
export interface TailscaleStatusEvent {
  serverId: string;
  /** NoState | NeedsLogin | Starting | Running | ... */
  backendState: string;
  /** loggedIn = (Running||Starting) 且 key 未过期。 */
  loggedIn: boolean;
  /** NeedsLogin 时的交互登录 URL（主核路径带，瞬态核路径不带）。 */
  authURL?: string;
  /** 本节点自身内网 IP（self.tailscaleIPs，100.x/fd7a:…）。 */
  tailscaleIPs: string[];
  /** key 是否过期。 */
  expired: boolean;
  /** 对端列表（摊平 userGroups 各组 + 去重）；供出口下拉 + 组网信息 popover。
   *  「当前出口」由 peers 中 exitNode=true 的那台体现，无需另带事件级字段。 */
  peers: TailscaleStatusPeer[];
}

/**
 * TAILSCALE_GET_STATUS 返回：主进程缓存的各节点末帧 + 新鲜度。
 * connected=false 时 statuses 为「上次已知」陈旧值——renderer 据此灰显动态位(online/active)。
 */
export interface TailscaleStatusSnapshot {
  /** 主核是否在运行（=状态流是否 live）。false → statuses 为陈旧缓存。 */
  connected: boolean;
  /** 各 serverId 的末帧（仅当前 config 在册的 TS 节点；幽灵条目已过滤）。 */
  statuses: TailscaleStatusEvent[];
}
