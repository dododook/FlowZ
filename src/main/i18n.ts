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

  // —— 完全卸载（Linux 本体删不掉时引导手动移除：deb 系统装 root 无权 / 无废纸篓后端 / 边缘形态） ——
  uninstallManualTitle: {
    'zh-CN': '需手动移除应用本体',
    'zh-TW': '需手動移除應用本體',
    'en-US': 'Remove the app manually',
    ru: 'Удалите приложение вручную',
    fa: 'برنامه را به‌صورت دستی حذف کنید',
  },
  uninstallManualMessage: {
    'zh-CN': 'FlowZ 用户数据已清除。',
    'zh-TW': 'FlowZ 使用者資料已清除。',
    'en-US': 'FlowZ user data has been removed.',
    ru: 'Пользовательские данные FlowZ удалены.',
    fa: 'داده‌های کاربری FlowZ حذف شد.',
  },
  // detail 末尾会拼接应用本体的实际路径（exe 目录或 AppImage 文件），故以冒号结尾。
  uninstallManualBody: {
    'zh-CN':
      '应用本体未能自动删除（可能位于系统目录或受保护位置）：\n• 若经 .deb 安装：sudo apt remove flowz（或 sudo dpkg -r flowz）\n• 若以 AppImage 运行：请删除你的 .AppImage 文件\n• 否则请手动删除以下路径：',
    'zh-TW':
      '應用本體未能自動刪除（可能位於系統目錄或受保護位置）：\n• 若經 .deb 安裝：sudo apt remove flowz（或 sudo dpkg -r flowz）\n• 若以 AppImage 執行：請刪除你的 .AppImage 檔案\n• 否則請手動刪除以下路徑：',
    'en-US':
      'The app itself could not be removed automatically (it may be in a system or protected location):\n• If installed via .deb: sudo apt remove flowz (or sudo dpkg -r flowz)\n• If running as an AppImage: delete your .AppImage file\n• Otherwise, delete this path manually:',
    ru: 'Само приложение не удалось удалить автоматически (возможно, оно в системном или защищённом расположении):\n• Если установлено через .deb: sudo apt remove flowz (или sudo dpkg -r flowz)\n• Если запущено как AppImage: удалите ваш файл .AppImage\n• Иначе удалите этот путь вручную:',
    fa: 'خودِ برنامه به‌صورت خودکار حذف نشد (ممکن است در مسیری سیستمی یا محافظت‌شده باشد):\n• اگر از طریق ‎.deb‎ نصب شده: sudo apt remove flowz (یا sudo dpkg -r flowz)\n• اگر به‌صورت AppImage اجرا می‌شود: فایل ‎.AppImage‎ خود را حذف کنید\n• در غیر این صورت این مسیر را به‌صورت دستی حذف کنید:',
  },
  uninstallManualOk: {
    'zh-CN': '知道了',
    'zh-TW': '知道了',
    'en-US': 'Got it',
    ru: 'Понятно',
    fa: 'متوجه شدم',
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
    fa: 'گره‌های سفارشی',
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

  // —— 提权 helper 授权对话框（index.ts）：按钮 ——
  btnCancel: {
    'zh-CN': '取消',
    'zh-TW': '取消',
    'en-US': 'Cancel',
    ru: 'Отмена',
    fa: 'لغو',
  },
  btnRepairStart: {
    'zh-CN': '修复并启动',
    'zh-TW': '修復並啟動',
    'en-US': 'Repair & start',
    ru: 'Исправить и запустить',
    fa: 'تعمیر و راه‌اندازی',
  },
  btnInstallStart: {
    'zh-CN': '安装并启动',
    'zh-TW': '安裝並啟動',
    'en-US': 'Install & start',
    ru: 'Установить и запустить',
    fa: 'نصب و راه‌اندازی',
  },
  btnUseUac: {
    'zh-CN': '用 UAC 启动',
    'zh-TW': '用 UAC 啟動',
    'en-US': 'Use UAC',
    ru: 'Запустить через UAC',
    fa: 'راه‌اندازی با UAC',
  },
  btnUseSystemAuth: {
    'zh-CN': '用系统授权启动',
    'zh-TW': '用系統授權啟動',
    'en-US': 'Use system auth',
    ru: 'С системной авторизацией',
    fa: 'با احراز هویت سیستم',
  },
  btnOpenSystemSettings: {
    'zh-CN': '打开系统设置',
    'zh-TW': '開啟系統設定',
    'en-US': 'Open System Settings',
    ru: 'Открыть системные настройки',
    fa: 'باز کردن تنظیمات سیستم',
  },
  btnStartThisSession: {
    'zh-CN': '本次直接启动',
    'zh-TW': '本次直接啟動',
    'en-US': 'Start this session',
    ru: 'Запустить сейчас',
    fa: 'راه‌اندازی این بار',
  },

  // —— 对话框：标题 ——
  dlgWinRepairServiceMsg: {
    'zh-CN': '修复 Windows 提权服务？',
    'zh-TW': '修復 Windows 提權服務？',
    'en-US': 'Repair privileged service?',
    ru: 'Исправить привилегированную службу?',
    fa: 'سرویس ممتاز تعمیر شود؟',
  },
  dlgWinInstallServiceMsg: {
    'zh-CN': '安装 Windows 提权服务？',
    'zh-TW': '安裝 Windows 提權服務？',
    'en-US': 'Install privileged service?',
    ru: 'Установить привилегированную службу?',
    fa: 'سرویس ممتاز نصب شود؟',
  },
  dlgMacBgOffMsg: {
    'zh-CN': '提权助手的「允许在后台」被系统关闭',
    'zh-TW': '提權助手的「允許在背景」被系統關閉',
    'en-US': 'Helper "Allow in Background" is off',
    ru: 'У помощника отключено «Разрешить в фоне»',
    fa: 'گزینه «اجازه در پس‌زمینه» دستیار خاموش است',
  },
  dlgMacRepairHelperMsg: {
    'zh-CN': '修复提权助手？',
    'zh-TW': '修復提權助手？',
    'en-US': 'Repair privileged helper?',
    ru: 'Исправить привилегированный помощник?',
    fa: 'دستیار ممتاز تعمیر شود؟',
  },
  dlgMacInstallHelperMsg: {
    'zh-CN': '安装提权助手？',
    'zh-TW': '安裝提權助手？',
    'en-US': 'Install privileged helper?',
    ru: 'Установить привилегированный помощник?',
    fa: 'دستیار ممتاز نصب شود؟',
  },

  // —— 对话框：详情（长段落） ——
  dlgWinRepairDetail: {
    'zh-CN':
      '提权服务已安装但未就绪（服务未运行或版本不符）。修复将重装服务，仅需授权一次（UAC）；也可本次用 UAC 启动。',
    'zh-TW':
      '提權服務已安裝但未就緒（服務未執行或版本不符）。修復將重新安裝服務，僅需授權一次（UAC）；也可本次用 UAC 啟動。',
    'en-US':
      'The privileged service is installed but not ready. Repair reinstalls it (one UAC prompt); or start with UAC this time.',
    ru: 'Привилегированная служба установлена, но не готова. Восстановление переустановит её (один запрос UAC); либо запустите через UAC сейчас.',
    fa: 'سرویس ممتاز نصب شده اما آماده نیست. تعمیر آن را دوباره نصب می‌کند (یک بار درخواست UAC)؛ یا این بار با UAC راه‌اندازی کنید.',
  },
  dlgWinInstallDetail: {
    'zh-CN':
      '安装后 Windows TUN 模式启停代理免每次 UAC（装服务需管理员授权一次）；也可本次用 UAC 启动。',
    'zh-TW':
      '安裝後 Windows TUN 模式啟停代理免每次 UAC（裝服務需管理員授權一次）；也可本次用 UAC 啟動。',
    'en-US':
      'After install, Windows TUN start/stop no longer needs UAC each time (installing the service needs one admin prompt); or start with UAC this time.',
    ru: 'После установки запуск/остановка TUN в Windows больше не требует UAC каждый раз (установка службы требует одного запроса администратора); либо запустите через UAC сейчас.',
    fa: 'پس از نصب، شروع/توقف TUN در ویندوز دیگر هر بار به UAC نیاز ندارد (نصب سرویس یک بار درخواست مدیر دارد)؛ یا این بار با UAC راه‌اندازی کنید.',
  },
  dlgMacBgOffDetail: {
    'zh-CN':
      '请在「系统设置 > 通用 > 登录项与扩展」重新打开 FlowZ 的「允许在后台」开关，然后回到 FlowZ 重新点击启动即可（届时免授权直接走提权助手）。\n「本次直接启动」会以系统管理员授权方式运行（弹一次密码框），不依赖后台开关；但之后每次启停都需授权，建议尽快去系统设置打开开关。',
    'zh-TW':
      '請在「系統設定 > 一般 > 登入項目與擴充功能」重新打開 FlowZ 的「允許在背景」開關，然後回到 FlowZ 重新點擊啟動即可（屆時免授權直接走提權助手）。\n「本次直接啟動」會以系統管理員授權方式執行（彈一次密碼框），不依賴背景開關；但之後每次啟停都需授權，建議盡快去系統設定打開開關。',
    'en-US':
      'Open System Settings → General → Login Items & Extensions and turn the "Allow in Background" toggle back on for FlowZ, then return to FlowZ and start again (no authorization needed then).\n"Start this session" runs with system administrator authorization (one password prompt) and does not depend on the toggle; each start/stop will prompt afterwards, so re-enabling the toggle is recommended.',
    ru: 'Откройте «Системные настройки → Основные → Объекты входа и расширения» и снова включите переключатель «Разрешить в фоне» для FlowZ, затем вернитесь в FlowZ и запустите снова (тогда авторизация не нужна).\n«Запустить сейчас» работает с авторизацией системного администратора (один запрос пароля) и не зависит от переключателя; после этого каждый запуск/остановка будет запрашивать пароль, поэтому рекомендуется снова включить переключатель.',
    fa: 'به «تنظیمات سیستم ← عمومی ← موارد ورود و افزونه‌ها» بروید و کلید «اجازه در پس‌زمینه» را برای FlowZ دوباره روشن کنید، سپس به FlowZ بازگردید و دوباره راه‌اندازی کنید (آنگاه به احراز هویت نیازی نیست).\n«راه‌اندازی این بار» با احراز هویت مدیر سیستم اجرا می‌شود (یک بار درخواست رمز) و به این کلید وابسته نیست؛ اما پس از آن هر شروع/توقف درخواست رمز می‌کند، بنابراین روشن کردن دوباره کلید توصیه می‌شود.',
  },
  dlgMacRepairNoteOff: {
    'zh-CN':
      '\n注意：若系统设置「允许在后台」开关已被关闭，此修复不会恢复该开关；请到「系统设置 > 通用 > 登录项与扩展」手动重新开启。',
    'zh-TW':
      '\n注意：若系統設定「允許在背景」開關已被關閉，此修復不會恢復該開關；請到「系統設定 > 一般 > 登入項目與擴充功能」手動重新開啟。',
    'en-US':
      '\nNote: if the "Allow in Background" toggle was turned off in System Settings, this repair will NOT restore it; re-enable it manually under System Settings → General → Login Items & Extensions.',
    ru: '\nПримечание: если переключатель «Разрешить в фоне» был выключен в системных настройках, это восстановление НЕ включит его; включите его вручную в «Системные настройки → Основные → Объекты входа и расширения».',
    fa: '\nتوجه: اگر کلید «اجازه در پس‌زمینه» در تنظیمات سیستم خاموش شده باشد، این تعمیر آن را بازنمی‌گرداند؛ آن را به‌صورت دستی در «تنظیمات سیستم ← عمومی ← موارد ورود و افزونه‌ها» دوباره فعال کنید.',
  },
  dlgMacRepairPathMismatchDetail: {
    'zh-CN':
      '检测到应用位置已变更，提权助手仍指向旧路径而无法生效。修复将重新登记当前路径，仅需授权一次；也可本次用系统授权启动。',
    'zh-TW':
      '偵測到應用位置已變更，提權助手仍指向舊路徑而無法生效。修復將重新登記目前路徑，僅需授權一次；也可本次用系統授權啟動。',
    'en-US':
      'The app was moved and the helper still points to the old path. Repair re-registers the current path (one authorization); or start with system auth this time.',
    ru: 'Приложение было перемещено, а помощник всё ещё указывает на старый путь. Восстановление заново зарегистрирует текущий путь (одна авторизация); либо запустите с системной авторизацией сейчас.',
    fa: 'برنامه جابه‌جا شده و دستیار هنوز به مسیر قدیمی اشاره می‌کند. تعمیر مسیر فعلی را دوباره ثبت می‌کند (یک بار احراز هویت)؛ یا این بار با احراز هویت سیستم راه‌اندازی کنید.',
  },
  dlgMacRepairUpgradeDetail: {
    'zh-CN':
      '提权助手需要更新到新版本（功能改进）。修复将重新安装，仅需授权一次；也可本次用系统授权启动。',
    'zh-TW':
      '提權助手需要更新到新版本（功能改進）。修復將重新安裝，僅需授權一次；也可本次用系統授權啟動。',
    'en-US':
      'The privileged helper needs updating to a newer version. Repair reinstalls it (one authorization); or start with system auth this time.',
    ru: 'Привилегированный помощник нужно обновить до новой версии. Восстановление переустановит его (одна авторизация); либо запустите с системной авторизацией сейчас.',
    fa: 'دستیار ممتاز باید به نسخه جدیدتری به‌روزرسانی شود. تعمیر آن را دوباره نصب می‌کند (یک بار احراز هویت)؛ یا این بار با احراز هویت سیستم راه‌اندازی کنید.',
  },
  dlgMacInstallDetail: {
    'zh-CN': '安装后 TUN 模式启停代理免每次系统授权；也可本次用系统授权启动。',
    'zh-TW': '安裝後 TUN 模式啟停代理免每次系統授權；也可本次用系統授權啟動。',
    'en-US':
      'After install, TUN start/stop no longer needs system authorization each time; or start with system auth this time.',
    ru: 'После установки запуск/остановка TUN больше не требует системной авторизации каждый раз; либо запустите с системной авторизацией сейчас.',
    fa: 'پس از نصب، شروع/توقف TUN دیگر هر بار به احراز هویت سیستم نیاز ندارد؛ یا این بار با احراز هویت سیستم راه‌اندازی کنید.',
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

/** 全部文案键（供测试遍历校验）。 */
export const MAIN_MESSAGE_KEYS = Object.keys(MESSAGES) as MainMessageKey[];
