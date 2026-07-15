import { useEffect } from 'react';
import { MainLayout } from './components/layout/main-layout';
import { useAppStore } from './store/app-store';
import { useNodeSortStore } from './store/use-node-sort-store';
import { useNativeEventListeners } from './hooks/use-native-events';
import { HomePage } from './pages/home-page';
import { LogsPage } from './pages/logs-page';
import { ConnectionsPage } from './pages/connections-page';
import { ServerPage } from './pages/server-page';
import { RulesPage } from './pages/rules-page';
import { RuleResourcesPage } from './pages/rule-resources-page';
import { AppPolicyPage } from './pages/app-policy-page';
import { SettingsPage } from './pages/settings-page';
import { Toaster } from './components/ui/sonner';
import { ErrorBoundary } from './components/error-boundary';
import { ipcClient } from './ipc/ipc-client';
import { toast } from 'sonner';
import { PrivacyOverlay } from './components/layout/privacy-overlay';
import {
  TooltipProvider,
  TOOLTIP_OPEN_DELAY_MS,
  TOOLTIP_SKIP_DELAY_MS,
} from './components/ui/tooltip';
import { api } from './ipc/api-client';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { SpeedTestOutcome } from '../shared/speed-test';
import i18n, { initialLanguageChoice } from './i18n';

function App() {
  const currentView = useAppStore((state) => state.currentView);
  const setCurrentView = useAppStore((state) => state.setCurrentView);
  const settingsSection = useAppStore((state) => state.settingsSection);
  const setSettingsSection = useAppStore((state) => state.setSettingsSection);
  const loadConfig = useAppStore((state) => state.loadConfig);
  const config = useAppStore((state) => state.config);
  const saveConfig = useAppStore((state) => state.saveConfig);
  const refreshConnectionStatus = useAppStore((state) => state.refreshConnectionStatus);
  const setPrivacyMode = useAppStore((state) => state.setPrivacyMode);
  const nodeSortByLatency = useNodeSortStore((state) => state.sortByLatency);

  // 主进程 mount 健康门就绪信号（GAP-1a，最先注册的 effect）：App 成功 render+commit 后发一次。若 App 函数体/
  // provider 在 render 前抛错，此 effect 永不触发 → 主进程 RENDERER_READY_TIMEOUT_MS 超时兜底（reload→静态错误页）。
  // 这是唯一能从主进程侧侦测「renderer 进程活着但 DOM 空（模块级 import 死 / render 抛错）」的手段——该故障不发
  // 任何主进程事件。用 preload 暴露的 invoke 单向发送（fire-and-forget，主进程 webContents.ipc.handle 收，忽略返回）；
  // window.electron 缺省（浏览器预览）时可选链短路，不报错。
  useEffect(() => {
    window.electron?.ipcRenderer?.invoke(IPC_CHANNELS.RENDERER_READY).catch(() => {});
  }, []);

  // 语言真值源迁移（存量）：旧配置无 config.language，i18n 已从旧 localStorage 解析出 initialLanguageChoice 显示，
  // 此处把它一次性回填进 config，使主进程下次启动能直接读到用户语言（否则主进程只会用系统语言兜底托盘/通知）。
  // 幂等：config.language 有值即 no-op；回填后 config 更新、守卫即止。新装 config.language 默认 'auto'，天然跳过。
  useEffect(() => {
    if (config && !config.language) {
      saveConfig({ ...config, language: initialLanguageChoice }).catch(console.error);
    }
  }, [config, saveConfig]);

  // 离开设置页重置子节的逻辑已下沉到 store.setCurrentView，此处直接用 setCurrentView

  useNativeEventListeners();

  // 同步「节点列表按延迟排序」开关到主进程：mount 时把 localStorage 持久值推给托盘（cold-start 同序），
  // 之后每次开关切换 nodeSortByLatency 变化即重推（托盘 setSortByLatency 幂等）。
  useEffect(() => {
    api.config.setNodeSortByLatency(nodeSortByLatency).catch(console.error);
  }, [nodeSortByLatency]);

  useEffect(() => {
    loadConfig();
    refreshConnectionStatus();
    // Tailscale 真实登录态由 sing-box 1.14 api STATUS 流（EVENT_TAILSCALE_STATUS，随主核起停推送）驱动，
    // 此处无需主动拉取。
    // 语言不再在此推送给主进程：主进程直接读 config.language 单一真值源（见上方迁移 effect + config-change 热同步）。

    const statusInterval = setInterval(() => {
      refreshConnectionStatus();
    }, 2000);

    return () => clearInterval(statusInterval);
  }, [loadConfig, refreshConnectionStatus]);

  useEffect(() => {
    const routeMap: Record<string, string> = {
      '/settings': 'settings',
      '/home': 'home',
      '/logs': 'logs',
      '/connections': 'connections',
      '/server': 'server',
      '/appPolicy': 'appPolicy',
      '/ruleResources': 'ruleResources',
      '/rules': 'rules',
    };

    const unsubscribe = ipcClient.on<string>(IPC_CHANNELS.EVENT_NAVIGATE, (route) => {
      // #256 关窗保活后，托盘再开窗是「隐藏→show」而非重建：Chromium 恢复隐藏前的焦点元素，且此路径
      // 命中 :focus-visible（键盘 ring 刻意保留，见 index.css .sidebar-toggle 注释）→ 折叠 toggle/导航项
      // 复现 #203 的「点亮」。托盘导航必然是新的鼠标语境 → 清掉恢复的焦点（落回 body，Tab 键可达性不受损）。
      (document.activeElement as HTMLElement | null)?.blur?.();
      const view = routeMap[route];
      if (view) {
        setCurrentView(view);
      }
    });

    return () => unsubscribe();
  }, [setCurrentView]);

  useEffect(() => {
    const unsubscribe = ipcClient.on<{
      outcome: SpeedTestOutcome;
      items: Array<{ name: string; protocol: string; latency: number | null }>;
      skipped?: number;
    }>(IPC_CHANNELS.EVENT_SPEED_TEST_RESULT_LIST, (payload) => {
      // 延迟明细已在各节点卡 ⚡ 徽标显示；此处只报完成/中断 + 一行摘要（节点数 + 最快），不再 dump 全列表压垮注意力。
      // items 已按延迟升序（TrayManager），首个非 null 即最快可测节点。
      const items = payload.items;
      const fastest = items.find((r) => r.latency !== null);
      let description = fastest
        ? i18n.t('home.speedTestSummary', {
            count: items.length,
            name: fastest.name,
            ms: fastest.latency,
          })
        : i18n.t('home.speedTestNoResult', { count: items.length });
      // §16 Layer2：波前缺席节点数副行（not-in-pool/未登录 TS）——追加到摘要，与页面聚合 toast 口径一致。
      if (payload.skipped && payload.skipped > 0) {
        description += ` · ${i18n.t('servers.speedTestSkippedSummary', {
          count: payload.skipped,
          defaultValue: '{{count}} 个节点待入池（重启内核后可测）',
        })}`;
      }

      // §16.2：interrupted（核 stop/restart/regen 打断，已测保留、未测原值）→ warning「测速中断」；否则 success「测速完成」。
      if (payload.outcome === 'interrupted') {
        toast.warning(i18n.t('home.speedTestInterrupted', { defaultValue: '测速中断' }), {
          description,
        });
      } else {
        toast.success(i18n.t('home.speedTestDone'), { description });
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const unsubscribeEnter = ipcClient.on(IPC_CHANNELS.EVENT_ENTER_PRIVACY_MODE, () => {
      setPrivacyMode(true);
    });
    const unsubscribeExit = ipcClient.on(IPC_CHANNELS.EVENT_EXIT_PRIVACY_MODE, () => {
      setPrivacyMode(false);
    });
    return () => {
      unsubscribeEnter();
      unsubscribeExit();
    };
  }, [setPrivacyMode]);

  return (
    <ErrorBoundary>
      <TooltipProvider
        delayDuration={TOOLTIP_OPEN_DELAY_MS}
        skipDelayDuration={TOOLTIP_SKIP_DELAY_MS}
      >
        <PrivacyOverlay />
        <MainLayout
        currentView={currentView}
        onViewChange={setCurrentView}
        settingsSection={settingsSection}
        onSettingsSectionChange={setSettingsSection}
      >
        {currentView === 'home' && <HomePage />}
        {currentView === 'logs' && <LogsPage />}
        {currentView === 'connections' && <ConnectionsPage />}
        {currentView === 'server' && <ServerPage />}
        {currentView === 'appPolicy' && <AppPolicyPage />}
        {currentView === 'ruleResources' && <RuleResourcesPage />}
        {currentView === 'rules' && <RulesPage />}
        {currentView === 'settings' && <SettingsPage activeSection={settingsSection} />}
        </MainLayout>
        <Toaster position="top-right" closeButton visibleToasts={4} />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

export default App;
