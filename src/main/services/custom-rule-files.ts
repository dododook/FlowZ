/**
 * 自定义规则外化为 per-rule local rule_set（source headless）的单一真值决策模块（纯函数，可单测）。
 *
 * 目的：把「全条件可 headless 表达」的启用 customRule 写成独立 `<userData>/custom-rules/custom-rule-<id>.json`
 * 文件，route 规则固化为 `{rule_set:<base>}`；编辑规则「值」→ 原子替换文件 → sing-box fswatch 热重载、零重启。
 *
 * 关键不变量：本模块的「可外化判定 / 值翻译 / mergeable·fail-closed·logical 结构」必须与 ProxyManager
 * generateCustomRules（route 侧）和 generateDnsConfig 的 bypassFakeIP 块（DNS 侧）**逐字等价**——
 * ProxyManager 的 EXT 类型分支与 DNS 提取应委托本模块，避免双份逻辑漂移。
 */
import { createHash } from 'crypto';
import type { Rule, RuleCondition, RuleType, UserConfig } from '../../shared/types';
import { parsePortValues, ruleConditions } from '../../shared/rules';

/** 可外化的条件类型：均有 headless source 等价字段（geosite/geoip/ruleSet 不可——headless 不能嵌套 rule_set）。 */
export const EXT_TYPES: ReadonlySet<RuleType> = new Set<RuleType>([
  'domain',
  'domainSuffix',
  'domainKeyword',
  'domainRegex',
  'ipCidr',
  'sourceIpCidr',
  'port',
  'sourcePort',
  'processName',
  'processPath',
]);

/** 目的地 OR 组：单条 default rule 内这些字段原生 OR（与 generateCustomRules:2930 一致）。 */
const OR_GROUP: ReadonlySet<RuleType> = new Set<RuleType>([
  'domain',
  'domainSuffix',
  'domainKeyword',
  'domainRegex',
  'ipCidr',
]);

function trimVals(cond: RuleCondition): string[] {
  return (cond.values || []).map((v) => v.trim()).filter(Boolean);
}

/**
 * 单个 EXT 条件 → headless matcher 字段对象（与 applyConditionFields 的 EXT 分支逐字等价）。
 * 无有效值（含端口全非法）→ null（= 现 hasMatcher=false 语义）。非 EXT 类型 → null。
 */
export function condMatcherFields(cond: RuleCondition): Record<string, unknown> | null {
  const vals = trimVals(cond);
  if (vals.length === 0) return null;
  switch (cond.type) {
    case 'domain':
      return { domain: vals };
    case 'domainSuffix':
      // domain_suffix 匹配该域名及子域名；剥 *. 前缀（与 route 侧一致）
      return { domain_suffix: vals.map((d) => (d.startsWith('*.') ? d.slice(2) : d)) };
    case 'domainKeyword':
      return { domain_keyword: vals };
    case 'domainRegex':
      return { domain_regex: vals };
    case 'ipCidr':
      return { ip_cidr: vals };
    case 'sourceIpCidr':
      return { source_ip_cidr: vals };
    case 'port': {
      const { ports, ranges } = parsePortValues(vals);
      if (!ports.length && !ranges.length) return null;
      const o: Record<string, unknown> = {};
      if (ports.length) o.port = ports;
      if (ranges.length) o.port_range = ranges;
      return o;
    }
    case 'sourcePort': {
      const { ports, ranges } = parsePortValues(vals);
      if (!ports.length && !ranges.length) return null;
      const o: Record<string, unknown> = {};
      if (ports.length) o.source_port = ports;
      if (ranges.length) o.source_port_range = ranges;
      return o;
    }
    case 'processName':
      return { process_name: vals };
    case 'processPath':
      return { process_path: vals };
    default:
      return null;
  }
}

/** 合并字段（值并集，保序去重无关——sing-box 数组内 OR）。 */
function mergeFields(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const k of Object.keys(src)) {
    const prev = (target[k] as unknown[] | undefined) || [];
    target[k] = [...prev, ...(src[k] as unknown[])];
  }
}

/**
 * bypassFakeIP 规则的 DNS 域名 headless 规则（与 generateDnsConfig:1447-1476 提取逐字等价）。
 * domain_suffix 用 flatMap [d, '.d'] 形态（保留 DNS 侧今日编码），与 route 侧裸后缀刻意不同。
 */
function dnsHeadlessRules(rule: Rule): object[] | null {
  if (!rule.bypassFakeIP) return null;
  const domain: string[] = [];
  const suffix: string[] = [];
  const keyword: string[] = [];
  for (const cond of ruleConditions(rule)) {
    const vals = trimVals(cond);
    if (vals.length === 0) continue;
    if (cond.type === 'domain') domain.push(...vals);
    else if (cond.type === 'domainSuffix')
      suffix.push(...vals.map((d) => (d.startsWith('*.') ? d.slice(2) : d)));
    else if (cond.type === 'domainKeyword') keyword.push(...vals);
  }
  if (!domain.length && !suffix.length && !keyword.length) return null;
  const m: Record<string, unknown> = {};
  if (domain.length) m.domain = domain;
  if (suffix.length) m.domain_suffix = suffix.flatMap((d) => [d, `.${d}`]);
  if (keyword.length) m.domain_keyword = keyword;
  return [m];
}

export type RulePlan =
  | { kind: 'inline' } // 任一条件 ∉ EXT_TYPES（geo/ruleSet/混合）→ 保持 ProxyManager inline 生成
  | { kind: 'ext-skip'; dnsRules: object[] | null } // 全 EXT 但 fail-closed 跳过 route；DNS 侧仍可能消费
  | { kind: 'ext'; fileRules: object[]; dnsRules: object[] | null };

/**
 * 规则外化计划（mergeable/fail-closed/logical 判定与 generateCustomRules:3046-3095 逐字等价）。
 * 仅依赖 rule 自身，不依赖 config（geo/ruleSet 已由 EXT 判定排除，无需 ruleResources）。
 */
export function planCustomRule(rule: Rule): RulePlan {
  const rawConds = ruleConditions(rule);
  if (rawConds.some((c) => !EXT_TYPES.has(c.type))) return { kind: 'inline' };

  const dnsRules = dnsHeadlessRules(rule);
  const conds = rawConds
    .map((c) => ({ type: c.type, values: trimVals(c) }))
    .filter((c) => c.values.length > 0);
  if (conds.length === 0) return { kind: 'ext-skip', dnsRules };
  // AND 模式任一条件值全空被丢 → 整条跳过（fail-closed，与 :3060 一致）
  if (rule.combineMode === 'and' && conds.length < rawConds.length)
    return { kind: 'ext-skip', dnsRules };

  const mergeable =
    conds.length === 1 || (rule.combineMode !== 'and' && conds.every((c) => OR_GROUP.has(c.type)));

  let fileRules: object[] | null = null;
  if (mergeable) {
    const merged: Record<string, unknown> = {};
    let has = false;
    for (const c of conds) {
      const f = condMatcherFields(c as RuleCondition);
      if (f) {
        mergeFields(merged, f);
        has = true;
      }
    }
    if (has) fileRules = [merged];
  } else {
    const subRules: Record<string, unknown>[] = [];
    let dropped = false;
    for (const c of conds) {
      const f = condMatcherFields(c as RuleCondition);
      if (f) subRules.push(f);
      else dropped = true;
    }
    if (rule.combineMode === 'and' && dropped)
      fileRules = null; // fail-closed（与 :3083 一致）
    else if (subRules.length === 1) fileRules = [subRules[0]];
    else if (subRules.length > 1)
      fileRules = [{ type: 'logical', mode: rule.combineMode || 'or', rules: subRules }];
  }
  if (!fileRules) return { kind: 'ext-skip', dnsRules };
  return { kind: 'ext', fileRules, dnsRules };
}

/** 文件名安全的 base：id 仅 [A-Za-z0-9_-] → custom-rule-<id>；否则 hash（旧 id 可能含任意字符）。 */
export function customRuleFileBase(id: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(id)) return `custom-rule-${id}`;
  return `custom-rule-h${createHash('sha1').update(id).digest('hex').slice(0, 12)}`;
}

/**
 * 是否启用 FakeIP（与 generateDnsConfig 的 enableFakeIp 同源，单一真值）：纯看开关，不分模式。
 * 缺省 true（新装默认开 + 存量经一次性迁移写入 effective 值，见 ConfigManager.migrateFakeIpToggle）。
 * 改前曾按 proxyModeType 分模式（非 systemProxy 恒开）——已统一到开关，TUN/systemProxy 行为一致。
 */
export function usesFakeIp(config: UserConfig): boolean {
  return config.dnsConfig?.enableFakeIp ?? true;
}

/**
 * 当前配置「应存在的外化文件全集」：fileName → JSON 内容。
 * 仅 smart 模式外化：global/direct 下 generateCustomRules 不执行（用户路由不生效）→ rule_set 不注册 → 文件无消费者。
 * 启动落盘与孤儿对账清扫都以此为期望集（非 smart 返空集 → 已存在的外化文件被当孤儿清扫）。
 */
export function buildCustomRuleFiles(config: UserConfig): Map<string, string> {
  const out = new Map<string, string>();
  if ((config.proxyMode || 'smart').toLowerCase() !== 'smart') return out;
  const fakeIp = usesFakeIp(config);
  for (const rule of config.customRules || []) {
    if (!rule.enabled) continue;
    const plan = planCustomRule(rule);
    if (plan.kind === 'inline') continue;
    const base = customRuleFileBase(rule.id);
    if (plan.kind === 'ext') {
      out.set(`${base}.json`, JSON.stringify({ version: 1, rules: plan.fileRules }, null, 2));
    }
    // DNS 文件：ext 与 ext-skip 都可能要（route 跳过但 DNS 仍消费 bypass 域名值）
    if (fakeIp && plan.dnsRules) {
      out.set(`${base}.dns.json`, JSON.stringify({ version: 1, rules: plan.dnsRules }, null, 2));
    }
  }
  return out;
}
