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
} from '../../shared/types';
import type { UpdateInfo } from '../../shared/types/update';
import { api } from '../ipc';
import { toast } from 'sonner';
import i18n from '../i18n';
import { mergeTailscaleLoginStates } from './tailscale-login-merge';

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

// loadConfig 单飞：防 configChanged 风暴 / 启动期重复拉取（替代原 isLoading 重入守卫）
let loadConfigInflight: Promise<void> | null = null;

// Tailscale 登录态防覆盖（P5 竞态）：refreshTailscaleLoginStates 整表覆盖 与 setTailscaleLoginState 乐观单点点亮
// 并发时，一次更早发起、快照仍是登录前 false 的 refresh 后到 → 把刚点亮的 true 覆盖回 false（角标闪/回退）。
// 用单调代际：每次乐观点亮 true 递增 gen 并登记 serverId→gen；refresh 发起时捕获 gen，响应回来时若某 serverId
// 在「refresh 发起之后」又被乐观点亮（登记 gen > 捕获 gen）且磁盘快照给的是 falsy → 保留该条乐观 true（丢弃过期覆盖）。
// 磁盘真值仍权威：登出（磁盘 false 且无更新乐观点亮）正常生效；仅保护「在途 refresh 期间新点亮的 true」。
let tailscaleOptimisticGen = 0;
const tailscaleOptimisticTrueAt = new Map<string, number>();

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

  // Latency test results (persisted across view changes)
  latencyMap: Record<string, number>;

  // 启动前配置校验 gate 剔除的非法节点（serverId → 信息）：节点列表据此标灰 + tooltip（不禁用点击）。
  // 仅会话内存，由 EVENT_PROXY_INVALID_NODES 事件覆盖（空数组=清空）。
  invalidNodes: Record<string, InvalidNodeInfo>;

  // Tailscale 节点真实登录态（serverId → loggedIn = hasAuthKey || state 目录存在）。Phase 1：
  // 「需登录」角标由此真实态驱动（替代静态 !authKey），故交互登录成功后角标会自动消失。
  // 仅 Tailscale 节点入表；挂载 / 节点增删 / 登录成功事件时由 refreshTailscaleLoginStates 刷新。
  tailscaleLoginStates: Record<string, boolean>;

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
  setSettingsSection: (section: string) => void;
  setLatencyMap: (
    map: Record<string, number> | ((prev: Record<string, number>) => Record<string, number>)
  ) => void;
  setPrivacyMode: (value: boolean) => void;
  setAvailableAppUpdate: (info: UpdateInfo | null) => void;
  setAvailableCoreUpdate: (info: AvailableCoreUpdate | null) => void;

  // Proxy Control Actions
  startProxy: () => Promise<void>;
  stopProxy: () => Promise<void>;

  // Configuration Actions
  loadConfig: () => Promise<void>;
  saveConfig: (config: UserConfig) => Promise<void>;
  updateProxyMode: (mode: ProxyMode) => Promise<void>;
  setConfigValue: (key: keyof UserConfig, value: any) => Promise<void>;

  // Status Actions
  refreshConnectionStatus: () => Promise<void>;
  refreshStatistics: () => Promise<void>;
  // Tailscale 登录态：整体刷新（挂载/节点增删后）+ 单条覆盖（登录成功事件即时更新，免一次 IPC 往返）。
  refreshTailscaleLoginStates: () => Promise<void>;
  setTailscaleLoginState: (serverId: string, loggedIn: boolean) => void;

  // Server Management Actions
  deleteServer: (serverId: string) => Promise<void>;

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
  invalidNodes: {},
  tailscaleLoginStates: {},
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
  setSettingsSection: (section) => set({ settingsSection: section }),
  setLatencyMap: (map) =>
    set((state) => ({
      latencyMap: typeof map === 'function' ? map(state.latencyMap) : map,
    })),
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
    loadConfigInflight = (async () => {
      try {
        const config = await api.config.get();

        // 确保有默认的TUN配置
        if (!config.tunConfig) {
          config.tunConfig = {
            mtu: window.electron?.platform === 'darwin' ? 1400 : 1350,
            stack: window.electron?.platform === 'darwin' ? 'gvisor' : 'system',
            autoRoute: true,
            strictRoute: true,
          };
        }

        // 确保有默认的代理模式类型
        if (!config.proxyModeType) {
          config.proxyModeType = 'systemProxy';
        }

        const isPrivacyMode = await api.config.getPrivacyMode();
        set({ config, isPrivacyMode });
        // 节点增删/导入/订阅更新/编辑最终都回流到 loadConfig（单飞合一）→ 在此统一刷新 Tailscale 登录态，
        // 使登录态表始终与最新节点集合对齐（含新增的带 authKey 节点不误显「需登录」）。fire-and-forget：
        // 不阻塞 loadConfig 主流程/单飞窗口，刷新失败仅 console（角标退化为缺省 false=保守显需登录，不破功能）。
        void get().refreshTailscaleLoginStates();
      } catch (error) {
        console.error('[Store] Exception loading config:', error);
        toast.error(i18n.t('common.configLoadFail'));
      } finally {
        loadConfigInflight = null;
      }
    })();
    return loadConfigInflight;
  },

  saveConfig: async (config) => {
    try {
      await api.config.save(config);
      set({ config });
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
    } catch (error) {
      console.error('[Store] Exception updating proxy mode:', error);
      throw error; // 调用点（proxy-control-card）catch + toast + 本地 busy
    }
  },

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

  refreshStatistics: async () => {
    try {
      const stats = await api.stats.get();
      set({ stats });
    } catch (error) {
      console.error('Failed to refresh statistics:', error);
    }
  },

  // 整体刷新 Tailscale 登录态（主进程按 hasAuthKey || state 目录存在 判定，整表覆盖）。
  // 防覆盖：捕获发起时代际；响应回来时，对「在途期间又被乐观点亮 true」的 serverId（登记 gen > 捕获 gen）
  // 且磁盘快照给 falsy 者，保留乐观 true（丢弃这次过期整表覆盖），避免刚点亮的角标被旧快照打回。
  refreshTailscaleLoginStates: async () => {
    const genAtStart = tailscaleOptimisticGen;
    try {
      const states = await api.server.getTailscaleLoginStates();
      set((s) => ({
        tailscaleLoginStates: mergeTailscaleLoginStates(
          states,
          s.tailscaleLoginStates,
          tailscaleOptimisticTrueAt,
          genAtStart
        ),
      }));
    } catch (error) {
      console.error('Failed to refresh tailscale login states:', error);
    }
  },

  // 单条覆盖（登录成功事件即时点亮，无需等整表 IPC；下次整体刷新会与磁盘真值对齐）。
  // 点亮 true 时递增代际并登记，供 refresh 防覆盖识别「在途期间的新乐观点亮」。
  setTailscaleLoginState: (serverId, loggedIn) => {
    if (loggedIn) {
      tailscaleOptimisticTrueAt.set(serverId, ++tailscaleOptimisticGen);
    } else {
      // 显式登出/置 false：撤销乐观保护（不再保留旧 true），让磁盘真值正常生效。
      tailscaleOptimisticTrueAt.delete(serverId);
    }
    set((s) => ({ tailscaleLoginStates: { ...s.tailscaleLoginStates, [serverId]: loggedIn } }));
  },

  // Server Management Actions
  deleteServer: async (serverId) => {
    try {
      await api.server.delete(serverId);
      // Reload config to get updated server list（loadConfig 内已统一刷新 Tailscale 登录态，覆盖增删/导入，
      // 故此处不再单独调 refreshTailscaleLoginStates，避免双刷）。
      await get().loadConfig();
    } catch (error) {
      console.error('[Store] Exception deleting server:', error);
      throw error; // 调用点 catch + toast
    }
  },

  // Custom Rules Actions
  addCustomRule: async (rule) => {
    try {
      await api.rules.add(rule);
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
    await api.rules.reorder(orderedIds);
  },

  setConfigValue: async (key, value) => {
    try {
      await api.config.setValue(key, value);
      // Update local state immediately for better UX
      const currentConfig = get().config;
      if (currentConfig) {
        set({ config: { ...currentConfig, [key]: value } });
      } else {
        await get().loadConfig();
      }
    } catch (error) {
      console.error(`[Store] Failed to set config value for ${String(key)}:`, error);
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
      await get().loadConfig();
      return { success: res.success, error: res.error };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
}));
