/**
 * 节点卡片视图项 —— 从 server-list.tsx 卡片网格抽出（审计 §1 Tier-1），JSX 字节级保留。
 * 选中态/批量选中态/国旗水印/各类角标/操作按钮组(ServerActions)均按原结构透传，无行为变化。
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { useTranslation } from 'react-i18next';
import type { InvalidNodeInfo } from '../../../shared/types';
import { iconProxySrc } from '../../../shared/icon-proxy';
import { openTailscaleLogin } from '../../lib/tailscale-login';
import { ServerActions } from './server-actions';
import { SpeedBadge } from './speed-badge';
import { MeshInfoPopover } from './mesh-info-popover';
import {
  getCountryCode,
  getTransportLabel,
  getProtocolBadgeVariant,
  isWarpNode,
  tailscaleNeedsLogin,
  tailscaleLoggingIn,
  meshInternetOff,
  endpointLabel,
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
  const countryCode = getCountryCode(server.name);
  return (
    <Card
      className={`cursor-pointer transition-colors relative overflow-hidden ${
        selectedServerId === server.id ? 'ring-2 ring-primary bg-primary/5' : 'hover:bg-muted/50'
      } ${isSelecting && selectedIds.has(server.id) ? 'ring-2 ring-primary bg-primary/10' : ''}`}
      onClick={() =>
        isSelecting
          ? onToggleSelect(server.id, { stopPropagation: () => {} } as any)
          : onSelectServer(server.id)
      }
    >
      {countryCode && (
        <div
          className="absolute -end-4 -bottom-4 z-0 h-28 w-28 opacity-[0.08] select-none pointer-events-none rounded-full overflow-hidden dark:opacity-[0.15]"
          style={{
            backgroundImage: `url('${iconProxySrc(`https://flagcdn.com/w160/${countryCode}.png`)}')`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            maskImage: 'radial-gradient(circle at 60% 60%, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 85%)',
            WebkitMaskImage:
              'radial-gradient(circle at 60% 60%, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 85%)',
          }}
        />
      )}
      {/* 批量选择 checkbox */}
      {isSelecting && (
        <div className="absolute top-2 start-2 z-10 pointer-events-none">
          <Checkbox checked={selectedIds.has(server.id)} />
        </div>
      )}
      <CardHeader className={`pb-2 ${isSelecting ? 'ps-8' : ''}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle
              className={`text-sm truncate ${invalidNodes[server.id] ? 'opacity-50' : ''}`}
              title={
                invalidNodes[server.id]
                  ? `${t('servers.nodeInvalid')}: ${invalidNodes[server.id].reason}`
                  : undefined
              }
            >
              {server.name}
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">{endpointLabel(server)}</CardDescription>
          </div>
          {!isSelecting && <ServerActions server={server} {...actions} />}
        </div>
        <div className="flex flex-wrap gap-1 mt-1">
          <Badge
            variant="outline"
            className={`text-xs h-4 px-1 border ${getProtocolBadgeVariant(server.protocol)}`}
          >
            {server.protocol.toUpperCase()}
          </Badge>
          {isWarpNode(server) && (
            <Badge
              variant="outline"
              className="text-xs h-4 px-1 bg-badge-sky/15 text-badge-sky border-badge-sky/30"
            >
              WARP
            </Badge>
          )}
          {tailscaleLoggingIn(
            server,
            tailscaleAuthUrls[server.id] !== undefined,
            tailscaleLoginStates[server.id]
          ) && (
            <Badge
              variant="outline"
              className="text-xs h-4 px-1 bg-badge-blue/15 text-badge-blue border-badge-blue/30"
            >
              {t('servers.tsLoggingIn', '登录中…')}
            </Badge>
          )}
          {!tailscaleLoggingIn(
            server,
            tailscaleAuthUrls[server.id] !== undefined,
            tailscaleLoginStates[server.id]
          ) &&
            tailscaleNeedsLogin(server, tailscaleLoginStates[server.id]) && (
              <Badge
                variant="outline"
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
                className="text-xs h-4 px-1 cursor-pointer bg-badge-amber/15 text-badge-amber border-badge-amber/30 hover:bg-badge-amber/25"
              >
                {t('servers.tsLoginAction', 'Log in')}
              </Badge>
            )}
          {meshInternetOff(server) && (
            <Badge
              variant="outline"
              className="text-xs h-4 px-1 bg-badge-amber/15 text-badge-amber border-badge-amber/30"
            >
              {t('servers.noInternetBadge', 'LAN only')}
            </Badge>
          )}
          {shadowedCidrs.has(server.id) && (
            <Badge
              variant="outline"
              title={t(
                'servers.meshShadowedTip',
                '以下网段已被列表中靠前的组网节点占有、不会经此节点：{{cidrs}}。可去重 / 调整节点顺序 / 用自定义规则覆盖。',
                { cidrs: shadowedCidrs.get(server.id)!.join(', ') }
              )}
              className="text-xs h-4 px-1 bg-badge-amber/15 text-badge-amber border-badge-amber/30"
            >
              {t('servers.meshShadowedBadge', '网段被覆盖')}
            </Badge>
          )}
          {selectedServerId === server.id && (
            <Badge variant="outline" className="text-xs h-4 px-1">
              {t('servers.current')}
            </Badge>
          )}
          {server.shadowTlsSettings && (
            <Badge
              variant="outline"
              className="text-xs h-4 px-1 text-badge-teal border-badge-teal/50"
            >
              +ST
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0 pb-3">
        {/* 传输/加密信息行（左）+ 测速结果（右下角，#59）。组网节点在「传输:」前加 ⓘ 弹内网IP/路由（#61）。 */}
        <div className="flex items-end justify-between gap-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {server.protocol?.toLowerCase() === 'shadowsocks' ? (
              <span>
                {t('servers.encryption')}: {server.shadowsocksSettings?.method || 'N/A'}
              </span>
            ) : (
              <>
                <span className="inline-flex items-center gap-1">
                  <MeshInfoPopover server={server} />
                  {t('servers.transport')}: {getTransportLabel(server)}
                </span>
                <span>
                  {t('servers.encryption')}: {server.security || 'none'}
                </span>
              </>
            )}
          </div>
          <SpeedBadge server={server} latencyMap={actions.latencyMap} />
        </div>
      </CardContent>
    </Card>
  );
}
