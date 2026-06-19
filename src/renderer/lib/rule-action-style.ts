/**
 * 规则 action 统一配色映射（语义 token）。
 * 供 connections-table、sortable-rule-row、connection-topology 共用，保证三处视觉一致。
 *
 * proxy  → primary（主色蓝）
 * direct → success（绿）
 * block  → destructive（红）
 */

import type { TFunction } from 'i18next';

export type RuleAction = 'proxy' | 'direct' | 'block' | string;

export interface RuleActionStyle {
  /** 实心圆点颜色 class（拓扑图节点点），如 "bg-primary" */
  dot: string;
  /** 文字颜色 class，如 "text-primary"（也用作淡色调 badge 的字色） */
  text: string;
  /** badge 淡色调背景 class（半透明），如 "bg-primary/15"——配合 text 同色字，深色模式去眩光，对齐资源缺失/覆盖组网角标 */
  badgeBg: string;
  /** badge hover 背景 class，如 "hover:bg-primary/25" */
  badgeBgHover: string;
}

export function getRuleActionStyle(action: RuleAction): RuleActionStyle {
  const a = (action || '').toLowerCase();
  if (a === 'direct') {
    return {
      dot: 'bg-success',
      text: 'text-success',
      badgeBg: 'bg-success/15',
      badgeBgHover: 'hover:bg-success/25',
    };
  }
  if (a === 'block' || a === 'reject' || a === 'reject-drop' || a === 'drop') {
    return {
      dot: 'bg-destructive',
      text: 'text-destructive',
      badgeBg: 'bg-destructive/15',
      badgeBgHover: 'hover:bg-destructive/25',
    };
  }
  // proxy 及具体节点名
  return {
    dot: 'bg-primary',
    text: 'text-primary',
    badgeBg: 'bg-primary/15',
    badgeBgHover: 'hover:bg-primary/25',
  };
}

/**
 * 规则 action → i18n 中文 label。
 * 仅映射 proxy/direct/block 三个语义值（未知值容错回落 proxy label）。
 * key 使用 'rules.proxy' / 'rules.direct' / 'rules.block'，与 sortable-rule-row 保持一致。
 */
export function ruleActionLabel(action: RuleAction, t: TFunction): string {
  const a = (action || '').toLowerCase();
  if (a === 'direct') return t('rules.direct');
  if (a === 'block' || a === 'reject' || a === 'reject-drop' || a === 'drop')
    return t('rules.block');
  return t('rules.proxy');
}
