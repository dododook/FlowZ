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
    'zh-CN': 'FlowZ 提权助手被系统关闭',
    'zh-TW': 'FlowZ 提權助手被系統關閉',
    'en-US': 'FlowZ helper disabled by the system',
    ru: 'Помощник FlowZ отключён системой',
    fa: 'دستیار FlowZ توسط سیستم غیرفعال شد',
  },
  helperDisabledBody: {
    'zh-CN':
      '「允许在后台」中本应用的提权助手被关闭，TUN 自动启动失败。请在「系统设置 > 通用 > 登录项与扩展」重新打开；点按本通知可直接打开设置。',
    'zh-TW':
      '「允許在背景」中本應用的提權助手被關閉，TUN 自動啟動失敗。請在「系統設定 > 一般 > 登入項目與擴充功能」重新打開；點按本通知可直接打開設定。',
    'en-US':
      "FlowZ's privileged helper was turned off in Login Items, so TUN could not start automatically. Re-enable it under System Settings > General > Login Items & Extensions; click this notification to open settings.",
    ru: 'Привилегированный помощник FlowZ отключён в «Объектах входа», поэтому TUN не запустился автоматически. Включите его снова в «Системные настройки → Основные → Объекты входа и расширения»; нажмите это уведомление, чтобы открыть настройки.',
    fa: 'دستیار ممتاز FlowZ در «موارد ورود» خاموش شده است، بنابراین TUN به‌طور خودکار اجرا نشد. آن را از مسیر «تنظیمات سیستم» بخش «عمومی» و سپس «موارد ورود و افزونه‌ها» دوباره فعال کنید؛ برای باز کردن تنظیمات روی این اعلان کلیک کنید.',
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
