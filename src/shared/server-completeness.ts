import type { ServerConfig, Protocol } from './types';
import { isAccountBasedProtocol } from './endpoint-routes';

/**
 * 协议「必填字段是否齐备」的**单一真值**——主侧 `ConfigManager.validateConfig`（缺则 throw）
 * 与渲染侧首页连接闸门 `isServerComplete`（缺则置灰）共用，杜绝两处各自按协议枚举导致的漂移
 * （WireGuard 当初漏列 → 连接按钮恒置灰、anytls 曾在 validateConfig 漏校验，均属此类）。
 *
 * 新增协议：只改这里一处 + 同步 ALL_PROTOCOLS，两个闸门 + 单测护栏自动覆盖。
 */

/** 受支持协议的权威运行时清单（从 types.ts `Protocol` 联合派生；ConfigManager 与单测共用）。 */
export const ALL_PROTOCOLS: readonly Protocol[] = [
  'vless',
  'vmess',
  'trojan',
  'hysteria2',
  'shadowsocks',
  'anytls',
  'tuic',
  'naive',
  'socks',
  'http',
  'ssh',
  'wireguard',
  'tailscale',
  'custom',
];

/** 自定义协议的 outbound 是否合法形态（对象且含非空字符串 type）。语义不校验，交内核。 */
export function isValidCustomOutbound(outbound: unknown): boolean {
  return (
    !!outbound &&
    typeof outbound === 'object' &&
    !Array.isArray(outbound) &&
    typeof (outbound as Record<string, unknown>).type === 'string' &&
    ((outbound as Record<string, unknown>).type as string).trim().length > 0
  );
}

const KNOWN = new Set<string>(ALL_PROTOCOLS);

/**
 * 返回该节点缺失协议必填项的英文错误信息；齐备返回 null。
 * 注意：仅校验「协议特有必填字段」，不含 address/port（那是各调用方各自的通用校验）。
 */
export function protocolRequirementError(server: ServerConfig): string | null {
  const p = server.protocol?.toLowerCase();
  switch (p) {
    case 'vless':
      return server.uuid?.trim() ? null : 'VLESS server requires uuid';
    case 'vmess':
      return server.uuid?.trim() ? null : 'VMess server requires uuid';
    case 'trojan':
      return server.password?.trim() ? null : 'Trojan server requires password';
    case 'hysteria2':
      return server.password?.trim() ? null : 'Hysteria2 server requires password';
    case 'anytls':
      return server.password?.trim() ? null : 'AnyTLS server requires password';
    case 'tuic':
      return server.uuid?.trim() && server.password?.trim()
        ? null
        : 'TUIC server requires uuid and password';
    case 'naive':
      return server.username?.trim() && server.password?.trim()
        ? null
        : 'Naive server requires username and password';
    case 'shadowsocks':
      return server.shadowsocksSettings?.method?.trim() &&
        server.shadowsocksSettings?.password?.trim()
        ? null
        : 'Shadowsocks server requires encryption method and password';
    case 'wireguard':
      return server.wireguardSettings?.privateKey?.trim() &&
        server.wireguardSettings?.peerPublicKey?.trim() &&
        server.wireguardSettings?.localAddress?.length
        ? null
        : 'WireGuard server requires privateKey, peerPublicKey and localAddress';
    case 'socks':
    case 'http':
    case 'ssh':
      return null; // 仅需 address/port（调用方通用校验）
    case 'tailscale':
      return null; // 账号制：auth_key 可选（无则运行时交互登录），无硬必填项；亦无 address/port
    case 'custom':
      // raw-JSON 透传：必须是含 type 的 outbound 对象（语义/能否启用由内核 check 判，FlowZ 不校验）。
      return isValidCustomOutbound(server.customSettings?.outbound)
        ? null
        : 'Custom protocol requires a JSON outbound object with a "type" field';
    default:
      return `Unsupported protocol: ${p ?? '(empty)'}`;
  }
}

/**
 * 节点是否「配置齐备、可启动代理」——首页连接按钮 disabled 闸门用。
 * = 存在 + address/port 合法 + 协议必填齐备 + 协议受支持。
 */
export function isServerComplete(server: ServerConfig | undefined | null): boolean {
  if (!server) return false;
  const p = server.protocol?.toLowerCase();
  if (!KNOWN.has(p)) return false;
  // 账号制协议（Tailscale）连控制面、custom（raw-JSON 自带 server/port）→ 无 ServerConfig address/port；其余必须有。
  if (!isAccountBasedProtocol(p) && p !== 'custom') {
    if (!server.address || server.address.trim() === '') return false;
    if (!server.port || server.port <= 0) return false;
  }
  return protocolRequirementError(server) === null;
}
