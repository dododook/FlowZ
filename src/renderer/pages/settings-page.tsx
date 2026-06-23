import {
  GeneralSettings,
  AppearanceSettings,
  AdvancedSettings,
  AboutSettings,
  NetworkSettings,
} from '@/components/settings';
import { ErrorBoundary } from '@/components/error-boundary';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/page-header';

interface SettingsPageProps {
  activeSection: string;
}

const sectionTitles: Record<
  string,
  { titleKey: string; defaultTitle: string; descKey: string; defaultDesc: string }
> = {
  general: {
    titleKey: 'settings.general.title',
    defaultTitle: '常规',
    descKey: 'settings.general.description',
    defaultDesc: '应用启动、行为与隐私',
  },
  network: {
    titleKey: 'settings.network.title',
    defaultTitle: '网络',
    descKey: 'settings.network.description',
    defaultDesc: 'DNS、端口、流量、测速与订阅更新',
  },
  appearance: {
    titleKey: 'settings.appearance.title',
    defaultTitle: '外观',
    descKey: 'settings.appearance.description',
    defaultDesc: '自定义应用程序的外观',
  },
  advanced: {
    titleKey: 'settings.advanced.title',
    defaultTitle: '高级',
    descKey: 'settings.advanced.description',
    defaultDesc: '数据备份与系统运维',
  },
  about: {
    titleKey: 'settings.about.title',
    defaultTitle: '关于',
    descKey: 'settings.about.description',
    defaultDesc: '版本信息与社区',
  },
};

export function SettingsPage({ activeSection }: SettingsPageProps) {
  const { t } = useTranslation();
  const meta = sectionTitles[activeSection] ?? sectionTitles.general;

  return (
    // 设置/表单页：居中窄列（max-w-[720px] mx-auto）。表单控件定宽，满宽会让「标签左·控件右」中间空一大条；
    // 居中窄列让控件填满列、两侧对称留白（macOS 系统设置 / Win11 Fluent 同款，刻意整洁）。
    // 密集列表页（规则/节点/连接）仍满宽，分而治之。
    <div className="mx-auto max-w-[720px] space-y-6">
      <PageHeader
        title={t(meta.titleKey, meta.defaultTitle)}
        description={t(meta.descKey, meta.defaultDesc)}
      />

      <div>
        <ErrorBoundary>
          {activeSection === 'general' && <GeneralSettings />}
          {activeSection === 'network' && <NetworkSettings />}
          {activeSection === 'appearance' && <AppearanceSettings />}
          {activeSection === 'advanced' && <AdvancedSettings />}
          {activeSection === 'about' && <AboutSettings />}
        </ErrorBoundary>
      </div>
    </div>
  );
}
