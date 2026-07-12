/**
 * 节点测速目标 URL 解析（纯函数，主进程 SpeedTestService + 单测共用；不经网络）。
 *
 * 测速经临时 sing-box 的各节点 HTTP 代理出站、CONNECT 隧道上发两次 GET 量 warm TTFB（mihomo `unified-delay` 等价）。
 * 默认 generate_204（204 空响应、可立即复用连接）。用户可自配（如 gstatic/自建端点），
 * HTTP/HTTPS 同走 CONNECT 隧道（https 目标先在隧道上 TLS 握手）。非法/非 http(s)/无 host → 调用方回落默认。
 */

import type { ServerConfig } from './types';

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

/**
 * 主核测速探测池大小（§15，测速全主核化）：主核 config 注入 K 个 probe-in-k(http 入站) + K 个 probe-selector-k
 * + K 条 route + K 个 dns-probe-exit-k，测速时按波把节点分配到 K 槽经 gRPC selectOutbound 热切、复用现成
 * measureViaTunnel（warm-TTFB 保真）→ 同核单会话，结构性消除 WG/WARP 双会话超时（G1）。K=16 对齐
 * PROXY_TEST_CONCURRENCY；大订阅可下调换 config 体积；=0 使池不注入（回退临时核，回滚锚点）。
 * ProxyManager（端口分配）+ SpeedTestService（编排）+ 四个 builder（config 注入）共用单一真值。
 */
export const PROBE_POOL_SIZE = 16;

/**
 * 主核测速探测池句柄（ProxyManager.getSpeedTestMainCoreProbe 产出，SpeedTestService 消费）：主核运行且池就绪
 * 时测速走主核（testServersViaMainCore），否则回退临时核（testServersViaProxy）。全部 call-time 取值。
 */
export interface MainCoreProbe {
  /** 池端口已分配（allocateProbePorts 3+K 成功）→ 主核 config 已注入池。 */
  available(): boolean;
  /** 主核进程存活且管理 API 客户端就绪（可 selectOutbound 热切 probe-selector-k）。 */
  isRunning(): boolean;
  /** K 个 probe-in-k 的 http 代理端口；poolPorts[k] ↔ probe-selector-k（1:1 槽绑定）。 */
  poolPorts: number[];
  /** 把第 k 槽 selector（probe-selector-k）热切到给定节点出站 tag（gRPC SelectOutbound，live 生效）。 */
  selectSlot(k: number, tag: string): Promise<void>;
  /** 节点 id → 出站 tag（= 主 proxy-selector 成员 tag）。 */
  tagOf(id: string): string;
  /** 该节点 id 是否已在主核池成员（currentIdToTagMap 有此 id）。§16.3.3：非成员=订阅新增/改址未重启入池，
   *  预筛缺席防 select-failed 假 -1（诚实性安全网）。 */
  hasTag(id: string): boolean;
  /** 该 Tailscale 节点是否已登录就绪（backendState==='Running' && !keyExpired）。§16.1.3 层3：
   *  未就绪 TS 节点波内缺席（不 select/measure/report），UI 走「未登录」徽标，绝不写假 -1。 */
  tsNodeReady(id: string): boolean;
  /** §2：节点已编辑未生效（**传入的待测节点**参数 ≠ 运行核启动快照）→ 波前剔除。否则测的是运行核里的旧参数出口、
   *  latency 挂到新参数名下失真（徽标已经 pendingChanges 显「待生效」，此处再免测省槽 + 不存陈旧值）。
   *  传完整节点（非 id）：待测列表来自 ConfigManager 最新 config，直接比其指纹 vs 快照，避开 currentConfig 在
   *  订阅 OFF 自动刷新路径的滞后（review F-B：currentConfig 那条路径不经 switchMode 更新会漏判）。 */
  isDirty(server: ServerConfig): boolean;
}

/** 测速本次运行结局（§16.2）：completed=本次入参全部有结果（含真实 -1 超时）；interrupted=有入参节点缺席
 *  （核 stop/restart/regen 跃迁或崩溃打断，保留旧值不写假 -1）。「起测即知不可测」（skipped）不产生 interrupted。 */
export type SpeedTestOutcome = 'completed' | 'interrupted';

/** 起测即知「本核不可测」而波前缺席的节点 id（§16.1.3 层3 / §16.3.3）：不入 outcome 分母（缺席≠中断），
 *  notInPool 另供徽标 tooltip reason 信号（§16.3.3）。 */
export interface SpeedTestSkipped {
  /** 非主核池成员（订阅新增/改址未重启入池）→ tooltip「刷新订阅后纳入测速」。 */
  notInPool: string[];
  /** TS 节点未登录就绪 → 徽标走既有「未登录」态。 */
  tsNotReady: string[];
}

/** doTestAllServers/testAllServers 收口返回（§16.2）：结果 map + 结局 + 波前缺席集。 */
export interface SpeedTestRunResult {
  results: Map<string, number | null>;
  outcome: SpeedTestOutcome;
  skipped: SpeedTestSkipped;
}

/** SERVER_SPEED_TEST invoke 返回（renderer 消费 §16.2/§16.3.3）：Record 化结果（null→-1）+ outcome + 波前缺席两列表
 *  （notInPool→徽标 tooltip「刷新订阅后纳入测速」信号存 Set；notInPool+tsNotReady 合计=toast 副行「N 未纳入」）。 */
export interface SpeedTestInvokeResult {
  results: Record<string, number>;
  outcome: SpeedTestOutcome;
  notInPool: string[];
  tsNotReady: string[];
}
