import { useAppStore } from '@/store/app-store';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * 日志设置（级别 + 关闭写盘）。从「高级」节迁入日志页（排障归一 C1/H2/M4）。
 * Conduit `.ld-grid`：两列 `.field`（级别 `.select` + 写盘 `.swt-row`），由日志页「日志与诊断」折叠卡承载。
 * 逻辑全保留：级别读写 saveConfig、诊断采集中级别锁定禁用、写盘开关（disableLogFile 语义不变）。
 */
export function LogSettingsSection() {
  const config = useAppStore((s) => s.config);
  const saveConfig = useAppStore((s) => s.saveConfig);
  const { t } = useTranslation();
  if (!config) return null;

  const level = config.logLevel || 'info';
  // 诊断采集中级别锁定为 debug：禁用 select 以免手动改被采集结束的快照还原静默覆盖（见诊断区）。
  const captureLocked = !!config.diagnosticCapture;
  const disableLogFile = config.disableLogFile === true;

  return (
    <div className="ld-grid">
      <div className="field">
        {/* full 说明保留在原生 title（对齐旧 InfoTooltip 的 …DescFull key，无 ⓘ 图标以贴合原型） */}
        <div className="field-lbl" title={t('settings.advanced.logLevelDescFull') as string}>
          {t('settings.advanced.logLevel')}
          <small>
            {captureLocked
              ? t('settings.advanced.logLevelCaptureLocked')
              : t('settings.advanced.logLevelDesc')}
          </small>
        </div>
        <div className="select">
          <select
            className="select-el"
            aria-label={t('settings.advanced.logLevel') as string}
            value={level}
            disabled={captureLocked}
            onChange={(e) =>
              saveConfig({
                ...config,
                logLevel: e.target.value as typeof config.logLevel,
              }).catch(() => toast.error(t('common.saveFailed')))
            }
          >
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
            <option value="fatal">fatal</option>
          </select>
          <svg
            className="select-chev"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>

      <div className="field">
        <div className="field-lbl" title={t('settings.advanced.disableLogFileDescFull') as string}>
          {t('settings.advanced.disableLogFile')}
          <small>{t('settings.advanced.disableLogFileDesc')}</small>
        </div>
        {/* .swt-row：开关语义与旧 Switch 一致（on = disableLogFile 真 = 关闭写盘）。 */}
        <label className="swt-row">
          <span className="mono">flowz.log</span>
          <button
            type="button"
            role="switch"
            aria-checked={disableLogFile}
            aria-label={t('settings.advanced.disableLogFile') as string}
            className={cn('swt', disableLogFile && 'on')}
            onClick={() =>
              saveConfig({ ...config, disableLogFile: !disableLogFile }).catch(() =>
                toast.error(t('common.saveFailed'))
              )
            }
          />
        </label>
      </div>
    </div>
  );
}
