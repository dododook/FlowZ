import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';
import enUS from './locales/en-US.json';
import ru from './locales/ru.json';
import fa from './locales/fa.json';
import {
  AUTO_LANGUAGE,
  migrateLanguageCode,
  resolveEffectiveLanguage,
} from '../../shared/language';

const resources = {
  'zh-CN': {
    translation: zhCN,
  },
  'zh-TW': {
    translation: zhTW,
  },
  'en-US': {
    translation: enUS,
  },
  ru: {
    translation: ru,
  },
  fa: {
    translation: fa,
  },
};

/** main→preload 经 webPreferences.additionalArguments 同步注入的 OS 偏好语言（无则空）。 */
function getSystemLanguages(): string[] {
  const sl = (window as unknown as { electron?: { systemLanguages?: string[] } }).electron
    ?.systemLanguages;
  return Array.isArray(sl) ? sl : [];
}

// RTL 语言集合：以语言前缀匹配（fa / fa-IR / ar / he / ur / ...），新增 RTL 语言时在此追加前缀。
const RTL_LANGUAGE_PREFIXES = ['fa', 'ar', 'he', 'ur'];

/** 判断某语言代码是否为 RTL（按前缀，忽略地区子标签）。 */
export function isRtlLanguage(lng: string): boolean {
  const primary = (lng || '').toLowerCase().split('-')[0];
  return RTL_LANGUAGE_PREFIXES.includes(primary);
}

/** 按当前语言同步 <html dir> + <html lang>（RTL 基建唯一接线点）。 */
function applyDocumentDirection(lng: string): void {
  document.documentElement.dir = isRtlLanguage(lng) ? 'rtl' : 'ltr';
  document.documentElement.lang = lng;
}

// 语言选择（localStorage['app-language']）：'auto'（跟随系统，首装默认）或某具体码。
// 迁移旧 'fa-IR' → 'fa'（回写，使设置页下拉与持久值一致）。
const rawChoice = localStorage.getItem('app-language');
const choice = migrateLanguageCode(rawChoice);
if (rawChoice === 'fa-IR') localStorage.setItem('app-language', 'fa'); // 回写迁移，使下拉回显与持久值一致

// 有效界面语言：'auto'/未设 → 按系统偏好（getPreferredSystemLanguages）解析；否则用具体码。
// 注：绝不能用 app.getLocale()（恒返 app bundle locale=en，与系统脱钩）——故系统语言经 additionalArguments 注入。
const effectiveLanguage = resolveEffectiveLanguage(choice ?? AUTO_LANGUAGE, getSystemLanguages());

i18n.use(initReactI18next).init({
  resources,
  lng: effectiveLanguage,
  fallbackLng: 'en-US',
  interpolation: {
    escapeValue: false,
  },
});

// 同步 <html lang> + <html dir>：初始化按当前语言设置，切换语言时随 languageChanged 更新。
// index.html 中静态的 lang="zh-CN" 仅作首屏默认，运行期以此为准；
// dir 随 RTL 语言（fa 等）切到 'rtl'，其余为 'ltr'，使整体布局镜像。
i18n.on('languageChanged', (lng) => {
  applyDocumentDirection(lng);
});
applyDocumentDirection(i18n.language);

export default i18n;
