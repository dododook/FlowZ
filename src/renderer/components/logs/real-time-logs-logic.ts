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
 * max<=0 → 空数组（否则 slice(-0) 退化为 slice(0) 返全量；当前调用恒传正数、不可达，但导出函数须自洽）。
 */
export function truncateToBuffer<T>(rows: T[], max: number): T[] {
  if (max <= 0) return [];
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
 * 级别 → pill「形+色」类（低饱和 tint 底 + 语义文字色，含 border-transparent 以贴合 ui/badge outline 基座）。
 * 单一真值：日志页级别标（logs-page）与实时日志级别标共用此函数，杜绝「两处各自内联映射」漂移。
 * warn=警告 tint / error·fatal=危险 tint / 其余（info/debug/默认）=中性 muted。
 */
export function getLevelPillClass(level: LogEntry['level']): string {
  switch (level) {
    case 'error':
    case 'fatal':
      return 'border-transparent bg-destructive/15 text-destructive';
    case 'warn':
      return 'border-transparent bg-warning/15 text-warning';
    default:
      return 'border-transparent bg-muted text-muted-foreground';
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
