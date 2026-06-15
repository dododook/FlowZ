/**
 * 规则资源引用枚举（单一真值，纯函数）——回答「某个规则资源(geo/.srs)被哪些启用规则引用」。
 *
 * 历史缺口：原 RuleResourceManager 只扫 customRules 的 `ruleSet/res:<id>` 引用，**漏**两类：
 *   ① customRules 的 geosite/geoip **类型条件**（值是裸 tag，如 `youtube` → 资源 id `geosite-youtube`）；
 *   ② 应用分流 appRules（经 preset.geositeTags/geoipTags 间接引用同款 geo 资源）。
 * 后果：删除这些 geo 资源时不提示（删除提醒不全）；下载/补回 geo 资源后不触发 core reload（规则不自动恢复）。
 *
 * 本模块把三类引用收口到一处，供：删除确认明细 / referencedBy 计数 / 下载·删除的 reload 判定 共用，
 * 确保「下载恢复 → reload → 规则自动恢复」闭环成立、删除提醒诚实完整。
 *
 * 纯函数、无 I/O、无 electron 依赖 → 可单测（见 __tests__/rule-resource-refs.test.ts）。
 */
import type { Rule, AppRule, CustomAppPreset, RuleResourceRef } from './types';
import { ruleConditions } from './rules';
import { getAppPreset } from './app-rules-preset';

export type { RuleResourceRef };

export interface RefScanInput {
  customRules?: Rule[];
  appRules?: AppRule[];
  customAppPresets?: CustomAppPreset[];
}

/** 归一 resId 为 geo tag：`builtin:geosite-x` → `geosite-x`；其余原样（`geosite-amazon` / `res_xxx`）。 */
function geoTagOf(resId: string): string {
  return resId.startsWith('builtin:') ? resId.slice('builtin:'.length) : resId;
}

/**
 * 枚举 resId 被哪些启用规则引用。resId 口径：`geosite-<tag>` / `geoip-<tag>` / `builtin:<tag>` / `res_<id>`。
 * 同时匹配三类引用：
 *   - customRules 的 `ruleSet` 条件 `res:<resId>`（精确）；
 *   - customRules 的 geosite/geoip 类型条件（裸 tag 命中 resId 的 geo 名）；
 *   - appRules + customAppPresets 的 geositeTags/geoipTags（裸 tag 命中 resId 的 geo 名）。
 */
export function enumerateResourceRefs(resId: string, input: RefScanInput): RuleResourceRef[] {
  const refs: RuleResourceRef[] = [];
  const resRef = `res:${resId}`;
  const tag = geoTagOf(resId);
  const m = tag.match(/^(geosite|geoip)-(.+)$/);
  const geoKind = m ? (m[1] as 'geosite' | 'geoip') : null;
  const geoName = m ? m[2].trim().toLowerCase() : null;

  for (const rule of input.customRules || []) {
    if (!rule.enabled) continue;
    const conds = ruleConditions(rule);
    const matched = conds.some((c) => {
      if (c.type === 'ruleSet' && c.values.includes(resRef)) return true;
      if (geoKind && c.type === geoKind) {
        return c.values.some((v) => v.trim().toLowerCase() === geoName);
      }
      return false;
    });
    if (!matched) continue;
    const c0 = conds[0];
    const summary = c0 ? `${c0.type}: ${(c0.values[0] || '').slice(0, 24)}` : rule.type;
    refs.push({ kind: 'route', id: rule.id, label: (rule.remarks || '').trim() || summary });
  }

  // 应用分流：仅 geo tag 类资源可被 preset 引用
  if (geoKind && geoName) {
    for (const ar of input.appRules || []) {
      if (!ar.enabled) continue;
      const preset = getAppPreset(ar.appId, input.customAppPresets);
      if (!preset) continue;
      const tags = geoKind === 'geosite' ? preset.geositeTags : preset.geoipTags || [];
      if (tags.some((tg) => tg.trim().toLowerCase() === geoName)) {
        const appBuiltin = !ar.appId.startsWith('custom-');
        refs.push({ kind: 'app', id: ar.appId, label: preset.labelKey, appBuiltin });
      }
    }
  }

  return refs;
}

/** 是否被任意启用规则引用（reload / 删除影响判定）。等价 enumerateResourceRefs(...).length > 0。 */
export function isResourceReferenced(resId: string, input: RefScanInput): boolean {
  return enumerateResourceRefs(resId, input).length > 0;
}

/**
 * 「本地可用资源」正向判断（与 ProxyManager 运行期 fail-closed 口径一致）——回答「某条规则 / 某个应用引用的规则资源是否
 * 本地缺失（已删除或文件丢失）」，供路由规则页 / 应用分流页就地标注「资源缺失」角标。
 *
 * 与 enumerateResourceRefs（反向：资源 → 引用它的规则）互补：删除会把资源整条移出 config.ruleResources，反向枚举
 * 便无从命中已删项；正向以「规则引用的 tag 是否在本地可用集合内」判定，删除态与文件缺失态统一收口。
 *
 * tag 口径严格对齐 generateCustomRules / getRequiredGeoCategories：
 *   - ruleSet `res:<id>` → geoTagOf(id)（builtin:geosite-cn→geosite-cn；geosite-amazon / res_x 原样）
 *   - geosite 裸 tag → `geosite-<tag>`；geoip 裸 tag → `geoip-<tag>`（trim + lowercase 归一）
 *   - 应用分流 preset.geositeTags/geoipTags → `geosite-/geoip-<tag>`
 * 可用集合 = 列表项中 fileExists 为真者的 geoTagOf(id)；仅判已启用规则 / 应用（与运行期一致，禁用规则不下发本就无效果）。
 */
export function availableResourceTagSet(
  resources: { id: string; fileExists: boolean }[]
): Set<string> {
  return new Set((resources || []).filter((r) => r.fileExists).map((r) => geoTagOf(r.id)));
}

/** 单条路由规则引用的全部资源 tag（口径同 generateCustomRules 的条件解析）。 */
export function ruleResourceTags(rule: Rule): string[] {
  const tags: string[] = [];
  for (const c of ruleConditions(rule)) {
    if (c.type === 'ruleSet') {
      for (const v of c.values || []) {
        const s = v.trim();
        if (s.startsWith('res:')) tags.push(geoTagOf(s.slice('res:'.length)));
      }
    } else if (c.type === 'geosite' || c.type === 'geoip') {
      for (const v of c.values || []) {
        const t = v.trim().toLowerCase();
        if (t) tags.push(`${c.type}-${t}`);
      }
    }
  }
  return tags;
}

/** 该路由规则是否引用了「本地不可用」资源（缺失 / 已删除）。仅判已启用规则。 */
export function ruleHasMissingResource(rule: Rule, available: Set<string>): boolean {
  if (!rule.enabled) return false;
  return ruleResourceTags(rule).some((t) => !available.has(t));
}

/** 引用了缺失资源的路由规则 id 集合（供路由规则列表就地角标）。 */
export function missingResourceRuleIds(rules: Rule[], available: Set<string>): Set<string> {
  const s = new Set<string>();
  for (const r of rules || []) if (ruleHasMissingResource(r, available)) s.add(r.id);
  return s;
}

/** 应用分流预设引用的全部 geo tag（口径同 generateRouteConfig 的 app 分支 / getRequiredGeoCategories）。 */
export function appPresetResourceTags(preset: {
  geositeTags: string[];
  geoipTags?: string[];
}): string[] {
  return [
    ...(preset.geositeTags || []).map((t) => `geosite-${t.trim().toLowerCase()}`),
    ...(preset.geoipTags || []).map((t) => `geoip-${t.trim().toLowerCase()}`),
  ];
}

/** 引用了缺失 geo 的应用 id 集合（进程名仍生效；仅判已启用 appRule）。 */
export function missingResourceAppIds(
  appRules: AppRule[],
  available: Set<string>,
  customAppPresets?: CustomAppPreset[]
): Set<string> {
  const s = new Set<string>();
  for (const ar of appRules || []) {
    if (!ar.enabled) continue;
    const preset = getAppPreset(ar.appId, customAppPresets);
    if (!preset) continue;
    if (appPresetResourceTags(preset).some((t) => !available.has(t))) s.add(ar.appId);
  }
  return s;
}
