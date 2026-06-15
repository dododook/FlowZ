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
