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
// 本文件内 interface 也用到 ProxyModeType，需本地绑定（re-export 不产生本地可用绑定）
import type { ProxyModeType } from '../../shared/types';
export type ProxyMode = 'global' | 'smart' | 'direct';
export type ProtocolType =
  | 'vless'
  | 'trojan'
  | 'hysteria2'
  | 'shadowsocks'
  | 'anytls'
  | 'tuic'
  | 'vmess'
  | 'naive'
  | 'socks'
  | 'http'
  | 'ssh';

// 兼容旧代码的类型别名
export type ServerConfigWithId = import('../../shared/types').ServerConfig;

// 连接状态类型
export interface ConnectionStatus {
  proxyCore: {
    running: boolean;
    pid?: number;
    uptime?: number;
    error?: string;
  };
  proxy: {
    enabled: boolean;
    server?: string;
  };
  proxyModeType: ProxyModeType;
}

// 事件数据类型
export interface NativeEventData {
  processStarted: { pid: number; timestamp: string };
  processStopped: { timestamp: string };
  processError: { error: string; timestamp: string };
  configChanged: { key?: string; oldValue?: any; newValue?: any };
  statsUpdated: any;
  navigateToPage: string;
  proxyModeSwitched: { success: boolean; newMode: string };
  proxyModeSwitchFailed: { success: boolean; error: string };
}

export type NativeEventListener<K extends keyof NativeEventData> = (
  data: NativeEventData[K]
) => void;
