/**
 * URL 安全工具（跨进程纯函数）。
 */

/**
 * 把任意来源的字符串安全归一化为 http(s) URL：仅 http: / https: 协议放行，返回规范化 href；
 * 非法 URL 或其它 scheme（file:/javascript: 等危险协议）返回 null。
 *
 * 用于在 openExternal 前限定协议——交互登录 URL 取自内核日志正则捕获，杜绝危险 scheme 注入。
 */
export function safeHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}
