/**
 * 组网节点信息 ⓘ（#61）：组网类型节点（WireGuard / Tailscale，WARP 本质是 wireguard）卡片在角标行末尾加 info 图标，
 * hover/focus 弹出内网 IP + 路由，消「要登录 Tailscale 控制台才看得到」的信息黑盒。
 *   - 内网 IP：Tailscale = api STATUS 流携带的 tailnet IP（store.tailscaleIps，100.x）；WireGuard = wireguardSettings.localAddress。
 *   - 路由：Tailscale = accept / advertise routes（acceptRoutes ? routes∪advertiseRoutes）；WireGuard = peer.allowed_ips（allowedIPs）。
 * 非组网节点（vless 等）不渲染此图标。
 *
 * Conduit 1:1 移植：由 radix HoverCard 改为原型纯 CSS 结构 `.nd-info`/`.nd-info-btn`/`.nd-info-pop`（`:hover`/`:focus-within`
 * 揭示，见 conduit.css）。a11y 不降级——触发器仍是可聚焦 `<button aria-label>`，键盘聚焦即 focus-within 弹出；
 * onClick stopPropagation 保「点 ⓘ 不选中卡片」。字段派生逻辑（IP/路由/出口/接受子网路由/陈旧标注）逐字保留。
 */
import { useTranslation } from 'react-i18next';
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
    <span className="nd-info">
      <button
        type="button"
        className="nd-info-btn"
        aria-label={t('common.moreInfo')}
        onClick={(e) => e.stopPropagation()}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 7.5h.01" />
        </svg>
      </button>
      <div className="nd-info-pop" onClick={(e) => e.stopPropagation()}>
        <div className="nd-info-row">
          <span className="nd-info-k">{t('servers.meshInfoIntranetIp')}</span>
          <span className="nd-info-v mono tnum break-all text-right">
            {ips.length > 0 ? ips.join(', ') : t('servers.meshInfoNotAssigned')}
            {/* 「上次已知」仅对 Tailscale：其内网IP 来自 STATUS 流缓存、停代理时确为陈旧。WG/WARP 的内网IP 是
                静态 config(localAddress)、永不陈旧，故不标（isAccountBasedProtocol=仅 Tailscale）。 */}
            {ips.length > 0 && !proxyRunning && isAccountBasedProtocol(server.protocol) && (
              <span className="ms-1 font-sans text-[hsl(var(--fg-faint))]">
                · {t('servers.meshInfoLastKnown', 'last known')}
              </span>
            )}
          </span>
        </div>
        <div className="nd-info-row">
          <span className="nd-info-k">{t('servers.meshInfoRoutes')}</span>
          <span className="nd-info-v mono tnum break-all text-right">
            {routes.length > 0 ? routes.join(', ') : t('servers.meshInfoNoRoutes')}
          </span>
        </div>
        {exitNode && (
          <div className="nd-info-row">
            <span className="nd-info-k">{t('servers.meshInfoExitNode', '出口节点')}</span>
            <span className="nd-info-v mono break-all text-right">{exitNode}</span>
          </div>
        )}
        {ts?.acceptRoutes && (
          <div className="nd-info-row">
            <span className="nd-info-k">
              {t('servers.meshInfoAcceptRoutesOn', '接受子网路由：已开启')}
            </span>
          </div>
        )}
      </div>
    </span>
  );
}
