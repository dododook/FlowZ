import type { RuleType, RuleCondition } from './types/rules';

const isProcessRuleType = (t: RuleType): boolean => t === 'processName' || t === 'processPath';

/**
 * 判断一条自定义规则是否含进程匹配条件（processName/processPath）。
 *
 * 这类规则平台特定（进程名/路径在 win/mac/linux 各异，如 chrome.exe / Google Chrome / chrome），
 * 跨平台 backup 导入会静默失效。导入侧据此【禁用】（enabled=false，保留供重映射，不静默移除/失效），
 * 详见 docs/design/config-portability.md §3。覆盖首条件镜像(type)与多条件(conditions[]) 两种承载。
 */
export function ruleHasProcessCondition(rule: {
  type: RuleType;
  conditions?: RuleCondition[];
}): boolean {
  if (isProcessRuleType(rule.type)) return true;
  return (rule.conditions ?? []).some((c) => isProcessRuleType(c.type));
}
