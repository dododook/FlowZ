import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppStore } from '@/store/app-store';
import { controlApiPort } from '@shared/proxy-ports';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { SettingsRow } from './settings-row';
import { TerminalProxySection } from './terminal-proxy-section';
import { BackupRestoreSection } from './backup-restore-section';
import { DiagnosticSection } from './diagnostic-section';

/**
 * 设置「高级」节：外部控制(clash API) / 日志 / 内核更新策略 / 终端代理速查(折叠) / 备份恢复。
 * DNS/端口/连接/订阅已拆到「网络」节。
 */
export function AdvancedSettings() {
  const config = useAppStore((state) => state.config);
  const saveConfig = useAppStore((state) => state.saveConfig);
  const { t } = useTranslation();
  const [showClashSecret, setShowClashSecret] = useState(false);

  // 重置 clash_api secret：浏览器侧随机 16 字节 hex，保存后重启代理生效
  const resetClashSecret = () => {
    if (!config) return;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const secret = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    saveConfig({ ...config, clashApiSecret: secret })
      .then(() => toast.success(t('settings.advanced.clashSecretReset')))
      .catch(() => toast.error(t('common.saveFailed')));
  };

  if (!config) return null;

  // mixed-only：HTTP 与 SOCKS 同口（mixed inbound）。
  const localPort = (config.mixedPort || config.httpPort || 7890).toString();
  const httpPort = localPort;
  const socksPort = localPort;
  // clash_api 控制端口（默认 9090，可在「网络」节改 controlPort）。展示与复制随之动态。
  const clashApiAddr = `127.0.0.1:${controlApiPort(config)}`;

  return (
    <div className="space-y-6">
      {/* 外部控制 / clash API */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div>
            <h4 className="text-sm font-medium">{t('settings.advanced.externalControl')}</h4>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings.advanced.externalControlDesc')}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="font-normal">{t('settings.advanced.clashApiAddress')}</Label>
            <div className="flex items-center gap-2">
              <code className="rounded bg-muted px-2 py-1 font-mono text-xs">{clashApiAddr}</code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(clashApiAddr);
                  toast.success(t('settings.advanced.copied'));
                }}
              >
                {t('settings.advanced.copy')}
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="font-normal">{t('settings.advanced.clashApiSecret')}</Label>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-[160px] max-w-md flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                {showClashSecret ? config.clashApiSecret || '—' : '•'.repeat(16)}
              </code>
              <Button variant="outline" size="sm" onClick={() => setShowClashSecret((v) => !v)}>
                {showClashSecret ? t('settings.advanced.hide') : t('settings.advanced.show')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(config.clashApiSecret || '');
                  toast.success(t('settings.advanced.copied'));
                }}
              >
                {t('settings.advanced.copy')}
              </Button>
              <Button variant="outline" size="sm" onClick={resetClashSecret}>
                {t('settings.advanced.reset')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('settings.advanced.clashApiSecretDesc')}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 日志（内核更新策略已迁至「内核管理」卡片，见 core-management-card） */}
      <Card>
        <CardContent className="divide-y divide-border/60 pt-2">
          <SettingsRow heading label={t('settings.network.logs', '日志')} />
          <SettingsRow
            label={t('settings.advanced.logLevel')}
            description={
              config.diagnosticCapture
                ? t('settings.advanced.logLevelCaptureLocked')
                : t('settings.advanced.logLevelDesc')
            }
          >
            {/* 诊断采集中级别锁定为 debug：禁用以免手动改被采集结束时的快照还原静默覆盖（见诊断卡片）。 */}
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
        </CardContent>
      </Card>

      {/* 诊断（导出脱敏报告 + 诊断采集临时提级） */}
      <Card>
        <CardContent className="pt-6">
          <DiagnosticSection />
        </CardContent>
      </Card>

      {/* 终端代理速查表（默认折叠） */}
      <Card>
        <CardContent className="pt-6">
          <TerminalProxySection httpPort={httpPort} socksPort={socksPort} />
        </CardContent>
      </Card>

      {/* 数据备份与恢复 */}
      <Card>
        <CardContent className="pt-6">
          <BackupRestoreSection />
        </CardContent>
      </Card>
    </div>
  );
}
