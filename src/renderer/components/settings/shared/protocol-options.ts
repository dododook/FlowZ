import type { ProtocolType } from '@/bridge/types';

/**
 * 协议选项单一来源：value（小写，内部值）+ label（显示名）。**按显示名排序**。
 * 供「添加节点」协议选择器与「节点列表」协议过滤下拉共用，避免两处各自维护顺序/标签。
 * 新增协议：在此加一行（保持按 label 字母序）+ types.ts Protocol/bridge ProtocolType 同步。
 */
export const PROTOCOL_OPTIONS: { value: ProtocolType; label: string }[] = [
  { value: 'anytls', label: 'AnyTLS' },
  // custom 是唯一描述性（非品牌名）标签，需本地化：消费方对 'custom' 用 t('servers.protocolCustom') 覆盖此英文兜底。
  { value: 'custom', label: 'Custom Outbound JSON' },
  { value: 'http', label: 'HTTP(S)' },
  { value: 'hysteria2', label: 'Hysteria2' },
  { value: 'naive', label: 'NaiveProxy' },
  { value: 'shadowsocks', label: 'Shadowsocks' },
  { value: 'socks', label: 'SOCKS5' },
  { value: 'ssh', label: 'SSH' },
  { value: 'tailscale', label: 'Tailscale' },
  { value: 'trojan', label: 'Trojan' },
  { value: 'tuic', label: 'TUIC' },
  { value: 'vless', label: 'VLESS' },
  { value: 'vmess', label: 'VMess' },
  { value: 'wireguard', label: 'WireGuard' },
];

/** 协议值 → 显示名（列表/徽标等处用）。 */
export const protocolLabel = (value: string): string =>
  PROTOCOL_OPTIONS.find((o) => o.value === value.toLowerCase())?.label ?? value;
