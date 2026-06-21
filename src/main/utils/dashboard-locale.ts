/**
 * Electron app.getLocale() → sing-box 官方面板合法语言码映射（纯函数，便于单测）。
 *
 * 面板源码实证支持的码：en / zh-Hans / zh-Hant / fa / ru（xl 数组）。面板默认按 navigator.languages 自检，
 * 但 Electron 窗口该值常为 en → 中文系统也显英文；故 FlowZ 打开面板时主动对齐（映射逻辑同面板 El()）。
 *
 * 表查找式（首条命中即返回）：zh-Hant 子串（hant/tw/hk/mo）必须排在 zh 之前，否则繁体地区会被泛 zh 抢先判成简体。
 * 任一未命中 → 'en'。
 */
const DASHBOARD_LANG_RULES: Array<[RegExp, string]> = [
  [/^zh.*(hant|tw|hk|mo)/, 'zh-Hant'],
  [/^zh/, 'zh-Hans'],
  [/^fa/, 'fa'],
  [/^ru/, 'ru'],
];

export function mapElectronLocaleToDashboardLang(loc: string): string {
  const lower = (loc || '').toLowerCase();
  return DASHBOARD_LANG_RULES.find(([re]) => re.test(lower))?.[1] ?? 'en';
}
