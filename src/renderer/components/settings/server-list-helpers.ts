/**
 * server-list 展示层共享的无状态纯函数与类型（从 server-list.tsx god-component 下沉，审计 §1 Tier-1）。
 * 全部不依赖组件 state/props，供主组件 + ServerCard/ServerRow/ServerActions 子组件共用，逐字保留原行为。
 */
import type { ServerConfig } from '@/bridge/types';
import {
  isAccountBasedProtocol,
  isEndpointProtocol,
  meshNodeCarriesFullTunnel,
} from '../../../shared/endpoint-routes';

export type ServerConfigWithId = ServerConfig;
export type ViewMode = 'card' | 'list';
export type SortKey = 'name' | 'protocol' | 'latency' | 'address';
export type SortOrder = 'asc' | 'desc';

/** ServerActions 所需的运行期上下文（测速态 + 各操作 handler），由 ServerCard/ServerRow 透传给 ServerActions。 */
export interface ServerActionsContext {
  testingServerIds: Set<string>;
  isTestingSpeed: boolean;
  latencyMap: Record<string, number>;
  onSingleSpeedTest: (serverId: string, e: React.MouseEvent) => void;
  onCopyShareUrl: (server: ServerConfigWithId, e: React.MouseEvent) => void;
  onCloneServer?: (server: ServerConfigWithId) => void;
  onEditServer: (server: ServerConfigWithId) => void;
  onDelete: (serverId: string) => void;
}

/** 无分享链接的协议（ProtocolParser.generateUrl 无对应分支）：隐藏/排除复制按钮，避免 per-server 抛错刷屏。 */
export const NO_SHARE_LINK_PROTOCOLS = new Set(['ssh', 'wireguard', 'tailscale', 'custom']);
export const hasShareLink = (protocol: string | undefined): boolean =>
  !NO_SHARE_LINK_PROTOCOLS.has(protocol?.toLowerCase() || '');

export const getCountryCode = (name: string): string | null => {
  const lowerName = name.toLowerCase();
  // 拉丁字母国家码/缩写要求两侧不与其他字母相邻（允许数字/分隔符），以免子串误判：
  // russia 含 us、berlin 含 in、montreal 含 tr、sweden 含 de、madrid 含 id 等；
  // 同时兼容 "US01" / "HK-02" 等写法。中文名/城市/旗帜 emoji 足够独特，仍按子串匹配。
  if (/香港|🇭🇰|hong kong|(?<![a-z])hk(?![a-z])/.test(lowerName)) return 'hk';
  if (/台湾|🇹🇼|台北|新北|(?<![a-z])(?:tw|taiwan)(?![a-z])/.test(lowerName)) return 'cn';
  if (/日本|🇯🇵|东京|大阪|(?<![a-z])(?:jp|japan)(?![a-z])/.test(lowerName)) return 'jp';
  if (/新加坡|🇸🇬|狮城|(?<![a-z])(?:sg|singapore)(?![a-z])/.test(lowerName)) return 'sg';
  if (/美国|🇺🇸|洛杉矶|硅谷|西雅图|(?<![a-z])(?:us|usa|america)(?![a-z])/.test(lowerName))
    return 'us';
  if (/韩国|🇰🇷|首尔|(?<![a-z])(?:kr|korea)(?![a-z])/.test(lowerName)) return 'kr';
  if (/英国|🇬🇧|伦敦|(?<![a-z])(?:uk|gb)(?![a-z])/.test(lowerName)) return 'gb';
  if (/德国|🇩🇪|法兰克福|(?<![a-z])(?:de|germany)(?![a-z])/.test(lowerName)) return 'de';
  if (/法国|🇫🇷|巴黎|(?<![a-z])(?:fr|france)(?![a-z])/.test(lowerName)) return 'fr';
  if (/澳洲|澳大利亚|🇦🇺|悉尼|(?<![a-z])(?:au|australia)(?![a-z])/.test(lowerName)) return 'au';
  if (/加拿大|🇨🇦|多伦多|温哥华|(?<![a-z])(?:ca|canada)(?![a-z])/.test(lowerName)) return 'ca';
  if (/印度|🇮🇳|孟买|(?<![a-z])(?:in|india)(?![a-z])/.test(lowerName)) return 'in';
  if (/俄罗斯|🇷🇺|莫斯科|(?<![a-z])(?:ru|russia)(?![a-z])/.test(lowerName)) return 'ru';
  if (/荷兰|🇳🇱|阿姆斯特丹|(?<![a-z])(?:nl|netherlands)(?![a-z])/.test(lowerName)) return 'nl';
  if (/土耳其|🇹🇷|伊斯坦布尔|(?<![a-z])(?:tr|turkey)(?![a-z])/.test(lowerName)) return 'tr';
  if (/阿根廷|🇦🇷|(?<![a-z])(?:ar|argentina)(?![a-z])/.test(lowerName)) return 'ar';
  if (/意大利|🇮🇹|罗马|米兰|(?<![a-z])(?:it|italy)(?![a-z])/.test(lowerName)) return 'it';
  if (/巴西|🇧🇷|圣保罗|(?<![a-z])(?:br|brazil)(?![a-z])/.test(lowerName)) return 'br';
  if (/西班牙|🇪🇸|马德里|(?<![a-z])(?:es|spain)(?![a-z])/.test(lowerName)) return 'es';
  if (/瑞士|🇨🇭|苏黎世|(?<![a-z])(?:ch|switzerland)(?![a-z])/.test(lowerName)) return 'ch';
  if (/瑞典|🇸🇪|斯德哥尔摩|(?<![a-z])(?:se|sweden)(?![a-z])/.test(lowerName)) return 'se';
  if (/印尼|印度尼西亚|🇮🇩|雅加达|(?<![a-z])(?:id|indonesia)(?![a-z])/.test(lowerName)) return 'id';
  if (/马来西亚|🇲🇾|吉隆坡|(?<![a-z])(?:my|malaysia)(?![a-z])/.test(lowerName)) return 'my';
  return null;
};

/** 传输层显示标签：QUIC 系协议(hysteria2/tuic/naive-HTTP3)统一显示 udp，其余按 network；缺省 tcp。 */
export const getTransportLabel = (server: ServerConfigWithId): string => {
  const p = server.protocol?.toLowerCase();
  if (p === 'hysteria2' || p === 'tuic' || p === 'wireguard') return 'udp';
  if (p === 'tailscale') return 'mesh';
  if (p === 'naive') return server.naiveSettings?.useHttp3 ? 'udp' : 'tcp';
  return server.network || 'tcp';
};

/** WARP 节点（一键生成的 wireguard，端点为 Cloudflare WARP relay）。无需持久标记，按端点域名判，缺则不显示。 */
export const isWarpNode = (s: ServerConfigWithId): boolean =>
  s.protocol?.toLowerCase() === 'wireguard' &&
  (s.address || '').toLowerCase().includes('cloudflareclient.com');

/** Tailscale 节点未配置 authKey → 首次连接需浏览器交互登录，列表给提示角标降低「为何连不上」的困惑。 */
export const tailscaleNeedsLogin = (s: ServerConfigWithId): boolean =>
  s.protocol?.toLowerCase() === 'tailscale' && !s.tailscaleSettings?.authKey?.trim();

/** 组网节点（WG/Tailscale）不承载全隧道（关外网 或 Phase2 system 内核接口）→ 列表角标提示「仅内网」，
 *  避免误以为它能作全局出口。system 节点恒 specific-only，故用 meshNodeCarriesFullTunnel 单一真值判定。 */
export const meshInternetOff = (s: ServerConfigWithId): boolean =>
  isEndpointProtocol(s.protocol) && !meshNodeCarriesFullTunnel(s);

// 账号制协议（Tailscale）无 server address/port；自定义协议 server/port 在 JSON 内（缺则显类型）——
// 卡片副标题不展示 `undefined:undefined`。
export const endpointLabel = (server: ServerConfigWithId): string => {
  if (isAccountBasedProtocol(server.protocol)) return `Tailscale · ${getTransportLabel(server)}`;
  if (server.protocol?.toLowerCase() === 'custom' && !server.address) {
    const type = (server.customSettings?.outbound as any)?.type;
    return `Custom · ${type || 'json'}`;
  }
  return `${server.address}:${server.port}`;
};

export const getLatencyColor = (latency: number | undefined) => {
  if (latency === undefined) return 'text-muted-foreground';
  if (latency === -1) return 'text-destructive';
  if (latency < 100) return 'text-success';
  if (latency < 300) return 'text-warning';
  return 'text-destructive';
};

export const getLatencyBg = (latency: number | undefined) => {
  if (latency === undefined) return '';
  if (latency === -1) return 'bg-destructive/10';
  if (latency < 100) return 'bg-success/10';
  if (latency < 300) return 'bg-warning/10';
  return 'bg-destructive/10';
};

export const getProtocolBadgeVariant = (protocol: string) => {
  const colors: Record<string, string> = {
    vless: 'bg-badge-blue/15 text-badge-blue border-badge-blue/30',
    trojan: 'bg-badge-purple/15 text-badge-purple border-badge-purple/30',
    hysteria2: 'bg-badge-orange/15 text-badge-orange border-badge-orange/30',
    shadowsocks: 'bg-badge-green/15 text-badge-green border-badge-green/30',
    anytls: 'bg-badge-teal/15 text-badge-teal border-badge-teal/30',
    tuic: 'bg-badge-indigo/15 text-badge-indigo border-badge-indigo/30',
    naive: 'bg-badge-rose/15 text-badge-rose border-badge-rose/30',
    socks: 'bg-badge-slate/15 text-badge-slate border-badge-slate/30',
    http: 'bg-badge-sky/15 text-badge-sky border-badge-sky/30',
    ssh: 'bg-badge-amber/15 text-badge-amber border-badge-amber/30',
    wireguard: 'bg-badge-cyan/15 text-badge-cyan border-badge-cyan/30',
    tailscale: 'bg-badge-blue/15 text-badge-blue border-badge-blue/30',
    custom: 'bg-badge-slate/15 text-badge-slate border-badge-slate/30',
  };
  return colors[protocol.toLowerCase()] || 'bg-muted text-muted-foreground';
};
