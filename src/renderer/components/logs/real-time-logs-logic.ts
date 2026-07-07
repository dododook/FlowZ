import type { LogEntry } from '@/bridge/types';

/**
 * 实时日志的纯逻辑（与 React 无关，便于在 node/.ts jest 下单测）。
 * 从 real-time-logs.tsx 抽出的搜索匹配 / 环形缓冲截断 / 级别配色映射，
 * 组件层只做订阅与渲染。
 */

/**
 * 搜索匹配：消息或级别子串命中（大小写不敏感）。
 * 空 term → 全部命中（`''.includes('')===true`，与原内联 filter 行为一致）。
 */
export function logMatchesSearch(log: Pick<LogEntry, 'message' | 'level'>, term: string): boolean {
  const q = term.toLowerCase();
  return log.message.toLowerCase().includes(q) || log.level.toLowerCase().includes(q);
}

/**
 * 环形缓冲截断：仅保留最新 max 条（超出则从尾部取）。
 * 未超限时原样返回同一引用，保持 setState 幂等、避免无谓重渲。
 */
export function truncateToBuffer<T>(rows: T[], max: number): T[] {
  return rows.length > max ? rows.slice(-max) : rows;
}

/** 级别 → 文字配色类（等宽日志级别标签/消息）。fatal 与 error 同 destructive。 */
export function getLevelColorClass(level: LogEntry['level']): string {
  switch (level) {
    case 'error':
    case 'fatal':
      return 'text-destructive';
    case 'warn':
      return 'text-warning';
    case 'info':
      return 'text-info';
    case 'debug':
      return 'text-muted-foreground';
    default:
      return 'text-foreground';
  }
}

/**
 * 级别 → 行容器「形编码」类（左脊 + 底色，独立于文字色，形+色双编码）。
 * info/debug/默认给透明左脊占位，保持等宽对齐不跳动。
 */
export function getLevelRowClass(level: LogEntry['level']): string {
  switch (level) {
    case 'error':
    case 'fatal':
      return 'border-s-2 border-destructive bg-destructive/5';
    case 'warn':
      return 'border-s-2 border-warning/60';
    default:
      return 'border-s-2 border-transparent';
  }
}
