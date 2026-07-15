/**
 * 主进程转发 renderer console 错误的**纯限频 + 截断**（GAP-1c，供单测）。
 *
 * 定位：renderer 的未捕获错误 / 主动 console.error 是「进程活着但可能 DOM 空」的可观测信号（Electron 不发主进程
 * 事件），经 webContents 'console-message' 桥到 app.log。风险是错误风暴（如 render 循环里每帧 throw）把 logManager
 * 刷爆；故滑动窗口限频 + 单条截断。纯逻辑无 electron 依赖，接线层负责取 details、写 logManager。
 */

/** 默认滑动窗口 1s。 */
const DEFAULT_WINDOW_MS = 1_000;
/** 默认每窗口最多转 10 条（够看清风暴征兆，又不至刷爆日志）。 */
const DEFAULT_MAX_PER_WINDOW = 10;
/** 默认单条 message 截断上限（字符）。 */
const DEFAULT_MAX_MESSAGE_CHARS = 2_000;

/**
 * 限频决策（纯函数，形态同 detectRenderCrashLoop）。剪掉窗口外的旧时刻，未超上限则纳入本次并 admit=true，
 * 超上限则不纳入、admit=false（丢弃本条，不占额度以免风暴期计数无界增长）。
 * @returns recent 剪枝后的时间戳数组（admit 时含本次）；admit 是否放行本条。
 */
export function admitConsoleMessage(
  timestamps: number[],
  now: number,
  windowMs: number = DEFAULT_WINDOW_MS,
  maxPerWindow: number = DEFAULT_MAX_PER_WINDOW
): { recent: number[]; admit: boolean } {
  const recent = timestamps.filter((t) => now - t < windowMs);
  if (recent.length >= maxPerWindow) {
    return { recent, admit: false };
  }
  recent.push(now);
  return { recent, admit: true };
}

/** 单条 message 截断（超上限尾部加省略标记，防超长串撑爆单行日志）。 */
export function truncateConsoleMessage(
  message: string,
  maxChars: number = DEFAULT_MAX_MESSAGE_CHARS
): string {
  if (message.length <= maxChars) return message;
  return message.slice(0, maxChars) + `…(+${message.length - maxChars} chars)`;
}
