import { useEffect, useState } from 'react';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc/api-client';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { InfoTooltip } from './shared/info-tooltip';
import { Srow, Swt } from './conduit-controls';

/**
 * 控制面板卡（Conduit 高级面板 `.card.set-card`）：sing-box 原生控制 API（opt-in 逃生舱）。
 * 主开关 `.srow` + 开启后配置区 `.ctl-group`（缩进 + teal 内脊，归组于主开关下）。
 * 开关写 config.singboxDashboard，经 saveConfig→CONFIG_CHANGED 自动重启生效（不显式 restart）。
 * 「打开面板」仅开关 on 且代理运行时可点 → 调 IPC，main 用运行期 api 端口构造 /dashboard/ URL + 系统浏览器打开。
 */
export function SingboxDashboardSection() {
  const config = useAppStore((s) => s.config);
  const saveConfig = useAppStore((s) => s.saveConfig);
  const connectionStatus = useAppStore((s) => s.connectionStatus);
  const { t, i18n } = useTranslation();

  const enabled = config?.singboxDashboard === true;
  const running = connectionStatus?.proxyCore?.running === true;

  // 面板 URL（形如 http://127.0.0.1:<动态端口>/dashboard/）：仅运行 + 面板开关 on 时从 main 拉一次（端口动态，渲染端构造不出）。
  // 复用 GET_SINGBOX_DASHBOARD_CONNECTION 的 url 字段——不含 secret，安全可显，供用户手动在浏览器打开。
  const [dashboardUrl, setDashboardUrl] = useState('');
  useEffect(() => {
    if (!enabled || !running) {
      setDashboardUrl('');
      return;
    }
    let cancelled = false;
    api.app
      .getSingboxDashboardConnection()
      .then((info) => {
        if (!cancelled) setDashboardUrl(info.ok ? info.url : '');
      })
      .catch(() => {
        if (!cancelled) setDashboardUrl('');
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, running]);

  if (!config) return null;

  const handleToggle = (value: boolean) => {
    saveConfig({ ...config, singboxDashboard: value }).catch(() =>
      toast.error(t('common.saveFailed'))
    );
  };

  const openDashboard = () => {
    // 传渲染端实际 UI 语言（i18n.language，如 zh-CN/zh-TW），main 据此对齐内窗口面板语言；
    // 不能用 app.getLocale()（拿的是 Electron app bundle locale，FlowZ.app 未声明 zh → 恒 en，与 UI 语言脱钩）。
    api.app.openSingboxDashboard(i18n.language).catch(() => toast.error(t('common.saveFailed')));
  };

  // 复制连接信息（dashboard #55）：URL=管理 API 地址 + secret=clashApiSecret，经 IPC 从 main 现取（secret 不长驻渲染端 store）。
  // 供手动在其它面板/工具填后端用，与内窗口一键直连互为补充。
  const copyConnection = async () => {
    try {
      const info = await api.app.getSingboxDashboardConnection();
      if (!info.ok) {
        toast.error(t('settings.advanced.dashboardCopyUnavailable'));
        return;
      }
      await navigator.clipboard.writeText(`URL=${info.apiUrl}\nsecret=${info.secret}`);
      toast.success(t('settings.advanced.dashboardCopied'));
    } catch {
      toast.error(t('common.saveFailed'));
    }
  };

  return (
    <div className="card set-card">
      <div className="set-h">
        <b>{t('settings.advanced.singboxDashboard')}</b>
        <small>{t('settings.advanced.singboxDashboardCardSub', 'sing-box 原生控制 API')}</small>
      </div>
      <Srow
        label={
          <>
            {t('settings.advanced.singboxDashboardEnable', '启用外部控制')}
            {/* 单个 ⓘ 合并两段说明：面板离线可用 + D5 延迟重启下节点组可能与 FlowZ 列表不一致（避免同 label 双 i）。 */}
            <InfoTooltip
              content={
                <>
                  <p>{t('settings.advanced.dashboardNeedsNetwork')}</p>
                  <p style={{ marginTop: 6 }}>{t('settings.advanced.dashboardNodeGroupHint')}</p>
                </>
              }
            />
          </>
        }
      >
        <Swt checked={enabled} onChange={handleToggle} />
      </Srow>
      {enabled && (
        <div className="ctl-group">
          <Srow
            label={t('settings.advanced.openDashboard')}
            desc={t('settings.advanced.dashboardNeedsNetwork')}
          >
            <button
              type="button"
              className="btn ghost sm"
              disabled={!running}
              onClick={openDashboard}
            >
              {t('settings.advanced.openDashboard')}
            </button>
          </Srow>
          <Srow
            label={t('settings.advanced.dashboardAddress')}
            desc={t('settings.advanced.dashboardAddressDesc')}
          >
            {running && dashboardUrl ? (
              <span
                className="mono"
                title={dashboardUrl}
                onClick={() => api.system.openExternal(dashboardUrl).catch(() => undefined)}
                style={{
                  fontSize: 12,
                  color: 'hsl(var(--flow-hi))',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  textUnderlineOffset: 2,
                  maxWidth: '18rem',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {dashboardUrl}
              </span>
            ) : (
              <span className="mono" style={{ fontSize: 12, color: 'hsl(var(--fg-faint))' }}>
                {t('settings.advanced.dashboardAddressUnavailable')}
              </span>
            )}
          </Srow>
          <Srow
            label={t('settings.advanced.dashboardCopyConnection')}
            desc={t('settings.advanced.dashboardCopyConnectionDesc')}
          >
            <button
              type="button"
              className="btn ghost sm"
              disabled={!running}
              onClick={copyConnection}
            >
              {t('settings.advanced.dashboardCopyConnection')}
            </button>
          </Srow>
        </div>
      )}
    </div>
  );
}
