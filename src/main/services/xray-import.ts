/**
 * Xray / v2ray JSON 配置 → ServerConfig 解析（纯模块，刻意不 import electron，可直接 jest 单测）。
 *
 * 与 sing-box JSON 的差异：xray outbound 用 `protocol` + `settings`（vnext/servers）+ `streamSettings`，
 * 而 sing-box 用扁平 `type` + 同级字段。本模块只覆盖 FlowZ 已建模的主流协议；其余协议跳过并报告
 * （不透传 custom：custom 落点是 sing-box outbound schema，xray schema 不兼容）。
 *
 * 逐 outbound try/catch，单条失败不影响其它（对齐 ClashSubscriptionParser.parseClashProxies）。
 */
import { randomUUID } from 'crypto';
import type { ServerConfig, Network, Security } from '../../shared/types';

/** 本模块可映射的 xray outbound.protocol。 */
const XRAY_SUPPORTED = new Set(['vmess', 'vless', 'trojan', 'shadowsocks']);
/** xray 内部/非节点 outbound（忽略，不计入 skipped）。 */
const XRAY_INTERNAL = new Set(['freedom', 'blackhole', 'dns', 'loopback']);

export interface XrayParseResult {
  servers: ServerConfig[];
  skipped: number; // 协议不支持
  failed: number; // 字段缺失 / 异常
  warnings: string[];
}

/** 标量规整：数字/字符串统一 String()，缺省 undefined。 */
function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** xray streamSettings → ServerConfig 传输/安全层字段。 */
function applyStreamSettings(server: ServerConfig, ss: Record<string, unknown> | undefined): void {
  if (!ss || typeof ss !== 'object') return;

  // 传输层
  const network = (str(ss.network) || 'tcp').toLowerCase();
  if (network === 'ws') {
    server.network = 'ws';
    const ws = (ss.wsSettings as Record<string, unknown>) || {};
    const headers = (ws.headers as Record<string, unknown>) || {};
    const host = str(headers.Host) || str(headers.host);
    server.wsSettings = { path: str(ws.path) || '/', headers: host ? { Host: host } : undefined };
  } else if (network === 'grpc') {
    server.network = 'grpc';
    const grpc = (ss.grpcSettings as Record<string, unknown>) || {};
    server.grpcSettings = { serviceName: str(grpc.serviceName) || '' };
  } else if (network === 'h2' || network === 'http') {
    server.network = 'http';
    const h2 = (ss.httpSettings as Record<string, unknown>) || {};
    const hostVal = h2.host;
    server.httpSettings = {
      path: str(h2.path) || '/',
      host: Array.isArray(hostVal)
        ? (hostVal as string[])
        : str(hostVal)
          ? [str(hostVal)!]
          : undefined,
    };
  } else if (network === 'httpupgrade') {
    server.network = 'httpupgrade';
    const hu = (ss.httpupgradeSettings as Record<string, unknown>) || {};
    const host = str(hu.host);
    server.wsSettings = { path: str(hu.path) || '/', headers: host ? { Host: host } : undefined };
  } else {
    server.network = 'tcp' as Network;
  }

  // 安全层
  const security = (str(ss.security) || 'none').toLowerCase();
  if (security === 'tls' || security === 'xtls') {
    server.security = 'tls' as Security;
    const tls = (ss.tlsSettings as Record<string, unknown>) || {};
    const alpn = tls.alpn;
    server.tlsSettings = {
      serverName: str(tls.serverName),
      allowInsecure: tls.allowInsecure === true,
      alpn: Array.isArray(alpn) ? (alpn as string[]) : undefined,
      fingerprint: str(tls.fingerprint) || 'chrome',
    };
  } else if (security === 'reality') {
    server.security = 'reality' as Security;
    const reality = (ss.realitySettings as Record<string, unknown>) || {};
    server.tlsSettings = {
      serverName: str(reality.serverName),
      fingerprint: str(reality.fingerprint) || 'chrome',
    };
    server.realitySettings = {
      publicKey: str(reality.publicKey) || '',
      shortId: str(reality.shortId),
    };
  } else {
    server.security = 'none' as Security;
  }
}

/** 单条 xray outbound → ServerConfig（失败 throw / 返回 null）。 */
function mapXrayOutbound(
  o: Record<string, unknown>,
  proto: string,
  now: string
): ServerConfig | null {
  const settings = (o.settings as Record<string, unknown>) || {};
  const tag = str(o.tag);

  const base = (address: string, port: number): ServerConfig => ({
    id: randomUUID(),
    name: tag || `${address}:${port}`,
    protocol: proto as ServerConfig['protocol'],
    address,
    port,
    createdAt: now,
    updatedAt: now,
  });

  if (proto === 'vmess' || proto === 'vless') {
    const vnext = (settings.vnext as Array<Record<string, unknown>>)?.[0];
    if (!vnext) return null;
    const address = str(vnext.address);
    const port = num(vnext.port);
    const user = (vnext.users as Array<Record<string, unknown>>)?.[0];
    const uuid = str(user?.id);
    if (!address || !port || !uuid) return null;
    const server = base(address, port);
    server.uuid = uuid;
    if (proto === 'vmess') {
      server.alterId = num(user?.alterId) ?? 0;
      server.vmessSecurity = str(user?.security) || 'auto';
    } else {
      server.flow = str(user?.flow);
    }
    applyStreamSettings(server, o.streamSettings as Record<string, unknown>);
    return server;
  }

  if (proto === 'trojan') {
    const srv = (settings.servers as Array<Record<string, unknown>>)?.[0];
    if (!srv) return null;
    const address = str(srv.address);
    const port = num(srv.port);
    const password = str(srv.password);
    if (!address || !port || !password) return null;
    const server = base(address, port);
    server.password = password;
    applyStreamSettings(server, o.streamSettings as Record<string, unknown>);
    return server;
  }

  if (proto === 'shadowsocks') {
    const srv = (settings.servers as Array<Record<string, unknown>>)?.[0];
    if (!srv) return null;
    const address = str(srv.address);
    const port = num(srv.port);
    const method = str(srv.method);
    const password = str(srv.password);
    if (!address || !port || !method || !password) return null;
    const server = base(address, port);
    server.shadowsocksSettings = { method, password };
    applyStreamSettings(server, o.streamSettings as Record<string, unknown>);
    return server;
  }

  return null;
}

/** xray outbounds[] → ServerConfig[]，逐条 try/catch，聚合 skipped/failed/warnings。 */
export function parseXrayOutbounds(outbounds: unknown, now: string): XrayParseResult {
  const servers: ServerConfig[] = [];
  let skipped = 0;
  let failed = 0;
  const warnings: string[] = [];
  if (!Array.isArray(outbounds)) return { servers, skipped, failed, warnings };

  const skipByProto = new Map<string, number>();

  for (const ob of outbounds) {
    if (!ob || typeof ob !== 'object') {
      failed++;
      continue;
    }
    const o = ob as Record<string, unknown>;
    const proto = (str(o.protocol) || '').toLowerCase();
    if (!XRAY_SUPPORTED.has(proto)) {
      if (!XRAY_INTERNAL.has(proto)) {
        skipped++;
        skipByProto.set(proto || '(empty)', (skipByProto.get(proto || '(empty)') ?? 0) + 1);
      }
      continue;
    }
    try {
      const server = mapXrayOutbound(o, proto, now);
      if (server) servers.push(server);
      else failed++;
    } catch {
      failed++;
    }
  }

  if (skipByProto.size > 0) {
    const detail = [...skipByProto.entries()].map(([p, c]) => `${p}(${c})`).join(', ');
    warnings.push(`跳过 ${skipped} 个不支持的 Xray 协议: ${detail}`);
  }
  return { servers, skipped, failed, warnings };
}
