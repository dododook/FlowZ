/**
 * Bridge types for compatibility with old code
 * Re-exports types from shared types
 */

export type {
  UserConfig,
  ServerConfig,
  Rule,
  RuleType,
  RuleCondition,
  SystemProcessInfo,
  ProxyStatus,
  TrafficStats,
  LogEntry,
  ApiResponse,
  SubscriptionConfig,
  ImportParseResult,
  ProxyMode,
  ProxyModeType,
  IpInfo,
  IpInfoSnapshot,
  RuleResource,
  RuleResourceListItem,
  RuleResourceCatalogItem,
  RuleResourceCatalogResult,
  RuleResourceProgress,
  RuleResourceCategory,
  RuleResourceDownloadItem,
  RuleResourceDownloadResult,
  RuleResourceRef,
} from '../../shared/types';

// 一致性 review H4：原手抄 Protocol 联合 14 项（新增协议易漏同步）。改为从 Protocol alias，
// 自动跟随 shared/types.ts 真值，消除"协议清单假对齐"漂移源。
import type { Protocol as ProtocolT } from '../../shared/types';
export type ProtocolType = ProtocolT;
