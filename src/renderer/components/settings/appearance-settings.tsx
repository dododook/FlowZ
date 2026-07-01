import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTheme } from '@/components/theme-provider';
import { toast } from 'sonner';
import i18n, { initialLanguageChoice } from '@/i18n';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { SettingsRow } from './settings-row';
import {
  AUTO_LANGUAGE,
  SUPPORTED_LANGUAGES,
  resolveEffectiveLanguage,
} from '../../../shared/language';

// 各语言「母语自名」（不随界面语言翻译，便于使用者识别）。新增语言时在此与 i18n resources 同步追加。
const NATIVE_NAMES: Record<string, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  'en-US': 'English',
  ru: 'Русский',
  fa: 'فارسی',
};

// 实际语言按各自母语名排序（auto 另置首位、不参与排序）。
const REAL_LANGUAGE_OPTIONS = SUPPORTED_LANGUAGES.map((v) => ({
  value: v,
  label: NATIVE_NAMES[v],
})).sort((a, b) => a.label.localeCompare(b.label));

/** main→preload 经 additionalArguments 注入的 OS 偏好语言（auto 解析用）。 */
function getSystemLanguages(): string[] {
  const sl = (window as unknown as { electron?: { systemLanguages?: string[] } }).electron
    ?.systemLanguages;
  return Array.isArray(sl) ? sl : [];
}

export function AppearanceSettings() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const config = useAppStore((state) => state.config);
  const saveConfig = useAppStore((state) => state.saveConfig);
  // 语言「选择」（auto 或具体码），驱动下拉显示；真值源 = config.language。本地 state 作乐观回显（saveConfig
  // 非乐观、落盘后才回写 store，无本地 state 会出现下拉短暂停在旧值）。初值取注入/迁移得到的 initialLanguageChoice，
  // config 加载/外部变更后由下方 effect 同步。
  const [langChoice, setLangChoice] = useState<string>(initialLanguageChoice);

  useEffect(() => {
    if (config?.language) setLangChoice(config.language);
  }, [config?.language]);

  const handleThemeChange = (value: string) => {
    setTheme(value as 'light' | 'dark' | 'system');
    toast.success(t('settings.appearance.themeUpdated'));
  };

  const handleLanguageChange = (choice: string) => {
    if (!config) return;
    // 选 auto → 按系统偏好解析出实际语言；选具体码 → 即该码。i18n 用「实际语言」即时切界面；config.language 存
    // 「选择」（auto/具体）作单一真值源——主进程据此定托盘/通知语言（经 config-change 热同步），不再收 IPC 推送。
    const effective = resolveEffectiveLanguage(choice, getSystemLanguages());
    setLangChoice(choice); // 乐观回显
    i18n.changeLanguage(effective);
    saveConfig({ ...config, language: choice }).catch(console.error);
    // 用切换后的【实际语言码】强制解析提示文案（lng 是 i18next 保留选项=强制解析语言，必须是语言码而非显示名；
    // languageUpdated 各 locale 是自描述的「已切换为X」，故提示恒以目标语言显示）。
    toast.success(t('settings.appearance.languageUpdated', { lng: effective }));
  };

  return (
    <Card>
      <CardContent className="divide-y divide-border/60 pt-2">
        <SettingsRow label={t('settings.appearance.theme')} stacked>
          <SegmentedControl
            className="max-w-xs"
            value={theme}
            onChange={handleThemeChange}
            options={[
              // 跟随系统排首位：它是默认值（uiTheme 默认 'system'），默认项置首更符合预期。
              { value: 'system', label: t('settings.appearance.system') },
              { value: 'light', label: t('settings.appearance.light') },
              { value: 'dark', label: t('settings.appearance.dark') },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t('settings.appearance.language')} stacked>
          <Select value={langChoice} onValueChange={handleLanguageChange}>
            <SelectTrigger className="max-w-xs">
              <SelectValue />
            </SelectTrigger>
            {/* 固定 max-h-96：避免 radix popper 按可用高度算 max-h 造成顶部项命中死区 */}
            <SelectContent className="max-h-96">
              {/* 自动（跟随系统）置首位且为默认 */}
              <SelectItem value={AUTO_LANGUAGE}>{t('settings.appearance.languageAuto')}</SelectItem>
              {REAL_LANGUAGE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </CardContent>
    </Card>
  );
}
