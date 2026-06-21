/**
 * 节点测速目标 URL 解析（纯函数，主进程 SpeedTestService + 单测共用；不经网络）。
 *
 * 测速经临时 sing-box 的各节点 HTTP 代理出站、CONNECT 隧道上发两次 GET 量 warm TTFB（mihomo `unified-delay` 等价）。
 * 默认 generate_204（204 空响应、可立即复用连接）。用户可自配（如 gstatic/自建端点），
 * HTTP/HTTPS 同走 CONNECT 隧道（https 目标先在隧道上 TLS 握手）。非法/非 http(s)/无 host → 调用方回落默认。
 */

/**
 * 默认测速端点：cp.cloudflare.com generate_204（全球任播、无国内 CDN 镜像，对 WARP/海外/国内出口一致可达）。
 * 不用 gstatic：www.gstatic.com 有国内 CDN 镜像，AliDNS(223.5.5.5) 等国内 DNS 会解析到国内镜像 IP（如 180.163.150.162），
 * WARP 等海外全隧道出口连不上该国内 IP → 测速恒超时（Mac 真机实证：换 cp.cloudflare 后 WARP 多节点秒通 204）。
 */
export const DEFAULT_SPEED_TEST_URL = 'http://cp.cloudflare.com/generate_204';

export interface SpeedTestTarget {
  https: boolean;
  host: string; // 不含端口
  port: number; // 80 / 443 / 显式
  path: string; // 含前导 / 与 query
  /** HTTP 代理请求/CONNECT 用的 Host 头（标准端口省略端口，非标准带 host:port）。 */
  hostHeader: string;
  /** HTTP 代理绝对 URI（仅 http 路径用；https 走 CONNECT 不用）。 */
  absoluteUri: string;
}

/**
 * 默认端点解析结果（单源：由 DEFAULT_SPEED_TEST_URL 派生，避免兜底字面量与默认常量双源漂移）。
 * DEFAULT_SPEED_TEST_URL 恒合法 → parseSpeedTestUrl 必非空；`!` 断言由单测护栏（默认解析必成功）。
 */
const DEFAULT_TARGET: SpeedTestTarget = parseSpeedTestUrl(DEFAULT_SPEED_TEST_URL)!;

/**
 * 解析测速 URL 为 SpeedTestTarget。非法 / 非 http(s) / 无 host → null（调用方回落默认）。纯函数，不查网络/FS。
 */
export function parseSpeedTestUrl(raw: string | undefined | null): SpeedTestTarget | null {
  if (!raw || typeof raw !== 'string') return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
  const https = u.protocol === 'https:';
  const defaultPort = https ? 443 : 80;
  const port = u.port ? Number(u.port) : defaultPort;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  const host = u.hostname;
  const path = (u.pathname || '/') + (u.search || '');
  const hostHeader = port === defaultPort ? host : `${host}:${port}`;
  return { https, host, port, path, hostHeader, absoluteUri: `http://${hostHeader}${path}` };
}

/**
 * 解析测速 URL，非法/空回落默认（DEFAULT_TARGET，由 DEFAULT_SPEED_TEST_URL 派生，单源）。
 */
export function resolveSpeedTestTarget(raw?: string | null): SpeedTestTarget {
  return parseSpeedTestUrl(raw) ?? DEFAULT_TARGET;
}
