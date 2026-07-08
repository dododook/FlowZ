import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RealTimeLogs } from '@/components/logs';
import { LogSettingsSection } from '@/components/logs/log-settings-section';
import { DiagnosticSection } from '@/components/settings/diagnostic-section';
import { useAppStore } from '@/store/app-store';

/**
 * 日志页（Conduit `data-page="logs"`）：页头 + 「日志与诊断」折叠卡 + 实时日志查看器。
 * 折叠卡用原生 `<details class="log-diag">`（logs-local wrapper，避开共享 SettingsCollapsible 的自绘样式），
 * 受控 open + onToggle 防 config 变更重渲把用户折叠态弹回。摘要常显当前级别 pill（形+色经 CSS `.lvl-pill[data-lvl]`）。
 * 诊断节沿用共享 `DiagnosticSection`（as-is，不重写样式；后续波次再迁 conduit 观感）。
 */
export function LogsPage() {
  const { t } = useTranslation();
  const config = useAppStore((s) => s.config);
  const level = config?.logLevel || 'info';
  // 折叠卡默认收起（用户反馈：诊断低频，默认折叠）；受控以免流式/config 重渲覆盖用户折叠态。
  const [open, setOpen] = useState(false);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4" data-page="logs">
      <div className="page-h">
        <h1>{t('logs.pageTitle')}</h1>
        <span className="sub">{t('logs.pageDesc')}</span>
      </div>

      {/* 日志与诊断折叠卡：级别设置 + 诊断采集/导出（排障归一 C1/H2/M4）。 */}
      <details
        className="card log-diag"
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
      >
        <summary className="ld-head">
          <svg
            className="ld-chev"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="ld-title">{t('logs.settingsTitle', '日志与诊断')}</span>
          <span className="ld-head-meta">
            <span className="ld-cur">{t('logs.currentLevel', '级别')}</span>
            {/* 级别 pill：形+色双编码经 CSS `.lvl-pill[data-lvl]`（warn/error/fatal 语义色，其余中性）。 */}
            <span className="pill lvl-pill" data-lvl={level}>
              {level}
            </span>
          </span>
        </summary>

        <div className="ld-body">
          <LogSettingsSection />
          <div className="ld-hair" />
          {/* 共享诊断节（采集开关 + 导出）：as-is 复用，样式待后续波次统一。 */}
          <DiagnosticSection />
        </div>
      </details>

      {/* flex-fill 填至底部状态栏（对齐连接页 conns-card 风格）：wrapper 设为 flex-col + flex-1，使 conduit
          `.log-viewer{flex:1}` 生效撑满（非 flex 父级下会塌成内容高 → 之前的留白根因）。内部 .lv-stream 滚动。 */}
      <RealTimeLogs
        heightClass="flex min-h-0 flex-1 flex-col"
        initialLimit={200}
        maxBuffer={500}
      />
    </section>
  );
}
