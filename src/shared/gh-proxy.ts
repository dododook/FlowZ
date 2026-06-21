/**
 * GitHub 下载加速（gh-proxy 类前缀）：主进程下载与渲染端设置共用。
 * 加速默认关闭（''=直连，可选开关）。校验用户输入的加速域名合法性。
 */

export const GH_PROXY_PRESETS = [
  'https://gh-proxy.org/',
  'https://v4.gh-proxy.org/',
  'https://cdn.gh-proxy.org/',
] as const;

/**
 * sing-box 官方面板资源默认 download_url（zip）。sing-box 文档 service/api dashboard.download_url 缺省值。
 * 用户可在设置里用 singboxDashboardUrl 覆盖；下发时经 ghProxyPrefix 镜像加速包裹（github.com 域命中加速）。
 */
export const DEFAULT_SINGBOX_DASHBOARD_URL =
  'https://github.com/SagerNet/sing-box-dashboard/archive/refs/heads/gh-pages.zip';

// 主机名（可带端口）校验：标签 1-63、不以连字符首尾、TLD 2-63 字母、总长合理、可选端口
export const GH_PROXY_HOST_RE =
  /^(?=.{4,253}(?::\d{1,5})?$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}(:\d{1,5})?$/;

/**
 * 用户输入（裸域名或 https URL）→ 规范化 'https://host[:port]/'；非法返回 null。
 * 只许 https、根路径、无凭据/查询/锚点。
 */
export function normalizeGhProxyPrefix(input: string): string | null {
  const s = (input || '').trim().replace(/\/+$/, '');
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  const hostPort = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  if (!GH_PROXY_HOST_RE.test(hostPort)) return null;
  if (u.port && (Number(u.port) < 1 || Number(u.port) > 65535)) return null;
  return `https://${hostPort}/`;
}

const GH_HOSTS = [
  'raw.githubusercontent.com',
  'github.com',
  'objects.githubusercontent.com',
  'gist.githubusercontent.com',
  'codeload.github.com',
];

/**
 * 拼接加速前缀 + 完整原 URL（同 gh-proxy 用法）。非前缀 / 非 GitHub 域 → 原样返回。
 * 注意：api.github.com 不在 GH_HOSTS（Trees API 刷新不走加速）。
 */
export function applyGhProxy(prefix: string | undefined, url: string): string {
  if (!prefix) return url;
  try {
    if (!GH_HOSTS.includes(new URL(url).hostname)) return url;
  } catch {
    return url;
  }
  return prefix + url;
}

/**
 * GitHub 下载失败兜底镜像 URL：优先用户配置前缀（applyGhProxy 命中 GitHub 域时生效），
 * 否则回落内置 preset[0]（末尾带 '/'，直接拼完整原 URL）。收口 CoreUpdate(传 ghPrefix)/Update(不传)/
 * RuleResource 各处的镜像拼接为单一真值。
 */
export function ghMirrorUrl(url: string, ghPrefix?: string): string {
  if (ghPrefix) {
    const proxied = applyGhProxy(ghPrefix, url);
    if (proxied !== url) return proxied;
  }
  return GH_PROXY_PRESETS[0] + url;
}
