import {
  GeneralSettings,
  AppearanceSettings,
  AdvancedSettings,
  AboutSettings,
  NetworkSettings,
} from '@/components/settings';
import { ErrorBoundary } from '@/components/error-boundary';
import { useTranslation } from 'react-i18next';

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
    defaultDesc: '应用程序启动和行为设置',
  },
  network: {
    titleKey: 'settings.network.title',
    defaultTitle: '网络',
    descKey: 'settings.network.description',
    defaultDesc: 'DNS、端口、连接与订阅更新',
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
    defaultDesc: '高级网络和系统配置',
  },
  about: {
    titleKey: 'settings.about.title',
    defaultTitle: '关于',
    descKey: 'settings.about.description',
    defaultDesc: '版本信息和更新',
  },
};

export function SettingsPage({ activeSection }: SettingsPageProps) {
  const { t } = useTranslation();
  const meta = sectionTitles[activeSection] ?? sectionTitles.general;

  return (
    // 流式满宽：内容随窗口拖动自适应充满内容区（仅受全局 main 容器 max-w-[1400px] 约束），与规则/节点等其它页一致；
    // 不再限 max-w-2xl(672)——固定窄列会在宽窗右侧留白（用户反馈：自适应充满比留白更美观）。
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">{t(meta.titleKey, meta.defaultTitle)}</h2>
        <p className="text-muted-foreground mt-1">{t(meta.descKey, meta.defaultDesc)}</p>
      </div>

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
