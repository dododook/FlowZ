/**
 * 节点测速目标 URL 解析（纯函数，主进程 SpeedTestService + 单测共用；不经网络）。
 *
 * 测速经临时 sing-box 的各节点 HTTP 代理出站、CONNECT 隧道上发两次 GET 量 warm TTFB（mihomo `unified-delay` 等价）。
 * 默认 generate_204（204 空响应、可立即复用连接）。用户可自配（如 gstatic/自建端点），
 * HTTP/HTTPS 同走 CONNECT 隧道（https 目标先在隧道上 TLS 握手）。非法/非 http(s)/无 host → 调用方回落默认。
 */

/**
 * 默认测速端点：www.gstatic.com generate_204（204 空响应，连接可立即复用）。
 *
 * 为何不用 cp.cloudflare.com（曾用，issue #154）：CF-Workers / 优选IP 节点（FlowZ 用户里占大头）对 cp.cloudflare
 * 这个 Cloudflare 自家端点测速会失败——reporter 实证「把测速地址换成非 CF 端点即恢复正常」。
 * 为何 gstatic 的国内 CDN 镜像在此不成问题：测速目标域名由【每个被测节点的出口】远程解析，**不经本机 AliDNS**
 * （localhost 实验确证 sing-box 把域名 ATYP=domain 透传给出站，见 docs/design/speedtest-remote-resolve-154.md）——
 * 故各节点拿到本区域 IP，目标是否任播 / 有无国内镜像均与测速无关，海外出口绝不会被钉到国内镜像 IP。
 * 端点选择由此从「必须任播的脆弱依赖」降级为「次要、用户可在设置自配」。
 */
export const DEFAULT_SPEED_TEST_URL = 'http://www.gstatic.com/generate_204';

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

/**
 * 从 HTTP 响应（含状态行 `HTTP/1.1 204 ...`）解析状态码（纯函数，issue #154 ③ 校验响应码）。
 * 入参应从第二次响应的 `HTTP/` 状态行起算的缓冲；解析不出 → null（调用方按「无法判定」处理）。
 */
export function parseHttpStatusCode(responseHead: string): number | null {
  if (!responseHead) return null;
  const m = responseHead.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i);
  if (!m) return null;
  const code = Number(m[1]);
  return Number.isInteger(code) && code >= 100 && code <= 599 ? code : null;
}

/**
 * 测速目标响应是否「可接受为成功」：仅 2xx（含 generate_204 的 204 / 自配端点的 200）。
 * 非 2xx（3xx 重定向 / 4xx 如 cp.cloudflare 经 CF-Workers 的 403 / 5xx）判失败——堵住「错误页被当成功记 TTFB」。
 */
export function isAcceptableSpeedTestStatus(code: number): boolean {
  return code >= 200 && code <= 299;
}
