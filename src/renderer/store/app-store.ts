/**
 * Zustand store for application state management
 */

import { create } from 'zustand';
import type {
  UserConfig,
  Rule,
  TrafficStats,
  HelperStatus,
  IpInfoSnapshot,
  InvalidNodeInfo,
  PendingNodeChanges,
} from '../../shared/types';
import type { UpdateInfo } from '../../shared/types/update';
import type { TailscaleStatusPeer } from '../../shared/tailscale-status';
import { api } from '../ipc';
import { toast } from 'sonner';
import i18n from '../i18n';
import {
  loadTailscaleLoginStatesFromCache,
  useTailscaleLoginCacheStore,
} from './use-tailscale-login-cache-store';
import { pickFallbackExit, isDirectSelection } from '../../shared/direct-selection';
import { isServerComplete } from '../../shared/server-completeness';
import { meshNodeCarriesFullTunnel } from '../../shared/endpoint-routes';
import {
  SERVICE_IDS,
  type UnlockResult,
  type UnlockSnapshot,
  type UnlockEgress,
} from '../../shared/unlock-detection';

// 兼容旧的类型定义
type ProxyMode = UserConfig['proxyMode'];

/**
 * 可用的内核更新（常驻入口数据源）。放 store 与 availableAppUpdate 对称：
 * CoreManagementCard 随设置子节切换会卸载，本地 state 承载不了「toast 消失后入口仍在」。
 */
export interface AvailableCoreUpdate {
  latestVersion: string;
  downloadUrl: string;
  /** 是否跨当前 minor 带（如 1.13.x→1.14.x）；true 时 UI 用警告色 + 风险文案。 */
  crossBand?: boolean;
}

/**
 * 解锁检测显示态（issue 2）：提到 store 使其跨首页组件卸载存活——切导航离开首页 → UnlockInline 卸载但检测态留存，
 * 切回时直接展示、不从头重跑。progress/complete/invalidated 由 use-native-events 持久订阅写入（无论首页是否挂载均累积）；
 * 检测的发起唯一驱动 = 主进程 backend self-run（GAP-1），渲染端纯展示、不再自触发。
 */
export interface UnlockDisplayState {
  results: Record<string, UnlockResult>;
  running: boolean;
  checkedAt: number | null;
  egress: UnlockEgress | null;
  /**
   * 上次真发起一轮检测的完成时刻（renderer 打戳，含真检测 + notReady——两者后端都置 lastRunAt、force 15s 下限生效）。
   * 手动刷新冷却由此**派生**（不再手动 startCooldown）：统一 auto（backend self-run）+ manual 两条完成路径都镜像后端 force-min，
   * 消除「auto 路径完成后 15s 内点刷新→假重检闪烁」。blockedReason（M-gate 毫秒响应）不打戳、停代理清 null → 冷却自动灭。
   */
  lastRunAt: number | null;
}

const allCheckingResults = (): Record<string, UnlockResult> =>
  Object.fromEntries(SERVICE_IDS.map((id) => [id, { status: 'checking' as const }]));

// loadConfig 单飞：防 configChanged 风暴 / 启动期重复拉取（替代原 isLoading 重入守卫）
let loadConfigInflight: Promise<void> | null = null;
// loadConfig 代际计数：mutation（删/存节点等）成功后自增。单飞会复用「在 mutation 前就已开始拉取」的
// 在飞 promise，其 api.config.get() 拿的是 mutation 前旧快照，回填会用旧配置覆盖 store
// （典型症状：删节点后 UI 复活已删节点）。故在飞 load 回填前用代际比对丢弃陈旧快照。
let loadConfigGeneration = 0;
// mutation 落库/乐观 set 后调用：自增代际使在飞的旧 load 回填被丢弃，并置空单飞句柄，
// 令后续 loadConfig 重新拉取删/存后的最新配置，而非复用陈旧的在飞 promise。
function invalidateLoadConfig(): void {
  loadConfigGeneration++;
  loadConfigInflight = null;
}

// TS 登录态缓存孤儿 GC：清不在当前 servers 的缓存条目——覆盖所有绕过渲染端 deleteServer 的删节点路径
// （ConfigManager sanitize 丢多余 TS / 损坏备份导入 / 手改配置 / 订阅补更删节点），免 localStorage 缓存条目无上限泄漏。
// 抽共用（loadConfig 回填 + applyConfigFromEvent push 落地双调），避免双写漂移——replay 作废在飞 pull 时那次 pull 的
// GC 被 gen 守卫跳过，push 路径补跑一次使挂载期短窗也不漏 GC（#325 复审追零 Nit）。入参为权威 servers，无陈旧覆盖。
function gcOrphanTailscaleLoginCache(servers: UserConfig['servers']): void {
  const liveServerIds = new Set(servers.map((s) => s.id));
  const loginCache = useTailscaleLoginCacheStore.getState();
  for (const id of Object.keys(loginCache.cache)) {
    if (!liveServerIds.has(id)) loginCache.removeCached(id);
  }
}

/**
 * D4 删选中节点时的兜底出口候选（按列表序）：只纳入「可作真实全隧道出口」的剩余节点——
 *   ① isServerComplete（配置齐备、协议受支持、非空发射；已内含 !isMeshNodeUnroutable）；
 *   ② meshNodeCarriesFullTunnel（承载全出网流量：非组网节点恒真；WG allowInternet / TS 有 exitNode 才真）；
 *   ③ 不在 pendingChanges.added（未写入运行核，不可即刻承载流量）。
 * 剔除「子网-only 组网节点」（①真②假：如 allowInternet=off 但有网段的 WG / 无 exitNode 的 TS）是关键——
 * 选它作兜底出口会使公网流量静默走直连，而 toast 谎称「已切换到 X」（review Med：silent direct leak）。
 * 候选为空 → 调用方传 pickFallbackExit 得 null → selectedServerId=null → 显式直连（可见/审慎态，非静默泄漏）。
 */
function fallbackExitCandidateIds(
  servers: UserConfig['servers'],
  excludeIds: ReadonlySet<string>,
  pendingAdded: readonly string[]
): string[] {
  const added = new Set(pendingAdded);
  return servers
    .filter(
      (s) =>
        !excludeIds.has(s.id) &&
        !added.has(s.id) &&
        isServerComplete(s) &&
        meshNodeCarriesFullTunnel(s)
    )
    .map((s) => s.id);
}

interface ConnectionStatus {
  proxyCore: {
    running: boolean;
    pid?: number;
    uptime?: number;
    error?: string;
  };
  proxy: {
    enabled: boolean;
    server?: string;
  };
  proxyModeType: UserConfig['proxyModeType'];
}

interface AppState {
  // UI State
  currentView: string;
  // 首页空状态跳服务器页时的意图：'add-server' 唤起 ServerConfigDialog，'add-sub' 唤起订阅对话框（SubscriptionDialog），
  // 'ts-settings'（§H）落组网 tab + 自动打开 TS 设置弹窗（选出口设备），null 为无意图
  serverPageAction: 'add-server' | 'add-sub' | 'ts-settings' | null;
  // 设置页子节（general/about/...）。提升到 store，供非设置页组件（如 naive 横幅「去更新」）跨页导航到指定节
  settingsSection: string;
  // F27：进入设置页前的来源视图，设置页「返回」按钮的导航目标（默认 home）
  settingsReturnView: string;
  // F2：拆分全局 error/isLoading → 仅 start/stop 写的 proxyBusy/proxyError，避免无关操作污染首页状态
  proxyBusy: boolean;
  proxyPhase: 'idle' | 'starting' | 'stopping'; // 操作意图相位：按钮文案/颜色由此驱动，与瞬时 connectionStatus 解耦
  proxyError: string | null;

  // Connection State
  connectionStatus: ConnectionStatus | null;

  // Configuration
  config: UserConfig | null;

  // Statistics
  stats: TrafficStats | null;

  // 出口 IP 信息（本地直连出口 / 代理出口）
  ipInfo: IpInfoSnapshot | null;

  // 测速结果：仅应用生命周期内存态，重启清空（不持久化——重启是全新周期，不显示旧测速结果）
  latencyMap: Record<string, number>;
  // 每节点最近测速时间戳（serverId → epoch ms），与 latencyMap 并行；供延迟徽标「会话内」陈旧标识
  latencyTestedAt: Record<string, number>;
  // 本会话是否发起过全量测速（会话内存态，不持久化）：控制不可测节点徽标——未点过测速显「—」（同未测），
  // 点过全量测速后才显「不支持测速」（解释「为什么它没值」）。单节点 ⚡ 测速不置位（保持同步口径）。
  speedTestAttempted: boolean;
  // §16.3.3：上次测速中「非主核池成员」而缺席的节点 id（订阅新增/改址未重启入池）。徽标据此对无值节点显
  // tooltip「刷新订阅后纳入测速」（区别于恒不可测的「不支持测速」）。会话内存态；拿到真值即从集合移除（已入池）。
  speedTestNotInPool: Set<string>;

  // §2 待应用差集：节点集相对运行核启动快照的增(待入池)/改(待生效)/删。pull 模型——configChanged/proxyStarted/
  // proxyStopped 后 refreshPendingChanges 拉取。动作条汇总 + 徽标数据源。核未运行 → 全空（动作条隐藏）。
  pendingChanges: PendingNodeChanges;

  // issue 2：解锁检测显示态提到 store（跨首页组件卸载存活，切页回来不重跑）。见 UnlockDisplayState。
  unlock: UnlockDisplayState;

  // 启动前配置校验 gate 剔除的非法节点（serverId → 信息）：节点列表据此标灰 + tooltip（不禁用点击）。
  // 仅会话内存，由 EVENT_PROXY_INVALID_NODES 事件覆盖（空数组=清空）。
  invalidNodes: Record<string, InvalidNodeInfo>;

  // Tailscale 节点真实登录态（serverId → loggedIn）。1.14：由 api STATUS 流（backendState=Running||Starting）
  // 驱动，「需登录」角标据此点亮/熄灭（替代 1.13 的 state 目录存在性启发式，根除未认证误判已登录）。
  // 仅 Tailscale 节点入表；EVENT_TAILSCALE_STATUS 到达时由 setTailscaleLoginState 更新。
  tailscaleLoginStates: Record<string, boolean>;

  // Tailscale 节点最新交互登录 URL（serverId → AUTH_URL）。1.14 always-emit：未登录节点（含非出口）会持续 emit
  // EVENT_TAILSCALE_AUTH_URL，全量入此表。「需登录」角标据此可点直开该节点的登录页（无 URL 才回落触发重发）。
  // 登录成功（setTailscaleLoginState(id,true)）时清该 serverId 的 URL，避免点角标开已失效的旧 URL。
  tailscaleAuthUrls: Record<string, string>;

  // 用户是否【显式发起】了该 TS 节点的交互登录（serverId → initiated）。主核 always-emit AUTH_URL ≠ 用户在登录：
  // 未选中/未就绪节点的 URL 也会持续入 tailscaleAuthUrls，若据此判「登录中」会把卡片误推进「连接中…已开浏览器」。
  // 故卡片「logging-in」态须同时满足 initiated（用户点了登录/需登录角标）。登录成功、或收到空 URL（取消/超时/停核
  // 收尾信号）、或用户点取消时清除。仅会话内存，不持久化（登录发起是瞬时交互态，重启即失效）。
  tailscaleLoginInitiated: Record<string, boolean>;

  // Tailscale 节点内网 IP（serverId → tailnet IP 列表，100.x/fd7a:…）。1.14 api STATUS 流（self.tailscaleIPs）
  // 实时携带，由 setTailscaleIps 写入；供节点卡片「组网信息」popover 展示内网 IP，消「要登录控制台才看得到」黑盒。
  tailscaleIps: Record<string, string[]>;

  // Tailscale 对端列表（serverId → peers）。L2 状态流(EVENT_TAILSCALE_STATUS)/主动拉(TAILSCALE_GET_STATUS) 携带，
  // 供出口节点下拉(仅列 exitNodeOption=true) + 组网信息 popover。新鲜度看 connectionStatus.proxyCore.running（断开→陈旧灰显）。
  tailscalePeers: Record<string, TailscaleStatusPeer[]>;

  // Privacy Protection Mode
  isPrivacyMode: boolean;

  // macOS 提权 helper 状态
  helperStatus: HelperStatus | null;

  // F28：可用的 App 更新（持久入口数据源；放 store 因 AboutSettings 随子节切换会卸载，本地 state 承载不了）
  availableAppUpdate: UpdateInfo | null;

  // 可用的内核更新（常驻入口数据源；与 availableAppUpdate 同理放 store）
  availableCoreUpdate: AvailableCoreUpdate | null;

  // Actions
  setCurrentView: (view: string) => void;
  setServerPageAction: (action: 'add-server' | 'add-sub' | 'ts-settings' | null) => void;
  setSettingsSection: (section: string) => void;
  /** 应用一批测速结果（serverId→latency）：合并 latencyMap + 打 latencyTestedAt 时间戳（单一结果应用路径，会话内存态）。
   *  notInPool（§16.3.3）：本次「非池成员」缺席节点 id → 加入 speedTestNotInPool；拿到真值的节点从该集合移除（已入池）。 */
  applyLatencyResults: (results: Record<string, number>, notInPool?: string[]) => void;
  /** 标记本会话已发起全量测速（全量测速起跑时调；不可测节点徽标据此从「—」转「不支持测速」）。 */
  markSpeedTestAttempted: () => void;
  // issue 2 解锁检测显示态 actions：
  /** 发起/失效一轮检测：results 置 allChecking + running=true（切页不丢的「检测中」态；egress/checkedAt 清空待新值）。 */
  beginUnlockCheck: () => void;
  /** 单服务 settle 增量点亮（EVENT_UNLOCK_PROGRESS 持久订阅写入，无论首页是否挂载均累积）。 */
  setUnlockProgress: (serviceId: string, result: UnlockResult) => void;
  /** 应用一轮完整终态（run() 返回 / EVENT_UNLOCK_UPDATED）：notReady/blocked → idle，否则 results/checkedAt/egress，running=false。 */
  applyUnlockSnapshot: (snap: UnlockSnapshot) => void;
  /** 复位为 idle（停代理 / 选中出口无效）。 */
  resetUnlock: () => void;
  setPrivacyMode: (value: boolean) => void;
  setAvailableAppUpdate: (info: UpdateInfo | null) => void;
  setAvailableCoreUpdate: (info: AvailableCoreUpdate | null) => void;

  // Proxy Control Actions
  startProxy: () => Promise<void>;
  stopProxy: () => Promise<void>;

  // Configuration Actions
  loadConfig: () => Promise<void>;
  saveConfig: (config: UserConfig) => Promise<void>;
  // 从 main 推送的 config 事件（handleConfigChanged newValue 路径）落地：写 config + 作废在飞旧 pull，
  // 防「push 与 mount pull 并发」时旧 pull 迟到回填覆盖新 push（#325 A2 护栏）。
  applyConfigFromEvent: (config: UserConfig) => void;
  updateProxyMode: (mode: ProxyMode) => Promise<void>;
  setConfigValue: (key: keyof UserConfig, value: any) => Promise<void>;

  // §2 待应用差集：拉取节点差集入 store（configChanged/proxyStarted/proxyStopped 后 + 挂载时调）。失败静默（保留旧值）。
  refreshPendingChanges: () => Promise<void>;

  // Status Actions
  refreshConnectionStatus: () => Promise<void>;
  /** 手动重探出口 IP（force，绕 TTL）：状态栏检测超时/失败时的刷新按钮触发。 */
  reprobeExitIp: () => Promise<void>;
  // Tailscale 登录态单条覆盖（loggedIn=Running||Starting），由 EVENT_TAILSCALE_STATUS 驱动。
  setTailscaleLoginState: (
    serverId: string,
    loggedIn: boolean,
    opts?: { skipCache?: boolean }
  ) => void;
  // Tailscale 交互登录 URL 单条覆盖（serverId → 最新 AUTH_URL），由 EVENT_TAILSCALE_AUTH_URL 驱动。
  setTailscaleAuthUrl: (serverId: string, url: string) => void;
  // 用户显式发起/退出该 TS 节点交互登录的标记（点登录/需登录角标置 true；点取消置 false）。
  setTailscaleLoginInitiated: (serverId: string, initiated: boolean) => void;
  // Tailscale 内网 IP 单条覆盖（self.tailscaleIPs），由 EVENT_TAILSCALE_STATUS 驱动。
  setTailscaleIps: (serverId: string, ips: string[]) => void;
  // Tailscale 对端列表单条覆盖（serverId → peers），由 EVENT_TAILSCALE_STATUS / TAILSCALE_GET_STATUS 驱动。
  setTailscalePeers: (serverId: string, peers: TailscaleStatusPeer[]) => void;

  // Server Management Actions
  // 返回删选中节点的兜底出口（undefined=非删选中；null=无剩余→direct；string=兜底节点 id），供调用点 toast「已切换到 X」。
  deleteServer: (serverId: string) => Promise<string | null | undefined>;
  deleteServers: (
    serverIds: string[]
  ) => Promise<{ count: number; fallback: string | null | undefined }>;

  // Custom Rules Actions
  addCustomRule: (rule: Rule) => Promise<void>;
  updateCustomRule: (rule: Rule) => Promise<void>;
  deleteCustomRule: (ruleId: string) => Promise<void>;
  commitRuleOrder: (orderedIds: string[]) => Promise<void>;

  // macOS 提权 helper Actions
  refreshHelperStatus: (force?: boolean) => Promise<void>;
  installHelper: () => Promise<{ success: boolean; error?: string }>;
  uninstallHelper: () => Promise<{ success: boolean; error?: string }>;
}

export const useAppStore = create<AppState>((set, get) => ({
  // Initial State
  currentView: 'home',
  serverPageAction: null,
  settingsSection: 'general',
  settingsReturnView: 'home',
  proxyBusy: false,
  proxyPhase: 'idle',
  proxyError: null,
  connectionStatus: null,
  config: null,
  stats: null,
  ipInfo: null,
  latencyMap: {},
  latencyTestedAt: {},
  speedTestAttempted: false,
  speedTestNotInPool: new Set<string>(),
  pendingChanges: { added: [], modified: [] },
  unlock: { results: {}, running: false, checkedAt: null, egress: null, lastRunAt: null },
  invalidNodes: {},
  // 启动秒显：从 localStorage 缓存派生登录态初值（代理关时不再 spawn 瞬态核探针，见 use-tailscale-login-cache-store）。
  tailscaleLoginStates: loadTailscaleLoginStatesFromCache(),
  tailscaleAuthUrls: {},
  tailscaleLoginInitiated: {},
  tailscaleIps: {},
  tailscalePeers: {},
  isPrivacyMode: false,
  helperStatus: null,
  availableAppUpdate: null,
  availableCoreUpdate: null,

  // UI Actions
  // 离开设置页时把子节重置回 general（保留原 App 行为）；导航到设置页则保留当前/外部指定的子节
  setCurrentView: (view) =>
    set((s) => ({
      currentView: view,
      settingsSection: view === 'settings' ? s.settingsSection : 'general',
      // 仅在「从非设置页进入设置页」时记录来源；设置页内切子节/重复进入不覆盖
      settingsReturnView:
        view === 'settings' && s.currentView !== 'settings' ? s.currentView : s.settingsReturnView,
    })),
  setServerPageAction: (action) => set({ serverPageAction: action }),
  setSettingsSection: (section) => set({ settingsSection: section }),
  markSpeedTestAttempted: () => set({ speedTestAttempted: true }),
  applyLatencyResults: (results, notInPool = []) =>
    set((state) => {
      const now = Date.now();
      const latencyTestedAt = { ...state.latencyTestedAt };
      for (const id of Object.keys(results)) latencyTestedAt[id] = now;
      // §16.3.3：更新「非池成员」集——本次缺席的加入，拿到真值的移除（已入池）。仅在有增删时新建 Set（避免无谓重渲染）。
      let speedTestNotInPool = state.speedTestNotInPool;
      if (notInPool.length > 0 || Object.keys(results).some((id) => speedTestNotInPool.has(id))) {
        speedTestNotInPool = new Set(state.speedTestNotInPool);
        for (const id of notInPool) speedTestNotInPool.add(id);
        for (const id of Object.keys(results)) speedTestNotInPool.delete(id);
      }
      return {
        latencyMap: { ...state.latencyMap, ...results },
        latencyTestedAt,
        speedTestNotInPool,
      };
    }),
  setAvailableAppUpdate: (info) => set({ availableAppUpdate: info }),
  setAvailableCoreUpdate: (info) => set({ availableCoreUpdate: info }),
  setPrivacyMode: async (value) => {
    if (get().isPrivacyMode === value) return;
    set({ isPrivacyMode: value });
    try {
      await api.config.setPrivacyMode(value);
    } catch (error) {
      console.error('Failed to sync privacy mode to main process:', error);
    }
  },

  // Proxy Control Actions
  startProxy: async () => {
    if (get().proxyPhase !== 'idle') return; // 防重入（双击 / 竞态二次启动）
    set({ proxyPhase: 'starting', proxyBusy: true, proxyError: null });
    try {
      // 获取当前配置
      const currentConfig = get().config;
      if (!currentConfig) {
        throw new Error(i18n.t('errors.configNotLoaded'));
      }

      // 直接启动代理，ProxyManager 会在需要时通过 osascript 请求管理员权限
      // 不再预先检查权限，因为 sing-box 进程会在 TUN 模式下自动请求权限
      await api.proxy.start(currentConfig);
      // 启动成功后不立即清 proxyBusy，而是等待状态轮询完成

      // Poll connection status until connected or timeout
      const maxAttempts = 20; // 10 seconds (20 * 500ms)
      let attempts = 0;

      const pollStatus = async (): Promise<void> => {
        attempts++;
        await get().refreshConnectionStatus();

        const status = get().connectionStatus;

        // Check if connected based on proxy mode type
        const isTunMode = status?.proxyModeType === 'tun';
        const isConnected = isTunMode
          ? status?.proxyCore?.running // TUN mode: only check if proxy core is running
          : status?.proxyCore?.running && status?.proxy?.enabled; // System proxy mode: check both

        if (isConnected) {
          // Ensure final status update before completing
          await get().refreshConnectionStatus();
          set({ proxyPhase: 'idle', proxyBusy: false });
          return;
        }

        // Check for proxy core errors
        if (status?.proxyCore?.error) {
          set({
            proxyError: status.proxyCore.error,
            proxyPhase: 'idle',
            proxyBusy: false,
          });
          return;
        }

        // Check if proxy core failed to start (not running and no error means startup failed)
        if (attempts > 3 && !status?.proxyCore?.running) {
          set({
            proxyError: i18n.t('errors.startupFailed'),
            proxyPhase: 'idle',
            proxyBusy: false,
          });
          return;
        }

        // Check timeout
        if (attempts >= maxAttempts) {
          set({
            proxyError: i18n.t('errors.connectionTimeout'),
            proxyPhase: 'idle',
            proxyBusy: false,
          });
          return;
        }

        // Continue polling
        setTimeout(pollStatus, 500);
      };

      // Start polling immediately
      await pollStatus();
    } catch (error) {
      set({ proxyPhase: 'idle', proxyError: String(error), proxyBusy: false });
      // Refresh status to ensure UI reflects actual state
      await get().refreshConnectionStatus();
    }
  },

  stopProxy: async () => {
    if (get().proxyPhase !== 'idle') return;
    set({ proxyPhase: 'stopping', proxyBusy: true, proxyError: null });
    try {
      await api.proxy.stop();
      // Refresh status after stopping
      await get().refreshConnectionStatus();
    } catch (error) {
      // 卡片错误会被下一次 refresh 的「健康即清」掩盖，故启停失败必须 toast 保证用户感知
      set({ proxyError: String(error) });
      toast.error(i18n.t('home.stopProxyFailed'));
    } finally {
      set({ proxyPhase: 'idle', proxyBusy: false });
    }
  },

  // Configuration Actions
  loadConfig: async () => {
    // 单飞：在飞则复用同一 promise，防 configChanged 风暴 / 启动期重复拉取
    if (loadConfigInflight) return loadConfigInflight;
    // 代际快照：拉取期间若发生 mutation（invalidateLoadConfig 自增代际），本次快照即陈旧，回填时按此丢弃。
    const gen = loadConfigGeneration;
    loadConfigInflight = (async () => {
      try {
        const config = await api.config.get();

        // 确保有默认的TUN配置
        if (!config.tunConfig) {
          config.tunConfig = {
            // 'auto' = 跟随 (平台 × 具体栈) 映射（主进程 resolveTunMtu / resolveTunStack 解析），
            // 渲染端缺省兜底用新模型默认档，不在此复制平台数值（那正是旧模型散落多处的来源）。
            mtu: 'auto',
            stack: 'auto',
            autoRoute: true,
            strictRoute: true,
          };
        }

        // 确保有默认的代理模式类型
        if (!config.proxyModeType) {
          config.proxyModeType = 'systemProxy';
        }

        const isPrivacyMode = await api.config.getPrivacyMode();
        // isPrivacyMode 是主进程权威即时态、与 config 代际语义无耦合 → **无条件**回填，不随 config 代际护栏一起被
        // 作废。挂载期这是隐私态的唯一水合路径（silent-start autoPrivacyMode 空闲锁的 ENTER 事件同样无窗期丢失，
        // 见 index.ts:229-233/266-268），若被 replay / mutation 作废在飞 pull 时连带丢弃 → isPrivacyMode 恒留初值
        // false → 首开窗隐私遮罩不出现＝隐私锁旁路（#325 复审 High 1）。
        set({ isPrivacyMode });
        // 代际护栏：拉取期间发生了 mutation / applyConfigFromEvent（loadConfigGeneration 已变）→ 本 config 快照陈旧，
        // 丢弃不回填 store，交由推侧 push / mutation 触发的新一轮回填最新配置（防删节点后旧快照复活已删节点）。
        // 仅 config 与依赖 config.servers 的 TS 缓存 GC 受此护栏；isPrivacyMode 已在上方无条件回填。
        if (gen !== loadConfigGeneration) return;
        set({ config });
        // Tailscale 登录态不在此拉取：1.14 由 api STATUS 流（EVENT_TAILSCALE_STATUS，随主核起停持续推送）
        // 实时驱动 tailscaleLoginStates，无需 loadConfig 时整表 IPC 刷新（已剥离 refreshTailscaleLoginStates）。
        gcOrphanTailscaleLoginCache(config.servers);
      } catch (error) {
        console.error('[Store] Exception loading config:', error);
        toast.error(i18n.t('common.configLoadFail'));
      } finally {
        // 仅当本次 load 仍是最新代际（期间无 mutation 顶替）才清句柄：mutation 经 invalidateLoadConfig
        // 自增代际并置空句柄、可能已启动新一轮 load，旧 load 的 finally 不得误清新 load 的句柄。
        // 代际唯一标识当前 load（新 load 仅能在句柄为空后启动，而句柄置空必伴随代际自增），故用代际比对即可。
        if (gen === loadConfigGeneration) loadConfigInflight = null;
      }
    })();
    return loadConfigInflight;
  },

  // main push 的 config 事件落地（#325 replay + 常规 configChanged newValue 路径）。写 config 后同步作废在飞旧
  // pull——replay 使「push 与 mount loadConfig 并发」每次挂载必然发生，若不 invalidate，在飞旧 pull 迟到 resolve
  // 会用旧快照覆盖刚 push 的新 config（代际护栏只防 renderer mutation、不防 main push）。顺序循 saveConfig：先 set 再
  // invalidate。这是用护栏自己的 API 扩其覆盖面（新增合法自增点），单飞语义不变、内部护栏不外泄。
  applyConfigFromEvent: (config) => {
    set({ config });
    // 追零：replay 作废在飞 mount pull → 那次 pull 的孤儿 GC 被 gen 守卫跳过；push 落地同样跑一次（入参为
    // push 的权威 servers，无陈旧覆盖），使挂载期短窗也不漏清 TS 登录缓存孤儿条目（#325 复审追零 Nit）。
    gcOrphanTailscaleLoginCache(config.servers);
    invalidateLoadConfig();
  },

  saveConfig: async (config) => {
    try {
      await api.config.save(config);
      set({ config });
      // 代际护栏：本地乐观 set 后作废在飞的旧 load，防其陈旧快照覆盖刚保存的配置。
      invalidateLoadConfig();
    } catch (error) {
      console.error('[Store] Exception saving config:', error);
      throw error; // 调用点负责局部 toast，不再写全局 error
    }
  },

  updateProxyMode: async (mode) => {
    try {
      await api.config.updateMode(mode);
      // Update local config
      const currentConfig = get().config;
      if (currentConfig) {
        set({ config: { ...currentConfig, proxyMode: mode } });
      }
      // 代际护栏：乐观 set 后作废在飞的旧 load，防其陈旧快照覆盖刚切换的代理模式。
      invalidateLoadConfig();
    } catch (error) {
      console.error('[Store] Exception updating proxy mode:', error);
      throw error; // 调用点（原 proxy-control-card，已并入 connection-control-card）catch + toast + 本地 busy
    }
  },

  // §2 待应用差集：拉取入 store。失败静默保留旧值（差集是提示性 UI，拉失败不该清空误报「无待应用」）。
  refreshPendingChanges: async () => {
    try {
      const pc = await api.proxy.getPendingChanges();
      set({ pendingChanges: pc });
    } catch {
      /* 拉取失败保留旧值 */
    }
  },

  // issue 2 解锁检测显示态（lastRunAt 承载「上次完成时刻」供冷却派生；beginUnlockCheck/setUnlockProgress 保留旧 lastRunAt）：
  beginUnlockCheck: () =>
    set((s) => ({
      unlock: {
        results: allCheckingResults(),
        running: true,
        checkedAt: null,
        egress: null,
        lastRunAt: s.unlock.lastRunAt,
      },
    })),
  setUnlockProgress: (serviceId, result) =>
    set((s) => ({
      unlock: { ...s.unlock, results: { ...s.unlock.results, [serviceId]: result } },
    })),
  applyUnlockSnapshot: (snap) => {
    // review#5：陈旧轮 no-op 快照（空 results + 无 checkedAt/notReady/blockedReason）——本轮在飞期间被 invalidate、
    // 新一轮已 beginUnlockCheck 接管显示 → 不覆盖（否则会把新一轮「检测中」清成空 idle）。
    if (
      !snap.checkedAt &&
      !snap.notReady &&
      !snap.blockedReason &&
      Object.keys(snap.results).length === 0
    ) {
      return;
    }
    if (snap.blockedReason) {
      // gating 短路（proxy-not-running / exit-invalid）→ idle，不打 lastRunAt（M-gate 毫秒响应，允许反复点，无冷却）。
      set({
        unlock: { results: {}, running: false, checkedAt: null, egress: null, lastRunAt: null },
      });
    } else if (snap.notReady) {
      // 就绪门未过 → idle 但后端已置 lastRunAt（force 15s 下限生效）→ 打戳，冷却据此镜像。
      set({
        unlock: {
          results: {},
          running: false,
          checkedAt: null,
          egress: null,
          lastRunAt: Date.now(),
        },
      });
    } else {
      // 真检测落定 → results/checkedAt/egress。lastRunAt 取 snap.checkedAt（后端真跑一轮 checker 的完成时刻）而非
      // Date.now()：cache-hit 广播（A→B→A 命中缓存的 self-run，后端**不更新**自身 lastRunAt）回放的是旧 checkedAt，
      // 用它派生冷却 → 早于 15s 前的旧检测不再误禁刷新钮（Nit：over-disabled ~15s）；恰镜像后端 force-min（按真跑时刻计）。
      // checkedAt 理论上本分支必非空（gating/notReady 已分流），?? Date.now() 仅作类型兜底。
      set({
        unlock: {
          results: snap.results,
          running: false,
          checkedAt: snap.checkedAt,
          egress: snap.egress,
          lastRunAt: snap.checkedAt ?? Date.now(),
        },
      });
    }
  },
  resetUnlock: () =>
    set({
      unlock: { results: {}, running: false, checkedAt: null, egress: null, lastRunAt: null },
    }),

  // Status Actions
  refreshConnectionStatus: async () => {
    try {
      const proxyStatus = await api.proxy.getStatus();
      // 将 ProxyStatus 转换为 ConnectionStatus
      const connectionStatus: ConnectionStatus = {
        proxyCore: {
          running: proxyStatus.running,
          pid: proxyStatus.pid,
          uptime: proxyStatus.uptime,
          error: proxyStatus.error,
        },
        proxy: {
          enabled: proxyStatus.running,
          server: proxyStatus.currentServer?.name,
        },
        proxyModeType: get().config?.proxyModeType || 'systemProxy',
      };
      set({ connectionStatus });
      // F2：代理被观测到健康运行 ⇒ 上一次启停失败的 proxyError 已过时 ⇒ 清除（解决僵死）。
      // 未运行时保留错误供用户查看，至下次 start/stop 入口清零（避免 2s 轮询把错误闪没）。
      const healthy = connectionStatus.proxyCore.running && !connectionStatus.proxyCore.error;
      if (healthy && get().proxyError) set({ proxyError: null });
    } catch (error) {
      console.error('Failed to refresh connection status:', error);
    }
  },

  // 手动重探出口 IP（force+visible，绕 TTL）：可见流程「检测中…→新IP/检测超时/出口无效」，解锁刷新钮 + 状态栏
  // 刷新钮共用。中间态与终值均由 EVENT_IP_INFO_UPDATED 事件链写入 store（use-native-events，App 根常驻订阅）；
  // 【不回写 invoke 返回值】——终值可能晚于并发 markProxyConnecting（切节点清值广播、且不推 updatedAt 单调 guard
  // 挡不住）抵达，set 会用陈旧快照冲掉「检测中」态。await 仅用于两入口按钮的 reprobing spinner 生命周期。
  reprobeExitIp: async () => {
    try {
      await api.ipInfo.get(true, true);
    } catch (error) {
      console.error('Failed to reprobe exit IP:', error);
    }
  },

  // 单条覆盖：EVENT_TAILSCALE_STATUS 即时点亮/熄灭该节点登录态（loggedIn=Running||Starting）。
  // 1.14 api STATUS 是单一真值（无整表刷新 / 无乐观代际防覆盖：无并发整表覆盖竞态，纯单点写）。
  setTailscaleLoginState: (serverId, loggedIn, opts) => {
    set((s) => {
      const tailscaleLoginStates = { ...s.tailscaleLoginStates, [serverId]: loggedIn };
      const patch: Partial<AppState> = { tailscaleLoginStates };
      // 登录成功后旧 AUTH_URL 失效：清掉该 serverId 的缓存 URL，避免点角标开过期登录页（无则原样返回引用）。
      if (loggedIn && s.tailscaleAuthUrls[serverId] !== undefined) {
        const tailscaleAuthUrls = { ...s.tailscaleAuthUrls };
        delete tailscaleAuthUrls[serverId];
        patch.tailscaleAuthUrls = tailscaleAuthUrls;
      }
      // 登录成功即退出「用户发起登录」态（下次的 always-emit URL 不应再让卡片显「连接中」）。
      if (loggedIn && s.tailscaleLoginInitiated[serverId]) {
        const tailscaleLoginInitiated = { ...s.tailscaleLoginInitiated };
        delete tailscaleLoginInitiated[serverId];
        patch.tailscaleLoginInitiated = tailscaleLoginInitiated;
      }
      return patch;
    });
    // 持久化登录态真值（STATUS 流 / 登出均经此）→ 代理关时下次启动秒显，免起核探针。
    // skipCache：state 文件存在性兜底的「乐观 true」不写缓存——缓存只存 STATUS 流真值（设计契约）；
    // 否则 revoked/过期 key 的 state 目录残留会把乐观值固化进缓存（缓存优先级又高于 state 兜底），长期误显已连接。
    if (!opts?.skipCache) useTailscaleLoginCacheStore.getState().setCached(serverId, loggedIn);
  },
  // always-emit AUTH_URL：全量入表（无条件覆盖最新 URL），登录成功由 setTailscaleLoginState 反向清理。
  // 空 URL（登录超时/失败信号）→ 删除该 serverId 缓存，使卡片/表单退出「登录中」回「需登录」。
  setTailscaleAuthUrl: (serverId, url) => {
    set((s) => {
      if (!url) {
        // 空 URL = 取消/超时/停核收尾信号：一并退出「用户发起登录」态（否则残留 initiated 会让下次
        // always-emit 的 URL 又把卡片推回「连接中」）。
        const clearInitiated = s.tailscaleLoginInitiated[serverId] === true;
        if (s.tailscaleAuthUrls[serverId] === undefined && !clearInitiated) return {};
        const patch: Partial<AppState> = {};
        if (s.tailscaleAuthUrls[serverId] !== undefined) {
          const tailscaleAuthUrls = { ...s.tailscaleAuthUrls };
          delete tailscaleAuthUrls[serverId];
          patch.tailscaleAuthUrls = tailscaleAuthUrls;
        }
        if (clearInitiated) {
          const tailscaleLoginInitiated = { ...s.tailscaleLoginInitiated };
          delete tailscaleLoginInitiated[serverId];
          patch.tailscaleLoginInitiated = tailscaleLoginInitiated;
        }
        return patch;
      }
      // URL 未变则不重建表（always-emit 同一 URL 反复 emit 时省整表浅拷贝 + 无谓订阅者重渲染）。
      return s.tailscaleAuthUrls[serverId] === url
        ? {}
        : { tailscaleAuthUrls: { ...s.tailscaleAuthUrls, [serverId]: url } };
    });
  },
  // 用户显式发起/退出交互登录标记（内容未变返 {} 免重渲染）。true=点登录/需登录角标；false=点取消。
  setTailscaleLoginInitiated: (serverId, initiated) => {
    set((s) => {
      const current = s.tailscaleLoginInitiated[serverId] === true;
      if (current === initiated) return {};
      const tailscaleLoginInitiated = { ...s.tailscaleLoginInitiated };
      if (initiated) tailscaleLoginInitiated[serverId] = true;
      else delete tailscaleLoginInitiated[serverId];
      return { tailscaleLoginInitiated };
    });
  },
  // 单条覆盖：EVENT_TAILSCALE_STATUS 即时更新该节点内网 IP（self.tailscaleIPs，纯单点写无并发竞态）。
  setTailscaleIps: (serverId, ips) => {
    // IP 列表未变则不重建表（STATUS 多帧同 IP 反复 emit 时省整表浅拷贝 + 无谓订阅者重渲染）。
    // 用 length + 逐元素比较而非 join(' ')：IP 场景（无空格/分隔符歧义）二者等价，但逐位比较更稳，
    // 不依赖分隔符在元素值中不出现这一隐含前提。
    set((s) => {
      const prev = s.tailscaleIps[serverId];
      const unchanged = prev?.length === ips.length && prev.every((ip, i) => ip === ips[i]);
      return unchanged ? {} : { tailscaleIps: { ...s.tailscaleIps, [serverId]: ips } };
    });
  },
  // 内容未变则不重建表（状态流多帧、peers 常不变 → 省无谓重渲染）。逐元素逐字段比较（对齐 setTailscaleIps，
  // 零字符串分配、首差即短路；不依赖分隔符在 hostName 中不出现这一隐含前提）。
  setTailscalePeers: (serverId, peers) => {
    const same = (a: TailscaleStatusPeer, b: TailscaleStatusPeer): boolean =>
      a.hostName === b.hostName &&
      a.ip === b.ip &&
      a.online === b.online &&
      a.exitNode === b.exitNode &&
      a.exitNodeOption === b.exitNodeOption &&
      a.active === b.active;
    set((s) => {
      const prev = s.tailscalePeers[serverId];
      const unchanged = prev?.length === peers.length && prev.every((p, i) => same(p, peers[i]));
      return unchanged ? {} : { tailscalePeers: { ...s.tailscalePeers, [serverId]: peers } };
    });
  },

  // Server Management Actions
  deleteServer: async (serverId) => {
    try {
      // D4：删的是当前选中节点 → 算兜底出口（最快剩余节点，latency 在渲染端会话态）传后端，
      // 后端据此置 selectedServerId 并 emit 触发重启，把已删节点移出运行核（避免流量仍走已删出口）。
      const st = get();
      const cfg = st.config;
      const fallback =
        cfg && cfg.selectedServerId === serverId
          ? pickFallbackExit(
              fallbackExitCandidateIds(cfg.servers, new Set([serverId]), st.pendingChanges.added),
              st.latencyMap
            )
          : undefined;
      await api.server.delete(serverId, fallback);
      // 清该节点 Tailscale 登录态缓存（仅 TS 节点有此缓存，非 TS 为 no-op）：免删-增循环陈旧缓存累积，
      // 也免导入/恢复复用旧 uuid 时陈旧 true 让 state 兜底跳过、误显「已登录」。
      useTailscaleLoginCacheStore.getState().removeCached(serverId);
      // 代际护栏：删除已落库，作废在飞的旧 load（可能持删前快照）+ 自增代际，确保下面的 loadConfig
      // 拉到删后最新配置、且旧在飞 load 的回填被丢弃（否则删节点后旧快照复活已删节点）。
      invalidateLoadConfig();
      // Reload config to get updated server list（Tailscale 登录态由 api STATUS 流实时驱动，无需在此刷新）。
      await get().loadConfig();
      // 返回**生效后**的出口（loadConfig 后 config.selectedServerId 是后端实际所置——可能因兜底 id 悬空被后端校验回退
      // DIRECT，与渲染端预算的 fallback 不同，review Nit-4）：undefined=非删选中；null=切直连（含 DIRECT 哨兵归一）；string=兜底节点 id。
      if (fallback === undefined) return undefined;
      const eff = get().config?.selectedServerId ?? null;
      return isDirectSelection(eff) ? null : eff;
    } catch (error) {
      console.error('[Store] Exception deleting server:', error);
      throw error; // 调用点 catch + toast
    }
  },

  deleteServers: async (serverIds) => {
    try {
      // D4：删除集合含当前选中节点 → 兜底最快剩余节点（排除全部待删）传后端触发重启（同 deleteServer）。
      const st = get();
      const cfg = st.config;
      const delSet = new Set(serverIds);
      const fallback =
        cfg && cfg.selectedServerId && delSet.has(cfg.selectedServerId)
          ? pickFallbackExit(
              fallbackExitCandidateIds(cfg.servers, delSet, st.pendingChanges.added),
              st.latencyMap
            )
          : undefined;
      const count = await api.server.deleteBatch(serverIds, fallback);
      // 同 deleteServer：批量清各节点 Tailscale 登录态缓存（非 TS 为 no-op）。
      const cache = useTailscaleLoginCacheStore.getState();
      for (const id of serverIds) cache.removeCached(id);
      // 代际护栏：同 deleteServer，作废在飞旧 load，防批量删后旧快照复活已删节点。
      invalidateLoadConfig();
      await get().loadConfig();
      // fallback 同 deleteServer：返回生效后的实际出口（后端校验可能把悬空兜底回退 DIRECT，review Nit-4）；count 保留。
      if (fallback === undefined) return { count, fallback: undefined };
      const eff = get().config?.selectedServerId ?? null;
      return { count, fallback: isDirectSelection(eff) ? null : eff };
    } catch (error) {
      console.error('[Store] Exception batch-deleting servers:', error);
      throw error; // 调用点 catch + toast
    }
  },

  // Custom Rules Actions
  addCustomRule: async (rule) => {
    try {
      await api.rules.add(rule);
      // 代际护栏：作废在飞旧 load，防其陈旧快照丢掉刚新增的规则。
      invalidateLoadConfig();
      // Reload config to get updated rules
      await get().loadConfig();
    } catch (error) {
      console.error('[Store] Exception adding rule:', error);
      throw error;
    }
  },

  updateCustomRule: async (rule) => {
    try {
      await api.rules.update(rule);
      // 代际护栏：作废在飞旧 load，防其陈旧快照覆盖刚更新的规则。
      invalidateLoadConfig();
      // Reload config to get updated rules
      await get().loadConfig();
    } catch (error) {
      console.error('[Store] Exception in updateCustomRule:', error);
      throw error;
    }
  },

  deleteCustomRule: async (ruleId) => {
    try {
      await api.rules.delete(ruleId);
      // 代际护栏：作废在飞旧 load，防其陈旧快照复活已删规则。
      invalidateLoadConfig();
      // Reload config to get updated rules
      await get().loadConfig();
    } catch (error) {
      console.error('[Store] Exception deleting rule:', error);
      throw error; // 改 rethrow：原吞错使 delete-rule-dialog 失败也误弹「已删除」成功 toast
    }
  },

  // 排序编辑态「保存顺序」一次性提交：严格排列校验 + 乐观重排 + 立即 await（无 debounce）。
  // 失败 rethrow，由 rules-page toast + loadConfig 回滚；净零序由 server 端跳过 save（≤1 次重启）。
  commitRuleOrder: async (orderedIds) => {
    const cfg = get().config;
    if (!cfg) return;
    const byId = new Map((cfg.customRules || []).map((r) => [r.id, r]));
    if (
      orderedIds.length !== byId.size ||
      new Set(orderedIds).size !== orderedIds.length ||
      !orderedIds.every((id) => byId.has(id))
    ) {
      throw new Error('invalid rule order');
    }
    set({ config: { ...cfg, customRules: orderedIds.map((id) => byId.get(id)!) } });
    // 代际护栏：乐观重排 set 后作废在飞旧 load，防其陈旧快照把顺序回滚。
    invalidateLoadConfig();
    await api.rules.reorder(orderedIds);
  },

  setConfigValue: async (key, value) => {
    try {
      await api.config.setValue(key, value);
      // 代际护栏：已落库，作废在飞旧 load，防其陈旧快照覆盖本次改动（乐观 set / 兜底 loadConfig 均受保护）。
      invalidateLoadConfig();
      // Update local state immediately for better UX
      const currentConfig = get().config;
      if (currentConfig) {
        set({ config: { ...currentConfig, [key]: value } });
      } else {
        await get().loadConfig();
      }
    } catch (error) {
      console.error(`[Store] Failed to set config value for ${String(key)}:`, error);
      // 原纯 console 静默：写盘失败用户无感知，UI 可能显新值但未持久化。补 toast 让用户知晓保存失败。
      toast.error(i18n.t('apiToast.setConfigFailed'));
    }
  },

  // macOS 提权 helper Actions
  refreshHelperStatus: async (force) => {
    try {
      const helperStatus = await api.helper.getStatus(force === true);
      set({ helperStatus });
    } catch (error) {
      console.error('[Store] Failed to refresh helper status:', error);
    }
  },

  installHelper: async () => {
    try {
      const res = await api.helper.install();
      if (res.status) set({ helperStatus: res.status });
      // 代际护栏：helperPromptDismissed 等配置可能已变，作废在飞旧 load 防陈旧快照覆盖。
      invalidateLoadConfig();
      // helperPromptDismissed 等配置可能已变 → 同步（helperToken 已解耦到独立文件，不经 config）
      await get().loadConfig();
      return { success: res.success, error: res.error };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },

  uninstallHelper: async () => {
    try {
      const res = await api.helper.uninstall();
      if (res.status) set({ helperStatus: res.status });
      // 代际护栏：作废在飞旧 load，防陈旧快照覆盖卸载后的配置。
      invalidateLoadConfig();
      await get().loadConfig();
      return { success: res.success, error: res.error };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
}));
