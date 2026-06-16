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

/** WARP 注册产出的 WireGuard 草稿（无 id，供渲染端填表）。token 不在内（不持久化）。 */
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
