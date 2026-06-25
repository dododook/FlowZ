/**
 * 界面语言：受支持语言集 + 「自动（跟随系统）」解析 + 旧码迁移。纯函数，主/渲染/单测共用，零副作用。
 *
 * 关键：i18n 资源键用 `fa`（非 `fa-IR`）——与其余「只在消歧时带地区」的口径一致（ru 裸码、zh-CN/zh-TW 必须区分简繁）；
 * 也与 Chromium/Electron 的 `fa.pak`（无 `fa-IR.pak`）对齐。旧版本存的 `fa-IR` 经 migrateLanguageCode 迁移。
 */

/** 受支持的界面语言（i18n 资源键）。顺序无语义（UI 自行排序）。 */
export const SUPPORTED_LANGUAGES = ['zh-CN', 'zh-TW', 'en-US', 'ru', 'fa'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** 无匹配时的回退语言（国际通用，亦为 i18n fallbackLng）。 */
export const DEFAULT_LANGUAGE: SupportedLanguage = 'en-US';

/** 语言选择的「自动（跟随系统）」哨兵值（存 localStorage['app-language']）。 */
export const AUTO_LANGUAGE = 'auto';

/** 旧语言码迁移：`fa-IR` → `fa`（其余原样返回，含 null/undefined 透传）。 */
export function migrateLanguageCode(code: string | null | undefined): string | null | undefined {
  return code === 'fa-IR' ? 'fa' : code;
}

/** 单个 BCP47 语言码 → 受支持语言；无匹配返 null。按主语言子标签 + 脚本/地区消歧。 */
function matchSupported(raw: string): SupportedLanguage | null {
  const l = (raw || '').toLowerCase();
  if (!l) return null;
  const primary = l.split(/[-_]/)[0];
  if (primary === 'zh') {
    // 繁体：Hant 脚本 或 台/港/澳 地区；其余（Hans/cn/sg/裸 zh）→ 简体。
    if (l.includes('hant') || /(^|[-_])(tw|hk|mo)([-_]|$)/.test(l)) return 'zh-TW';
    return 'zh-CN';
  }
  if (primary === 'fa') return 'fa';
  if (primary === 'ru') return 'ru';
  if (primary === 'en') return 'en-US';
  return null;
}

/**
 * OS 偏好语言有序列表（app.getPreferredSystemLanguages，如 ['zh-Hans-CN','en-US']）→ 受支持语言。
 * 逐个匹配、命中即止；全不匹配 → DEFAULT_LANGUAGE（en-US）。
 */
export function resolveAutoLanguage(
  preferred: readonly string[] | null | undefined
): SupportedLanguage {
  for (const raw of preferred || []) {
    const m = matchSupported(raw);
    if (m) return m;
  }
  return DEFAULT_LANGUAGE;
}

/**
 * 解析有效界面语言：
 * - choice='auto' / 未设 / 旧 fa-IR 之外的非法值 → 按系统偏好解析；
 * - choice 是受支持的具体码（fa-IR 先迁移成 fa）→ 用它。
 */
export function resolveEffectiveLanguage(
  choice: string | null | undefined,
  systemLanguages: readonly string[] | null | undefined
): SupportedLanguage {
  const c = migrateLanguageCode(choice);
  if (!c || c === AUTO_LANGUAGE) return resolveAutoLanguage(systemLanguages);
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(c)
    ? (c as SupportedLanguage)
    : resolveAutoLanguage(systemLanguages);
}
