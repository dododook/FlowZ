import { useEffect } from 'react';
import { MainLayout } from './components/layout/main-layout';
import { useAppStore } from './store/app-store';
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
import i18n from './i18n';

function App() {
  const currentView = useAppStore((state) => state.currentView);
  const setCurrentView = useAppStore((state) => state.setCurrentView);
  const settingsSection = useAppStore((state) => state.settingsSection);
  const setSettingsSection = useAppStore((state) => state.setSettingsSection);
  const loadConfig = useAppStore((state) => state.loadConfig);
  const refreshConnectionStatus = useAppStore((state) => state.refreshConnectionStatus);
  const refreshTailscaleLoginStates = useAppStore((state) => state.refreshTailscaleLoginStates);
  const setPrivacyMode = useAppStore((state) => state.setPrivacyMode);

  // 离开设置页重置子节的逻辑已下沉到 store.setCurrentView，此处直接用 setCurrentView

  // Listen to native events
  useNativeEventListeners();

  // Load initial data
  useEffect(() => {
    loadConfig();
    refreshConnectionStatus();
    // Tailscale 真实登录态：挂载时刷新一次（驱动「需登录」角标，交互登录成功事件后再刷新对齐）。
    refreshTailscaleLoginStates();

    // Sync initial language to main process for tray menu
    api.config.setLanguage(i18n.language).catch(console.error);

    // Poll connection status every 2 seconds
    const statusInterval = setInterval(() => {
      refreshConnectionStatus();
    }, 2000);

    return () => clearInterval(statusInterval);
  }, [loadConfig, refreshConnectionStatus, refreshTailscaleLoginStates]);

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

    const unsubscribe = ipcClient.on<string>('navigate', (route) => {
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
    >('speedTestResult', (results) => {
      const message = results
        .map((r) =>
          r.latency !== null
            ? `${r.name}（${r.protocol}）: ${r.latency}ms`
            : `${r.name}（${r.protocol}）: ${i18n.t('servers.timeout')}`
        )
        .join('\n');

      toast.info(i18n.t('home.speedTestResult'), {
        description: message,
        duration: 10000,
        style: { whiteSpace: 'pre-line' },
      });
    });

    return () => unsubscribe();
  }, []);

  // Listen to privacy mode trigger from main process idle timer
  useEffect(() => {
    const unsubscribeEnter = ipcClient.on('event:enterPrivacyMode', () => {
      setPrivacyMode(true);
    });
    const unsubscribeExit = ipcClient.on('event:exitPrivacyMode', () => {
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
