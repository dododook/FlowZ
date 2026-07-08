/**
 * 订阅预检契约（主/渲染共用单一真值）。
 *
 * 动机（issue：新增订阅先加后删 + 错误不细分）：add 订阅原为「先建记录 → 再拉节点」，拉取失败要么留空订阅
 * 要么删记录（闪现/竞态），且失败只有布尔无原因。改为**预检先行**：add 前用 URL 拉取+解析但不写 config，
 * 返回节点数或**分类错误**；成功才建记录，失败留窗 + 说清原因。
 *
 * 本文件只放「契约 + 纯分类逻辑」（零 electron/网络依赖，可直测）：
 *  - SubscriptionErrorKind：错误分类枚举
 *  - SubscriptionPreviewResult：预检 IPC 返回形状
 *  - classifySubscriptionError：错误 → errorKind 纯映射（main 侧 catch 后调用）
 *  - SUBSCRIPTION_ERROR_I18N_KEY：errorKind → i18n key（渲染侧展示用）
 */

export type SubscriptionErrorKind =
  | 'dns' // 域名解析失败
  | 'timeout' // 连接/读取超时
  | 'refused' // 连接被拒绝（端口不可达）
  | 'http' // 服务器返回 4xx/5xx
  | 'ssrf' // 命中 SSRF guard（内网/本机地址）
  | 'scheme' // 非 http(s) 协议
  | 'toolarge' // 响应体积超上限
  | 'parse' // 拉到内容但非有效订阅格式
  | 'empty' // 解析成功但 0 节点
  | 'unknown'; // 未归类

export interface SubscriptionPreviewResult {
  ok: boolean;
  /** ok=true：解析出的可用节点数。 */
  nodeCount?: number;
  /** ok=false：错误分类。 */
  errorKind?: SubscriptionErrorKind;
  /** errorKind='http' 时的状态码。 */
  httpStatus?: number;
  /** 原始（已脱敏）错误信息，仅诊断用，不直接展示给用户。 */
  message?: string;
}

/** classifySubscriptionError 的输入：main 侧 catch 后把错误的可判定信号摊平传入。 */
export interface SubscriptionErrorSignal {
  /** error.message（fetchSubscriptionText/parseSubscriptionContent 抛出的文案）。 */
  message?: string;
  /** error.code 或 error.cause?.code（Node/Electron 网络错误码，如 ECONNREFUSED）。 */
  code?: string;
  /** response.status（HTTP 非 2xx 时由调用方显式传入，优先级最高）。 */
  httpStatus?: number;
}

/**
 * 错误 → errorKind 纯映射。判定顺序（先确定性强的信号，后文案关键字）：
 *  1) httpStatus 显式传入 → http；
 *  2) error.code（ENOTFOUND/ETIMEDOUT/ECONNREFUSED）；
 *  3) Electron net::ERR_* 与中文/英文文案关键字兜底（net.fetch 常把 code 藏在 message）。
 * 真机若出现未覆盖的 message 形态 → 落 unknown（UI 给通用文案 + 原始 message 供上报），不误判。
 */
export function classifySubscriptionError(
  sig: SubscriptionErrorSignal
): { errorKind: SubscriptionErrorKind; httpStatus?: number } {
  const status = sig.httpStatus;
  if (typeof status === 'number' && status >= 400) {
    return { errorKind: 'http', httpStatus: status };
  }

  const code = (sig.code || '').toUpperCase();
  const msg = sig.message || '';
  const m = msg.toLowerCase();

  // 体积/协议/空/SSRF：本项目 fetchSubscriptionText/parseSubscriptionContent 的确定性中文文案（先于网络码，
  // 因为这些是本项目主动 throw、文案稳定）。
  if (/体积超过上限|too large|导入内容过大/.test(msg)) return { errorKind: 'toolarge' };
  if (/协议不支持|仅允许 http/.test(msg)) return { errorKind: 'scheme' };
  if (/0 个可用节点|得到 0 个|为空/.test(msg)) return { errorKind: 'empty' };
  if (/内网|本机|私有地址|ssrf|loopback|private|重定向次数超过/.test(m) || /内网|本机/.test(msg))
    return { errorKind: 'ssrf' };

  // 网络错误码（Node dns/socket 层）。
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { errorKind: 'dns' };
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ABORT_ERR')
    return { errorKind: 'timeout' };
  if (code === 'ECONNREFUSED') return { errorKind: 'refused' };
  if (code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH')
    return { errorKind: 'refused' };

  // Electron net::ERR_* / fetch message 关键字兜底。
  if (/err_name_not_resolved|getaddrinfo|dns/.test(m)) return { errorKind: 'dns' };
  if (/err_timed_out|timeout|timed out|aborted|the operation was aborted/.test(m))
    return { errorKind: 'timeout' };
  if (/err_connection_refused|connection refused|econnrefused/.test(m))
    return { errorKind: 'refused' };
  if (/err_connection_reset|err_connection_closed|err_address_unreachable|unreachable/.test(m))
    return { errorKind: 'refused' };

  // 解析类文案（parseSubscriptionContent 的结构/格式错误）。
  if (/解析失败|无法识别|结构异常|格式错误|不是有效|parse|yaml|json/.test(m) || /解析|识别|格式/.test(msg))
    return { errorKind: 'parse' };

  return { errorKind: 'unknown' };
}

/** errorKind → i18n key（渲染侧 t() 取展示文案；标题/详情各一，见 i18n `sub.preview.*`）。 */
export const SUBSCRIPTION_ERROR_I18N_KEY: Record<
  SubscriptionErrorKind,
  { title: string; detail: string }
> = {
  dns: { title: 'sub.preview.dnsTitle', detail: 'sub.preview.dnsDetail' },
  timeout: { title: 'sub.preview.timeoutTitle', detail: 'sub.preview.timeoutDetail' },
  refused: { title: 'sub.preview.refusedTitle', detail: 'sub.preview.refusedDetail' },
  http: { title: 'sub.preview.httpTitle', detail: 'sub.preview.httpDetail' },
  ssrf: { title: 'sub.preview.ssrfTitle', detail: 'sub.preview.ssrfDetail' },
  scheme: { title: 'sub.preview.schemeTitle', detail: 'sub.preview.schemeDetail' },
  toolarge: { title: 'sub.preview.toolargeTitle', detail: 'sub.preview.toolargeDetail' },
  parse: { title: 'sub.preview.parseTitle', detail: 'sub.preview.parseDetail' },
  empty: { title: 'sub.preview.emptyTitle', detail: 'sub.preview.emptyDetail' },
  unknown: { title: 'sub.preview.unknownTitle', detail: 'sub.preview.unknownDetail' },
};
