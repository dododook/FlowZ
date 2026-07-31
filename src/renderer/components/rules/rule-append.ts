/**
 * 「把一个观测到的主机名追加进**已有**规则」的纯判据与纯变换（issue #336）。
 *
 * 放在 `.ts` 而非 `.tsx` 里：本仓 jest 是 node 环境、`testMatch` 只收 `*.test.ts`（jest.config.js），
 * 判据留在组件里等于没有门。逐类型语义一条都不在这里 —— 值合法性在 `shared/rules.ts` 的
 * `validateRuleValue`，条件遍历在 `ruleConditions`，类型分组在 `RULE_TYPE_CATEGORY`。
 *
 * # 为什么「加入已有规则」不是锦上添花，而是这条路上常常唯一有效的动作（两条硬事实）
 *
 * 1. **新建的规则恒落列表末尾**（右键直写腿 `[...customRules, newRule]`），而 sing-box 路由是
 *    **先匹配先生效**（`buildCustomRules` 按数组序产出 route 规则）。前面已有规则能命中同一域名时，
 *    新建的那条压根不生效，且原来的 UI 零提示。
 * 2. **往「全条件可外化」的规则里追加值零重启**：那类规则的值只落独立 rule_set 文件，原子替换后
 *    sing-box fswatch 热重载（`custom-rule-files.ts` 头注）；而**新建**规则必然改 config.json 的
 *    route 规则集合 ⇒ 走重启。
 *    ⚠️ 例外要如实说：规则若含不可外化条件（geosite/geoip/ruleSet/源设备类 → `planCustomRule` 判 inline），
 *    追加值同样改 config.json；**新开条件**还可能把规则的可外化性本身翻面。本模块不假装、也不据此拦人。
 *
 * # 候选面：**列出全部规则**，不能追加的置灰并逐条给原因
 *
 * 可追加有两条腿：
 *
 * 1. **规则已有域名族「字面量」条件** ⇒ 往那个条件里追加值。单条件内多值恒 OR
 *    （`buildCustomRules` 把同条件的值并进同一个 matcher 字段），纯扩宽、可预测。
 * 2. **规则没有能收下这个值的域名族条件，且 `combineMode !== 'and'`** ⇒ 为它**新开**一个
 *    {@link NEW_COND_TYPE} 条件。
 *
 * 第 2 条腿只对 `and` 关闭，判据在生成侧：`buildCustomRules` 里 `mergeable` 的条件是
 * 「单条件 或（`combineMode !== 'and'` 且全为 OR 组类型）」，logical 分支的 `mode` 取
 * `rule.combineMode || 'or'` —— 即 **`undefined` 与 `'or'` 走同一条路，默认就是 OR**。
 * ⇒ `or` 下「新开一个域名条件」与「往已有域名条件追加值」生成结果等价，都是纯 OR 扩宽；
 * 只有 `and` 是求交（「域名 AND 进程名」是语义完全不同的规则）。**故只有 `and` 置灰**，并指向规则弹窗
 * 显式编辑。单条件 + `combineMode:'and'` 也一样拦：那个 `and` 今天是潜伏的（单条件走 mergeable、模式不起
 * 作用），新开第二个条件会把它**激活**成求交；UI 不能替用户把它悄悄改成 `or`。
 *
 * - **`domainRegex` 永不作为追加目标**：把字面主机名塞进正则表需要转义（`.` 会从字面点变成通配符），
 *   是正确性陷阱。但「只有 `domainRegex` 条件」的规则**不因此被排除** —— 它走第 2 条腿新开一个字面量条件。
 * - **`domainKeyword` 保留**，但调用方必须显式标出类型：整个主机名当关键词是**更窄**的匹配
 *   （`example.com` 也会命中 `notexample.com.evil.tld` 这类子串），用户看到类型才知道自己拿到了什么。
 * - **禁用规则也是合法目标**（用户可能在攒一条待启用的规则），但要标出禁用态。
 */
import type { Rule, RuleCondition, RuleType } from '../../../shared/types';
import {
  RULE_TYPE_IDS,
  RULE_TYPE_CATEGORY,
  ruleConditions,
  validateRuleValue,
} from '../../../shared/rules';

/**
 * 可作为追加目标的条件类型 —— 域名族里**值是字面主机名**的那三个。
 *
 * 派生自 `RULE_TYPE_CATEGORY`（不另立第二张类型表），只显式减掉 `domainRegex` 那一个：它的值是
 * **模式**不是字面量，是本模块唯一需要点名的例外。将来若新增域名类型：模式类加进下面这个排除集，
 * 字面量类自动被纳入而无需改代码。
 */
const PATTERN_DOMAIN_TYPES: ReadonlySet<RuleType> = new Set<RuleType>(['domainRegex']);

export const APPENDABLE_HOST_TYPES: readonly RuleType[] = RULE_TYPE_IDS.filter(
  (id) => RULE_TYPE_CATEGORY[id] === 'domain' && !PATTERN_DOMAIN_TYPES.has(id)
);

const APPENDABLE = new Set<RuleType>(APPENDABLE_HOST_TYPES);

/**
 * 新开条件时用的类型 —— 与右键「加入自定义规则」直写腿**同一个常量**，两条腿产出同形规则。
 * `domainSuffix` = 匹配该域名及其全部子域名，是右键场景（观测到一个主机名）最合意图的一档。
 */
export const NEW_COND_TYPE: RuleType = 'domainSuffix';

/**
 * 这个名字能不能当规则值用（拓扑中列节点名可能是 host / destIP / rule 名）。
 * 判据保持宽松（含 `.` 或 `:`）—— 真正的形状校验在 `validateRuleValue`，这里只挡掉「其他」这类聚合名。
 */
export function isRuleableHost(name: string): boolean {
  const v = name.trim();
  return v.length > 0 && (v.includes('.') || v.includes(':'));
}

/**
 * 不可追加的原因（`null` = 可追加）。**每一项都指向一条具体出路**，不是笼统的「不可追加」。
 *
 *  - `contains`    该条件已含这个值 —— 成功的无事可做，不是失败。
 *  - `andMode`     规则要求「全部条件都命中」且没有能收下这个值的域名条件 —— 新开条件会变成求交
 *                  而非扩宽，去规则弹窗显式编辑。
 *  - `valueUnfit`  这个值本身进不了域名字面量条件（典型是 IPv6 地址：`isRuleableHost` 只看含 `.` 或 `:`，
 *                  故 `2606:4700::1` 会走到这里，而它过不了 `domainSuffix` 的域名形状校验）。
 */
export type AppendBlock = 'contains' | 'andMode' | 'valueUnfit';

/** 一个「往哪条规则的哪个条件里追加」的目标。**每条规则至少一项**（不能追加的带 `block`）。 */
export interface RuleAppendTarget {
  readonly ruleId: string;
  /** 规则在规则数组里的下标 = 优先级（越小越先匹配）。 */
  readonly ruleIndex: number;
  /** 规则备注（空串 = 无备注，由渲染层回落成类型名 + 首值）。 */
  readonly remarks: string;
  readonly enabled: boolean;
  /**
   * 规则自身的镜像（= `conditions[0]` 的类型与值）—— **认规则**用，与下面的 `type`/`values`
   * （**认目标条件**）是两码事。没有目标条件的行（新开腿 / 置灰行）第二行放的是说明或原因，
   * 认不出是哪条规则，就得靠这一对把规则身份写进第一行。
   */
  readonly ruleType: RuleType;
  readonly ruleValues: readonly string[];
  /**
   * 目标条件下标。`>= 0` = 索引进 `ruleConditions(rule)`；`-1` = **为该规则新开一个条件**
   * （`block !== null` 时同样是 `-1`，那种行根本没有目标）。
   */
  readonly condIndex: number;
  /** 目标条件的类型（新开腿 = {@link NEW_COND_TYPE}；`block !== null` 时回落成 `ruleType`，无意义）。 */
  readonly type: RuleType;
  /** 目标条件的现有值（新开腿与 `block !== null` 时为空）。 */
  readonly values: readonly string[];
  /** `null` = 可追加；否则 = 不可追加的原因（渲染层据此置灰 + 逐条说明）。 */
  readonly block: AppendBlock | null;
  /** 检索语料（已小写）。**置灰项同样参与检索** —— 搜得到规则名却搜不到规则，用户会以为规则不存在。 */
  readonly search: readonly string[];
}

const lower = (v: string): string => v.trim().toLowerCase();

/** 条件的值数组（防御非数组 / 非字符串：旁路 `config:save` 可注入）。 */
function condValues(cond: RuleCondition): string[] {
  return Array.isArray(cond.values)
    ? cond.values.filter((v): v is string => typeof v === 'string')
    : [];
}

/**
 * 全部规则的追加目标（每条规则至少一项；顺序 = 规则顺序 → 条件顺序，**未排序**）。
 *
 * `validateRuleValue` 这道过滤是 **fail-closed**：不置灰就点得下去的必须存得下去。上架一个点一下就
 * 在保存时被后端 `validateRule` 拒掉的目标，比把它置灰并说明原因更糟。
 *
 * 排序不在这里做（{@link sortAppendTargets} 单独一支）：本函数的产物要能被「顺序 = 规则顺序」的断言直接检查。
 */
export function ruleAppendTargets(rules: readonly Rule[], value: string): RuleAppendTarget[] {
  const v = value.trim();
  if (!v) return [];
  const lv = v.toLowerCase();
  const out: RuleAppendTarget[] = [];
  rules.forEach((rule, ruleIndex) => {
    const conds = ruleConditions(rule).filter((c): c is RuleCondition => !!c);
    const remarks = (rule.remarks ?? '').trim();
    const ruleType = conds[0]?.type ?? rule.type;
    const ruleValues = conds[0] ? condValues(conds[0]) : [];
    // 检索语料按**整条规则**取（不按单个条件）：一条规则的任一个值都该能把它搜出来。
    const search = [remarks, ruleType, ...conds.flatMap((c) => [c.type, ...condValues(c)])]
      .filter(Boolean)
      .map((s) => s.toLowerCase());
    const base = {
      ruleId: rule.id,
      ruleIndex,
      remarks,
      enabled: rule.enabled === true,
      ruleType,
      ruleValues,
      search,
    };

    const hits = conds
      .map((cond, condIndex) => ({ cond, condIndex }))
      .filter(({ cond }) => APPENDABLE.has(cond.type) && validateRuleValue(cond.type, v));

    if (hits.length > 0) {
      for (const { cond, condIndex } of hits) {
        const values = condValues(cond);
        out.push({
          ...base,
          condIndex,
          type: cond.type,
          values,
          block: values.some((x) => lower(x) === lv) ? 'contains' : null,
        });
      }
      return;
    }

    // 没有能收下这个值的既有条件 ⇒ 新开条件腿（失败原因二选一，值不合形状优先于组合模式）。
    const block: AppendBlock | null = !validateRuleValue(NEW_COND_TYPE, v)
      ? 'valueUnfit'
      : rule.combineMode === 'and'
        ? 'andMode'
        : null;
    out.push({
      ...base,
      condIndex: -1,
      type: block === null ? NEW_COND_TYPE : ruleType,
      values: [],
      block,
    });
  });
  return out;
}

/**
 * 展示顺序：可追加在前 → 已包含 → 其余置灰，**同档内保持规则顺序**（顺序 = 优先级，不许打乱）。
 *
 * `contains` 单独一档而不与其它置灰项混在一起：它是「已经做到了」，与「做不到」不是一回事，
 * 混排会让用户在一堆做不到里翻找那条其实已经覆盖了的规则。
 */
const RANK: Record<AppendBlock | 'ok', number> = { ok: 0, contains: 1, andMode: 2, valueUnfit: 2 };

export function sortAppendTargets(targets: readonly RuleAppendTarget[]): RuleAppendTarget[] {
  return targets
    .map((t, i) => ({ t, i }))
    .sort((a, b) => RANK[a.t.block ?? 'ok'] - RANK[b.t.block ?? 'ok'] || a.i - b.i)
    .map(({ t }) => t);
}

/** 按检索词过滤（空词 = 原样副本）。 */
export function matchAppendTargets(
  targets: readonly RuleAppendTarget[],
  query: string
): RuleAppendTarget[] {
  const q = query.trim().toLowerCase();
  if (!q) return targets.slice();
  return targets.filter((t) => t.search.some((s) => s.includes(q)));
}

/**
 * 追加一个值，产出**整条**新规则；无事可做 / 目标漂移 / 目标本就置灰 ⇒ `null`（调用方按 no-op 处理）。
 *
 * 三条约束，每条都必须在写入侧成立：
 *  1. **`{ ...base }` 起底**：保全 `tlsSpoof` / `targetServerId` / `bypassFakeIP` 这类不在本函数视野里的字段。
 *  2. **镜像不变式**：`Rule.type` / `Rule.values` 恒 = `conditions[0]` 的镜像（契约见 `types/rules.ts`：
 *     「首条件镜像，恒与 conditions[0] 一致」）。新开的条件**追加在末尾**，故 `conditions[0]` 不动；
 *     镜像仍从 `next[0]` 现算，不靠「它没变」的假设。
 *  3. **目标漂移防御**：从「打开选择器」到「点下某一项」之间，规则可能被别处改过。既有条件腿是位置寻址，
 *     位置上换了别的类型就必须放弃；新开条件腿则要复核**判据本身**仍成立（还是没有能收下这个值的同族条件、
 *     还不是 `and`）—— 否则会在一条已有域名条件的规则上再挂一个多余条件，或者把条件挂进一条已被改成求交的规则。
 *
 * 单条件规则保持单条件形态（`conditions` / `combineMode` 显式清成 `undefined`），与规则弹窗提交腿同形。
 */
export function appendValueToRule(
  base: Rule,
  target: RuleAppendTarget,
  value: string
): Rule | null {
  const v = value.trim();
  if (!v || base.id !== target.ruleId || target.block !== null) return null;
  const conds = ruleConditions(base).filter((c): c is RuleCondition => !!c);
  if (!validateRuleValue(target.type, v)) return null;

  let next: RuleCondition[];
  if (target.condIndex < 0) {
    // 新开条件腿：判据复核（漂移防御）——「不给 and 规则新开条件」这条线在写入侧同样有牙。
    if (base.combineMode === 'and') return null;
    if (conds.some((c) => APPENDABLE.has(c.type) && validateRuleValue(c.type, v))) return null;
    next = [...conds, { type: target.type, values: [v] }];
  } else {
    const cond = conds[target.condIndex];
    if (!cond || cond.type !== target.type || !APPENDABLE.has(cond.type)) return null;
    const values = condValues(cond);
    if (values.some((x) => lower(x) === v.toLowerCase())) return null; // 已包含 = 无事可做
    next = conds.map((c, i) =>
      i === target.condIndex ? { type: c.type, values: [...values, v] } : c
    );
  }

  const multi = next.length > 1;
  return {
    ...base,
    type: next[0].type,
    values: next[0].values,
    conditions: multi ? next : undefined,
    combineMode: multi ? base.combineMode : undefined,
  };
}

/**
 * 「哪些规则看起来会命中这个域名」+「顺序上第一条是谁」。
 *
 * ⚠️ **只能做提示，不能做门。** 权威匹配器在 sing-box 内核；这里是渲染端启发式，且**只判域名族条件**
 * （见 {@link condVerdict}）—— geosite / geoip / ipCidr / 进程 / 端口 这些条件渲染端根本无从判定，
 * 一律记 `unknown`。据此禁用「新建规则」= 把一个必然漏报的启发式升格成阻断闸门，故绝不阻断，
 * 只改排序与一行提示，文案也必须如实（「可能先命中」而不是「不会生效」）。
 *
 * 只看**已启用**规则：禁用规则不下发，遮蔽不了任何东西。注意这与 {@link ruleAppendTargets} 收禁用规则
 * 不矛盾 —— 那边问的是「能不能写进去」，这边问的是「写进去会不会被前面的先吃掉」。
 */
export interface DomainCoverage {
  /** 启发式命中该值的**已启用**规则 id。 */
  readonly coveredIds: ReadonlySet<string>;
  /** 顺序上第一条命中的规则下标（先匹配先生效 ⇒ 它就是实际生效的那条）；-1 = 无。 */
  readonly firstIndex: number;
  readonly firstId: string | null;
}

/** 单个条件对某主机名的判定。`unknown` = 渲染端判不了（**不是** miss，见下方合成规则）。 */
type CondVerdict = 'hit' | 'miss' | 'unknown';

/**
 * 逐条件判定。语义按各类型在 sing-box 的匹配面取，**宁可漏报不误报**：
 *  - `domain`        全等（大小写不敏感）；
 *  - `domainSuffix`  该域名本身或其子域名（与 UI 对该类型的说明一致）；
 *  - `domainKeyword` 子串；
 *  - `domainRegex`   正则 test；正则本身非法（存量脏值）→ `unknown`，不冒充 miss；
 *  - 其余类型        `unknown` —— 渲染端没有 geo 数据库/连接元数据，判不了就说判不了。
 */
function condVerdict(cond: RuleCondition, host: string): CondVerdict {
  const vals = condValues(cond)
    .map((v) => v.trim())
    .filter(Boolean);
  if (vals.length === 0) return 'miss';
  switch (cond.type) {
    case 'domain':
      return vals.some((v) => lower(v) === host) ? 'hit' : 'miss';
    case 'domainSuffix':
      return vals.some((v) => {
        const s = lower(v).replace(/^\./, '');
        return host === s || host.endsWith(`.${s}`);
      })
        ? 'hit'
        : 'miss';
    case 'domainKeyword':
      return vals.some((v) => host.includes(lower(v))) ? 'hit' : 'miss';
    case 'domainRegex':
      for (const v of vals) {
        try {
          if (new RegExp(v).test(host)) return 'hit';
        } catch {
          return 'unknown'; // 非法正则：判不了，别说成没命中
        }
      }
      return 'miss';
    default:
      return 'unknown';
  }
}

/**
 * 整条规则的判定。`unknown` 的合成方式是本函数唯一需要点名的取舍：
 *  - **or**：任一 `hit` 即 hit；否则只要还有 `unknown` 就记 unknown（可能命中，别说没命中）；
 *  - **and**：任一 `miss` 即 miss；否则只要还有 `unknown` 就记 unknown。
 * 最终只有确定的 `hit` 才算「覆盖」——提示宁可少给，不给错的。
 */
function ruleVerdict(rule: Rule, host: string): CondVerdict {
  const conds = ruleConditions(rule).filter((c): c is RuleCondition => !!c);
  if (conds.length === 0) return 'miss';
  const verdicts = conds.map((c) => condVerdict(c, host));
  if (rule.combineMode === 'and') {
    if (verdicts.includes('miss')) return 'miss';
    return verdicts.includes('unknown') ? 'unknown' : 'hit';
  }
  if (verdicts.includes('hit')) return 'hit';
  return verdicts.includes('unknown') ? 'unknown' : 'miss';
}

export function analyzeDomainCoverage(rules: readonly Rule[], value: string): DomainCoverage {
  const coveredIds = new Set<string>();
  let firstIndex = -1;
  let firstId: string | null = null;
  const host = lower(value);
  if (host) {
    rules.forEach((rule, i) => {
      if (rule.enabled !== true) return;
      if (ruleVerdict(rule, host) !== 'hit') return;
      coveredIds.add(rule.id);
      if (firstIndex < 0) {
        firstIndex = i;
        firstId = rule.id;
      }
    });
  }
  return { coveredIds, firstIndex, firstId };
}

/** 该目标是否被**更靠前**的规则遮蔽（追加进去可能不生效）。同样只是提示。 */
export function isShadowedTarget(coverage: DomainCoverage, target: RuleAppendTarget): boolean {
  return coverage.firstIndex >= 0 && coverage.firstIndex < target.ruleIndex;
}
