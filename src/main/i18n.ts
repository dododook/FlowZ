/**
 * 主进程用户可见文案的轻量 i18n（5 语，与渲染端 SUPPORTED_LANGUAGES 对齐）。
 *
 * 背景：渲染端用 i18next（locales/*.json）做 5 语，但**主进程没有 i18next 实例**——IPC 只同步 currentLanguage
 * 字符串过来。历史上主进程用户串走「zh/en 二元」土办法（TrayManager.t / native dialog），fa/ru/zh-TW 用户看到英文，
 * 部分串甚至纯中文。本模块给主进程一个真 5 语出口：中央语言持有点 + 文案目录，桌面通知/托盘/对话框等调 mt() 即可。
 *
 * 设计：
 * - 文案主进程私有（渲染端从不显示这些串，故不复用 renderer 的 locale JSON——且 tsconfig.main 也 import 不到它）。
 * - 语言持有点由 index.ts 在启动（系统偏好）+ APP_SET_LANGUAGE（渲染端同步）两处 setMainLanguage 写入。
 * - 缺键/未知语言 → 回退 DEFAULT_LANGUAGE，绝不抛。
 * - MESSAGES 用 `satisfies Record<string, Record<SupportedLanguage,string>>`：编译期强制每键 5 语齐全，
 *   且 `MainMessageKey = keyof typeof MESSAGES` 自动派生 key 联合类型（新增键无需手维护 union）。
 */
import {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  resolveEffectiveLanguage,
  type SupportedLanguage,
} from '../shared/language';

/** key → 各受支持语言文案。satisfies 保证每键 5 语齐全；新增主进程用户可见串在此扩展。 */
const MESSAGES = {
  // —— 桌面通知（notify-user 出口） ——
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

  // —— 托盘菜单（TrayManager） ——
  trayStatusError: {
    'zh-CN': '连接异常',
    'zh-TW': '連線異常',
    'en-US': 'Connection Error',
    ru: 'Ошибка подключения',
    fa: 'خطای اتصال',
  },
  trayStatusConnected: {
    'zh-CN': '已连接',
    'zh-TW': '已連線',
    'en-US': 'Connected',
    ru: 'Подключено',
    fa: 'متصل',
  },
  trayStatusDisconnected: {
    'zh-CN': '已断开',
    'zh-TW': '已斷開',
    'en-US': 'Disconnected',
    ru: 'Отключено',
    fa: 'قطع شد',
  },
  trayTimeout: {
    'zh-CN': '超时',
    'zh-TW': '逾時',
    'en-US': 'Timeout',
    ru: 'Таймаут',
    fa: 'فرصت تمام شد',
  },
  trayDirect: {
    'zh-CN': '直连',
    'zh-TW': '直連',
    'en-US': 'Direct',
    ru: 'Напрямую',
    fa: 'مستقیم',
  },
  trayNoServers: {
    'zh-CN': '未配置服务器',
    'zh-TW': '未設定伺服器',
    'en-US': 'No Servers Configured',
    ru: 'Серверы не настроены',
    fa: 'هیچ سروری پیکربندی نشده',
  },
  trayMesh: {
    'zh-CN': '组网',
    'zh-TW': '組網',
    'en-US': 'Mesh',
    ru: 'Меш-сеть',
    fa: 'شبکه مش',
  },
  trayCustomNodes: {
    'zh-CN': '自建节点',
    'zh-TW': '自建節點',
    'en-US': 'Custom Nodes',
    ru: 'Свои узлы',
    fa: 'نُدهای سفارشی',
  },
  trayManageServers: {
    'zh-CN': '管理服务器',
    'zh-TW': '管理伺服器',
    'en-US': 'Manage Servers',
    ru: 'Управление серверами',
    fa: 'مدیریت سرورها',
  },
  trayGlobalProxy: {
    'zh-CN': '全局代理',
    'zh-TW': '全域代理',
    'en-US': 'Global Proxy',
    ru: 'Глобальный прокси',
    fa: 'پروکسی سراسری',
  },
  traySmartRouting: {
    'zh-CN': '智能分流',
    'zh-TW': '智慧分流',
    'en-US': 'Smart Routing',
    ru: 'Умная маршрутизация',
    fa: 'مسیریابی هوشمند',
  },
  trayDirectMode: {
    'zh-CN': '直连模式',
    'zh-TW': '直連模式',
    'en-US': 'Direct Connection',
    ru: 'Прямое подключение',
    fa: 'اتصال مستقیم',
  },
  traySystemProxy: {
    'zh-CN': '系统代理',
    'zh-TW': '系統代理',
    'en-US': 'System Proxy',
    ru: 'Системный прокси',
    fa: 'پروکسی سیستم',
  },
  trayTun: {
    'zh-CN': 'TUN 网卡',
    'zh-TW': 'TUN 網卡',
    'en-US': 'TUN',
    ru: 'TUN',
    fa: 'TUN',
  },
  trayLocalOnly: {
    'zh-CN': '仅本地',
    'zh-TW': '僅本機',
    'en-US': 'Local Only',
    ru: 'Только локально',
    fa: 'فقط محلی',
  },
  trayOpenMainWindow: {
    'zh-CN': '打开主窗口',
    'zh-TW': '開啟主視窗',
    'en-US': 'Open Main Window',
    ru: 'Открыть главное окно',
    fa: 'باز کردن پنجره اصلی',
  },
  trayDisableProxy: {
    'zh-CN': '禁用代理',
    'zh-TW': '停用代理',
    'en-US': 'Disable Proxy',
    ru: 'Отключить прокси',
    fa: 'غیرفعال‌سازی پروکسی',
  },
  trayEnableProxy: {
    'zh-CN': '启用代理',
    'zh-TW': '啟用代理',
    'en-US': 'Enable Proxy',
    ru: 'Включить прокси',
    fa: 'فعال‌سازی پروکسی',
  },
  traySelectServer: {
    'zh-CN': '选择服务器',
    'zh-TW': '選擇伺服器',
    'en-US': 'Select Server',
    ru: 'Выбрать сервер',
    fa: 'انتخاب سرور',
  },
  trayTakeover: {
    'zh-CN': '接管方式',
    'zh-TW': '接管方式',
    'en-US': 'Takeover',
    ru: 'Перехват',
    fa: 'نحوه تصاحب',
  },
  trayRouting: {
    'zh-CN': '分流策略',
    'zh-TW': '分流策略',
    'en-US': 'Routing',
    ru: 'Маршрутизация',
    fa: 'مسیریابی',
  },
  trayLightweightMode: {
    'zh-CN': '进入轻量模式',
    'zh-TW': '進入輕量模式',
    'en-US': 'Enter Lightweight Mode',
    ru: 'Лёгкий режим',
    fa: 'حالت سبک',
  },
  trayPrivacyMode: {
    'zh-CN': '进入隐私模式',
    'zh-TW': '進入隱私模式',
    'en-US': 'Enter Privacy Mode',
    ru: 'Режим конфиденциальности',
    fa: 'حالت حریم خصوصی',
  },
  trayOpenSettings: {
    'zh-CN': '打开设置',
    'zh-TW': '開啟設定',
    'en-US': 'Open Settings',
    ru: 'Открыть настройки',
    fa: 'باز کردن تنظیمات',
  },
  trayCheckUpdates: {
    'zh-CN': '检查更新',
    'zh-TW': '檢查更新',
    'en-US': 'Check for Updates',
    ru: 'Проверить обновления',
    fa: 'بررسی به‌روزرسانی',
  },
  trayQuit: {
    'zh-CN': '退出',
    'zh-TW': '結束',
    'en-US': 'Quit',
    ru: 'Выход',
    fa: 'خروج',
  },
  trayTestingSpeed: {
    'zh-CN': '测速中...',
    'zh-TW': '測速中...',
    'en-US': 'Testing Speed...',
    ru: 'Проверка скорости...',
    fa: 'در حال تست سرعت...',
  },
  traySpeedTest: {
    'zh-CN': '服务器测速',
    'zh-TW': '伺服器測速',
    'en-US': 'Speed Test',
    ru: 'Тест скорости',
    fa: 'تست سرعت',
  },
  trayTooltipDisconnected: {
    'zh-CN': 'FlowZ - 未连接',
    'zh-TW': 'FlowZ - 未連線',
    'en-US': 'FlowZ - Disconnected',
    ru: 'FlowZ — Отключено',
    fa: 'FlowZ — قطع شد',
  },
  trayTooltipConnecting: {
    'zh-CN': 'FlowZ - 连接中...',
    'zh-TW': 'FlowZ - 連線中...',
    'en-US': 'FlowZ - Connecting...',
    ru: 'FlowZ — Подключение...',
    fa: 'FlowZ — در حال اتصال...',
  },
  trayTooltipConnected: {
    'zh-CN': 'FlowZ - 已连接',
    'zh-TW': 'FlowZ - 已連線',
    'en-US': 'FlowZ - Connected',
    ru: 'FlowZ — Подключено',
    fa: 'FlowZ — متصل',
  },
} satisfies Record<string, Record<SupportedLanguage, string>>;

/** 主进程文案键（自 MESSAGES 自动派生，无需手维护 union）。 */
export type MainMessageKey = keyof typeof MESSAGES;

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

/** 全部文案键（供测试遍历校验）。 */
export const MAIN_MESSAGE_KEYS = Object.keys(MESSAGES) as MainMessageKey[];
