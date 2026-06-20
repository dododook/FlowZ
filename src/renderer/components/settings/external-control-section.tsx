import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store/app-store';
import { controlApiPort } from '@shared/proxy-ports';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { SettingsRow } from './settings-row';

/**
 * 外部控制（clash API）：地址 + secret 展示/复制/重置。
 * 从「高级」节迁入「网络」节，与控制端口(controlApiPort)同节就近（M2：同一对象不再被拆两节）。
 * 父级包 `<Card><CardContent className="divide-y...">` 渲染本组件返回的 SettingsRow 片段。
 */
export function ExternalControlSection() {
  const config = useAppStore((s) => s.config);
  const saveConfig = useAppStore((s) => s.saveConfig);
  const { t } = useTranslation();
  const [showClashSecret, setShowClashSecret] = useState(false);

  // 重置 clash_api secret：浏览器侧随机 16 字节 hex，保存后重启代理生效。
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
  const clashApiAddr = `127.0.0.1:${controlApiPort(config)}`;

  return (
    <>
      <SettingsRow heading label={t('settings.advanced.externalControl')} />
      <SettingsRow
        label={t('settings.advanced.clashApiAddress')}
        description={t('settings.advanced.externalControlDesc')}
        tooltip={t('settings.advanced.externalControlDescFull')}
        stacked
      >
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
      </SettingsRow>
      <SettingsRow
        label={t('settings.advanced.clashApiSecret')}
        description={t('settings.advanced.clashApiSecretDesc')}
        tooltip={t('settings.advanced.clashApiSecretDescFull')}
        stacked
      >
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
      </SettingsRow>
    </>
  );
}
