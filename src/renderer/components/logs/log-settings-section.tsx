import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppStore } from '@/store/app-store';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { SettingsRow } from '../settings/settings-row';

/**
 * 日志设置（级别 + 关闭写盘）。从「高级」节迁入日志页（排障归一 C1/H2/M4）。
 * 返回 SettingsRow 片段，由日志页的折叠容器承载。
 */
export function LogSettingsSection() {
  const config = useAppStore((s) => s.config);
  const saveConfig = useAppStore((s) => s.saveConfig);
  const { t } = useTranslation();
  if (!config) return null;

  return (
    <>
      <SettingsRow
        label={t('settings.advanced.logLevel')}
        description={
          config.diagnosticCapture
            ? t('settings.advanced.logLevelCaptureLocked')
            : t('settings.advanced.logLevelDesc')
        }
      >
        {/* 诊断采集中级别锁定为 debug：禁用以免手动改被采集结束的快照还原静默覆盖（见诊断区）。 */}
        <Select
          value={config.logLevel || 'info'}
          disabled={!!config.diagnosticCapture}
          onValueChange={(v) =>
            saveConfig({ ...config, logLevel: v as typeof config.logLevel }).catch(() =>
              toast.error(t('common.saveFailed'))
            )
          }
        >
          <SelectTrigger className="h-8 w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="debug">debug</SelectItem>
            <SelectItem value="info">info</SelectItem>
            <SelectItem value="warn">warn</SelectItem>
            <SelectItem value="error">error</SelectItem>
            <SelectItem value="fatal">fatal</SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow
        label={t('settings.advanced.disableLogFile')}
        description={t('settings.advanced.disableLogFileDesc')}
      >
        <Switch
          checked={config.disableLogFile === true}
          onCheckedChange={(c) =>
            saveConfig({ ...config, disableLogFile: c }).catch(() =>
              toast.error(t('common.saveFailed'))
            )
          }
        />
      </SettingsRow>
    </>
  );
}
