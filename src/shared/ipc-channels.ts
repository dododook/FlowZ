/**
 * IPC 通道常量定义
 * 用于主进程和渲染进程之间的通信
 */

export const IPC_CHANNELS = {
  // 代理控制
  PROXY_START: 'proxy:start',
  PROXY_STOP: 'proxy:stop',
  PROXY_GET_STATUS: 'proxy:getStatus',
  PROXY_RESTART: 'proxy:restart',
  // §2 待应用差集（pull 模型，configChanged/STARTED/STOPPED 后拉）：节点集相对运行核快照的增/改/删差集，供动作条汇总
  // + 待入池/待生效徽标数据源。核未运行（无快照）→ 空差集（动作条隐藏）。
  PROXY_GET_PENDING_CHANGES: 'proxy:getPendingChanges',
  // §2 动作条「立即应用」：把 ConfigManager 最新 config force-restart 入核（复用 F11 applyConfigForcingRestart，绕 P2-A/B defer）。
  PROXY_APPLY_PENDING_CHANGES: 'proxy:applyPendingChanges',
  KERNEL_PROBE_OUTBOUND: 'kernel:probeOutbound', // 自定义协议兼容性 probe（当前内核 sing-box check）

  // 配置管理
  CONFIG_GET: 'config:get',
  CONFIG_SAVE: 'config:save',
  CONFIG_UPDATE_MODE: 'config:updateMode',
  CONFIG_GET_VALUE: 'config:getValue',
  CONFIG_SET_VALUE: 'config:setValue',
  CONFIG_GET_PRIVACY_MODE: 'config:getPrivacyMode',
  CONFIG_SET_PRIVACY_MODE: 'config:setPrivacyMode',
  PRIVACY_SET_PASSWORD: 'privacy:setPassword',
  PRIVACY_UNLOCK: 'privacy:unlock',
  PRIVACY_HAS_PASSWORD: 'privacy:hasPassword',

  // 服务器管理
  SERVER_SWITCH: 'server:switch',
  SERVER_GENERATE_URL: 'server:generateUrl',
  SERVER_ADD: 'server:add',
  SERVER_ADD_BULK: 'server:addBulk', // 批量添加自建节点（本地导入，一次 loadConfig→saveConfig）
  LOCAL_IMPORT_PARSE: 'localImport:parse', // 本地导入：解析文件/文本 → 预览（节点 + 订阅 + 统计）；不可识别格式 throw
  LOCAL_IMPORT_PICK_FILE: 'localImport:pickFile', // 本地导入：弹系统原生文件对话框选配置文件 + 读内容回传（替代 HTML input，避开 Chromium 英文文案、对话框天然跟随系统语言）
  SERVER_UPDATE: 'server:update',
  SERVER_DELETE: 'server:delete',
  SERVER_DELETE_BATCH: 'server:deleteBatch',
  SERVER_GET_ALL: 'server:getAll',
  SERVER_SPEED_TEST: 'server:speedTest',
  WARP_REGISTER: 'warp:register', // Cloudflare WARP 设备注册 → 生成 WireGuard 草稿
  WARP_APPLY_LICENSE: 'warp:applyLicense', // 对已注册 WARP 节点原地应用 WARP+ license（升级免重建）
  TAILSCALE_LOGIN: 'tailscale:login', // 按需瞬态登录核：拉起登录专用 sing-box 取交互登录 URL（Phase 2）
  TAILSCALE_LOGIN_CANCEL: 'tailscale:loginCancel', // 取消某节点在飞的瞬态登录核（用户手动取消）
  TAILSCALE_LOGOUT: 'tailscale:logout', // 退出登录：清该节点 state 目录（持久会话）；保留节点配置/authKey
  TAILSCALE_STATE_EXISTS: 'tailscale:stateExists', // 批量查 TS 节点 state 目录存在性（不起核判「登录过没」）：代理关时登录态缓存未命中的兜底
  TAILSCALE_GET_STATUS: 'tailscale:getStatus', // L2：主动拉各 TS 节点状态末帧(self IP/peers) + 新鲜度(connected)。治本「状态流 push-only 无 pull、渲染端错过推送即陈旧」

  // 订阅管理
  SUBSCRIPTION_ADD: 'subscription:add',
  SUBSCRIPTION_UPDATE: 'subscription:update',
  SUBSCRIPTION_DELETE: 'subscription:delete',
  SUBSCRIPTION_UPDATE_SERVERS: 'subscription:updateServers',
  SUBSCRIPTION_PREVIEW: 'subscription:preview', // 新增订阅前预检：拉取+解析 URL 但不写 config，返回节点数或分类错误

  // 路由规则管理
  RULES_GET_ALL: 'rules:getAll',
  RULES_ADD: 'rules:add',
  RULES_UPDATE: 'rules:update',
  RULES_DELETE: 'rules:delete',
  RULES_REORDER: 'rules:reorder',

  // 规则资源管理（.srs 下载/管理）
  RULE_RESOURCES_LIST: 'ruleResources:list',
  RULE_RESOURCES_DOWNLOAD: 'ruleResources:download',
  RULE_RESOURCES_REDOWNLOAD: 'ruleResources:redownload',
  RULE_RESOURCES_DELETE: 'ruleResources:delete',
  RULE_RESOURCES_SET_GH_PROXY: 'ruleResources:setGhProxy',
  RULE_RESOURCES_GET_CATALOG: 'ruleResources:getCatalog',
  RULE_RESOURCES_REFRESH_CATALOG: 'ruleResources:refreshCatalog',
  RULE_RESOURCES_SET_AUTO_UPDATE: 'ruleResources:setAutoUpdate',
  RULE_RESOURCES_UPDATE_ALL: 'ruleResources:updateAll',
  RULE_RESOURCES_RESET_BUILTIN: 'ruleResources:resetBuiltin',
  RULE_RESOURCES_ICON_GALLERIES: 'ruleResources:iconGalleries', // 图标库拉取（经 update-in，Phase 1b）

  // 日志管理
  LOGS_GET: 'logs:get',
  LOGS_CLEAR: 'logs:clear',

  // 渲染端就绪信号（renderer -> main，单向 fire-and-forget）：App 成功 render+commit（或根级 ErrorBoundary
  // fallback 挂上）后发一次，供主进程 mount 健康门确认「renderer 进程活着且 DOM 真的挂上了」。C 类白屏（进程活着但
  // DOM 空）不发任何主进程事件，此信号缺席（超时）是唯一侦测手段。经 webContents.ipc.handle 按窗甄别（用 invoke）。
  RENDERER_READY: 'renderer:ready',
  // 终局错误页「重新加载」按钮（renderer -> main）：主进程复位 mount 门 + 对本窗重新 loadFile 真实应用。经主进程
  // 驱动的 loadFile 绕开 Chromium 对 data: 顶层导航/reload 的拦截（错误页是 data: 页，自身 location.reload 恢复不了应用）。
  FATAL_RETRY: 'fatal:retry',

  // 自启动管理
  AUTO_START_SET: 'autoStart:set',
  AUTO_START_GET_STATUS: 'autoStart:getStatus',

  // 统计信息（batch3 §3.7：订阅驱动数据面。renderer 按 topic 声明订阅，main 据订阅集派生 worker demand + 精确 relay）
  STATS_SUBSCRIBE: 'stats:subscribe', // 订阅某 topic（stats|aggregate|detail）：main 挂订阅 + 即回初始帧（合并旧 GET 初值路径）
  STATS_UNSUBSCRIBE: 'stats:unsubscribe', // 退订某 topic（unmount/窗口隐藏/暂停）：无订阅者 → worker 逐级停机
  CONNECTIONS_CLOSE: 'connections:close', // 关单条连接（main 经 9090 DELETE /connections/{id}）
  CONNECTIONS_CLOSE_ALL: 'connections:closeAll', // 关全部连接（main 经 9090 DELETE /connections，触发 ResetNetwork）

  // 出口 IP 信息（本地直连出口 / 代理出口）
  IP_INFO_GET: 'ipinfo:get',

  // 解锁检测（AI/流媒体，经当前代理出口）：run 触发一轮检测（force 绕 TTL）；get 纯读最近快照（水合）
  UNLOCK_RUN: 'unlock:run',
  UNLOCK_GET: 'unlock:get',

  // 系统进程枚举（路由规则的进程快速选择器）
  SYSTEM_LIST_PROCESSES: 'system:listProcesses',

  // 版本信息
  VERSION_GET_INFO: 'version:getInfo',

  // 更新管理
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
  UPDATE_SKIP: 'update:skip',
  UPDATE_OPEN_RELEASES: 'update:openReleases',
  // App 更新弹窗（独立 mini 更新窗）：主进程 → 弹窗推四态状态载荷；弹窗 → 主进程回传按钮/关闭动作。
  UPDATE_POPUP_STATE: 'update:popupState',
  UPDATE_POPUP_ACTION: 'update:popupAction',

  // 核心管理
  CORE_UPDATE_CHECK: 'core-update:check',
  CORE_UPDATE_RUN: 'core-update:update',
  CORE_GET_VERSION_INFO: 'core:getVersionInfo',
  CORE_ROLLBACK: 'core:rollback',
  CORE_REPLACE_MANUAL: 'core:replaceManual',
  CORE_UPDATE_GET_AUTO_STATUS: 'core:getAutoStatus', // 内核自动更新状态（lastCheckAt/staged/跨带提示）
  CORE_UPDATE_APPLY_STAGED: 'core:applyStaged', // 用户点「立即应用」：停代理→换核→重启（唯一允许主动断流）
  CORE_UPDATE_ACK_VERSION_CHANGE: 'core:ackVersionChange', // banner 展示版本变更通知后 ack 清除 pendingChangeNotice（show→ack，弹一次非每启）
  CORE_RESET_FACTORY: 'core-update:reset-factory', // B6：把内核恢复为随 App 出厂的版本
  APP_UNINSTALL_ALL: 'app:uninstall-all', // B6：完全卸载 FlowZ（提权 helper / 受保护目录内核 / 用户配置 / 应用本体）

  // Shell 操作
  SHELL_OPEN_EXTERNAL: 'shell:openExternal',
  // 打开 sing-box 官方面板（dashboard #55）：main 开**应用内 BrowserWindow** 加载运行期 /dashboard/，并经面板专用 preload
  // 在 document-start 预写 localStorage `sing-box-dashboard.server`（一键直连，免手填后端）。渲染端构造不出动态端口故经此 IPC。
  OPEN_SINGBOX_DASHBOARD: 'app:openSingboxDashboard',
  // 刷新 sing-box 官方面板资源：清本地缓存目录（<userData>/singbox-dashboard），使核下次启动重拉新 zip。供 UI 手动刷新。
  REFRESH_SINGBOX_DASHBOARD: 'app:refreshSingboxDashboard',
  // dashboard #55：取面板连接信息（URL + secret）供「复制连接信息」按钮。secret 取自 main config，不长驻渲染端 store。
  GET_SINGBOX_DASHBOARD_CONNECTION: 'app:getSingboxDashboardConnection',

  // 更新事件 (主进程 -> 渲染进程)
  EVENT_UPDATE_PROGRESS: 'update:progress',

  // macOS 提权 helper（免提权启停 sing-box）
  HELPER_GET_STATUS: 'helper:getStatus',
  HELPER_INSTALL: 'helper:install',
  HELPER_UNINSTALL: 'helper:uninstall',

  // 系统代理：用户主动关闭（TUN 残留提示的「关闭系统代理」一键动作）
  SYSTEM_PROXY_DISABLE: 'systemProxy:disable',

  // 事件 (主进程 -> 渲染进程)
  EVENT_PROXY_STARTED: 'event:proxyStarted',
  EVENT_PROXY_STOPPED: 'event:proxyStopped',
  EVENT_PROXY_ERROR: 'event:proxyError',
  EVENT_CONFIG_CHANGED: 'event:configChanged',
  // 日志批处理广播（T1，issue #225）：~150ms 窗口 coalesce 多条日志为单次数组 IPC（取代旧逐条 event:logReceived，
  // 已删），削平 sing-box 启动期日志洪流对主线程的 IPC 冲击（每条一次 send → 撞 Windows 拖动 move 循环致拖动卡顿）。
  EVENT_LOG_RECEIVED_BATCH: 'event:logReceivedBatch',
  EVENT_STATS_UPDATED: 'event:statsUpdated',
  // 首页拓扑连接聚合（StatsWorkerHost 每帧 O(N) 聚合后广播，载荷 ~Top-N host + 出口数，与连接总数解耦）。
  // 取代旧 EVENT_CONNECTIONS_UPDATED（每秒全量 ConnectionEntry[] relay）——连接风暴下渲染端被全量明细拖死（issue #227）。
  // batch3 §3.7：兼作 aggregate topic 的初始帧 + 增量 push 通道（订阅即回缓存帧，之后 seq 变更才推）。
  EVENT_CONNECTIONS_AGGREGATE: 'event:connectionsAggregate',
  // 连接明细 push（batch3 §3.7）：detail topic 订阅期 worker→main→订阅 renderer 的全量连接快照（取代旧 CONNECTIONS_GET
  // 按需 pull）。初始帧 + 增量同一通道；仅连接页订阅期流动，无订阅者 worker 不 post（逐级停机）。
  EVENT_CONNECTIONS_DETAIL: 'event:connectionsDetail',
  EVENT_ENTER_PRIVACY_MODE: 'event:enterPrivacyMode',
  EVENT_EXIT_PRIVACY_MODE: 'event:exitPrivacyMode', // 退出隐私模式（解锁/idle 计时复位）
  EVENT_NAVIGATE: 'navigate', // 托盘菜单 -> 渲染端路由跳转
  EVENT_CORE_VERSION_CHANGED: 'event:coreVersionChanged',
  EVENT_CORE_AUTO_UPDATE_STATUS: 'event:coreAutoUpdateStatus', // 内核自动更新状态变更（staged 待生效 / 跨带提示）
  EVENT_CORE_BASELINE_WARNING: 'event:coreBaselineWarning', // 非官方核 ≤ 随包基线：启动 reconcile 发兼容风险提醒
  EVENT_HELPER_UPGRADEABLE: 'event:helperUpgradeable', // 提权 helper proto < 期望（如属主根治 v6）：启动后发，渲染端 toast 引导升级
  EVENT_AUTO_NODE_SWITCHED: 'event:autoNodeSwitched', // 自动换节点成功通知
  EVENT_PROXY_INVALID_NODES: 'proxy:invalid-nodes', // 启动 gate 剔除的非法节点（空数组=清陈旧标灰）
  EVENT_IP_INFO_UPDATED: 'event:ipInfoUpdated', // 出口 IP 信息更新
  EVENT_UNLOCK_PROGRESS: 'event:unlockProgress', // 解锁检测：单个服务 settle 逐个点亮
  EVENT_UNLOCK_INVALIDATED: 'event:unlockInvalidated', // 解锁检测：切节点/起停代理 → 缓存失效，渲染端复位重跑
  EVENT_UNLOCK_UPDATED: 'event:unlockUpdated', // 解锁检测：一轮完成的完整终态快照（issue 2：渲染端 store 跨组件卸载持有 checkedAt/egress）
  EVENT_RULE_RESOURCE_PROGRESS: 'event:ruleResourceProgress', // 规则资源下载进度
  EVENT_SPEED_TEST_RESULT: 'event:speedTestResult', // 测速单个节点完成（流式增量显示，payload={serverId,latency}）
  EVENT_SPEED_TEST_RESULT_LIST: 'speedTestResult', // 测速全部完成的结果列表（托盘→渲染端汇总 toast，payload=数组）——与逐节点 EVENT_SPEED_TEST_RESULT 为不同通道，勿合并
  EVENT_SPEED_TEST_PROGRESS: 'event:speedTestProgress', // 测速进度（已测/成功/总数）
  EVENT_TAILSCALE_AUTH_URL: 'event:tailscaleAuthUrl', // Tailscale 节点需交互登录：核日志抓出的登录 URL（瞬态核路径）
  EVENT_TAILSCALE_STATUS: 'event:tailscaleStatus', // sing-box 1.14 管理 API 推送的 Tailscale 节点真实态（backendState/loggedIn/authURL/IP/过期）
  EVENT_TAILSCALE_STATE_CLEARED: 'event:tailscaleStateCleared', // 启动前属主归一删掉某节点 root 残留 state（登录态已失效）→ 渲染端清缓存，避免陈旧 loggedIn=true 与已清空 state 撕裂（payload={serverId}）
  EVENT_MESH_LOGIN_FALLBACK: 'event:meshLoginFallback', // 缺陷1 登录期出口让位：选中 TS 出口未就绪→默认路由让位直连(engaged=true)/就绪后切回(engaged=false)，渲染端据此提示（payload={engaged,serverName?}）
  EVENT_SYSTEM_PROXY_RESIDUAL: 'event:systemProxyResidual', // TUN 启动后检测到无 marker 的系统代理残留（非 FlowZ 设的）→ 一次性提示

  // 界面语言不再经此反向同步：改走 config.language 单一真值源（主进程直接读 config，见 ConfigManager）。

  // 节点列表「按延迟排序」开关同步（渲染进程 -> 主进程，使托盘列表与下拉同序）
  APP_SET_NODE_SORT_BY_LATENCY: 'app:setNodeSortByLatency',

  // 窗口控制（Linux 嵌入式标题栏自绘 min/max/close；Mac 原生红绿灯 / Win titleBarOverlay 系统按钮无需）
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE_TOGGLE: 'window:maximizeToggle',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:isMaximized',
  // 最大化态变更（main -> 渲染）：标题栏 max/restore 图标跟随 WM 双击/拖顶等非按钮操作同步
  EVENT_WINDOW_MAXIMIZE_CHANGED: 'event:windowMaximizeChanged',

  // 数据备份与恢复
  BACKUP_EXPORT: 'backup:export', // 选择性导出：接 { categories }，pickCategories 只导出勾选类
  BACKUP_IMPORT_PICK: 'backup:importPick', // 选择性导入①：弹文件框 + 解析 → 返回备份含哪些类 + 各类数量（不 apply）
  BACKUP_IMPORT_APPLY: 'backup:importApply', // 选择性导入②：按所选类整类替换 + 空跳过 + sanitize + 保存
  BACKUP_GET_INFO: 'backup:getInfo',

  // 诊断报告导出（单 Markdown，脱敏）
  DIAGNOSTIC_EXPORT: 'diagnostic:export',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * stats 订阅 topic（batch3 §3.7 订阅驱动数据面）：renderer 按 topic 精确声明订阅，main 据订阅集派生 worker
 * demand（aggregate|detail → 上游 Connections 流；detail → 跨进程明细）并只 relay 给对应 topic 的订阅者。
 */
export type StatsTopic = 'stats' | 'aggregate' | 'detail';

/**
 * topic → 事件推送通道（订阅即回的初始帧 + 后续增量 push 共用同一通道）。主/渲两侧订阅与 relay 的单一真值，
 * 防裸字符串通道名两处漂移（tsc 不查字符串值相等，见 IPC 通道收敛陷阱教训）。
 */
export const STATS_TOPIC_EVENT: Record<StatsTopic, IpcChannel> = {
  stats: IPC_CHANNELS.EVENT_STATS_UPDATED,
  aggregate: IPC_CHANNELS.EVENT_CONNECTIONS_AGGREGATE,
  detail: IPC_CHANNELS.EVENT_CONNECTIONS_DETAIL,
};
