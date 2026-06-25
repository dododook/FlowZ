import { useState } from 'react';
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
import i18n from '@/i18n';
import { useTranslation } from 'react-i18next';
import { api } from '@/ipc';
import { SettingsRow } from './settings-row';
import {
  AUTO_LANGUAGE,
  SUPPORTED_LANGUAGES,
  migrateLanguageCode,
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
  // 语言「选择」（auto 或具体码），驱动下拉显示；与 i18n.language（解析后的实际语言）区分。默认 auto。
  const [langChoice, setLangChoice] = useState<string>(
    () => migrateLanguageCode(localStorage.getItem('app-language')) ?? AUTO_LANGUAGE
  );

  const handleThemeChange = (value: string) => {
    setTheme(value as 'light' | 'dark' | 'system');
    toast.success(t('settings.appearance.themeUpdated'));
  };

  const handleLanguageChange = (choice: string) => {
    // 选 auto → 按系统偏好解析出实际语言；选具体码 → 即该码。i18n 与 main 都用「实际语言」（main 托盘/对话框
    // 用 startsWith('zh') 判断，不能收到 'auto'）；localStorage 存「选择」（auto/具体）供下拉回显。
    const effective = resolveEffectiveLanguage(choice, getSystemLanguages());
    setLangChoice(choice);
    localStorage.setItem('app-language', choice);
    i18n.changeLanguage(effective);
    api.config.setLanguage(effective).catch(console.error);
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
