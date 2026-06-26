/**
 * Cloudflare WARP 设备注册协议（纯逻辑，无网络）——供主进程 WarpService 调用、单测覆盖。
 * WARP 即 WireGuard：匿名注册一个设备 → 拿到一份 WG 配置（对端公钥/端点/分配 IP/client_id），
 * FlowZ 直接作为普通 WireGuard endpoint 节点使用（已支持 reserved）。网络发送/TLS 指纹在 WarpService。
 *
 * 版本串说明：Cloudflare 按客户端发版滚动 API 版本，path 段(version)与 CF-Client-Version 必须配对，
 * 旧串会被服务端拒（如 wgcf 钉死的 v0a1922 自 2025-08 起注册返 500）。故做成常量、可被 WarpService 覆盖重试。
 */

/** 注册端点与请求头默认值（可被 WarpService 调用方覆盖以应对版本漂移）。 */
export const WARP_API_BASE = 'https://api.cloudflareclient.com';
export const WARP_API_VERSION = 'v0a2158';
export const WARP_CLIENT_VERSION = 'a-7.21-0721';
export const WARP_USER_AGENT = 'okhttp/3.12.1';

/** WARP 标准 WG 参数。endpoint 一般由注册响应给出（engage.cloudflareclient.com:2408），下列为兜底默认。 */
export const WARP_DEFAULT_ENDPOINT_HOST = 'engage.cloudflareclient.com';
export const WARP_DEFAULT_ENDPOINT_PORT = 2408;
export const WARP_MTU = 1280;
export const WARP_ALLOWED_IPS = ['0.0.0.0/0', '::/0'];

/** WARP 端点域名锚点：注册响应给出的 endpoint 均属此域（engage / 162.159.x 走 *.cloudflareclient.com）。 */
export const WARP_ENDPOINT_DOMAIN = 'cloudflareclient.com';

/**
 * 判定 WireGuard 节点是否为 Cloudflare WARP。**鲁棒**：新节点带自删凭据 `warpDevice`，但**旧/导入的 WARP 节点无此标记**
 * → 必须同时按端点域名（`*.cloudflareclient.com`）兜底，否则旧 WARP 漏判（真机实证：旧 WARP 节点 `warpDevice` 缺失，
 * 致接入模式/子网路由该隐藏未隐藏、且 system 误判可触发 `Connect: resource busy`）。供 builder 接入模式否决
 * （meshUsesSystemInterface）、WG 表单只读/隐藏组网、列表角标共用单一真值。
 */
export function isWarpServer(server: {
  protocol?: string;
  address?: string;
  wireguardSettings?: { warpDevice?: unknown } | null;
}): boolean {
  if (server.protocol?.toLowerCase() !== 'wireguard') return false;
  if (server.wireguardSettings?.warpDevice) return true;
  return (server.address || '').toLowerCase().includes(WARP_ENDPOINT_DOMAIN);
}

/** 注册请求体（POST /reg）。tos = RFC3339Nano UTC 时间戳（ToS 接受时间）；install_id/fcm_token 传空可注册。 */
export function buildRegisterBody(
  publicKeyB64: string,
  tosTimestamp: string
): Record<string, string> {
  return {
    key: publicKeyB64,
    install_id: '',
    fcm_token: '',
    tos: tosTimestamp,
    model: 'PC',
    type: 'Android',
    locale: 'en_US',
  };
}

/** base64(client_id) → 前 3 字节十进制数组（sing-box/xray 的 reserved）。非法/不足 3 字节返回 undefined。 */
export function reservedFromClientId(clientId: string | undefined): number[] | undefined {
  if (!clientId) return undefined;
  let buf: Buffer;
  try {
    buf = Buffer.from(clientId, 'base64');
  } catch {
    return undefined;
  }
  if (buf.length < 3) return undefined;
  return [buf[0], buf[1], buf[2]];
}

/** 拆 "host:port" / "[v6]:port"；缺端口回落 WARP 默认 2408。 */
export function splitEndpoint(endpoint: string | undefined): { host: string; port: number } {
  const e = (endpoint || '').trim();
  if (!e) return { host: WARP_DEFAULT_ENDPOINT_HOST, port: WARP_DEFAULT_ENDPOINT_PORT };
  // [2606:4700:...]:2408
  const v6 = e.match(/^\[(.+)\]:(\d+)$/);
  if (v6) return { host: v6[1], port: Number(v6[2]) };
  const idx = e.lastIndexOf(':');
  if (idx > 0 && !e.slice(idx + 1).includes(':')) {
    const port = Number(e.slice(idx + 1));
    if (Number.isInteger(port) && port > 0) return { host: e.slice(0, idx), port };
  }
  return { host: e, port: WARP_DEFAULT_ENDPOINT_PORT };
}

/**
 * WARP 注册产出的 WireGuard 草稿（无 id，供渲染端填表）。
 * warpDevice = 自删凭据（deviceId+token），随节点落 wireguardSettings.warpDevice、与 privateKey 同脱敏
 * （历史上「token 不持久化」红线已被用户拍板放宽，见 WARP 设计 §设备移除 / 不变量）。
 */
export interface WarpWireGuardDraft {
  address: string;
  port: number;
  privateKey: string;
  peerPublicKey: string;
  localAddress: string[];
  allowedIPs: string[];
  reserved?: number[];
  mtu: number;
  meta: { deviceId: string; accountId: string; license: string; warpPlus: boolean };
  /** 远端设备自删凭据（deviceId+token）。删除此节点时据它发 DELETE /reg/{deviceId} 注销匿名设备。 */
  warpDevice: { deviceId: string; token: string };
}

/** WARP 注册响应里 FlowZ 关心的子集。 */
export interface WarpRegisterResult {
  /** 对端（WARP relay）地址：endpoint host。 */
  address: string;
  /** 对端端口。 */
  port: number;
  /** 对端 WG 公钥。 */
  peerPublicKey: string;
  /** 分配给本机的隧道地址（v4 /32、v6 /128）。 */
  localAddress: string[];
  /** reserved 3 字节（来自 client_id）。 */
  reserved: number[] | undefined;
  /** 设备 id / 账户 id / license（仅供日志/展示，token 不持久化）。 */
  deviceId: string;
  accountId: string;
  license: string;
  /** 是否 WARP+（account.warp_plus）。 */
  warpPlus: boolean;
}

/**
 * 解析 POST /reg 的 JSON 响应 → WarpRegisterResult。缺关键字段（peer 公钥/端点/分配 IP）则抛错。
 * 不含 privateKey（本地生成，由 WarpService 合并）。
 */
export function parseRegisterResponse(json: any): WarpRegisterResult {
  const config = json?.config;
  const peer = config?.peers?.[0];
  const peerPublicKey = peer?.public_key;
  const endpointHost = peer?.endpoint?.host;
  const v4 = config?.interface?.addresses?.v4;
  const v6 = config?.interface?.addresses?.v6;
  if (!peerPublicKey || !endpointHost || (!v4 && !v6)) {
    throw new Error('WARP 注册响应缺少 peer 公钥 / 端点 / 分配地址');
  }
  const { host, port } = splitEndpoint(endpointHost);
  const localAddress: string[] = [];
  if (v4) localAddress.push(`${v4}/32`);
  if (v6) localAddress.push(`${v6}/128`);
  return {
    address: host,
    port,
    peerPublicKey,
    localAddress,
    reserved: reservedFromClientId(config?.client_id),
    deviceId: json?.id || '',
    accountId: json?.account?.id || '',
    license: json?.account?.license || '',
    warpPlus: !!json?.account?.warp_plus,
  };
}

// ── 设备注销 / 待注销队列（纯逻辑，网络/文件 IO 在 WarpService / WarpDeregisterQueue） ──────────────

/**
 * 注销重试阈值（常量化便于调）。
 * 主阈值按「入队年龄」而非次数——重试等的是网络恢复（wall-clock 量纲），次数随开 app 频率漂移不可比。
 */
export const WARP_DEREGISTER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天未成功 → 放弃（孤儿零计费）
export const WARP_DEREGISTER_MAX_QUEUE = 100; // 队列条数上限，超则丢最旧 + 日志（防 register-loop 撑爆）
export const WARP_DEREGISTER_MAX_PER_DRAIN = 10; // 单次 drain 至多处理条数（避免启动 hammer CF / 触 1020）

/** 待注销队列条目（落 <userData>/warp/pending-deregister.json）。token=自删凭据，与 privateKey 同脱敏。 */
export interface PendingDeregisterEntry {
  deviceId: string;
  token: string;
  enqueuedAt: number; // Date.now()，按年龄判超时
}

/**
 * 构造注销请求（纯函数，无网络）。裸 DELETE /{version}/reg/{deviceId} + Bearer token + 同 register 的
 * UA/CF-Client-Version（TLS1.2/okhttp 指纹在 WarpService，否则 1020）。
 * 实测：自删走裸 /reg/{id}（非 .../account/reg/{id}——那是登录账户删绑定设备、自删返 401）→ 204；再删 404。
 */
export function buildUnregisterRequest(
  version: string,
  deviceId: string,
  token: string
): { url: string; headers: Record<string, string> } {
  return {
    url: `${WARP_API_BASE}/${version}/reg/${deviceId}`,
    headers: {
      'User-Agent': WARP_USER_AGENT,
      'CF-Client-Version': WARP_CLIENT_VERSION,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  };
}

/** 注销结果分类：done=出队（已注销/别处已销）；drop=出队（凭据死，重试纯浪费）；retry=留队消耗重试预算。 */
export type DeregisterResult = 'done' | 'drop' | 'retry';

/**
 * 注销失败分类（纯函数）。status=null 表网络失败/超时（无 HTTP 状态）。
 *  - 204 / 404 → done（404=别处已销，视作成功）
 *  - 401 / 403 → drop（token 失效/被拒，重试死 token 纯浪费）
 *  - 网络失败/超时(null) / 5xx / 400 / 含 1020 → retry（暂时不可达 / 待 app 升级版本串）
 *  - 其它未知 4xx → drop（非暂时性，重试无收益；保守不无限占预算）
 */
export function classifyDeregisterResult(status: number | null, err?: unknown): DeregisterResult {
  // 网络失败 / 超时：无 HTTP 状态 → 暂时不可达，重试。
  if (status == null) return 'retry';
  if (status === 204 || status === 404) return 'done'; // definitive success，优先于一切
  // Cloudflare WAF 1020（版本串失效）常以 403 携带 body code 1020 返回——这是「待 app 升级版本串」信号，
  // 须**优先于** 401/403 的 drop 判定（否则被误当 token 死而放弃）。err 文本含 1020 一律 retry（升级后恢复）。
  if (err != null && String((err as { message?: unknown })?.message ?? err).includes('1020')) {
    return 'retry';
  }
  if (status === 401 || status === 403) return 'drop'; // token 失效/被拒，重试死 token 纯浪费
  if (status >= 500) return 'retry';
  if (status === 400) return 'retry';
  // 其它未知 4xx：非暂时性，drop（不无限占重试预算）。
  return 'drop';
}

/**
 * 入队（纯函数）：追加新条目，受 WARP_DEREGISTER_MAX_QUEUE 护栏——超上限丢最旧（FIFO）。
 * 返回 { queue, dropped }：dropped=被挤掉的最旧条目（供调用方日志，只打 deviceId 前缀）。
 */
export function enqueuePendingDeregister(
  queue: PendingDeregisterEntry[],
  entry: PendingDeregisterEntry
): { queue: PendingDeregisterEntry[]; dropped: PendingDeregisterEntry[] } {
  const next = [...queue, entry];
  const dropped: PendingDeregisterEntry[] = [];
  while (next.length > WARP_DEREGISTER_MAX_QUEUE) {
    const old = next.shift();
    if (old) dropped.push(old);
  }
  return { queue: next, dropped };
}

/** 单条 drain 计划：超龄 expire（不调网络直接 drop）/ 在龄 eligible（调 unregister）。 */
export interface DrainPlanItem {
  entry: PendingDeregisterEntry;
  action: 'expire' | 'eligible';
}

/**
 * drain 计划（纯函数，无 IO）：按年龄分流 + 截断到 MAX_PER_DRAIN。
 *  - 年龄 > MAX_AGE_MS → expire（放弃，warn 后出队，不调网络）
 *  - 否则 → eligible（本次调 unregister）；eligible 至多取前 MAX_PER_DRAIN 条，余下顺延下个触发点
 * expired 不占 MAX_PER_DRAIN 预算（不调网络）。返回 plan（本次处理）+ deferred（本次不动、留队）。
 */
export function planDeregisterDrain(
  queue: PendingDeregisterEntry[],
  now: number
): { plan: DrainPlanItem[]; deferred: PendingDeregisterEntry[] } {
  const plan: DrainPlanItem[] = [];
  const deferred: PendingDeregisterEntry[] = [];
  let eligibleCount = 0;
  for (const entry of queue) {
    if (now - entry.enqueuedAt > WARP_DEREGISTER_MAX_AGE_MS) {
      plan.push({ entry, action: 'expire' });
    } else if (eligibleCount < WARP_DEREGISTER_MAX_PER_DRAIN) {
      plan.push({ entry, action: 'eligible' });
      eligibleCount += 1;
    } else {
      deferred.push(entry);
    }
  }
  return { plan, deferred };
}
