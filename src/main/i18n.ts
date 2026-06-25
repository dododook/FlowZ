/**
 * 主进程用户可见文案的轻量 i18n（5 语，与渲染端 SUPPORTED_LANGUAGES 对齐）。
 *
 * 背景：渲染端用 i18next（locales/*.json）做 5 语，但**主进程没有 i18next 实例**——IPC 只同步 currentLanguage
 * 字符串过来。历史上主进程用户串走「zh/en 二元」土办法（TrayManager.t / native dialog），fa/ru/zh-TW 用户看到英文，
 * 部分串甚至纯中文。本模块给主进程一个真 5 语出口：中央语言持有点 + 文案目录，桌面通知等任意主进程服务调 mt() 即可。
 *
 * 设计：
 * - 文案主进程私有（渲染端从不显示这些串，故不复用 renderer 的 locale JSON——且 tsconfig.main 也 import 不到它）。
 * - 语言持有点由 index.ts 在启动（系统偏好）+ APP_SET_LANGUAGE（渲染端同步）两处 setMainLanguage 写入。
 * - 缺键/未知语言 → 回退 DEFAULT_LANGUAGE，绝不抛。
 */
import {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  resolveEffectiveLanguage,
  type SupportedLanguage,
} from '../shared/language';

/** 主进程文案键。新增主进程用户可见串时在此扩展（编译期强制 5 语齐全）。 */
export type MainMessageKey =
  | 'proxyErrorTitle'
  | 'proxyErrorBody'
  | 'helperDisabledTitle'
  | 'helperDisabledBody'
  | 'tailscaleAuthBody';

/** key → 各受支持语言文案。Record<SupportedLanguage,...> 保证编译期 5 语不缺。 */
const MESSAGES: Record<MainMessageKey, Record<SupportedLanguage, string>> = {
  proxyErrorTitle: {
    'zh-CN': 'FlowZ 代理出错',
    'zh-TW': 'FlowZ 代理出錯',
    'en-US': 'FlowZ Proxy Error',
    ru: 'Ошибка прокси FlowZ',
    fa: 'خطای پروکسی FlowZ',
  },
  proxyErrorBody: {
    'zh-CN': '代理已停止，请打开应用查看详情',
    'zh-TW': '代理已停止，請打開應用查看詳情',
    'en-US': 'The proxy has stopped. Open FlowZ for details.',
    ru: 'Прокси остановлен. Откройте FlowZ, чтобы узнать подробности.',
    fa: 'پروکسی متوقف شد. برای جزئیات FlowZ را باز کنید.',
  },
  helperDisabledTitle: {
    'zh-CN': 'FlowZ 提权助手被关闭',
    'zh-TW': 'FlowZ 提權助手被關閉',
    'en-US': 'FlowZ helper disabled',
    ru: 'Помощник FlowZ отключён',
    fa: 'دستیار FlowZ غیرفعال شد',
  },
  helperDisabledBody: {
    'zh-CN': 'TUN 无法自动启动，点此打开设置重新开启。',
    'zh-TW': 'TUN 無法自動啟動，點此打開設定重新開啟。',
    'en-US': "TUN can't auto-start. Click to open settings and re-enable.",
    ru: 'TUN не запускается автоматически. Нажмите, чтобы открыть настройки.',
    fa: 'TUN به‌طور خودکار اجرا نمی‌شود. برای باز کردن تنظیمات کلیک کنید.',
  },
  tailscaleAuthBody: {
    'zh-CN': '在浏览器中完成登录授权以加入网络',
    'zh-TW': '在瀏覽器中完成登入授權以加入網路',
    'en-US': 'Complete sign-in in your browser to join the network',
    ru: 'Завершите вход в браузере, чтобы присоединиться к сети',
    fa: 'برای پیوستن به شبکه، ورود را در مرورگر کامل کنید',
  },
};

let currentLang: SupportedLanguage = DEFAULT_LANGUAGE;

/** 设主进程当前语言（启动按系统偏好 / APP_SET_LANGUAGE 按渲染端同步）。未知/auto/非法 → 回退默认。 */
export function setMainLanguage(lang: string | null | undefined): void {
  currentLang = resolveEffectiveLanguage(lang, null);
}

/** 取主进程当前语言（供测试/诊断）。 */
export function getMainLanguage(): SupportedLanguage {
  return currentLang;
}

/** 按当前语言取文案；缺键兜底回 DEFAULT_LANGUAGE，绝不返 undefined。 */
export function mt(key: MainMessageKey): string {
  const row = MESSAGES[key];
  return row[currentLang] ?? row[DEFAULT_LANGUAGE];
}

/** 受支持语言数（供测试校验 parity）。 */
export const MAIN_I18N_LANG_COUNT = SUPPORTED_LANGUAGES.length;
