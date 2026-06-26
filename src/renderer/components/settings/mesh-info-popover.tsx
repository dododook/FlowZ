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
import { isAccountBasedProtocol, isEndpointProtocol } from '../../../shared/endpoint-routes';
import { dedupe } from '../../../shared/collections';
import { useAppStore } from '../../store/app-store';
import type { ServerConfigWithId } from './server-list-helpers';

// 精确订阅 tailscaleIps[server.id] 时的稳定空数组：模块级常量避免 selector 内联 `?? []` 每帧生成新数组、
// 破坏 zustand 引用相等而触发无谓重渲染。
const EMPTY: string[] = [];

/** 组网节点的内网 IP（Tailscale 取传入的 STATUS 流 tailnet IP；WireGuard 取 localAddress）。 */
function meshIntranetIps(server: ServerConfigWithId, tailscaleIps: string[]): string[] {
  // Tailscale = 账号制协议（唯一），其内网 IP 来自 api STATUS 流（store.tailscaleIps[id]）。
  if (isAccountBasedProtocol(server.protocol)) {
    return tailscaleIps;
  }
  // wireguard（含 WARP）：本地隧道地址即内网 IP
  return server.wireguardSettings?.localAddress || [];
}

/** 组网节点的路由段（Tailscale = accept/advertise routes；WireGuard = peer.allowed_ips）。 */
function meshRoutes(server: ServerConfigWithId): string[] {
  if (isAccountBasedProtocol(server.protocol)) {
    const ts = server.tailscaleSettings;
    // accept routes（routes）+ advertise routes（本机对外广告）并集去重；纯展示，与 force-route 计算解耦。
    return dedupe([...(ts?.routes || []), ...(ts?.advertiseRoutes || [])]);
  }
  return server.wireguardSettings?.allowedIPs || [];
}

export function MeshInfoPopover({ server }: { server: ServerConfigWithId }) {
  const { t } = useTranslation();
  // 精确订阅本节点 IP：任一节点 IP 更新不波及其余卡片（整表订阅会全卡片重渲染）。EMPTY 模块级常量保引用稳定。
  const tailscaleIps = useAppStore((s) => s.tailscaleIps[server.id] ?? EMPTY);
  // 新鲜度：代理未运行 → 内网IP 是「上次已知」缓存值（L2 主动拉 TAILSCALE_GET_STATUS），标陈旧而非当真 live。
  const proxyRunning = useAppStore((s) => s.connectionStatus?.proxyCore?.running ?? false);
  // 非组网协议（vless 等）不显此 icon。
  if (!isEndpointProtocol(server.protocol)) return null;

  const ips = meshIntranetIps(server, tailscaleIps);
  const routes = meshRoutes(server);
  // Tailscale 专属：出口节点 + 接受子网路由开关（WireGuard 无此概念，条件不显）。
  const ts = isAccountBasedProtocol(server.protocol) ? server.tailscaleSettings : undefined;
  const exitNode = ts?.exitNode?.trim();

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
              {/* 「上次已知」仅对 Tailscale：其内网IP 来自 STATUS 流缓存、停代理时确为陈旧。WG/WARP 的内网IP 是
                  静态 config(localAddress)、永不陈旧，故不标（isAccountBasedProtocol=仅 Tailscale）。 */}
              {ips.length > 0 && !proxyRunning && isAccountBasedProtocol(server.protocol) && (
                <span className="ms-1 font-sans text-muted-foreground">
                  · {t('servers.meshInfoLastKnown', 'last known')}
                </span>
              )}
            </div>
          </div>
          <div>
            <div className="font-medium text-foreground">{t('servers.meshInfoRoutes')}</div>
            <div className="break-all font-mono">
              {routes.length > 0 ? routes.join(', ') : t('servers.meshInfoNoRoutes')}
            </div>
          </div>
          {exitNode && (
            <div>
              <div className="font-medium text-foreground">
                {t('servers.meshInfoExitNode', '出口节点')}
              </div>
              <div className="break-all font-mono">{exitNode}</div>
            </div>
          )}
          {ts?.acceptRoutes && (
            <div className="font-medium text-foreground">
              {t('servers.meshInfoAcceptRoutesOn', '接受子网路由：已开启')}
            </div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
