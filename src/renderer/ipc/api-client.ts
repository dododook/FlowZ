/**
 * API 客户端
 * 封装所有 IPC 调用方法，提供类型安全的 API 接口
 */

import { ipcClient } from './ipc-client';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { CoreBuildKind } from '../../shared/core-build';
import type {
  UserConfig,
  ServerConfig,
  ProxyStatus,
  ProxyErrorCode,
  LogEntry,
  TrafficStats,
  Rule,
  AutoStartStatus,
  SubscriptionConfig,
  HelperStatus,
  IpInfoSnapshot,
  SystemProcessInfo,
  RuleResourceDeleteResult,
  RuleResourceListItem,
  RuleResourceDownloadItem,
  RuleResourceDownloadResult,
  RuleResourceProgress,
  RuleResourceCatalogResult,
  InvalidNodeInfo,
  ImportParseResult,
} from '../../shared/types';
import type { SubscriptionPreviewResult } from '../../shared/subscription-preview';
import type { WarpWireGuardDraft } from '../../shared/warp';
import type { BackupCategory } from '../../shared/backup-categories';
import type { TailscaleStatusEvent, TailscaleStatusSnapshot } from '../../shared/tailscale-status';

/**
 * 代理控制 API
 */
export const proxyApi = {
  /**
   * 启动代理
   * @param config 用户配置
   */
  async start(config: UserConfig): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.PROXY_START, config);
  },

  /**
   * 停止代理
   */
  async stop(): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.PROXY_STOP);
  },

  /**
   * 重启代理
   */
  async restart(): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.PROXY_RESTART);
  },

  /**
   * 获取代理状态
   */
  async getStatus(): Promise<ProxyStatus> {
    return ipcClient.invoke(IPC_CHANNELS.PROXY_GET_STATUS);
  },

  /**
   * 自定义协议兼容性 probe：当前内核能否识别该 outbound（sing-box check）。
   */
  async probeOutbound(
    outbound: unknown,
    isEndpoint?: boolean
  ): Promise<{ ok: boolean; indeterminate?: boolean; error?: string }> {
    return ipcClient.invoke(IPC_CHANNELS.KERNEL_PROBE_OUTBOUND, { outbound, isEndpoint });
  },

  /**
   * 用户主动关闭系统代理（TUN 残留提示的「关闭系统代理」一键动作）。
   */
  async disableSystemProxy(): Promise<{ ok: boolean }> {
    return ipcClient.invoke(IPC_CHANNELS.SYSTEM_PROXY_DISABLE);
  },

  /**
   * 监听代理启动事件
   */
  onStarted(
    listener: (data: {
      pid: number | null;
      startTime?: string | Date | null;
      autoRestarted?: boolean;
    }) => void
  ): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_PROXY_STARTED, listener);
  },

  /**
   * 监听代理停止事件
   */
  onStopped(listener: (data: Record<string, never>) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_PROXY_STOPPED, listener);
  },

  /**
   * 监听代理错误事件。主进程各 emit 点 payload 形状不一，message 优先 / error 兜底。
   */
  onError(
    listener: (data: {
      message?: string;
      error?: string;
      errorCode?: ProxyErrorCode;
      code?: number;
      signal?: string | null;
    }) => void
  ): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_PROXY_ERROR, listener);
  },

  /**
   * 监听自动换节点成功事件
   */
  onAutoNodeSwitched(
    listener: (data: { reason: string; newServerName: string; latency: number }) => void
  ): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_AUTO_NODE_SWITCHED, listener);
  },

  /**
   * 监听启动前配置校验 gate 剔除的非法节点（空数组=本次启动无非法节点/清陈旧标灰）。
   */
  onInvalidNodes(listener: (data: InvalidNodeInfo[]) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_PROXY_INVALID_NODES, listener);
  },

  /**
   * 监听 Tailscale 交互登录 URL（无 auth_key 的节点启动时核日志出登录 URL）。
   * transient=true 表示来自 Phase 2 按需登录核（已自动开浏览器）→ 渲染端降级为可关闭普通 toast。
   */
  onTailscaleAuth(
    listener: (data: {
      nodeName: string;
      url: string;
      transient?: boolean;
      serverId?: string;
    }) => void
  ): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_TAILSCALE_AUTH_URL, listener);
  },

  /**
   * 监听 sing-box 1.14 管理 API 推送的 Tailscale 节点真实态（backendState/loggedIn/authURL/IP/expired）。
   * 取代 1.13 的「轮询 state 目录 + AUTH_OK」启发式：登录成功（Running/Starting）、需登录（NeedsLogin+authURL）、
   * 过期（expired）全由此流驱动，与日志等级无关。
   */
  onTailscaleStatus(listener: (data: TailscaleStatusEvent) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_TAILSCALE_STATUS, listener);
  },

  /**
   * 监听「启动前属主归一删掉某节点 root 残留 state」（登录态已失效）→ 渲染端清登录缓存 + 登录态，
   * 避免陈旧 loggedIn=true 与已清空 state 撕裂（review #4）。
   */
  onTailscaleStateCleared(listener: (data: { serverId: string }) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_TAILSCALE_STATE_CLEARED, listener);
  },

  /**
   * 监听「登录期出口让位」事件（缺陷1）：选中 TS 出口未就绪→默认路由让位直连（engaged=true）、隧道 Running 后
   * 切回（engaged=false）。渲染端据此提示用户「登录期临时直连」。preload 通用 ipcRenderer.on 无 allowlist，无需改 preload。
   */
  onMeshLoginFallback(
    listener: (data: { engaged: boolean; serverName?: string }) => void
  ): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_MESH_LOGIN_FALLBACK, listener);
  },

  /**
   * 监听 TUN 启动后的「无 marker 系统代理残留」提示（非 FlowZ 设的代理仍开着，可能干扰 TUN）。
   */
  onSystemProxyResidual(listener: (data: { proxy: string }) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_SYSTEM_PROXY_RESIDUAL, listener);
  },

  /** #40：非官方核 ≤ 随包基线 → 兼容风险提醒（启动 reconcile emit）。 */
  onCoreBaselineWarning(
    listener: (data: { current: string; bundled: string; kind: string }) => void
  ): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_CORE_BASELINE_WARNING, listener);
  },
};

/**
 * 配置管理 API
 */
export const configApi = {
  /**
   * 获取完整配置
   */
  async get(): Promise<UserConfig> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_GET);
  },

  /**
   * 保存完整配置
   */
  async save(config: UserConfig): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_SAVE, config);
  },

  /**
   * 更新代理模式
   */
  async updateMode(mode: UserConfig['proxyMode']): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_UPDATE_MODE, { mode });
  },

  /**
   * 获取配置值
   */
  async getValue<T = any>(key: string): Promise<T> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_GET_VALUE, { key });
  },

  /**
   * 设置配置值
   */
  async setValue(key: string, value: any): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_SET_VALUE, { key, value });
  },

  /**
   * 监听配置变化事件
   */
  onChanged(
    listener: (data: { key?: string; oldValue?: any; newValue?: any }) => void
  ): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_CONFIG_CHANGED, listener);
  },

  /**
   * 获取隐私模式状态
   */
  async getPrivacyMode(): Promise<boolean> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_GET_PRIVACY_MODE);
  },

  /**
   * 设置隐私模式状态
   */
  async setPrivacyMode(value: boolean): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.CONFIG_SET_PRIVACY_MODE, value);
  },

  // 语言不再经 IPC 同步给主进程：改写 config.language（saveConfig），主进程直接读 config 单一真值源。

  /**
   * 同步「节点列表按延迟排序」开关到主进程（使托盘节点列表与下拉同序）。
   */
  async setNodeSortByLatency(value: boolean): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.APP_SET_NODE_SORT_BY_LATENCY, value);
  },
};

/** F29：隐私密码 API。哈希/校验全在 main；渲染端只拿 hasPassword 布尔与 verify 结果，永不接触明文/哈希。 */
export const privacyApi = {
  setPassword: (plain: string): Promise<{ success: boolean }> =>
    ipcClient.invoke(IPC_CHANNELS.PRIVACY_SET_PASSWORD, { plain }),
  unlock: (plain: string): Promise<{ ok: boolean }> =>
    ipcClient.invoke(IPC_CHANNELS.PRIVACY_UNLOCK, { plain }),
  hasPassword: (): Promise<boolean> => ipcClient.invoke(IPC_CHANNELS.PRIVACY_HAS_PASSWORD),
};

/**
 * 服务器管理 API
 */
export const serverApi = {
  /**
   * 获取所有服务器
   */
  async getAll(): Promise<ServerConfig[]> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_GET_ALL);
  },

  /**
   * 添加服务器
   */
  async add(server: Omit<ServerConfig, 'id'>): Promise<ServerConfig> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_ADD, server);
  },

  /**
   * 批量添加自建节点（本地导入，一次写盘）
   */
  async addBulk(servers: ServerConfig[]): Promise<{ added: number }> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_ADD_BULK, { servers });
  },

  /**
   * 更新服务器
   */
  async update(server: ServerConfig): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_UPDATE, server);
  },

  /**
   * 删除服务器
   */
  async delete(serverId: string): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_DELETE, { serverId });
  },

  /**
   * 批量删除服务器（一次配置写，避免并发单删竞态）。返回实际删除数。
   */
  async deleteBatch(serverIds: string[]): Promise<number> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_DELETE_BATCH, { serverIds });
  },

  /**
   * Phase 2 按需登录：拉起瞬态登录核取交互登录 URL（主进程自动开浏览器 + 系统通知）。
   * started=false 时 reason 说明（alreadyLoggedIn / inMainCore / alreadyRunning），渲染端据此提示。
   */
  async tailscaleLogin(server: ServerConfig): Promise<{
    started: boolean;
    reason?: 'alreadyLoggedIn' | 'inMainCore' | 'alreadyRunning';
    authUrl?: string; // inMainCore/alreadyRunning 时回传主核当前 authURL，渲染端可靠重开授权页（补取消后空窗）
  }> {
    return ipcClient.invoke(IPC_CHANNELS.TAILSCALE_LOGIN, { server });
  },

  /**
   * 取消某节点在飞的瞬态登录核（用户手动取消）。
   */
  async tailscaleLoginCancel(serverId: string): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.TAILSCALE_LOGIN_CANCEL, { serverId });
  },

  /**
   * 退出登录：清该节点 Tailscale 持久登录会话（state 目录），下次需重新交互登录。保留节点配置/authKey。
   * runningNeedsRestart=true 时该节点正在主核运行，需重启代理才彻底生效（UI 据此提示）。
   */
  async tailscaleLogout(serverId: string): Promise<{ runningNeedsRestart: boolean }> {
    return ipcClient.invoke(IPC_CHANNELS.TAILSCALE_LOGOUT, { serverId });
  },

  /**
   * 批量查 TS 节点 state 目录存在性（不起核判「登录过没」）：代理关时登录态缓存未命中的兜底。
   * 返回 serverId → 是否已有持久登录会话目录。
   */
  async tailscaleStateExists(serverIds: string[]): Promise<Record<string, boolean>> {
    return ipcClient.invoke(IPC_CHANNELS.TAILSCALE_STATE_EXISTS, { serverIds });
  },

  /**
   * L2：主动拉各 TS 节点状态末帧(self IP/peers) + 新鲜度(connected)。
   * 治本「状态流 push-only-on-change、无 pull、渲染端错过推送即永久陈旧」：挂载/出口表单打开即拉当前态。
   */
  async tailscaleGetStatus(): Promise<TailscaleStatusSnapshot> {
    return ipcClient.invoke(IPC_CHANNELS.TAILSCALE_GET_STATUS);
  },

  /**
   * 切换服务器
   */
  async switch(serverId: string): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_SWITCH, { serverId });
  },

  /**
   * 生成分享 URL
   */
  async generateUrl(server: ServerConfig): Promise<string> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_GENERATE_URL, { server });
  },

  /**
   * Cloudflare WARP：注册匿名设备 → 返回 WireGuard 草稿（供 WG 表单填充）。licenseKey 可选（WARP+）。
   */
  async registerWarp(licenseKey?: string): Promise<WarpWireGuardDraft> {
    return ipcClient.invoke(IPC_CHANNELS.WARP_REGISTER, { licenseKey });
  },

  /**
   * 对已注册 WARP 节点原地应用 WARP+ license（升级免重建）。token 服务端按 serverId 取、不经渲染端。
   * 无 warpDevice 凭据的旧节点返 { ok:false, error:'no-credentials' }（渲染端置灰 + 提示重建）。
   */
  async applyWarpLicense(
    serverId: string,
    license: string
  ): Promise<{ ok: boolean; warpPlus?: boolean; error?: string }> {
    return ipcClient.invoke(IPC_CHANNELS.WARP_APPLY_LICENSE, { serverId, license });
  },

  /**
   * 测试指定服务器延迟，不传则测试所有服务器
   */
  async speedTest(serverIds?: string[]): Promise<Record<string, number>> {
    return ipcClient.invoke(IPC_CHANNELS.SERVER_SPEED_TEST, { serverIds });
  },

  /**
   * 订阅测速单个节点完成事件（流式增量显示，不等队列）。
   * listener: (data: { serverId: string; latency: number }) => void
   * 返回取消订阅函数。
   */
  onSpeedTestResult(listener: (data: { serverId: string; latency: number }) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_SPEED_TEST_RESULT, listener);
  },

  /**
   * 订阅测速进度事件（已测/成功/总数，参考 mihomo zashboard）。
   * listener: (data: { tested: number; ok: number; total: number }) => void
   * 返回取消订阅函数。
   */
  onSpeedTestProgress(
    listener: (data: { tested: number; ok: number; total: number }) => void
  ): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_SPEED_TEST_PROGRESS, listener);
  },
};

/**
 * 路由规则管理 API
 */
export const rulesApi = {
  /**
   * 获取所有规则
   */
  async getAll(): Promise<Rule[]> {
    return ipcClient.invoke(IPC_CHANNELS.RULES_GET_ALL);
  },

  /**
   * 添加规则
   */
  async add(rule: Omit<Rule, 'id'>): Promise<Rule> {
    return ipcClient.invoke(IPC_CHANNELS.RULES_ADD, rule);
  },

  /**
   * 更新规则
   */
  async update(rule: Rule): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.RULES_UPDATE, rule);
  },

  /**
   * 删除规则
   */
  async delete(ruleId: string): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.RULES_DELETE, { ruleId });
  },

  /** 重排规则：orderedIds 为全部规则 id 的新顺序 */
  async reorder(orderedIds: string[]): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.RULES_REORDER, { orderedIds });
  },
};

/**
 * 日志管理 API
 */
export const logsApi = {
  /**
   * 获取日志
   */
  async get(limit?: number): Promise<LogEntry[]> {
    return ipcClient.invoke(IPC_CHANNELS.LOGS_GET, { limit });
  },

  /**
   * 清空日志
   */
  async clear(): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.LOGS_CLEAR);
  },

  /**
   * 监听批量日志接收事件（T1，issue #225）：主进程 ~150ms coalesce 多条日志为一次数组推送，
   * 渲染端单次 setState 批量追加。取代旧逐条 EVENT_LOG_RECEIVED（已删，削渲染端高频重渲与 RDP 逐帧流式开销）。
   */
  onReceivedBatch(listener: (logs: LogEntry[]) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_LOG_RECEIVED_BATCH, listener);
  },
};

/**
 * 自启动管理 API
 */
export const autoStartApi = {
  /**
   * 设置自启动
   */
  async set(enabled: boolean): Promise<boolean> {
    return ipcClient.invoke(IPC_CHANNELS.AUTO_START_SET, { enabled });
  },

  /**
   * 获取自启动状态
   */
  async getStatus(): Promise<AutoStartStatus> {
    return ipcClient.invoke(IPC_CHANNELS.AUTO_START_GET_STATUS);
  },
};

/**
 * 统计信息 API
 */
export const statsApi = {
  /**
   * 获取流量统计快照（一次性读，如 app-store.refreshStatistics）。batch3：stats 增量改走 useStatsTopic('stats')
   * 订阅（EVENT_STATS_UPDATED），故此处 onUpdated 已删；一次性快照读仍保留 STATS_GET。
   */
  async get(): Promise<TrafficStats> {
    return ipcClient.invoke(IPC_CHANNELS.STATS_GET);
  },
};

/**
 * 连接数据 API（batch3 §3.7）：明细（detail）与拓扑聚合（aggregate）已改订阅驱动——渲染端经 useStatsTopic
 * ('detail'/'aggregate') 订阅、订阅即回初始帧 + 增量 push，旧 CONNECTIONS_GET / CONNECTIONS_AGGREGATE_GET 双路径
 * 随之删除。此处仅留关连接的命令式动作；渲染端不直连 :9090、不持 secret。
 */
export const connectionsApi = {
  /** 关单条连接（main 经 9090 DELETE /connections/{id}；渲染端无 secret）。 */
  async close(id: string): Promise<{ ok: boolean }> {
    return ipcClient.invoke(IPC_CHANNELS.CONNECTIONS_CLOSE, { id });
  },
  /** 关全部连接（main 经 9090 DELETE /connections，触发 ResetNetwork）。 */
  async closeAll(): Promise<{ ok: boolean }> {
    return ipcClient.invoke(IPC_CHANNELS.CONNECTIONS_CLOSE_ALL);
  },
};

/**
 * 系统能力 API（进程枚举等）
 */
export const systemApi = {
  /** 枚举当前系统进程（聚合去重，供进程规则快速选择） */
  async listProcesses(): Promise<SystemProcessInfo[]> {
    return ipcClient.invoke(IPC_CHANNELS.SYSTEM_LIST_PROCESSES);
  },
  /** 用系统默认浏览器打开外部链接（收口 shell:openExternal；api-client 单一入口，渐替 bridge/api-wrapper.openExternal）。 */
  async openExternal(url: string): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, url);
  },
};

/**
 * 规则资源 API（.srs 下载/管理）
 */
export const ruleResourcesApi = {
  list(): Promise<RuleResourceListItem[]> {
    return ipcClient.invoke(IPC_CHANNELS.RULE_RESOURCES_LIST);
  },
  download(items: RuleResourceDownloadItem[]): Promise<RuleResourceDownloadResult[]> {
    return ipcClient.invoke(IPC_CHANNELS.RULE_RESOURCES_DOWNLOAD, { items });
  },
  redownload(id: string): Promise<RuleResourceDownloadResult> {
    return ipcClient.invoke(IPC_CHANNELS.RULE_RESOURCES_REDOWNLOAD, { id });
  },
  delete(id: string, force?: boolean): Promise<RuleResourceDeleteResult> {
    return ipcClient.invoke(IPC_CHANNELS.RULE_RESOURCES_DELETE, { id, force });
  },
  setGhProxy(prefix: string): Promise<{ ok: boolean; value?: string; error?: string }> {
    return ipcClient.invoke(IPC_CHANNELS.RULE_RESOURCES_SET_GH_PROXY, { prefix });
  },
  getCatalog(): Promise<RuleResourceCatalogResult> {
    return ipcClient.invoke(IPC_CHANNELS.RULE_RESOURCES_GET_CATALOG);
  },
  refreshCatalog(): Promise<RuleResourceCatalogResult> {
    return ipcClient.invoke(IPC_CHANNELS.RULE_RESOURCES_REFRESH_CATALOG);
  },
  setAutoUpdate(args: { enabled: boolean; intervalHours?: number }): Promise<{ ok: boolean }> {
    return ipcClient.invoke(IPC_CHANNELS.RULE_RESOURCES_SET_AUTO_UPDATE, args);
  },
  updateAll(): Promise<RuleResourceDownloadResult[]> {
    return ipcClient.invoke(IPC_CHANNELS.RULE_RESOURCES_UPDATE_ALL);
  },
  resetBuiltin(tag: string): Promise<RuleResourceDownloadResult> {
    return ipcClient.invoke(IPC_CHANNELS.RULE_RESOURCES_RESET_BUILTIN, { tag });
  },
  // 图标库拉取（经主进程 update-in 统一会话，Phase 1b）。全失败返 []，UI 回落手动输入图标 URL。
  fetchIconGalleries(): Promise<Array<{ name: string; url: string }>> {
    return ipcClient.invoke(IPC_CHANNELS.RULE_RESOURCES_ICON_GALLERIES);
  },
  onProgress(listener: (p: RuleResourceProgress) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_RULE_RESOURCE_PROGRESS, listener);
  },
};

/**
 * 出口 IP 信息 API
 */
export const ipInfoApi = {
  /** 获取出口 IP 快照（force 强制重测） */
  async get(force = false): Promise<IpInfoSnapshot> {
    return ipcClient.invoke(IPC_CHANNELS.IP_INFO_GET, { force });
  },

  /** 监听出口 IP 更新事件 */
  onUpdated(listener: (snap: IpInfoSnapshot) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_IP_INFO_UPDATED, listener);
  },
};

/**
 * 版本信息类型
 */
export interface VersionInfo {
  appVersion: string;
  appName: string;
  buildDate: string;
  singBoxVersion: string;
  copyright: string;
  repositoryUrl: string;
  platform: string;
  arch: string;
  osVersion: string;
}

/**
 * 版本信息 API
 */
export const versionApi = {
  /**
   * 获取版本信息
   */
  async getInfo(): Promise<VersionInfo> {
    return ipcClient.invoke(IPC_CHANNELS.VERSION_GET_INFO);
  },
};

/**
 * 更新检查结果
 */
export interface UpdateCheckResult {
  hasUpdate: boolean;
  updateInfo?: UpdateInfo;
  error?: string;
}

/**
 * 更新信息
 */
export interface UpdateInfo {
  version: string;
  title: string;
  releaseNotes: string;
  downloadUrl: string;
  fileSize: number;
  publishedAt: string;
  isPrerelease: boolean;
  fileName: string;
}

/**
 * 更新进度
 */
export interface UpdateProgress {
  status:
    | 'idle'
    | 'checking'
    | 'no-update'
    | 'update-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  percentage: number;
  message: string;
  error?: string;
}

/**
 * 更新管理 API
 */
export const updateApi = {
  /**
   * 检查更新
   */
  async check(includePrerelease = false): Promise<UpdateCheckResult> {
    return ipcClient.invoke(IPC_CHANNELS.UPDATE_CHECK, { includePrerelease });
  },

  /**
   * 下载更新
   */
  async download(
    updateInfo: UpdateInfo
  ): Promise<{ success: boolean; filePath?: string; error?: string }> {
    return ipcClient.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD, { updateInfo });
  },

  /**
   * 安装更新
   */
  async install(filePath: string): Promise<{ success: boolean; error?: string }> {
    return ipcClient.invoke(IPC_CHANNELS.UPDATE_INSTALL, { filePath });
  },

  /**
   * 跳过版本
   */
  async skip(version: string): Promise<{ success: boolean }> {
    return ipcClient.invoke(IPC_CHANNELS.UPDATE_SKIP, { version });
  },

  /**
   * 打开 Releases 页面
   */
  async openReleases(): Promise<{ success: boolean }> {
    return ipcClient.invoke(IPC_CHANNELS.UPDATE_OPEN_RELEASES);
  },

  /**
   * 监听更新进度事件
   */
  onProgress(listener: (progress: UpdateProgress) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_UPDATE_PROGRESS, listener);
  },
};

/**
 * 核心更新 API
 */
export const coreUpdateApi = {
  /**
   * 检查核心更新
   */
  async check(): Promise<{
    hasUpdate: boolean;
    currentVersion: string;
    latestVersion?: string;
    downloadUrl?: string;
    releaseNotes?: string;
    /** latestVersion 是否跨当前 minor 带（如 1.13.x→1.14.x）；true 时 UI 标注跨大版本风险。 */
    crossBand?: boolean;
    error?: string;
  }> {
    return ipcClient.invoke(IPC_CHANNELS.CORE_UPDATE_CHECK);
  },

  /**
   * 更新核心
   */
  async update(downloadUrl: string): Promise<boolean> {
    return ipcClient.invoke(IPC_CHANNELS.CORE_UPDATE_RUN, downloadUrl);
  },

  /**
   * 获取核心版本信息（当前版本、备份版本、是否有备份）
   */
  async getVersionInfo(): Promise<{
    currentVersion: string;
    backupVersion: string | null;
    hasBackup: boolean;
    lastKnownVersion: string | null;
    /** 内核来源：official=官方 / fork=第三方（禁在线·自动更新）/ unknown=无法确认（仅提示）。 */
    build: 'official' | 'fork' | 'unknown';
  }> {
    return ipcClient.invoke(IPC_CHANNELS.CORE_GET_VERSION_INFO);
  },

  /**
   * 回滚核心到上一个备份版本
   */
  async rollback(): Promise<boolean> {
    return ipcClient.invoke(IPC_CHANNELS.CORE_ROLLBACK);
  },

  /**
   * 监听核心版本变更事件
   */
  onVersionChanged(
    listener: (data: {
      previousVersion: string;
      currentVersion: string;
      hasBackup: boolean;
    }) => void
  ): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_CORE_VERSION_CHANGED, listener);
  },

  /**
   * 手动替换核心。
   * - 无参：弹文件选择器 + 预检 + 同版本/基线检测。返回 needConfirm 的两种情形，均由 UI 弹确认框：
   *   · 同版本：`{ ok:false, needConfirm:true, sameVersion, filePath }`；
   *   · 基线预判（官方核旧于随包基线，B-2）：`{ ok:false, needConfirm:true, baselineOverride:true, uploadVersion, bundledVersion, filePath }`。
   *   否则直接换核返回 `{ ok:true, build }`（build 供 UI 对 fork/unknown 追加来源提示，B-3）。
   * - 传 `{ filePath, force:true }`：跳过同版本/基线确认，直接换该文件。
   * 用户取消文件选择器时主进程返回 `{ ok:false }`（无 needConfirm），UI 静默不提示。
   */
  async replaceManual(opts?: { filePath?: string; force?: boolean }): Promise<
    | { ok: true; build?: CoreBuildKind }
    | {
        ok: false;
        needConfirm?: boolean;
        sameVersion?: string;
        baselineOverride?: boolean;
        uploadVersion?: string;
        bundledVersion?: string;
        filePath?: string;
        error?: string;
      }
  > {
    return ipcClient.invoke(IPC_CHANNELS.CORE_REPLACE_MANUAL, opts);
  },

  /**
   * B6：重置内核到出厂版本（恢复为随 App 出厂的内核）。
   */
  async resetFactory(): Promise<{ ok: boolean; error?: string }> {
    return ipcClient.invoke(IPC_CHANNELS.CORE_RESET_FACTORY);
  },

  /**
   * 内核自动更新状态（lastCheckAt / staged 待生效 / 跨带提示）
   */
  async getAutoStatus(): Promise<{
    autoUpdateEnabled: boolean;
    lastCheckAt: number | null;
    staged: { version: string; stagedAt: string } | null;
    crossBandLatest: string | null;
  }> {
    return ipcClient.invoke(IPC_CHANNELS.CORE_UPDATE_GET_AUTO_STATUS);
  },

  /**
   * 用户点「立即应用」：停代理→换核→重启（唯一允许主动断流）。
   * 返回落位结果枚举（applied→成功 / failed→失败 / discarded→已作废 / deferred→仍待生效 / noop→无暂存），
   * 供 UI 分情况反馈（与主进程 StagedApplyResult 同形，inline 避免跨进程类型 import）。
   */
  async applyStaged(): Promise<'applied' | 'discarded' | 'deferred' | 'failed' | 'noop'> {
    return ipcClient.invoke(IPC_CHANNELS.CORE_UPDATE_APPLY_STAGED);
  },

  /**
   * 监听内核自动更新状态变更事件（staged 待生效 / 跨带提示）
   */
  onAutoStatusChanged(
    listener: (data: {
      // autoUpdateEnabled 不随事件推送（主进程同步 emit 算不出真值）；真值由 getAutoStatus 快照提供。
      lastCheckAt: number | null;
      staged: { version: string; stagedAt: string } | null;
      crossBandLatest: string | null;
    }) => void
  ): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_CORE_AUTO_UPDATE_STATUS, listener);
  },
};

/**
 * 订阅管理 API
 */
export const subscriptionApi = {
  /**
   * 添加订阅
   */
  async add(
    subscription: Omit<SubscriptionConfig, 'id' | 'createdAt'>
  ): Promise<SubscriptionConfig> {
    return ipcClient.invoke(IPC_CHANNELS.SUBSCRIPTION_ADD, { subscription });
  },

  /**
   * 更新订阅配置
   */
  async update(subscription: SubscriptionConfig): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.SUBSCRIPTION_UPDATE, { subscription });
  },

  /**
   * 根据 ID 删除订阅
   */
  async delete(subscriptionId: string): Promise<void> {
    return ipcClient.invoke(IPC_CHANNELS.SUBSCRIPTION_DELETE, { subscriptionId });
  },

  /**
   * 触发订阅节点更新
   */
  async updateServers(subscriptionId: string): Promise<{
    success: boolean;
    addedServers: number;
    updatedServers: number;
    deletedServers: number;
    error?: string;
  }> {
    return ipcClient.invoke(IPC_CHANNELS.SUBSCRIPTION_UPDATE_SERVERS, { subscriptionId });
  },

  /**
   * 订阅预检（add 前先行，不写 config）：拉取+解析返回节点数或分类错误（errorKind），成功才建记录（无先加后删闪现）。
   */
  async preview(
    url: string,
    opts: { viaProxy?: boolean; userAgent?: string }
  ): Promise<SubscriptionPreviewResult> {
    return ipcClient.invoke(IPC_CHANNELS.SUBSCRIPTION_PREVIEW, {
      url,
      viaProxy: opts.viaProxy,
      userAgent: opts.userAgent,
    });
  },
};

/**
 * 数据备份与恢复摘要信息
 */
export interface BackupInfo {
  serverCount: number;
  manualServerCount: number;
  meshServerCount: number;
  subscriptionCount: number;
  ruleCount: number;
  ruleSetCount: number;
  appRuleCount: number;
  // 跨平台导入时被禁用的进程规则数（processName/processPath 平台特定）。同后端 BackupInfo。
  crossPlatformDisabledRules?: number;
}

/**
 * 数据备份与恢复 API
 */
export const backupApi = {
  /**
   * 导出备份（按勾选类别；缺省/空 = 全部）。弹系统保存对话框。
   */
  async export(
    categories?: BackupCategory[]
  ): Promise<{ success: boolean; filePath?: string; error?: string }> {
    return ipcClient.invoke(IPC_CHANNELS.BACKUP_EXPORT, { categories });
  },

  /**
   * 导入①：弹文件框 + 解析 → 返回备份含哪些类 + 各类数量（不 apply）。canceled=用户取消。
   */
  async importPick(): Promise<{
    canceled: boolean;
    filePath?: string;
    available?: BackupCategory[];
    counts?: Partial<Record<BackupCategory, number>>;
    error?: string;
  }> {
    return ipcClient.invoke(IPC_CHANNELS.BACKUP_IMPORT_PICK);
  },

  /**
   * 导入②：按所选类整类替换 + 空跳过 + 保存。skipped=选了但备份为空被跳过的类。
   */
  async importApply(
    filePath: string,
    categories: BackupCategory[]
  ): Promise<{ success: boolean; info?: BackupInfo; skipped?: BackupCategory[]; error?: string }> {
    return ipcClient.invoke(IPC_CHANNELS.BACKUP_IMPORT_APPLY, { filePath, categories });
  },

  /**
   * 获取当前配置摘要（节点数、订阅数、规则数等）
   */
  async getInfo(): Promise<BackupInfo> {
    return ipcClient.invoke(IPC_CHANNELS.BACKUP_GET_INFO);
  },
};

/**
 * 诊断 API（导出脱敏诊断报告）
 */
export const diagnosticApi = {
  /** 导出诊断报告（弹出系统文件保存对话框，单 Markdown，密钥已脱敏） */
  async export(): Promise<{ success: boolean; filePath?: string; error?: string }> {
    return ipcClient.invoke(IPC_CHANNELS.DIAGNOSTIC_EXPORT);
  },
};

/**
 * macOS 提权 helper API（免提权启停 sing-box）
 */
export const helperApi = {
  /** 查询 helper 安装/就绪状态 */
  async getStatus(force = false): Promise<HelperStatus> {
    return ipcClient.invoke(IPC_CHANNELS.HELPER_GET_STATUS, force);
  },

  /** 安装/修复 helper（弹一次管理员授权框） */
  async install(): Promise<{ success: boolean; error?: string; status: HelperStatus }> {
    return ipcClient.invoke(IPC_CHANNELS.HELPER_INSTALL);
  },

  /** 卸载 helper（弹一次管理员授权框） */
  async uninstall(): Promise<{ success: boolean; error?: string; status: HelperStatus }> {
    return ipcClient.invoke(IPC_CHANNELS.HELPER_UNINSTALL);
  },

  /** 监听「helper 可升级」事件（启动后主进程检测 proto < 期望时 emit，渲染端 toast 引导升级） */
  onUpgradeable(listener: (data: { version: string }) => void): () => void {
    return ipcClient.on(IPC_CHANNELS.EVENT_HELPER_UPGRADEABLE, listener);
  },
};

/**
 * 应用级 API（生命周期 / 卸载等）
 */
export const appApi = {
  /**
   * B6：完全卸载 FlowZ（清除提权 helper、受保护目录内核、用户配置、应用本体）。
   */
  async uninstallAll(): Promise<{ ok: boolean; error?: string }> {
    return ipcClient.invoke(IPC_CHANNELS.APP_UNINSTALL_ALL);
  },
  /**
   * 打开 sing-box 官方面板（dashboard #55）：main 开应用内窗口加载运行期 /dashboard/，并经 preload 预写 localStorage
   * 一键直连（免手填后端）。代理未运行 → 返回 { ok: false }（UI 仅在开关 on 且运行中才 enable 按钮）。
   */
  async openSingboxDashboard(locale?: string): Promise<{ ok: boolean }> {
    // locale=渲染端 UI 语言（i18n.language），透传给 main 对齐面板语言；省略时 main 兜底 app.getLocale()。
    return ipcClient.invoke(IPC_CHANNELS.OPEN_SINGBOX_DASHBOARD, locale);
  },
  /**
   * 刷新 sing-box 官方面板资源：main 清本地缓存目录 → 核下次启动重拉新 zip。供设置页手动刷新。
   */
  async refreshSingboxDashboard(): Promise<{ ok: boolean }> {
    return ipcClient.invoke(IPC_CHANNELS.REFRESH_SINGBOX_DASHBOARD);
  },
  /**
   * dashboard #55：取面板连接信息（url=面板 URL + apiUrl + secret）供「复制连接信息」按钮与面板 URL 显示。
   * secret 取自 main config，不长驻渲染端 store。代理未运行 → { ok: false }。
   */
  async getSingboxDashboardConnection(): Promise<{
    ok: boolean;
    url: string;
    apiUrl: string;
    secret: string;
  }> {
    return ipcClient.invoke(IPC_CHANNELS.GET_SINGBOX_DASHBOARD_CONNECTION);
  },
};

/** 窗口控制（Linux frameless 自绘标题栏用；Mac 红绿灯 / Win titleBarOverlay 原生按钮不经此）。 */
export const windowApi = {
  minimize: (): Promise<void> => ipcClient.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
  /** 切换最大化/还原，返回切换后是否最大化。 */
  maximizeToggle: (): Promise<boolean> => ipcClient.invoke(IPC_CHANNELS.WINDOW_MAXIMIZE_TOGGLE),
  close: (): Promise<void> => ipcClient.invoke(IPC_CHANNELS.WINDOW_CLOSE),
  isMaximized: (): Promise<boolean> => ipcClient.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
  /** 监听最大化态变更（WM 双击标题/拖顶等非按钮操作）；返回取消订阅函数。 */
  onMaximizeChange: (listener: (maximized: boolean) => void): (() => void) =>
    ipcClient.on(IPC_CHANNELS.EVENT_WINDOW_MAXIMIZE_CHANGED, listener),
};

/**
 * 统一的 API 客户端
 */
/**
 * 本地导入 API（解析文件/文本 → 预览；不可识别格式时主进程 throw → 此处 reject）
 */
export const localImportApi = {
  parse(text: string): Promise<ImportParseResult> {
    return ipcClient.invoke(IPC_CHANNELS.LOCAL_IMPORT_PARSE, { text });
  },
  /**
   * 弹系统原生文件对话框选配置文件 + 读内容回传（替代 HTML <input type=file>，对话框跟随系统语言）。
   * canceled=用户取消（UI 静默）；error='too_large'|'read_failed'（UI toast）；否则带 content + fileName。
   */
  pickFile(): Promise<{
    canceled: boolean;
    content?: string;
    fileName?: string;
    error?: 'too_large' | 'read_failed';
  }> {
    return ipcClient.invoke(IPC_CHANNELS.LOCAL_IMPORT_PICK_FILE);
  },
};

export const api = {
  proxy: proxyApi,
  window: windowApi,
  config: configApi,
  privacy: privacyApi,
  server: serverApi,
  rules: rulesApi,
  logs: logsApi,
  autoStart: autoStartApi,
  stats: statsApi,
  connections: connectionsApi,
  system: systemApi,
  ruleResources: ruleResourcesApi,
  ipInfo: ipInfoApi,
  version: versionApi,
  update: updateApi,
  coreUpdate: coreUpdateApi,
  subscription: subscriptionApi,
  localImport: localImportApi,
  backup: backupApi,
  diagnostic: diagnosticApi,
  helper: helperApi,
  app: appApi,
};

/**
 * 默认导出
 */
export default api;
