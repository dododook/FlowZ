/**
 * 组网节点信息 ⓘ（#61）：组网类型节点（WireGuard / Tailscale，WARP 本质是 wireguard）卡片在「传输:」前加 info 图标，
 * hover/click 弹出内网 IP + 路由，消「要登录 Tailscale 控制台才看得到」的信息黑盒。
 *   - 内网 IP：Tailscale = api STATUS 流携带的 tailnet IP（store.tailscaleIps，100.x）；WireGuard = wireguardSettings.localAddress。
 *   - 路由：Tailscale = accept / advertise routes（acceptRoutes ? routes∪advertiseRoutes）；WireGuard = peer.allowed_ips（allowedIPs）。
 * 非组网节点（vless 等）不渲染此图标。基于既有 hover-card（@radix-ui/react-hover-card），lucide Info 触发器，
 * 复用 InfoTooltip 同范式（a11y：键盘可聚焦 + aria-label）。
 */
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';
import { isEndpointProtocol } from '../../../shared/endpoint-routes';
import { useAppStore } from '../../store/app-store';
import type { ServerConfigWithId } from './server-list-helpers';

/** 组网节点的内网 IP（Tailscale 取 STATUS 流的 tailnet IP；WireGuard 取 localAddress）。 */
function meshIntranetIps(
  server: ServerConfigWithId,
  tailscaleIps: Record<string, string[]>
): string[] {
  if (server.protocol?.toLowerCase() === 'tailscale') {
    return tailscaleIps[server.id] || [];
  }
  // wireguard（含 WARP）：本地隧道地址即内网 IP
  return server.wireguardSettings?.localAddress || [];
}

/** 组网节点的路由段（Tailscale = accept/advertise routes；WireGuard = peer.allowed_ips）。 */
function meshRoutes(server: ServerConfigWithId): string[] {
  if (server.protocol?.toLowerCase() === 'tailscale') {
    const ts = server.tailscaleSettings;
    // accept routes（routes）+ advertise routes（本机对外广告）并集去重；纯展示，与 force-route 计算解耦。
    return Array.from(new Set([...(ts?.routes || []), ...(ts?.advertiseRoutes || [])]));
  }
  return server.wireguardSettings?.allowedIPs || [];
}

export function MeshInfoPopover({ server }: { server: ServerConfigWithId }) {
  const { t } = useTranslation();
  const tailscaleIps = useAppStore((s) => s.tailscaleIps);
  // 非组网协议（vless 等）不显此 icon。
  if (!isEndpointProtocol(server.protocol)) return null;

  const ips = meshIntranetIps(server, tailscaleIps);
  const routes = meshRoutes(server);

  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={t('common.moreInfo')}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex shrink-0 items-center text-muted-foreground/70 hover:text-foreground"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        onClick={(e) => e.stopPropagation()}
        className="w-64 text-xs leading-relaxed text-muted-foreground"
      >
        <div className="space-y-1.5">
          <div>
            <div className="font-medium text-foreground">{t('servers.meshInfoIntranetIp')}</div>
            <div className="break-all font-mono">
              {ips.length > 0 ? ips.join(', ') : t('servers.meshInfoNotAssigned')}
            </div>
          </div>
          <div>
            <div className="font-medium text-foreground">{t('servers.meshInfoRoutes')}</div>
            <div className="break-all font-mono">
              {routes.length > 0 ? routes.join(', ') : t('servers.meshInfoNoRoutes')}
            </div>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
