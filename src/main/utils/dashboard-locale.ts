/**
 * Electron app.getLocale() → sing-box 官方面板合法语言码映射（纯函数，便于单测）。
 *
 * 面板源码实证支持的码：en / zh-Hans / zh-Hant / fa / ru（xl 数组）。面板默认按 navigator.languages 自检，
 * 但 Electron 窗口该值常为 en → 中文系统也显英文；故 FlowZ 打开面板时主动对齐（映射逻辑同面板 El()）。
 *
 * 繁简判定（脚本优先，不用裸子串匹配）：
 *  - 显式简体脚本 `hans` → zh-Hans（即便地区码含 tw/hk/mo，如 zh-Hans-MO 澳门简体，脚本码优先于地区）。
 *  - 否则繁体脚本 `hant`，或地区码 (tw|hk|mo) 锚定段边界 (^|-)…(-|$) → zh-Hant。
 *    锚定段边界避免裸子串误判：zh-hans-x-promo 的 "promo" 含 mo、zh-Hans-MO 含 mo，均不应判繁体。
 *  - 其余 zh → zh-Hans；fa → fa；ru → ru；任一未命中 → en。
 * 旧实现 [/^zh.*(hant|tw|hk|mo)/] 把 mo|tw|hk|hant 当裸子串，会把 zh-Hans-MO / zh-hans-x-promo 误判成繁体（已修）。
 */
export function mapElectronLocaleToDashboardLang(loc: string): string {
  const lower = (loc || '').toLowerCase();
  if (lower.startsWith('zh')) {
    if (lower.includes('hans')) return 'zh-Hans';
    if (lower.includes('hant') || /(^|-)(tw|hk|mo)(-|$)/.test(lower)) return 'zh-Hant';
    return 'zh-Hans';
  }
  if (lower.startsWith('fa')) return 'fa';
  if (lower.startsWith('ru')) return 'ru';
  return 'en';
}
