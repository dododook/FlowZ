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
import { api } from './ipc/api-client';
import { IPC_CHANNELS } from '../shared/ipc-channels';
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

  // 语言真值源迁移（存量）：旧配置无 config.language，i18n 已从旧 localStorage 解析出 initialLanguageChoice 显示，
  // 此处把它一次性回填进 config，使主进程下次启动能直接读到用户语言（否则主进程只会用系统语言兜底托盘/通知）。
  // 幂等：config.language 有值即 no-op；回填后 config 更新、守卫即止。新装 config.language 默认 'auto'，天然跳过。
  useEffect(() => {
    if (config && !config.language) {
      saveConfig({ ...config, language: initialLanguageChoice }).catch(console.error);
    }
  }, [config, saveConfig]);

  // 离开设置页重置子节的逻辑已下沉到 store.setCurrentView，此处直接用 setCurrentView

  // Listen to native events
  useNativeEventListeners();

  // 同步「节点列表按延迟排序」开关到主进程：mount 时把 localStorage 持久值推给托盘（cold-start 同序），
  // 之后每次开关切换 nodeSortByLatency 变化即重推（托盘 setSortByLatency 幂等）。
  useEffect(() => {
    api.config.setNodeSortByLatency(nodeSortByLatency).catch(console.error);
  }, [nodeSortByLatency]);

  // Load initial data
  useEffect(() => {
    loadConfig();
    refreshConnectionStatus();
    // Tailscale 真实登录态由 sing-box 1.14 api STATUS 流（EVENT_TAILSCALE_STATUS，随主核起停推送）驱动，
    // 此处无需主动拉取。
    // 语言不再在此推送给主进程：主进程直接读 config.language 单一真值源（见上方迁移 effect + config-change 热同步）。

    // Poll connection status every 2 seconds
    const statusInterval = setInterval(() => {
      refreshConnectionStatus();
    }, 2000);

    return () => clearInterval(statusInterval);
  }, [loadConfig, refreshConnectionStatus]);

  // Listen to navigate events from main process (tray menu)
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
      const view = routeMap[route];
      if (view) {
        setCurrentView(view);
      }
    });

    return () => unsubscribe();
  }, [setCurrentView]);

  // Listen to speed test results
  useEffect(() => {
    const unsubscribe = ipcClient.on<
      Array<{ name: string; protocol: string; latency: number | null }>
    >(IPC_CHANNELS.EVENT_SPEED_TEST_RESULT_LIST, (results) => {
      // 延迟明细已在各节点卡 ⚡ 徽标显示；此处只报完成 + 一行摘要（节点数 + 最快），不再 dump 全列表压垮注意力。
      // resultList 已按延迟升序（TrayManager），首个非 null 即最快可测节点。
      const fastest = results.find((r) => r.latency !== null);
      const description = fastest
        ? i18n.t('home.speedTestSummary', {
            count: results.length,
            name: fastest.name,
            ms: fastest.latency,
          })
        : i18n.t('home.speedTestNoResult', { count: results.length });

      toast.success(i18n.t('home.speedTestDone'), { description });
    });

    return () => unsubscribe();
  }, []);

  // Listen to privacy mode trigger from main process idle timer
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
      <Toaster position="top-right" closeButton />
    </ErrorBoundary>
  );
}

export default App;
