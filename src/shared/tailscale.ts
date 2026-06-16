/**
 * Tailscale 相关纯逻辑（可单测）。
 */

/**
 * 从 sing-box 日志行抓 Tailscale 交互登录 URL。
 * 实证格式（2026-06-16，netns 真跑）：`... endpoint/tailscale[<tag>]: Waiting for authentication: <url>`。
 * 命中返回 { nodeName(=tag), url }；否则 null。tag 即节点显示名（idToTagMap 用 server.name）。
 */
export function parseTailscaleAuthLine(line: string): { nodeName: string; url: string } | null {
  const m = /endpoint\/tailscale\[(.+?)\]:\s*Waiting for authentication:\s*(\S+)/i.exec(line);
  if (!m) return null;
  return { nodeName: m[1], url: m[2] };
}
