/**
 * 节点列表视图行 —— 从 server-list.tsx 列表抽出（审计 §1 Tier-1），JSX 字节级保留。
 * 行点击在选择态走 onToggleSelectId（与原内联 setSelectedIds 同一 toggle 语义）、非选择态走 onSelectServer；
 * checkbox/选中指示器/国旗水印/各类角标/操作按钮组(ServerActions)均按原结构透传，无行为变化。
 */
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { useTranslation } from 'react-i18next';
import { isAccountBasedProtocol } from '../../../shared/endpoint-routes';
import type { InvalidNodeInfo } from '../../../shared/types';
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
  const countryCode = getCountryCode(server.name);
  return (
    <div
      className={`relative overflow-hidden flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${
        selectedServerId === server.id ? 'bg-primary/5' : 'hover:bg-muted/50'
      } ${isSelecting && selectedIds.has(server.id) ? 'bg-primary/10' : ''}`}
      onClick={() => {
        if (isSelecting) {
          onToggleSelectId(server.id);
        } else {
          onSelectServer(server.id);
        }
      }}
    >
      {/* 批量选择 */}
      {isSelecting && (
        <Checkbox className="pointer-events-none" checked={selectedIds.has(server.id)} />
      )}

      {/* 选中指示器 */}
      {!isSelecting && (
        <div
          className={`relative z-10 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
            selectedServerId === server.id ? 'bg-primary' : 'bg-transparent'
          }`}
        />
      )}

      {/* 背景国旗 */}
      {countryCode && (
        <div
          className="absolute end-12 top-1/2 -translate-y-1/2 z-0 h-24 w-24 opacity-[0.05] select-none pointer-events-none rounded-full overflow-hidden dark:opacity-[0.1]"
          style={{
            backgroundImage: `url('https://flagcdn.com/w80/${countryCode}.png')`,
            backgroundSize: 'contain',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            maskImage:
              'linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,1) 30%, rgba(0,0,0,1) 70%, rgba(0,0,0,0) 100%)',
            WebkitMaskImage:
              'linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,1) 30%, rgba(0,0,0,1) 70%, rgba(0,0,0,0) 100%)',
          }}
        />
      )}

      {/* 名称 + 地址 */}
      <div className="flex-1 min-w-0 relative z-10">
        <div className="flex items-center gap-2">
          <span
            className={`text-sm font-medium truncate ${invalidNodes[server.id] ? 'opacity-50' : ''}`}
            title={
              invalidNodes[server.id]
                ? `${t('servers.nodeInvalid')}: ${invalidNodes[server.id].reason}`
                : undefined
            }
          >
            {server.name}
          </span>
          <Badge
            variant="outline"
            className={`text-[10px] h-4 px-1 flex-shrink-0 border ${getProtocolBadgeVariant(server.protocol)}`}
          >
            {server.protocol.toUpperCase()}
          </Badge>
          {isWarpNode(server) && (
            <Badge
              variant="outline"
              className="text-[10px] h-4 px-1 flex-shrink-0 bg-badge-sky/15 text-badge-sky border-badge-sky/30"
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
              className="text-[10px] h-4 px-1 flex-shrink-0 bg-badge-blue/15 text-badge-blue border-badge-blue/30"
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
                className="text-[10px] h-4 px-1 flex-shrink-0 cursor-pointer bg-badge-amber/15 text-badge-amber border-badge-amber/30 hover:bg-badge-amber/25"
              >
                {t('servers.tsLoginAction', 'Log in')}
              </Badge>
            )}
          {meshInternetOff(server) && (
            <Badge
              variant="outline"
              className="text-[10px] h-4 px-1 flex-shrink-0 bg-badge-amber/15 text-badge-amber border-badge-amber/30"
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
              className="text-[10px] h-4 px-1 flex-shrink-0 bg-badge-amber/15 text-badge-amber border-badge-amber/30"
            >
              {t('servers.meshShadowedBadge', '网段被覆盖')}
            </Badge>
          )}
          {server.shadowTlsSettings && (
            <Badge
              variant="outline"
              className="text-[10px] h-4 px-1 flex-shrink-0 text-badge-teal border-badge-teal/50"
            >
              +ST
            </Badge>
          )}
          {selectedServerId === server.id && (
            <Badge variant="outline" className="text-[10px] h-4 px-1 flex-shrink-0">
              {t('servers.current')}
            </Badge>
          )}
        </div>
        {/* 底部信息行（端点/传输）+ 测速结果（右，#59）。组网节点前缀 ⓘ 弹内网IP/路由（#61）。
            用 div 而非 p：内含 HoverCard 触发器 <button>，p 内嵌 button 是非法嵌套。 */}
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground mt-0.5">
          <span className="inline-flex items-center gap-1 min-w-0 truncate">
            <MeshInfoPopover server={server} />
            <span className="truncate">
              {endpointLabel(server)}
              {!isAccountBasedProtocol(server.protocol) &&
                server.protocol?.toLowerCase() !== 'custom' &&
                getTransportLabel(server) !== 'tcp' && (
                  <span className="ms-2">{getTransportLabel(server)}</span>
                )}
            </span>
          </span>
          <span className="relative z-10 shrink-0">
            <SpeedBadge server={server} latencyMap={actions.latencyMap} />
          </span>
        </div>
      </div>

      {/* 延迟 + 操作 */}
      {!isSelecting && (
        <div className="relative z-10 flex items-center">
          <ServerActions server={server} {...actions} />
        </div>
      )}
    </div>
  );
}
