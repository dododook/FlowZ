/**
 * 规则编辑对话框的纯逻辑（无 react/store/@别名依赖）：表单校验、提交值派生。
 * 从 rule-dialog 抽出以便 .test.ts 直接覆盖「条件校验 / 策略派生」矩阵，并把提交前
 * 校验从 toast 迁到内联（单一真值：UI 与提交 gate 同一函数）。
 */
import type { RuleType, RuleAction } from '../../../shared/types';
import { validateRuleValue, BYPASS_FAKEIP_TYPES } from '../../../shared/rules';
import { parseLines } from '../../../shared/parse-lines';

/** 单条件块的字段级错误：empty=未填值 / invalid=含非法值（empty 优先）。 */
export type ConditionError = 'empty' | 'invalid';

export interface RuleFormErrors {
  /** 按条件类型的字段级错误（键存在即该块出错）。 */
  conditions: Partial<Record<RuleType, ConditionError>>;
  /** 备注名必填未填。 */
  remarksRequired?: boolean;
}

/**
 * 收集表单字段级错误（提交 gate + 内联展示共用，替代原 toast）。
 * 每个条件块：解析后无值→empty；含非法值→invalid。备注名 trim 后为空→remarksRequired。
 */
export function collectRuleFormErrors(
  conditionTypes: RuleType[],
  valuesByType: Partial<Record<RuleType, string>>,
  remarks: string
): RuleFormErrors {
  const conditions: Partial<Record<RuleType, ConditionError>> = {};
  for (const ct of conditionTypes) {
    const values = parseLines(valuesByType[ct] ?? '');
    if (values.length === 0) {
      conditions[ct] = 'empty';
    } else if (values.some((v) => !validateRuleValue(ct, v))) {
      conditions[ct] = 'invalid';
    }
  }
  const errors: RuleFormErrors = { conditions };
  if (!remarks.trim()) errors.remarksRequired = true;
  return errors;
}

/** 是否存在任一字段级错误（提交 gate）。 */
export function hasRuleFormErrors(errors: RuleFormErrors): boolean {
  return errors.remarksRequired === true || Object.keys(errors.conditions).length > 0;
}

/**
 * 目标节点「跟随全局」哨兵 id：选它表示不锁具体节点、跟随全局出口。UI 选项 id、state 初值、
 * 提交派生共用此常量（取代散落的裸 'default' 字面量，杜绝一处改漏）。
 */
export const FOLLOW_GLOBAL_NODE_ID = 'default';

/** 提交值派生：目标节点哨兵（跟随全局）→ undefined，其余原样。 */
export function deriveTargetServerId(targetServerId: string): string | undefined {
  return targetServerId === FOLLOW_GLOBAL_NODE_ID ? undefined : targetServerId;
}

/** bypassFakeIP 是否适用：任一条件为域名类（domain/domainSuffix/domainKeyword）。 */
export function isBypassApplicable(conditionTypes: RuleType[]): boolean {
  return conditionTypes.some((ct) => BYPASS_FAKEIP_TYPES.includes(ct));
}

/**
 * 持久化的 bypassFakeIP：不适用 → undefined；适用 → 与 UI checked 对齐（全局 FakeIP 关时天然 no-op → false）。
 * 与 rule-dialog 原 `bypassApplicable ? globalFakeIpEnabled && bypassFakeIP : undefined` 等价。
 */
export function deriveBypassFakeIp(
  applicable: boolean,
  globalFakeIpEnabled: boolean,
  bypassFakeIP: boolean
): boolean | undefined {
  return applicable ? globalFakeIpEnabled && bypassFakeIP : undefined;
}

/** action 非代理时不应展示/写入目标节点（当前 UI 仅代理显目标节点选择器）。 */
export function showsTargetNode(action: RuleAction): boolean {
  return action === 'proxy';
}
