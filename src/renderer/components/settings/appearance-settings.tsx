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

// 语言列表：每项以「母语自名」展示，便于使用者识别（不随界面语言翻译）。
// 新增语言时在此追加一项，并在 src/renderer/i18n/index.ts 注册对应 resources。
const LANGUAGE_OPTIONS = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en-US', label: 'English' },
  { value: 'ru', label: 'Русский' },
  { value: 'fa-IR', label: 'فارسی' },
];

export function AppearanceSettings() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();

  const handleThemeChange = (value: string) => {
    setTheme(value as 'light' | 'dark' | 'system');
    toast.success(t('settings.appearance.themeUpdated'));
  };

  const handleLanguageChange = (value: string) => {
    i18n.changeLanguage(value);
    localStorage.setItem('app-language', value);
    api.config.setLanguage(value).catch(console.error);
    toast.success(t('settings.appearance.languageUpdated'));
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
              { value: 'light', label: t('settings.appearance.light') },
              { value: 'dark', label: t('settings.appearance.dark') },
              { value: 'system', label: t('settings.appearance.system') },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t('settings.appearance.language')} stacked>
          <Select value={i18n.language} onValueChange={handleLanguageChange}>
            <SelectTrigger className="max-w-xs">
              <SelectValue />
            </SelectTrigger>
            {/* 固定 max-h-96：避免 radix popper 按可用高度算 max-h 造成顶部项命中死区 */}
            <SelectContent className="max-h-96">
              {LANGUAGE_OPTIONS.map((opt) => (
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
