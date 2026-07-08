import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Collapse } from './conduit-controls';

interface TerminalProxySectionProps {
  httpPort: string;
  socksPort: string;
}

/**
 * 终端代理速查表（Conduit 网络面板末位卡 `.card.set-card` + `.set-collapse.flush`）：默认折叠。
 * 数据驱动渲染各平台命令块（`.cmd-block`），每块一个「复制」拷贝整段命令。
 */
export function TerminalProxySection({ httpPort, socksPort }: TerminalProxySectionProps) {
  const { t } = useTranslation();

  const copy = (cmds: string[]) => {
    navigator.clipboard.writeText(cmds.join('\n'));
    toast.success(t('settings.advanced.copied'));
  };

  const h = `http://127.0.0.1:${httpPort}`;
  const s = `socks5://127.0.0.1:${socksPort}`;
  const groups: { label: string; cmds: string[] }[] = [
    { label: 'Windows (CMD)', cmds: [`set http_proxy=${h}`, `set https_proxy=${h}`] },
    { label: 'Windows (PowerShell)', cmds: [`$env:http_proxy="${h}"`, `$env:https_proxy="${h}"`] },
    {
      label: 'Linux/macOS (Bash/Zsh)',
      cmds: [`export http_proxy=${h}`, `export https_proxy=${h}`],
    },
    {
      label: t('settings.advanced.gitProxy'),
      cmds: [`git config --global http.proxy ${h}`, `git config --global https.proxy ${h}`],
    },
    {
      label: t('settings.advanced.npmProxy'),
      cmds: [`npm config set proxy ${h}`, `npm config set https-proxy ${h}`],
    },
    {
      label: t('settings.advanced.socks5Proxy'),
      cmds: [`set ALL_PROXY=${s}`, `$env:ALL_PROXY="${s}"`, `export ALL_PROXY=${s}`],
    },
  ];

  return (
    <div className="card set-card">
      <Collapse summary={t('settings.advanced.terminalProxy')} className="flush">
        <p className="ng-hint" style={{ marginBottom: 4 }}>
          {t('settings.advanced.terminalProxyDesc')}
        </p>
        {groups.map((g) => (
          <div key={g.label} className="cmd-block">
            <div className="cmd-h">
              {g.label}
              <button type="button" className="btn ghost sm" onClick={() => copy(g.cmds)}>
                {t('common.copy', '复制')}
              </button>
            </div>
            <pre className="cmd">{g.cmds.join('\n')}</pre>
          </div>
        ))}
        <div className="set-note info" style={{ marginTop: 4 }}>
          <div>
            <strong>{t('settings.advanced.tip')}</strong>
            <ul style={{ marginTop: 4, paddingLeft: 16, lineHeight: 1.7 }}>
              <li>{t('settings.advanced.tipSessionOnly')}</li>
              <li>{t('settings.advanced.tipPermanent')}</li>
              <li>{t('settings.advanced.tipHttpPort', { port: httpPort })}</li>
              <li>{t('settings.advanced.tipSocksPort', { port: socksPort })}</li>
              <li>{t('settings.advanced.tipDisable')}</li>
            </ul>
          </div>
        </div>
      </Collapse>
    </div>
  );
}
