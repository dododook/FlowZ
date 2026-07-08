/**
 * 节点卡片视图项 —— Conduit `.nd-card` 形态（原型 1:1）。国旗 emoji 水印 + 状态点 + 名称 + 延迟徽标（首行），
 * 协议/组网能力/登录态/当前/传输摘要角标（第二行），hover 操作条（ServerActions）。
 * 选中态（.cur）/批量选中态（.pick + .nd-chk）/组网态（.mesh + pending）/各角标均逐字保留原判定与行为。
 */
import { useTranslation } from 'react-i18next';
import { LogIn, LogOut } from 'lucide-react';
import { isEndpointProtocol } from '../../../shared/endpoint-routes';
import type { InvalidNodeInfo } from '../../../shared/types';
import { openTailscaleLogin } from '../../lib/tailscale-login';
import { ServerActions } from './server-actions';
import { SpeedBadge } from './speed-badge';
import { MeshInfoPopover } from './mesh-info-popover';
import {
  flagEmoji,
  transferSummary,
  nodeTypeLabel,
  tailscaleNeedsLogin,
  tailscaleLoggingIn,
  meshInternetOff,
  meshIsExitCapable,
  type ServerConfigWithId,
  type ServerActionsContext,
} from './server-list-helpers';

interface ServerCardProps {
  server: ServerConfigWithId;
  selectedServerId?: string;
  isSelecting: boolean;
  selectedIds: Set<string>;
  invalidNodes: Record<string, InvalidNodeInfo>;
  tailscaleLoginStates: Record<string, boolean>;
  tailscaleAuthUrls: Record<string, string>;
  shadowedCidrs: Map<string, string[]>;
  onSelectServer: (serverId: string) => void;
  onToggleSelect: (id: string, e: React.MouseEvent) => void;
  actions: ServerActionsContext;
}

export function ServerCard({
  server,
  selectedServerId,
  isSelecting,
  selectedIds,
  invalidNodes,
  tailscaleLoginStates,
  tailscaleAuthUrls,
  shadowedCidrs,
  onSelectServer,
  onToggleSelect,
  actions,
}: ServerCardProps) {
  const { t } = useTranslation();
  const flag = flagEmoji(server.name);
  const isMesh = isEndpointProtocol(server.protocol);
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

  // 状态点：登录中→warn；当前出口→ok；超时→warn；其余→idle。
  const dotTone = loggingIn ? 'warn' : isCurrent ? 'ok' : latency === -1 ? 'warn' : 'idle';

  const cls = ['nd-card'];
  if (isMesh) cls.push('mesh');
  if (isSelecting) {
    if (isPicked) cls.push('pick');
  } else {
    if (isCurrent) cls.push('cur');
    if (loggingIn || needsLogin) cls.push('pending');
  }

  return (
    <div
      className={cls.join(' ')}
      tabIndex={0}
      onClick={(e) => {
        if (isSelecting) {
          onToggleSelect(server.id, e);
        } else {
          onSelectServer(server.id);
        }
      }}
    >
      {flag && <span className="nd-flag">{flag}</span>}

      <div className="nd-card-top">
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
        <SpeedBadge server={server} latencyMap={actions.latencyMap} />
      </div>

      <div className="nd-tags">
        {/* 类型角标用短标签（nodeTypeLabel：WARP/WG/TS/…）：WARP 不显底层 wireguard + 避免 TAILSCALE 等长名截断（用户反馈）。 */}
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
      </div>

      {!isSelecting && <ServerActions server={server} {...actions} />}
    </div>
  );
}
