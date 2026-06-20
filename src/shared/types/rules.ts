/**
 * 路由规则相关类型定义
 */

// RuleAction 在路由规则、应用分流等规则域内广泛使用，统一在此定义
export type RuleAction = 'proxy' | 'direct' | 'block';

/**
 * 旧版自定义规则结构（仅域名 + ipCidr）。保留供迁移读取旧配置/旧备份用，新代码一律用 {@link Rule}。
 * @deprecated 用 Rule
 */
export interface LegacyDomainRule {
  id: string;
  domains: string[];
  ipCidr?: string[]; // IP CIDR 规则
  action: RuleAction;
  enabled: boolean;
  bypassFakeIP?: boolean;
  targetServerId?: string;
  remarks?: string;
}

/**
 * 自定义规则类型（对应 sing-box route rule 常用全集，去冗余）。
 * 域名类：domain/domainSuffix/domainKeyword/domainRegex；
 * IP/端口类：ipCidr(目的)/sourceIpCidr(源)/port(目的)/sourcePort(源)；
 * 源设备类（sing-box 1.14 LAN 设备识别）：sourceMac(源 MAC)/sourceHostname(源主机名)；
 * 进程类：processName/processPath；规则集类：geosite/geoip/ruleSet。
 */
export type RuleType =
  | 'domain'
  | 'domainSuffix'
  | 'domainKeyword'
  | 'domainRegex'
  | 'ipCidr'
  | 'sourceIpCidr'
  | 'port'
  | 'sourcePort'
  // sing-box 1.14 源设备识别（按 MAC / DHCP 主机名分流；仅 Linux/macOS，见 shared/neighbor.ts）。
  | 'sourceMac'
  | 'sourceHostname'
  | 'processName'
  | 'processPath'
  | 'geosite'
  | 'geoip'
  | 'ruleSet';

/**
 * 自定义路由规则（一条规则 = 单一 type + values 数组）。统一 values 为字符串数组：域名/CIDR/
 * 端口("443"或"1000-2000")/进程名/路径/geo 标签/规则集(URL 或 res:<resourceId>)，一项一条。
 */
/** 单个匹配条件（type + values）。多条件规则用 conditions 数组承载。 */
export interface RuleCondition {
  type: RuleType;
  values: string[];
}

export interface Rule {
  id: string;
  type: RuleType; // 首条件镜像（向后兼容旧消费点 + 回滚安全；恒与 conditions[0] 一致）
  values: string[]; // 首条件镜像
  /** 多条件共存（≥2 条件时存在；首条件镜像到 type/values）。空/缺省 = 单条件规则。 */
  conditions?: RuleCondition[];
  /** 多条件组合：'or'(默认，命中任一) / 'and'(全部命中)。单条件时无意义。 */
  combineMode?: 'and' | 'or';
  action: RuleAction;
  enabled: boolean;
  /** 绕过 FakeIP（仅 domain/domainSuffix/domainKeyword 有效） */
  bypassFakeIP?: boolean;
  /** 目标代理服务器 ID（仅当 action === 'proxy' 时有效） */
  targetServerId?: string;
  /** 规则备注说明 */
  remarks?: string;
  /**
   * TLS spoof（P3a 抗审查，sing-box 1.14 route action tls_spoof/tls_spoof_method）：对命中本规则的连接，
   * 真握手前发伪造 ClientHello 骗 SNI 过滤中间盒。tlsSpoof=伪造的白名单 SNI（域名，非空才生效），
   * tlsSpoofMethod=方法（wrong-ack/wrong-md5/wrong-timestamp）。两者须成对填写。
   * **硬限界（同 outbound spoof，见 shared/tls-spoof.ts）**：需提权、ARM64 不支持、SNI 须为域名（非 IP 字面量）。
   * 构建期按 arch/方法/IP 字面量门控（singbox-custom-rules applyRuleAction）。
   */
  tlsSpoof?: string;
  tlsSpoofMethod?: 'wrong-ack' | 'wrong-md5' | 'wrong-timestamp';
}

/** 系统进程信息（进程快速选择器用）。 */
export interface SystemProcessInfo {
  name: string;
  path?: string;
  count: number;
}

// 自定义规则集（从 URL 导入）
export interface CustomRuleSet {
  id: string;
  name: string;
  url: string; // 规则集 URL（.srs 或 .json）
  action: 'proxy' | 'direct' | 'block';
  enabled: boolean;
  addedAt: string;
}

// ============================================================================
// 规则资源（已下载到本地的 sing-box .srs 规则集）
// ============================================================================

export type RuleResourceFormat = 'binary' | 'source'; // .srs→binary（下载恒此），.json→source（仅保留扩展位）
export type RuleResourceCategory = 'geosite' | 'geoip' | 'geosite-lite' | 'geoip-lite' | 'custom';

/** 已下载到本地的规则资源（文件落 <userData>/rule-resources/，本清单存 config.json）。 */
export interface RuleResource {
  id: string; // 内置=catalog id（'geosite-youtube'）；手动='res_<ts>_<rand>'
  name: string;
  category: RuleResourceCategory;
  sourceUrl: string; // 原始 URL（不含加速前缀，更新时现拼）
  fileName: string; // 落盘名，含分类前缀防撞，如 'geosite-youtube.srs'
  format: RuleResourceFormat;
  size: number; // 字节
  downloadedAt: string; // ISO
}

/** 内置/动态资源库条目（catalog）。 */
export interface RuleResourceCatalogItem {
  id: string;
  category: RuleResourceCategory;
  name: string;
  path: string; // meta-rules-dat 仓库内路径，如 'geo/geosite/youtube.srs'
}

/** 列表项：本地资源 + 文件是否存在 + 被启用 ruleSet 规则引用计数。 */
export interface RuleResourceListItem extends RuleResource {
  fileExists: boolean;
  referencedBy: number;
  /** 内置 geo 规则集（智能分流固定依赖）：不可删除、更新写回 <userData>/rules 热重载、可重置为出厂。id 形如 'builtin:geosite-cn'。 */
  builtin?: boolean;
}

/**
 * 规则资源引用记录（单一真值，见 shared/rule-resource-refs.ts）。
 * kind 区分来源：'route'=自定义路由规则 / 'app'=应用分流卡片。
 * label：route=已就绪文案（备注/首条件摘要）；app=内置 labelKey(i18n key) 或自定义 name（由 appBuiltin 决定渲染端是否 i18n）。
 */
export interface RuleResourceRef {
  kind: 'route' | 'app';
  id: string;
  label: string;
  appBuiltin?: boolean;
}

/** 删除资源结果：被启用规则引用且未 force 时不删，回传 needConfirm + 引用规则明细（供前端分组展开确认列出）。 */
export interface RuleResourceDeleteResult {
  ok: boolean;
  needConfirm?: boolean;
  referencingRules?: RuleResourceRef[];
}

/** 下载入参：catalogId（内置/动态项）或 url（手动，name 可选自动生成）。id/category 仅 redownload 内部用于保留原 id。 */
export interface RuleResourceDownloadItem {
  catalogId?: string;
  url?: string;
  name?: string;
  id?: string;
  category?: RuleResourceCategory;
}

export interface RuleResourceDownloadResult {
  ok: boolean;
  resource?: RuleResource;
  error?: string;
  errorCode?: string;
  id?: string;
  name?: string;
  /** 下载前目标文件是否已存在：用于收窄重启判定（已存在=内容更新，sing-box ≥1.10 热重载，无需重启）。 */
  existedBefore?: boolean;
}

export interface RuleResourceProgress {
  id: string;
  name: string;
  received: number;
  total: number | null;
  percent: number | null;
  status: 'queued' | 'downloading' | 'done' | 'error';
  error?: string;
  errorCode?: string;
}

export interface RuleResourceCatalogResult {
  items: RuleResourceCatalogItem[];
  fetchedAt: number | null;
  source: 'remote' | 'cache' | 'builtin';
}

// 应用分流规则（实验性）- 映射到内置 geosite 规则集
export interface AppRule {
  /** 应用 ID，对应 APP_PRESETS 中的 id 或 customAppPresets 中的 id */
  appId: string;
  /** 流量策略 */
  action: RuleAction;
  /** 是否启用 */
  enabled: boolean;
  /** 目标代理服务器 ID (仅当 action === 'proxy' 时有效) */
  targetServerId?: string;
}

/** 自定义应用分流预设（用户手动添加） */
export interface CustomAppPreset {
  id: string;
  name: string;
  emoji: string;
  /** 图标 URL（Qure Color 等彩色图标集的应用图标） */
  iconUrl?: string;
  geositeTags: string[];
  geoipTags?: string[];
}
