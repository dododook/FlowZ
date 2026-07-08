import {
  GeneralSettings,
  AppearanceSettings,
  AdvancedSettings,
  AboutSettings,
  NetworkSettings,
} from '@/components/settings';
import { ErrorBoundary } from '@/components/error-boundary';

interface SettingsPageProps {
  activeSection: string;
}

/**
 * 设置页外壳：按 activeSection 渲染对应面板（Conduit .set-panel）。
 * 与原型一致：设置区不设 .page-h 标题头——当前小节由侧栏 settings-mode 子导航（Phase 2）高亮指示，
 * 主区域直接呈现面板卡片，避免与侧栏重复。满宽跟随 main-layout container(max-w-1400)。
 */
export function SettingsPage({ activeSection }: SettingsPageProps) {
  return (
    <div data-page="settings">
      <ErrorBoundary>
        {activeSection === 'general' && <GeneralSettings />}
        {activeSection === 'network' && <NetworkSettings />}
        {activeSection === 'appearance' && <AppearanceSettings />}
        {activeSection === 'advanced' && <AdvancedSettings />}
        {activeSection === 'about' && <AboutSettings />}
      </ErrorBoundary>
    </div>
  );
}
