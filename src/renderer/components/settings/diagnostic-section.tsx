import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Stethoscope, FileDown, Activity, Square } from 'lucide-react';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc/api-client';

/**
 * 诊断节（[[issue-diagnostics-and-support]] P0 + 诊断采集）。渲染于「日志」页的「日志与诊断」折叠节
 * （logs-page.tsx，2026-06 从「设置·高级」迁入；用户路径＝主页 → 日志 → 诊断），文件名/import 路径仍在 settings/ 下未迁。
 * - 导出诊断报告：始终可用，汇集环境/脱敏配置/日志 tail 成单 Markdown。
 * - 诊断采集：临时把 logLevel 拉到 debug 复现问题（快照原级别，结束/重启还原），与导出形成「采集→复现→导出」闭环。
 * 二者关系：导出取已发生的；采集让下次复现记录更详细。还原到采集前快照级别，绝不硬编码。
 */
export function DiagnosticSection() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const saveConfig = useAppStore((s) => s.saveConfig);
  const [isExporting, setIsExporting] = useState(false);
  const [isToggling, setIsToggling] = useState(false);

  if (!config) return null;

  const captureActive = !!config.diagnosticCapture;

  // 注：改变 logLevel 后无需在此显式重启代理——saveConfig 经主进程 CONFIG_CHANGED 监听自动
  //   switchMode(latestConfig) 重启（logLevel 变更属非切节点改动→全量重启），sing-box 核心据此拾取新级别。
  //   代理未运行则不重启，级别随下次启动生效。显式 restart 反而会与之竞态/双重重启。

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const result = await api.diagnostic.export();
      if (result.success) {
        toast.success(t('settings.advanced.diagnostics.exportSuccess'), {
          description: t('settings.advanced.diagnostics.exportSuccessDesc', {
            path: result.filePath,
          }),
        });
      } else if (result.error !== 'cancelled') {
        toast.error(t('settings.advanced.diagnostics.exportFail'), { description: result.error });
      }
    } catch (err: any) {
      toast.error(t('settings.advanced.diagnostics.exportFail'), { description: err?.message });
    } finally {
      setIsExporting(false);
    }
  };

  const handleStartCapture = async () => {
    // 静默失效护栏：debug 采集依赖日志写盘 + 非隐私级别，否则「采集了却没数据」。两者均先拒绝并提示。
    if (config.disableLogFile) {
      toast.error(t('settings.advanced.diagnostics.captureLogFileDisabled'));
      return;
    }
    // 隐私模式会把有效级别抬到 ≥warn → debug 采集失效；先要求关闭。
    const privacy = await api.config.getPrivacyMode().catch(() => false);
    if (privacy) {
      toast.error(t('settings.advanced.diagnostics.capturePrivacyBlocked'));
      return;
    }
    setIsToggling(true);
    try {
      // 仅落盘配置：主进程 CONFIG_CHANGED 监听自动应用 debug 级别（运行中则重启核心生效）。
      await saveConfig({
        ...config,
        logLevel: 'debug',
        diagnosticCapture: { prevLogLevel: config.logLevel },
      });
      toast.success(t('settings.advanced.diagnostics.captureStarted'), {
        description: t('settings.advanced.diagnostics.captureStartedDesc'),
      });
    } catch (err: any) {
      toast.error(t('common.saveFailed'), { description: err?.message });
    } finally {
      setIsToggling(false);
    }
  };

  const handleStopCapture = async () => {
    setIsToggling(true);
    try {
      const prev = config.diagnosticCapture?.prevLogLevel ?? 'info';
      await saveConfig({ ...config, logLevel: prev, diagnosticCapture: undefined });
      toast.success(t('settings.advanced.diagnostics.captureStopped', { level: prev }));
    } catch (err: any) {
      toast.error(t('common.saveFailed'), { description: err?.message });
    } finally {
      setIsToggling(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div className="field-lbl">
          <Stethoscope className="h-3.5 w-3.5" />
          {t('settings.advanced.diagnostics.title')}
        </div>
        <p className="ng-hint" style={{ marginTop: 4 }}>
          {t('settings.advanced.diagnostics.desc')}
        </p>
      </div>

      {/* 采集中横幅（含隐私提示） */}
      {captureActive && (
        <div className="set-note warn">
          <Activity className="h-3.5 w-3.5 animate-pulse" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 560 }}>
              {t('settings.advanced.diagnostics.captureActiveTitle')}
            </div>
            <p className="ng-hint" style={{ marginTop: 2 }}>
              {t('settings.advanced.diagnostics.captureActiveDesc')}
            </p>
          </div>
        </div>
      )}

      {/* 动作行 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          className="btn ghost sm"
          disabled={isExporting || isToggling}
          onClick={handleExport}
        >
          <FileDown className={`h-3.5 w-3.5 ${isExporting ? 'animate-pulse' : ''}`} />
          {isExporting
            ? t('settings.advanced.diagnostics.exporting')
            : t('settings.advanced.diagnostics.export')}
        </button>

        {captureActive ? (
          <button
            type="button"
            className="btn ghost sm"
            disabled={isToggling}
            onClick={handleStopCapture}
          >
            <Square className="h-3.5 w-3.5" />
            {t('settings.advanced.diagnostics.captureStop')}
          </button>
        ) : (
          <button
            type="button"
            className="btn ghost sm"
            disabled={isToggling}
            onClick={handleStartCapture}
          >
            <Activity className="h-3.5 w-3.5" />
            {t('settings.advanced.diagnostics.captureStart')}
          </button>
        )}
      </div>
    </div>
  );
}
