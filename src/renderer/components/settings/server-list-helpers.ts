/**
 * server-list 展示层共享的无状态纯函数与类型（从 server-list.tsx god-component 下沉，审计 §1 Tier-1）。
 * 全部不依赖组件 state/props，供主组件 + ServerCard/ServerRow/ServerActions 子组件共用，逐字保留原行为。
 */
import type { ServerConfig } from '@/bridge/types';
import { latencyTone, LATENCY_TONE_TEXT_CLASS, type LatencyTone } from '../ui/node-picker-logic';
import {
  isAccountBasedProtocol,
  isEndpointProtocol,
  meshNodeCarriesFullTunnel,
} from '../../../shared/endpoint-routes';
import { isWarpServer } from '../../../shared/warp';
import { sortServersByLatency } from '../../../shared/server-latency-sort';

export type ServerConfigWithId = ServerConfig;
export type ViewMode = 'card' | 'list';
export type SortKey = 'name' | 'protocol' | 'latency' | 'address';
export type SortOrder = 'asc' | 'desc';

/**
 * 节点列表排序（纯函数，供 useServerFilter 调用 + 单测）。
 * latency 排序对「无有效测速结果」优雅降级：无结果节点**始终沉底**（与 asc/desc 无关），
 * 两者都无结果 → 按名称升序——空测速=稳定的默认序（体感等同默认排序），但排序偏好仍保留，
 * 测速一回来已测节点自动按延迟浮顶。测速结果（latencyMap）刻意不持久化：延迟易过期，
 * 陈旧值会把已挂节点显示成「最快」而误导，故只持久化排序偏好、不持久化结果。
 */
export function sortServers(
  list: ServerConfigWithId[],
  sortKey: SortKey,
  sortOrder: SortOrder,
  latencyMap: Record<string, number>
): ServerConfigWithId[] {
  // 延迟排序委托给共享比较器（单一来源，与首页下拉 + 托盘同序；语义不变：无结果沉底、按名称降级）。
  if (sortKey === 'latency') {
    return sortServersByLatency(list, (id) => latencyMap[id], sortOrder);
  }
  return [...list].sort((a, b) => {
    let cmp = 0;
    if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
    else if (sortKey === 'protocol') cmp = a.protocol.localeCompare(b.protocol);
    else if (sortKey === 'address') cmp = (a.address || '').localeCompare(b.address || '');
    return sortOrder === 'asc' ? cmp : -cmp;
  });
}

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

/** 无分享链接的协议（ProtocolParser.generateUrl 无对应分支）：隐藏/排除复制按钮，避免 per-server 抛错刷屏。
 *  snell 已按事实形态（sub-store 等）支持 parse/generate，不在此列。 */
export const NO_SHARE_LINK_PROTOCOLS = new Set(['ssh', 'wireguard', 'tailscale', 'custom']);
export const hasShareLink = (protocol: string | undefined): boolean =>
  !NO_SHARE_LINK_PROTOCOLS.has(protocol?.toLowerCase() || '');

export const getCountryCode = (name: string): string | null => {
  const lowerName = name.toLowerCase();
  // 拉丁字母国家码/缩写要求两侧不与其他字母相邻（允许数字/分隔符），以免子串误判：
  // russia 含 us、berlin 含 in、montreal 含 tr、sweden 含 de、madrid 含 id 等；
  // 同时兼容 "US01" / "HK-02" 等写法。中文名/城市/旗帜 emoji 足够独特，仍按子串匹配。
  if (/香港|🇭🇰|hong kong|(?<![a-z])hk(?![a-z])/.test(lowerName)) return 'hk';
  if (/台湾|🇹🇼|台北|新北|(?<![a-z])(?:tw|taiwan)(?![a-z])/.test(lowerName)) return 'tw';
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

/** WARP 节点（一键生成的 wireguard，端点为 Cloudflare WARP relay）。鲁棒判定单一真值 → shared isWarpServer。 */
export const isWarpNode = (s: ServerConfigWithId): boolean => isWarpServer(s);

/**
 * 节点类型 pill 显示标签（单一真值，ServerRow / ServerCard 共用，复用 server-picker-items 的「WARP 优先」模式）：
 *   - WARP：语义独立，显 'WARP' 而非底层 wireguard —— 消 line 95「WIREGUARD」+ 独立 WARP 徽章的双标识残留。
 *   - 组网协议：用短名 WG / TS —— 全大写 WIREGUARD/TAILSCALE(9 字符) 在弹性行里易触发行溢出被 .nd-rows overflow:hidden 截断。
 *   - 其余：保持大写协议名，与既有 pill 视觉一致（WG/TS/WARP 本就全大写、不破坏风格）。
 */
export const nodeTypeLabel = (s: ServerConfigWithId): string => {
  if (isWarpServer(s)) return 'WARP';
  const p = s.protocol?.toLowerCase();
  if (p === 'wireguard') return 'WG';
  if (p === 'tailscale') return 'TS';
  return (s.protocol || '').toUpperCase();
};

/**
 * Tailscale 节点是否「需登录」（Phase 1：真实登录态驱动，非静态 !authKey）。
 * 真实登录态 = authKey || loggedIn（主进程 state 目录真值，经 store.tailscaleLoginStates 透传）。
 * loggedIn 缺省 false（store 未刷新到该节点时按「需登录」保守显示，刷新后即收敛）。
 * 这样交互登录成功（产出 state 会话、loggedIn=true）后角标会自动消失，修 P3「登录后不消」。
 */
export const tailscaleNeedsLogin = (s: ServerConfigWithId, loggedIn = false): boolean =>
  s.protocol?.toLowerCase() === 'tailscale' && !(s.tailscaleSettings?.authKey?.trim() || loggedIn);

/**
 * Tailscale「登录中」态：已产生登录 URL（用户点了登录、瞬态核在等浏览器授权 + STATUS 同步到 Running）
 * 且尚未登录成功。authUrl 在登录成功（setTailscaleLoginState true）时被清除 → 自动退出；登录超时/失败
 * 由 main 侧发「清 authUrl」事件退出。优先于「需登录」显示，给用户「正在进行」的反馈（修「点了登录仍显未登录」）。
 */
export const tailscaleLoggingIn = (
  s: ServerConfigWithId,
  hasAuthUrl: boolean,
  loggedIn = false
): boolean =>
  s.protocol?.toLowerCase() === 'tailscale' &&
  !s.tailscaleSettings?.authKey?.trim() &&
  hasAuthUrl &&
  !loggedIn;

/**
 * Tailscale 表单登录区三态（纯函数，便于单测；与 tailscaleNeedsLogin 同登录态口径）。
 * - 'loggedIn'：已登录 → 显「已登录」+ 退出登录 + 重新登录。
 * - 'needsLogin'：编辑态（有 id）未登录且未填 authKey → 显「立即登录」。
 * - 'none'：新建态（无 id），或已填 authKey 未登录（pre-auth：由 key 登录、不显交互登录区）。
 */
export type TailscaleLoginUiState = 'loggedIn' | 'needsLogin' | 'none';
export const tailscaleLoginUiState = (
  hasId: boolean,
  loggedIn: boolean,
  hasAuthKey: boolean
): TailscaleLoginUiState => {
  if (!hasId) return 'none';
  if (loggedIn) return 'loggedIn';
  if (!hasAuthKey) return 'needsLogin';
  return 'none';
};

/** 组网节点（WG/Tailscale）不承载全隧道（关外网 或 Phase2 system 内核接口）→ 列表角标提示「仅内网」，
 *  避免误以为它能作全局出口。system 节点恒 specific-only，故用 meshNodeCarriesFullTunnel 单一真值判定。 */
export const meshInternetOff = (s: ServerConfigWithId): boolean =>
  isEndpointProtocol(s.protocol) && !meshNodeCarriesFullTunnel(s);

/** 组网节点承载全隧道默认出口 → 可作全局出口（meshInternetOff 的正向补集），列表用 teal「出口」chip 正向标注。
 *  「出口能力」与「当前选中(current ring)」是正交两层：能力 chip 说明「能否作出口」，ring 说明「此刻是否选它」。
 *  仅对 endpoint 协议(WG/WARP/Tailscale)成立；代理节点恒 false（其出口能力由协议本身隐含，不需标注）。 */
export const meshIsExitCapable = (s: ServerConfigWithId): boolean =>
  isEndpointProtocol(s.protocol) && meshNodeCarriesFullTunnel(s);

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

// 延迟色档与 .npick 共用单一真值：阈值判定委托 latencyTone，文字色映射复用 LATENCY_TONE_TEXT_CLASS，
// 背景色映射为本地色档表（仅此处消费）——杜绝阈值/映射双写漂移。
const LATENCY_TONE_BG_CLASS: Record<LatencyTone, string> = {
  good: 'bg-success/10',
  medium: 'bg-warning/10',
  bad: 'bg-destructive/10',
  idle: '',
};

export const getLatencyColor = (latency: number | undefined) =>
  LATENCY_TONE_TEXT_CLASS[latencyTone(latency)];

export const getLatencyBg = (latency: number | undefined) =>
  LATENCY_TONE_BG_CLASS[latencyTone(latency)];

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

// ══════════════════ Conduit nodes-page（.nd-*）展示辅助 ══════════════════

/** ISO 3166-1 alpha-2 国家码 → 区域指示符 emoji 旗帜（hk → 🇭🇰）。非法/空输入 → 空串。 */
export const countryCodeToFlag = (code: string | null): string => {
  if (!code || code.length !== 2) return '';
  const cc = code.toUpperCase();
  return String.fromCodePoint(0x1f1e6 + cc.charCodeAt(0) - 65, 0x1f1e6 + cc.charCodeAt(1) - 65);
};

/** 节点名 → 旗帜 emoji（.nd-flag 水印用）；识别不到国家 → 空串（省略水印）。复用 getCountryCode 单一真值。 */
export const flagEmoji = (name: string): string => countryCodeToFlag(getCountryCode(name));

/** 延迟数值 → .nd-lat 语义档类名（ok/warn/err）；无测速结果 / idle → ''。
 *  阈值判定委托 latencyTone（与 getLatencyColor / .npick 同一单一真值，杜绝阈值双写漂移）。 */
export const latToneClass = (latency: number | undefined): '' | 'ok' | 'warn' | 'err' => {
  const tone = latencyTone(latency);
  return tone === 'good' ? 'ok' : tone === 'medium' ? 'warn' : tone === 'bad' ? 'err' : '';
};

/** .nd-xfer 传输/加密紧凑摘要（如 "ws · tls" / "reality" / ss method）。空串则调用方省略该角标。 */
export const transferSummary = (server: ServerConfigWithId): string => {
  const p = server.protocol?.toLowerCase();
  if (p === 'shadowsocks') return server.shadowsocksSettings?.method || '';
  return [getTransportLabel(server), server.security].filter(Boolean).join(' · ');
};
