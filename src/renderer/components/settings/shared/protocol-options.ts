import type { ProtocolType } from '@/bridge/types';
import type { TFunction } from 'i18next';

/**
 * 协议选项单一来源：value（小写，内部值）+ label（品牌名兜底）。
 * 供「添加节点」协议选择器与「节点列表」协议过滤下拉共用，避免两处各自维护顺序/标签。
 * UI 展示顺序**不取本数组顺序**——经 getSortedProtocolOptions 运行时按【实际显示标签 + 当前语言 collation】
 * 排序，custom（自定义出站 JSON）恒置末。新增协议：在此加一行即可（顺序自动）+ types.ts Protocol/bridge ProtocolType 同步。
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
  // Tailscale 不再从「添加节点」协议下拉加入——已抽离为组网 tab 顶部的单例「连接」卡（批3，设计文档④）。
  // 仅移除「添加」入口；数据层（ServerConfig protocol='tailscale'）与路由/出口引用照常，TailscaleForm 经单例卡设置复用。
  { value: 'trojan', label: 'Trojan' },
  { value: 'tuic', label: 'TUIC' },
  { value: 'vless', label: 'VLESS' },
  { value: 'vmess', label: 'VMess' },
  { value: 'wireguard', label: 'WireGuard' },
];

/** 协议值 → 显示名（列表/徽标等处用）。 */
export const protocolLabel = (value: string): string =>
  PROTOCOL_OPTIONS.find((o) => o.value === value.toLowerCase())?.label ?? value;

/** 解析协议显示标签：custom 走 i18n（自定义出站 JSON / Custom Outbound JSON），其余用品牌名 label。 */
export const resolveProtocolLabel = (value: ProtocolType, label: string, t: TFunction): string =>
  value === 'custom' ? t('servers.protocolCustom', label) : label;

/**
 * 返回按「实际显示标签 + 当前语言 collation」排序的协议选项；custom（自定义出站 JSON）恒置列表末尾。
 * 取代直接消费硬编码 PROTOCOL_OPTIONS 顺序：中/英文按当前 UI 语言 localeCompare 实排，custom 不参与排序、固定垫底。
 * @param t i18n 翻译函数
 * @param language 当前 UI 语言（localeCompare collation，如 'zh-CN' / 'en-US'）
 * @param filter 可选：仅保留命中的协议 value（节点列表按当前分组实际存在的协议过滤）
 */
export function getSortedProtocolOptions(
  t: TFunction,
  language: string,
  filter?: (value: ProtocolType) => boolean
): { value: ProtocolType; label: string }[] {
  return PROTOCOL_OPTIONS.filter((o) => !filter || filter(o.value))
    .map((o) => ({ value: o.value, label: resolveProtocolLabel(o.value, o.label, t) }))
    .sort((a, b) => {
      if (a.value === 'custom') return 1; // custom 恒置末
      if (b.value === 'custom') return -1;
      return a.label.localeCompare(b.label, language || undefined);
    });
}
