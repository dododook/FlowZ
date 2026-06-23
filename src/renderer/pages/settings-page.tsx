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
    // 设置页满宽跟随窗口（用户选定：自动缩放、不居中留白）。跟随 main-layout container(max-w-1400)：
    // 窗口 < 1400 铺满、> 1400 由 container 统一居中。SettingsRow「标签左·控件右」在宽窗口会拉开，
    // 是用户知情的取舍（换取大屏不浪费空间）；与密集列表页（规则/节点/连接）满宽行为一致。
    <div className="space-y-6">
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
