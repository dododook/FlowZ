/**
 * 按需瞬态登录核（Phase 2）：纯逻辑部分。
 *
 * 「登录专用 sing-box」与运行中主核并存、零提权、无 TUN/clash_api/监听端口，仅为拉起一个 tailscale
 * endpoint 拿交互登录 URL（核自身 stdout 打印 `endpoint/tailscale[<tag>]: Waiting for authentication: <url>`）。
 * PoC（Mac 真机 sing-box 1.13.13）已验：无 inbound 即合法（check exit 0）、瞬态与主核并存无冲突。
 *
 * 本模块只放**纯函数**（config 生成 + 双写防护判定），便于单测、与 ProxyManager 的进程生命周期解耦。
 * 进程 spawn/kill/stdout 解析住 ProxyManager（复用其 singboxPath / spawn / Notification / 事件通道）。
 */

import type { ServerConfig, UserConfig } from '../../shared/types';
import { tailscaleStateDir } from './tailscale-state';

/** 瞬态登录核管理 API（1.14 services[]）入参：独立空闲端口 + 随机 secret，使瞬态核暴露 STATUS 流。 */
export interface TailscaleLoginApiService {
  /** 本地空闲端口（须独立于主核 api 端口，避 bind 冲突；由 startTailscaleLogin resolve 后传入）。 */
  port: number;
  /** 每次随机 secret（gRPC Bearer 鉴权；空串退化免认证）。 */
  secret: string;
}

/** 登录专用 config 的最小形状（无 inbound / 无 route，仅 tailscale endpoint + direct + 可选管理 api service）。 */
export interface TailscaleLoginConfig {
  log: { level: 'info'; timestamp: true };
  endpoints: Array<Record<string, unknown>>;
  outbounds: Array<{ type: 'direct'; tag: 'direct' }>;
  // 1.14 管理 API：传入 api 入参时注入 → 瞬态核暴露 SubscribeTailscaleStatus（STATUS 验真登录态）。
  // 与主核 api service 同形（singbox-config-types SingBoxApiService），但端口独立、secret 每次随机。
  services?: Array<{ type: 'api'; listen: '127.0.0.1'; listen_port: number; secret?: string }>;
}

/**
 * 生成登录专用 config：仅含该节点的 tailscale endpoint（state_directory 复用 tailscale-state，与主核一致）
 * + 一个 direct outbound（+ 传入 api 入参时的管理 api service）。**auth_key 永不写入**（有 authKey 就不需要
 * 交互登录，此路径专为无 key 节点）。
 *
 * log.level 强制 info + timestamp:true（不读用户 logLevel/隐私）→ 一并解决 P2（登录捕获不再受日志等级摆布）。
 * 不含 inbound/route：PoC 验过无 inbound 合法；瞬态无监听代理端口故与主核并存无冲突（api service 端口独立解析）。
 *
 * api 入参（可选）：传入则注入 1.14 services[]（type=api，listen=127.0.0.1，独立空闲端口 + 随机 secret），
 * 使瞬态核有 STATUS 流——根治 #132「toast 报已登录但角标恒需登录」：登录成功改由 STATUS(backendState=Running)
 * 经 EVENT_TAILSCALE_STATUS 驱动渲染端 loggedIn，不再靠 stateExists 启发式。不传则退回纯 stdout AUTH_URL 路径。
 *
 * controlUrl/hostname 等身份字段从 tailscaleSettings 透传（与 buildTailscaleEndpoint 同语义），
 * 但**只透传登录相关的少量字段**——瞬态核只为拿 URL + 落 state，不承载路由/出口，故不带 exit_node/
 * advertise_routes/system_interface 等运行期字段（带了也无害，但保持最小、零提权、零接口创建意图）。
 */
export function buildTailscaleLoginConfig(
  server: ServerConfig,
  api?: TailscaleLoginApiService
): TailscaleLoginConfig {
  const ts = server.tailscaleSettings || {};
  const endpoint: Record<string, unknown> = {
    type: 'tailscale',
    tag: server.name,
    state_directory: tailscaleStateDir(server.id),
  };
  // auth_key 故意不写入：本核只服务交互登录（无 key）；有 key 的节点直接连即可，无需此路径。
  const controlUrl = ts.controlUrl?.trim();
  if (controlUrl) endpoint.control_url = controlUrl;
  const hostname = ts.hostname?.trim();
  if (hostname) endpoint.hostname = hostname;
  const ephemeral = ts.ephemeral === true;
  if (ephemeral) endpoint.ephemeral = true;

  const cfg: TailscaleLoginConfig = {
    log: { level: 'info', timestamp: true },
    endpoints: [endpoint],
    outbounds: [{ type: 'direct', tag: 'direct' }],
  };
  if (api) {
    cfg.services = [
      { type: 'api', listen: '127.0.0.1', listen_port: api.port, secret: api.secret || undefined },
    ];
  }
  return cfg;
}

/**
 * 生成「多节点 status-only 探针」专用 config：含传入**所有** Tailscale 节点的 endpoint（state_directory 复用
 * tailscale-state，与主核/登录核一致）+ 一个 direct outbound + 一个管理 api service（STATUS 流）。
 *
 * 与 buildTailscaleLoginConfig 同形（无 inbound/route、零提权、log.level:info）但**多节点**：用于「代理关时也显真实
 * 登录态」——主核未运行时无 STATUS 流，已登录的 Tailscale 节点会被误显「需登录」。探针拉一个含全部 TS endpoint 的
 * 瞬态核，订阅 STATUS（backendState=Running/Starting → loggedIn=true）驱动各节点真实登录态，秒回即拆核。
 *
 * 与登录核的关键区别：**纯查询态**——只为读 STATUS，不开浏览器、不解析 AUTH_URL、不弹登录 toast（调用方 status-only）。
 * auth_key 同样**永不写入**（探针不承载认证，已认证节点的 valid state 会秒回 Running 验真，无 key 节点回 NeedsLogin
 * 仅记 loggedIn=false 不弹 URL）。endpoint.tag = server.name（与主核/handleTailscaleStatus 反查口径一致）。
 *
 * @param servers 待探测的 Tailscale 节点（调用方已按 protocol==='tailscale' 过滤；空数组 → endpoints 空）
 * @param api 管理 api service 入参（独立空闲端口 + 随机 secret，使探针核暴露 SubscribeTailscaleStatus）
 */
export function buildTailscaleStatusProbeConfig(
  servers: ServerConfig[],
  api: TailscaleLoginApiService
): TailscaleLoginConfig {
  const endpoints: Array<Record<string, unknown>> = servers.map((server) => {
    const ts = server.tailscaleSettings || {};
    const endpoint: Record<string, unknown> = {
      type: 'tailscale',
      tag: server.name,
      state_directory: tailscaleStateDir(server.id),
    };
    // auth_key 故意不写入（同 buildTailscaleLoginConfig）：探针只读 STATUS，不承载认证。
    const controlUrl = ts.controlUrl?.trim();
    if (controlUrl) endpoint.control_url = controlUrl;
    const hostname = ts.hostname?.trim();
    if (hostname) endpoint.hostname = hostname;
    if (ts.ephemeral === true) endpoint.ephemeral = true;
    return endpoint;
  });
  return {
    log: { level: 'info', timestamp: true },
    endpoints,
    outbounds: [{ type: 'direct', tag: 'direct' }],
    services: [
      { type: 'api', listen: '127.0.0.1', listen_port: api.port, secret: api.secret || undefined },
    ],
  };
}

/**
 * 双写防护判定（关键正确性）：该节点的 tailscale endpoint **是否已在运行中的主核里**。
 *
 * 两个 sing-box 进程同时写同一 state_directory（tailscaled.state 等）会冲突 → 若主核已带该 endpoint，
 * 则**不要**再起瞬态核。主核带该 endpoint 的条件 = buildOutbounds 的就绪门控（singbox-outbound-builder
 * 行 732-740）：核在运行 且（节点被选中 OR 已就绪 authKey||stateExists）。
 *
 * 返回 true（已在主核）时，调用方拒绝起瞬态核——此时该节点要么已登录（state 已落盘），要么主核路径
 * 已在出 URL（Phase 1 的选中即触发登录）。
 *
 * @param isRunning 主核是否在运行（ProxyManager 进程存活）
 * @param runningConfig 主核当前运行配置（this.currentConfig）；null=未运行
 * @param stateExists 该节点 state 目录是否存在（注入，便于单测；运行期传 tailscaleStateExists(serverId)）
 */
export function tailscaleEndpointInRunningCore(
  serverId: string,
  isRunning: boolean,
  runningConfig: UserConfig | null,
  stateExists: boolean
): boolean {
  if (!isRunning || !runningConfig) return false;
  const server = runningConfig.servers.find(
    (s) => s.id === serverId && s.protocol?.toLowerCase() === 'tailscale'
  );
  if (!server) return false; // 节点不在运行配置里 → 主核没带它的 endpoint
  // buildOutbounds 发射门控：选中 OR 就绪（authKey || state 目录存在）。
  const hasAuthKey = !!server.tailscaleSettings?.authKey?.trim();
  const selected = runningConfig.selectedServerId === serverId;
  const ready = hasAuthKey || stateExists;
  return selected || ready;
}
