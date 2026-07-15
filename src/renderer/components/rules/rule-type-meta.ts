/**
 * 路由规则类型的渲染端元数据（唯一来源）：分组、占位示例、中文默认名/说明（i18n 回退）。
 * 供 rule-dialog、rules-page 列表 Badge、delete-dialog 共用。
 */
import type { RuleType } from '../../../shared/types';
import type { RuleCategory } from '../../../shared/rules';
import { RULE_TYPE_CATEGORY, BYPASS_FAKEIP_TYPES } from '../../../shared/rules';
import { RULE_RESOURCE_CATALOG } from '../../../shared/rule-resource-catalog';
import { Globe, Network, AppWindow, Library, Router } from 'lucide-react';

// 单一来源：分组映射与 bypassFakeIP 适用类型复用 shared/rules，避免与之漂移
export const TYPE_TO_CATEGORY = RULE_TYPE_CATEGORY;
export { BYPASS_FAKEIP_TYPES };

export const RULE_CATEGORIES: RuleCategory[] = [
  'domain',
  'network',
  'device',
  'process',
  'ruleset',
];

export const CATEGORY_TYPES: Record<RuleCategory, RuleType[]> = {
  domain: ['domain', 'domainSuffix', 'domainKeyword', 'domainRegex'],
  network: ['ipCidr', 'sourceIpCidr', 'port', 'sourcePort'],
  device: ['sourceMac', 'sourceHostname'],
  process: ['processName', 'processPath'],
  ruleset: ['geosite', 'geoip', 'ruleSet'],
};

/** 分组的默认中文名（i18n key: rules.category.<cat>）。 */
export const CATEGORY_NAME: Record<RuleCategory, string> = {
  domain: '域名',
  network: 'IP / 端口',
  device: '局域网设备',
  process: '进程',
  ruleset: '规则集',
};

export const CATEGORY_ICON: Record<RuleCategory, typeof Globe> = {
  domain: Globe,
  network: Network,
  device: Router,
  process: AppWindow,
  ruleset: Library,
};

/** 分组 Badge 着色（域名蓝 / IP紫 / 设备绿 / 进程橙 / 规则集青）。 */
export const CATEGORY_BADGE_CLASS: Record<RuleCategory, string> = {
  domain: 'border-transparent bg-badge-blue/15 text-badge-blue',
  network: 'border-transparent bg-badge-purple/15 text-badge-purple',
  device: 'border-transparent bg-badge-green/15 text-badge-green',
  process: 'border-transparent bg-badge-orange/15 text-badge-orange',
  ruleset: 'border-transparent bg-badge-cyan/15 text-badge-cyan',
};

/** 类型默认中文名（i18n key: rules.types.<type>.name）。 */
export const RULE_TYPE_NAME: Record<RuleType, string> = {
  domain: '域名',
  domainSuffix: '域名后缀',
  domainKeyword: '域名关键词',
  domainRegex: '域名正则',
  ipCidr: '目的 IP/CIDR',
  sourceIpCidr: '源 IP/CIDR',
  port: '目的端口',
  sourcePort: '源端口',
  sourceMac: '源设备 MAC',
  sourceHostname: '源设备主机名',
  processName: '进程名',
  processPath: '进程路径',
  geosite: 'Geosite',
  geoip: 'GeoIP',
  ruleSet: '规则集',
};

/** 类型默认中文说明（i18n key: rules.types.<type>.desc）。 */
export const RULE_TYPE_DESC: Record<RuleType, string> = {
  domain: '精确匹配完整域名，不含子域名',
  domainSuffix: '匹配该域名及其全部子域名（推荐）',
  domainKeyword: '域名中包含该关键词即匹配',
  domainRegex: 'Golang RE2 正则匹配域名（高级）',
  ipCidr: '目的 IP/CIDR 网段（支持 IPv4/IPv6）',
  sourceIpCidr: '源 IP/CIDR（按来源设备分流）',
  port: '目的端口，支持单端口与区间（如 1000-2000）',
  sourcePort: '源端口（高级，少用）',
  sourceMac: '按来源设备 MAC 分流（局域网网关场景，仅 Linux/macOS）',
  sourceHostname: '按来源设备主机名分流（DHCP 租约名，仅 Linux/macOS）',
  processName: '进程可执行文件名（Windows 含 .exe）；仅本机发起的连接可识别',
  processPath: '进程可执行文件完整路径（区分同名程序）',
  geosite: 'sing-geosite 域名分类库标签（如 youtube）',
  geoip: 'sing-geoip 国家/地区 IP 库标签（如 cn）',
  ruleSet: '已下载的本地规则资源',
};

/** 每行一条输入的占位示例（i18n key: rules.types.<type>.placeholder）。 */
export const RULE_TYPE_PLACEHOLDER: Record<RuleType, string> = {
  domain: 'www.google.com',
  domainSuffix: 'google.com',
  domainKeyword: 'youtube',
  domainRegex: '^stun\\..+',
  ipCidr: '8.8.8.8/32',
  sourceIpCidr: '192.168.1.100/32',
  port: '443\n1000-2000',
  sourcePort: '5060',
  sourceMac: '00:11:22:33:44:55',
  sourceHostname: 'my-laptop',
  processName: 'Telegram',
  processPath: '/Applications/Telegram.app/Contents/MacOS/Telegram',
  geosite: 'youtube',
  geoip: 'cn',
  ruleSet: '',
};

export const PROCESS_TYPES: RuleType[] = ['processName', 'processPath'];

/** 按类型的输入格式 hint（i18n key: rules.types.<type>.hint）。ruleSet 用 ResourcePicker，不取此值。 */
export const RULE_TYPE_HINT: Record<RuleType, string> = {
  domain: '每行一条完整域名',
  domainSuffix: '每行一条域名（匹配其及全部子域名）',
  domainKeyword: '每行一个关键词，域名包含即匹配',
  domainRegex: 'Golang RE2 正则，不支持 lookahead / 反向引用',
  ipCidr: '每行一条，裸 IP 视为单主机；IPv4/IPv6 均可',
  sourceIpCidr: '每行一条源 IP/CIDR',
  port: '每行一条端口或区间（如 443 或 1000-2000）',
  sourcePort: '每行一条源端口或区间',
  sourceMac: '每行一个 MAC（00:11:22:33:44:55 / 00-11-22-33-44-55 / 0011.2233.4455）',
  sourceHostname: '每行一个设备主机名（来自 DHCP 租约）',
  processName: '每行一个进程名（Windows 含 .exe）',
  processPath: '每行一个进程完整路径',
  geosite: '每行一个标签（如 youtube），或从下方常用标签选择',
  geoip: '每行一个标签（如 cn），或从下方常用标签选择',
  ruleSet: '',
};

/** 这些类型典型只 1-3 条 → 输入框用较矮高度。 */
export const SHORT_VALUE_TYPES: RuleType[] = [
  'domainRegex',
  'port',
  'sourcePort',
  'sourceMac',
  'sourceHostname',
  'geosite',
  'geoip',
];

/** geosite/geoip 的「常用标签」建议（来自内置精选清单，渲染端直接 import，零 IPC）。 */
export const GEO_SUGGEST: Partial<Record<RuleType, string[]>> = {
  geosite: RULE_RESOURCE_CATALOG.filter((i) => i.category === 'geosite').map((i) => i.name),
  geoip: RULE_RESOURCE_CATALOG.filter((i) => i.category === 'geoip').map((i) => i.name),
};
