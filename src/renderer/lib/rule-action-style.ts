/**
 * 规则 action 统一配色映射（语义 token）。
 * 供 connections-table、sortable-rule-row、connection-topology 共用，保证三处视觉一致。
 *
 * proxy  → primary（主色蓝）
 * direct → success（绿）
 * block  → destructive（红）
 */

export type RuleAction = 'proxy' | 'direct' | 'block' | string;

export interface RuleActionStyle {
  /** 实心圆点颜色 class，如 "bg-primary" */
  dot: string;
  /** 文字颜色 class，如 "text-primary" */
  text: string;
  /** badge 背景色 class（实色），如 "bg-primary" */
  badgeBg: string;
  /** badge hover 背景色 class，如 "hover:bg-primary/90" */
  badgeBgHover: string;
}

export function getRuleActionStyle(action: RuleAction): RuleActionStyle {
  const a = (action || '').toLowerCase();
  if (a === 'direct') {
    return {
      dot: 'bg-success',
      text: 'text-success',
      badgeBg: 'bg-success',
      badgeBgHover: 'hover:bg-success/90',
    };
  }
  if (a === 'block' || a === 'reject' || a === 'reject-drop' || a === 'drop') {
    return {
      dot: 'bg-destructive',
      text: 'text-destructive',
      badgeBg: 'bg-destructive',
      badgeBgHover: 'hover:bg-destructive/90',
    };
  }
  // proxy 及具体节点名
  return {
    dot: 'bg-primary',
    text: 'text-primary',
    badgeBg: 'bg-primary',
    badgeBgHover: 'hover:bg-primary/90',
  };
}
