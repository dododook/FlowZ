import { useTranslation } from 'react-i18next';
import { LogIn, LogOut } from 'lucide-react';
import type { InvalidNodeInfo } from '../../../shared/types';
import { openTailscaleLogin } from '../../lib/tailscale-login';
import { ServerActions } from './server-actions';
import { SpeedBadge } from './speed-badge';
import { MeshInfoPopover } from './mesh-info-popover';
import {
  flagAsset,
  transferSummary,
  nodeTypeLabel,
  tailscaleNeedsLogin,
  tailscaleLoggingIn,
  meshInternetOff,
  meshIsExitCapable,
  type ServerConfigWithId,
  type ServerActionsContext,
} from './server-list-helpers';

interface ServerRowProps {
  server: ServerConfigWithId;
  selectedServerId?: string;
  isSelecting: boolean;
  selectedIds: Set<string>;
  invalidNodes: Record<string, InvalidNodeInfo>;
  tailscaleLoginStates: Record<string, boolean>;
  tailscaleAuthUrls: Record<string, string>;
  shadowedCidrs: Map<string, string[]>;
  onSelectServer: (serverId: string) => void;
  onToggleSelectId: (serverId: string) => void;
  actions: ServerActionsContext;
}

export function ServerRow({
  server,
  selectedServerId,
  isSelecting,
  selectedIds,
  invalidNodes,
  tailscaleLoginStates,
  tailscaleAuthUrls,
  shadowedCidrs,
  onSelectServer,
  onToggleSelectId,
  actions,
}: ServerRowProps) {
  const { t } = useTranslation();
  const flag = flagAsset(server.name);
  const isCurrent = selectedServerId === server.id;
  const isPicked = selectedIds.has(server.id);
  const invalid = invalidNodes[server.id];
  const latency = actions.latencyMap[server.id];
  const xfer = transferSummary(server);

  const loggingIn = tailscaleLoggingIn(
    server,
    tailscaleAuthUrls[server.id] !== undefined,
    tailscaleLoginStates[server.id]
  );
  const needsLogin = !loggingIn && tailscaleNeedsLogin(server, tailscaleLoginStates[server.id]);

  const dotTone = loggingIn ? 'warn' : isCurrent ? 'ok' : latency === -1 ? 'warn' : 'idle';

  return (
    <div
      className="nd-row"
      tabIndex={0}
      onClick={() => {
        if (isSelecting) {
          onToggleSelectId(server.id);
        } else {
          onSelectServer(server.id);
        }
      }}
    >
      {flag && (
        <img className="nd-row-flag" src={flag.src} alt="" aria-hidden="true" draggable={false} />
      )}
      {isSelecting ? (
        <label className={`nd-chk${isPicked ? ' on' : ''}`} />
      ) : (
        <span className={`dot ${dotTone}`} />
      )}

      <span
        className={`nd-name${invalid ? ' opacity-50' : ''}`}
        title={invalid ? `${t('servers.nodeInvalid')}: ${invalid.reason}` : undefined}
      >
        {server.name}
      </span>

      <span className="pill proto">{nodeTypeLabel(server)}</span>
      {meshIsExitCapable(server) && (
        <span className="nd-cap exit">
          <LogOut />
          {t('servers.exitCapableBadge', 'Exit')}
        </span>
      )}
      {meshInternetOff(server) && (
        <span className="nd-cap lan">{t('servers.noInternetBadge', 'LAN only')}</span>
      )}
      {loggingIn && (
        <span className="nd-login ing">
          <span className="nd-spin" />
          {t('servers.tsLoggingIn', '登录中…')}
        </span>
      )}
      {needsLogin && (
        <span
          className="nd-login wait"
          role="button"
          tabIndex={0}
          title={t('servers.tsLoginClickHint', 'Click to log in')}
          onClick={(e) => {
            e.stopPropagation();
            openTailscaleLogin(server, tailscaleAuthUrls[server.id]);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              openTailscaleLogin(server, tailscaleAuthUrls[server.id]);
            }
          }}
        >
          <LogIn />
          {t('servers.tsLoginAction', 'Log in')}
        </span>
      )}
      {isCurrent && <span className="nd-cur">{t('servers.current')}</span>}
      {xfer && <span className="nd-xfer mono">{xfer}</span>}
      <MeshInfoPopover server={server} />
      {shadowedCidrs.has(server.id) && (
        <span
          className="nd-badge warn"
          title={t(
            'servers.meshShadowedTip',
            '以下网段已被列表中靠前的组网节点占有、不会经此节点：{{cidrs}}。可去重 / 调整节点顺序 / 用自定义规则覆盖。',
            { cidrs: shadowedCidrs.get(server.id)!.join(', ') }
          )}
        >
          {t('servers.meshShadowedBadge', '网段被覆盖')}
        </span>
      )}
      {server.shadowTlsSettings && <span className="nd-badge">+ST</span>}

      <span className="nd-row-sp" />
      <SpeedBadge server={server} latencyMap={actions.latencyMap} />

      {!isSelecting && <ServerActions server={server} {...actions} />}
    </div>
  );
}
