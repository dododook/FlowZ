/**
 * Clash / mihomo YAML 订阅解析（纯模块，刻意不 import electron）。
 *
 * 职责拆分：
 *  - tryLoadClashDoc：预检 + yaml 解析（失败包装上抛，绝不静默落 Base64）。
 *  - parseClashProxies：Clash proxies[] → ServerConfig[]，逐节点 try/catch，产出对齐
 *    SubscriptionService.parseSingboxOutbounds（同一物理节点四元组指纹一致，reconcile 命中）。
 *  - resolveProxyProviders：proxy-providers 编排（并发拉取 + filter/exclude/override + 合并）。
 *
 * 之所以与 electron 解耦：jest 在 node env 下可直接 require 本模块做单测，无需 mock electron；
 * app.getVersion() 等 electron 依赖一律由 SubscriptionService 侧注入/传入。
 */
import { randomUUID } from 'crypto';
import { load as yamlLoad } from 'js-yaml';
import type { ServerConfig, Protocol } from '../../shared/types';
import { normalizeDuration } from '../../shared/duration';

// ── 探测正则 / 校验 ──────────────────────────────────────────────────────────
/** 内联 proxies: 或 proxy-providers: 任一命中即「确为 Clash 意图」。 */
export const CLASH_PROBE_RE = /^(proxies|proxy-providers)\s*:/m;

/** Clash 文档结构（仅取本模块关心的字段，其余忽略）。 */
export interface ClashDoc {
  proxies?: unknown;
  'proxy-providers'?: unknown;
  [k: string]: unknown;
}

/** 单条解析产出：节点 + 统计（skipped=不支持/未知 plugin；failed=缺字段/异常）+ 聚合告警。 */
export interface ClashParseResult {
  servers: ServerConfig[];
  skipped: number;
  failed: number;
  warnings: string[];
}

/** proxy-providers 编排依赖注入（DI 保 jest 可测，零网络/零 electron）。 */
export interface ProviderDeps {
  /** 复用 SubscriptionService 的同一 fetch 路径（含 SSRF guard + viaProxy 一致性 + UA）。 */
  fetchText: (url: string, signal: AbortSignal) => Promise<string>;
  /** provider 响应内容解析（allowProviders:false 再入主解析，复用四分支，零新解析代码）。
   *  async：复用 SubscriptionService.parseSubscriptionContent（含 YAML/JSON/base64/url-list 分支）。 */
  parseContent: (trimmed: string) => Promise<ClashParseResult>;
  /** 日志（warn 聚合）。 */
  log: (level: 'info' | 'warn', message: string) => void;
  subscriptionId: string;
  now: string;
  maxProviders?: number; // 默认 8
  fetchTimeoutMs?: number; // 默认 15000
}

const DEFAULT_MAX_PROVIDERS = 8;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

// ── 工具 ─────────────────────────────────────────────────────────────────────
/** 标量规整：数字/字符串统一 String()，缺省 undefined。机场常把 password/uuid 写成数字。 */
function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  return undefined;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return undefined;
}

/** ws-opts.headers 大小写不敏感取 Host（机场写 Host / host / HOST 都接）。 */
function pickHostHeader(headers: unknown): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === 'host') return str(v);
  }
  return undefined;
}

/** alpn 接受字符串或数组，统一成 string[]。 */
function toAlpn(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const arr = v.map((x) => str(x)).filter((x): x is string => !!x);
    return arr.length > 0 ? arr : undefined;
  }
  const s = str(v);
  return s ? [s] : undefined;
}

const SUPPORTED_CLASH_TYPES = new Set<Protocol>([
  'vless',
  'vmess',
  'trojan',
  'shadowsocks',
  'hysteria2',
  'tuic',
  'anytls',
  'socks',
  'http',
  'ssh',
]);

/** Clash type → 内部 Protocol（处理 ss/hysteria2/socks5/http 等别名）。 */
function normalizeClashType(rawType: unknown): Protocol | null {
  const t = str(rawType)?.toLowerCase();
  if (!t) return null;
  switch (t) {
    case 'ss':
    case 'shadowsocks':
      return 'shadowsocks';
    case 'hysteria2':
    case 'hy2':
      return 'hysteria2';
    case 'socks5':
    case 'socks':
      return 'socks';
    case 'http':
    case 'https':
      return 'http';
    case 'vless':
      return 'vless';
    case 'vmess':
      return 'vmess';
    case 'trojan':
      return 'trojan';
    case 'tuic':
      return 'tuic';
    case 'anytls':
      return 'anytls';
    case 'ssh':
      return 'ssh';
    default:
      return null; // ssr/snell/wireguard/hysteria(v1)/mieru/direct/dns 等 → 不支持
  }
}

// ── 文档加载 ─────────────────────────────────────────────────────────────────
/**
 * 预检命中后做 yaml 解析。json:true 容忍机场手写常见的重复 key（取后者）。
 * 解析失败包装后上抛，由调用方决定（绝不静默落 Base64）。
 */
export function tryLoadClashDoc(trimmed: string): ClashDoc {
  let doc: unknown;
  try {
    doc = yamlLoad(trimmed, { json: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Clash YAML 解析失败: ${msg}`);
  }
  if (!doc || typeof doc !== 'object') {
    throw new Error('检测到 Clash 订阅特征，但文档结构异常（非对象）');
  }
  return doc as ClashDoc;
}

// ── 传输层 / TLS 公共映射 ─────────────────────────────────────────────────────
/**
 * 把 Clash proxy 的 network/tls/传输字段折叠进 base config。
 * CDN 三落点严格不错位：
 *   server → address（在 buildBase 已落，绝不被 sni/Host 覆盖）
 *   servername ?? sni → tlsSettings.serverName（SNI 专用）
 *   ws-opts.headers.Host → wsSettings.headers.Host（伪装 Host）
 * @param forceTls 协议隐含必开 TLS（trojan/hy2/tuic/anytls）。
 */
function applyTransportAndTls(
  config: ServerConfig,
  p: Record<string, unknown>,
  forceTls: boolean
): void {
  // —— 传输层 network —— //
  const rawNet = str(p['network'])?.toLowerCase();
  if (rawNet === 'ws') {
    config.network = 'ws';
    const wsOpts = (p['ws-opts'] as Record<string, unknown>) || {};
    const path = str(wsOpts['path']);
    const host = pickHostHeader(wsOpts['headers']);
    const ws: NonNullable<ServerConfig['wsSettings']> = {};
    if (path) ws.path = path;
    if (host) ws.headers = { Host: host };
    const med = num(wsOpts['max-early-data']);
    if (med !== undefined) ws.maxEarlyData = med;
    const edhn = str(wsOpts['early-data-header-name']);
    if (edhn) ws.earlyDataHeaderName = edhn;
    if (Object.keys(ws).length > 0) config.wsSettings = ws;
    // mihomo 的 HTTPUpgrade 表达 = network:ws + ws-opts.v2ray-http-upgrade:true（无独立 network 值）。
    // 不识别会导入成纯 ws——服务端等 HTTP Upgrade、客户端发 WS 帧的必死假节点（issue #263 同类）。
    if (bool(wsOpts['v2ray-http-upgrade']) === true) {
      config.network = 'httpupgrade';
    }
  } else if (rawNet === 'grpc') {
    config.network = 'grpc';
    const grpcOpts = (p['grpc-opts'] as Record<string, unknown>) || {};
    const serviceName = str(grpcOpts['grpc-service-name']);
    if (serviceName) config.grpcSettings = { serviceName };
    else config.grpcSettings = {};
  } else if (rawNet === 'h2' || rawNet === 'http') {
    config.network = 'http';
    // h2-opts（h2，path 为字符串、host 为数组）与 http-opts（vmess network:http，path 为数组取首、
    // host 可在 host 键或 headers.Host）两种落点都读：vmess 走 http-opts 时不能只看 h2-opts 漏 path/host。
    const h2Opts = (p['h2-opts'] as Record<string, unknown>) || {};
    const httpOpts = (p['http-opts'] as Record<string, unknown>) || {};
    const httpSettings: NonNullable<ServerConfig['httpSettings']> = {};
    // path：h2-opts.path（字符串）优先；否则 http-opts.path（数组取首 / 字符串）。
    const rawPath = h2Opts['path'] ?? httpOpts['path'];
    const path = Array.isArray(rawPath) ? str(rawPath[0]) : str(rawPath);
    if (path) httpSettings.path = path;
    // host：h2-opts.host（数组/字符串）→ http-opts.host（数组/字符串）→ http-opts.headers.Host。
    const rawHost = h2Opts['host'] ?? httpOpts['host'];
    if (Array.isArray(rawHost)) {
      const hosts = rawHost.map((x) => str(x)).filter((x): x is string => !!x);
      if (hosts.length > 0) httpSettings.host = hosts;
    } else {
      const single = str(rawHost) ?? pickHostHeader(httpOpts['headers']);
      if (single) httpSettings.host = [single];
    }
    if (Object.keys(httpSettings).length > 0) config.httpSettings = httpSettings;
  } else if (rawNet && rawNet !== 'tcp') {
    // xhttp/splithttp/kcp 等 sing-box 不支持的传输：静默落 tcp 会产出连不上的假节点，
    // 整节点拒绝（mapNode catch 计 fail、聚合告警；与分享链/sing-box JSON 路径统一口径，issue #263）。
    throw new Error(`不支持的传输层类型: ${rawNet}`);
  }
  // 缺省/tcp 不写，等价 tcp。

  // —— TLS / Reality —— //
  const tlsEnabled = bool(p['tls']) === true || forceTls;
  const realityOpts = p['reality-opts'] as Record<string, unknown> | undefined;
  const hasReality = !!realityOpts && !!str(realityOpts['public-key']);
  if (realityOpts && !hasReality) {
    // 带 reality-opts 却缺 public-key：按普通 TLS 入库无法完成 Reality 握手（假节点），整节点拒绝。
    throw new Error('reality-opts 缺少 public-key');
  }

  if (tlsEnabled || hasReality) {
    config.security = hasReality ? 'reality' : 'tls';
    const tls: NonNullable<ServerConfig['tlsSettings']> = {};
    // CDN 关键：SNI 专用落点。servername 优先，其次 sni。
    let serverName = str(p['servername']) ?? str(p['sni']);
    // 三级兜底：仅 TLS 开且 servername/sni 均缺时，借 ws Host 当 SNI（与 parseSingbox 行为对齐）。
    if (!serverName && config.wsSettings?.headers) {
      serverName = pickHostHeader(config.wsSettings.headers);
    }
    if (serverName) tls.serverName = serverName;
    if (bool(p['skip-cert-verify']) === true) tls.allowInsecure = true;
    const alpn = toAlpn(p['alpn']);
    if (alpn) tls.alpn = alpn;
    const fp = str(p['client-fingerprint']);
    if (fp) tls.fingerprint = fp;
    if (Object.keys(tls).length > 0) config.tlsSettings = tls;

    if (hasReality && realityOpts) {
      config.realitySettings = {
        publicKey: str(realityOpts['public-key'])!,
        shortId: str(realityOpts['short-id']),
      };
    }
  }

  // —— smux 多路复用（镜像现有 multiplexSettings）—— //
  const smux = p['smux'] as Record<string, unknown> | undefined;
  if (smux && bool(smux['enabled']) === true) {
    const proto = str(smux['protocol']);
    config.multiplexSettings = {
      enabled: true,
      protocol:
        proto === 'smux' || proto === 'yamux' || proto === 'h2mux'
          ? (proto as 'smux' | 'yamux' | 'h2mux')
          : 'h2mux',
      maxConnections: num(smux['max-connections']),
      minStreams: num(smux['min-streams']),
      padding: bool(smux['padding']),
    };
  }
}

// ── ss plugin 转换 ───────────────────────────────────────────────────────────
/** @returns 写入成功 true；未知 plugin（须整节点跳过）返回 false。 */
function applySsPlugin(
  ss: NonNullable<ServerConfig['shadowsocksSettings']>,
  config: ServerConfig,
  plugin: string,
  pluginOpts: Record<string, unknown>
): boolean {
  if (plugin === 'obfs' || plugin === 'obfs-local' || plugin === 'simple-obfs') {
    const mode = str(pluginOpts['mode']);
    const host = str(pluginOpts['host']);
    const parts: string[] = [];
    if (mode) parts.push(`obfs=${mode}`);
    if (host) parts.push(`obfs-host=${host}`);
    ss.plugin = 'obfs-local';
    ss.pluginOptions = parts.join(';');
    return true;
  }
  if (plugin === 'v2ray-plugin') {
    const parts: string[] = [];
    if (str(pluginOpts['mode'])) parts.push(`mode=${str(pluginOpts['mode'])}`);
    if (bool(pluginOpts['tls']) === true) parts.push('tls');
    if (str(pluginOpts['host'])) parts.push(`host=${str(pluginOpts['host'])}`);
    if (str(pluginOpts['path'])) parts.push(`path=${str(pluginOpts['path'])}`);
    ss.plugin = 'v2ray-plugin';
    ss.pluginOptions = parts.join(';');
    return true;
  }
  if (plugin === 'shadow-tls') {
    const password = str(pluginOpts['password']);
    const host = str(pluginOpts['host']);
    // 缺关键字段(password/host)→ 不写 shadowTlsSettings 的裸 SS 是连不上的假节点；
    // 与未知 plugin 同策略整节点跳过(返回 false)，而非伪装成功(返回 true)入库。
    if (!password || !host) {
      return false;
    }
    config.shadowTlsSettings = {
      password,
      sni: host,
      fingerprint: 'chrome',
    };
    const port = num(pluginOpts['port']);
    if (port !== undefined) config.shadowTlsSettings.port = port;
    return true;
  }
  // restls / 其他未知 plugin：剥 plugin 的裸 SS 连不上，整节点跳过更安全。
  return false;
}

// ── 单节点映射 ───────────────────────────────────────────────────────────────
type NodeOutcome =
  | { kind: 'server'; server: ServerConfig }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; reason: string };

function buildBase(
  p: Record<string, unknown>,
  protocol: Protocol,
  subscriptionId: string,
  now: string
): ServerConfig {
  // CDN 关键：server → address，连接目标，绝不被 sni/Host 覆盖。
  const server = str(p['server'])!;
  const port = num(p['port'])!;
  const name = str(p['name']) || `${server}:${port}`;
  return {
    id: randomUUID(),
    name,
    protocol,
    address: server,
    port,
    subscriptionId,
    createdAt: now,
    updatedAt: now,
  };
}

function mapNode(rawProxy: unknown, subscriptionId: string, now: string): NodeOutcome {
  if (!rawProxy || typeof rawProxy !== 'object') {
    return { kind: 'fail', reason: '节点非对象' };
  }
  const p = rawProxy as Record<string, unknown>;
  const rawType = p['type'];
  const protocol = normalizeClashType(rawType);
  const name = str(p['name']) || '(未命名)';

  if (!protocol) {
    return { kind: 'skip', reason: str(rawType)?.toLowerCase() || 'unknown' };
  }
  if (!SUPPORTED_CLASH_TYPES.has(protocol)) {
    return { kind: 'skip', reason: protocol };
  }

  const server = str(p['server']);
  const port = num(p['port']);
  if (!server || !port) {
    return { kind: 'fail', reason: `节点 "${name}" 缺 server/port` };
  }

  try {
    const config = buildBase(p, protocol, subscriptionId, now);

    if (protocol === 'vless') {
      const uuid = str(p['uuid']);
      if (!uuid) return { kind: 'fail', reason: `vless 节点 "${name}" 缺 uuid` };
      config.uuid = uuid;
      config.encryption = 'none';
      const flow = str(p['flow']);
      if (flow) config.flow = flow;
      const pe = str(p['packet-encoding']);
      if (pe !== undefined) config.packetEncoding = pe;
      applyTransportAndTls(config, p, false);
    } else if (protocol === 'vmess') {
      const uuid = str(p['uuid']);
      if (!uuid) return { kind: 'fail', reason: `vmess 节点 "${name}" 缺 uuid` };
      config.uuid = uuid;
      config.alterId = num(p['alterId']) ?? 0;
      config.vmessSecurity = str(p['cipher']) ?? 'auto';
      const pe = str(p['packet-encoding']);
      if (pe !== undefined) config.packetEncoding = pe;
      applyTransportAndTls(config, p, false);
    } else if (protocol === 'trojan') {
      const password = str(p['password']);
      if (!password) return { kind: 'fail', reason: `trojan 节点 "${name}" 缺 password` };
      config.password = password;
      applyTransportAndTls(config, p, true); // trojan 恒 TLS（reality-opts 在则 reality）
    } else if (protocol === 'shadowsocks') {
      const password = str(p['password']);
      const cipher = str(p['cipher']);
      if (!password) return { kind: 'fail', reason: `ss 节点 "${name}" 缺 password` };
      const ss: NonNullable<ServerConfig['shadowsocksSettings']> = {
        method: cipher ?? 'aes-256-gcm',
        password, // 不写顶层 config.password
      };
      const plugin = str(p['plugin']);
      if (plugin) {
        const pluginOpts = (p['plugin-opts'] as Record<string, unknown>) || {};
        const ok = applySsPlugin(ss, config, plugin, pluginOpts);
        if (!ok) {
          return { kind: 'skip', reason: `ss-plugin:${plugin}` };
        }
      }
      config.shadowsocksSettings = ss;
      applyTransportAndTls(config, p, false);
    } else if (protocol === 'hysteria2') {
      const password = str(p['password']);
      if (!password) return { kind: 'fail', reason: `hy2 节点 "${name}" 缺 password` };
      config.password = password;
      config.security = 'tls';
      const hy2: NonNullable<ServerConfig['hysteria2Settings']> = {};
      const obfs = str(p['obfs']);
      const obfsPassword = str(p['obfs-password']);
      if (obfs === 'salamander' && obfsPassword) {
        hy2.obfs = { type: 'salamander', password: obfsPassword };
      }
      const up = num(p['up']);
      const down = num(p['down']);
      if (up !== undefined) hy2.upMbps = up;
      if (down !== undefined) hy2.downMbps = down;
      // ports "20000-30000" / 多段逗号 → "20000:30000,40000:50000"；单端口段 "1000" → "1000:1000"
      // （sing-box server_ports 要求 "low:high" 形态，裸单端口会被拒）。
      const ports = str(p['ports']);
      if (ports) {
        hy2.serverPorts = ports
          .split(',')
          .map((seg) => seg.trim().replace(/-/g, ':'))
          .filter((s) => s.length > 0)
          .map((seg) => (seg.includes(':') ? seg : `${seg}:${seg}`))
          .join(',');
        const hop = num(p['hop-interval']);
        if (hop !== undefined) hy2.hopInterval = `${hop}s`;
      }
      // hy2 TLS：sni/skip-cert-verify/alpn 走公共映射，但不要二次置 network。
      const sni = str(p['sni']) ?? str(p['servername']);
      const tls: NonNullable<ServerConfig['tlsSettings']> = {};
      if (sni) tls.serverName = sni;
      if (bool(p['skip-cert-verify']) === true) tls.allowInsecure = true;
      const alpn = toAlpn(p['alpn']);
      if (alpn) tls.alpn = alpn;
      const fp = str(p['client-fingerprint']);
      if (fp) tls.fingerprint = fp;
      if (Object.keys(tls).length > 0) config.tlsSettings = tls;
      if (Object.keys(hy2).length > 0) config.hysteria2Settings = hy2;
    } else if (protocol === 'tuic') {
      const uuid = str(p['uuid']);
      const password = str(p['password']);
      if (!uuid || !password)
        return { kind: 'fail', reason: `tuic 节点 "${name}" 缺 uuid/password` };
      config.uuid = uuid;
      config.password = password;
      config.security = 'tls';
      const ts: NonNullable<ServerConfig['tuicSettings']> = {};
      const cc = str(p['congestion-controller']) ?? str(p['congestion_control']);
      if (cc === 'bbr' || cc === 'cubic' || cc === 'new_reno') ts.congestionControl = cc;
      const urm = str(p['udp-relay-mode']) ?? str(p['udp_relay_mode']);
      if (urm === 'native' || urm === 'quic') ts.udpRelayMode = urm;
      const zrtt = bool(p['reduce-rtt']) ?? bool(p['zero-rtt-handshake']);
      if (zrtt !== undefined) ts.zeroRttHandshake = zrtt;
      // heartbeat 规整：mihomo 常写毫秒整数(10000)，补 ms 单位，否则 sing-box ParseDuration 报错。
      const hb = normalizeDuration(p['heartbeat-interval'] ?? p['heartbeat']);
      if (hb) ts.heartbeat = hb;
      if (Object.keys(ts).length > 0) config.tuicSettings = ts;
      // tuic TLS
      const sni = str(p['sni']) ?? str(p['servername']);
      const tls: NonNullable<ServerConfig['tlsSettings']> = {};
      if (sni) tls.serverName = sni;
      if (bool(p['skip-cert-verify']) === true) tls.allowInsecure = true;
      const alpn = toAlpn(p['alpn']);
      if (alpn) tls.alpn = alpn;
      if (Object.keys(tls).length > 0) config.tlsSettings = tls;
    } else if (protocol === 'anytls') {
      const password = str(p['password']);
      if (!password) return { kind: 'fail', reason: `anytls 节点 "${name}" 缺 password` };
      config.password = password;
      // anytls 会话保活三件套：与 parseAnyTls/AnyTlsForm 收敛面对齐（mihomo 连字符 key，兼容下划线）
      const at: NonNullable<ServerConfig['anyTlsSettings']> = {};
      const idleCheck = normalizeDuration(
        p['idle-session-check-interval'] ?? p['idle_session_check_interval']
      );
      if (idleCheck) at.idleSessionCheckInterval = idleCheck;
      const idleTimeout = normalizeDuration(p['idle-session-timeout'] ?? p['idle_session_timeout']);
      if (idleTimeout) at.idleSessionTimeout = idleTimeout;
      const minIdle = num(p['min-idle-session'] ?? p['min_idle_session']);
      if (minIdle !== undefined) at.minIdleSession = minIdle;
      if (Object.keys(at).length > 0) config.anyTlsSettings = at;
      applyTransportAndTls(config, p, true); // anytls 默认 TLS
    } else if (protocol === 'socks') {
      // socks5：可选用户名/密码；指纹凭据取 username。
      config.username = str(p['username']);
      config.password = str(p['password']);
      config.network = 'tcp';
      config.security = 'none';
    } else if (protocol === 'http') {
      const isTls = bool(p['tls']) === true;
      config.username = str(p['username']);
      config.password = str(p['password']);
      config.network = 'tcp';
      config.security = isTls ? 'tls' : 'none';
      if (isTls) {
        const tls: NonNullable<ServerConfig['tlsSettings']> = {};
        const sni = str(p['sni']) ?? str(p['servername']);
        tls.serverName = sni || server;
        if (bool(p['skip-cert-verify']) === true) tls.allowInsecure = true;
        config.tlsSettings = tls;
      }
    } else if (protocol === 'ssh') {
      // ssh：凭据取 sshSettings.password（指纹兜底落点）。
      const ssh: NonNullable<ServerConfig['sshSettings']> = {};
      const user = str(p['username']);
      if (user) ssh.user = user;
      const password = str(p['password']);
      if (password) ssh.password = password;
      const pk = str(p['private-key']);
      if (pk) ssh.privateKey = pk;
      const hostKey = p['host-key'];
      if (Array.isArray(hostKey)) {
        const hk = hostKey.map((x) => str(x)).filter((x): x is string => !!x);
        if (hk.length > 0) ssh.hostKey = hk;
      }
      const hka = p['host-key-algorithms'];
      if (Array.isArray(hka)) {
        const a = hka.map((x) => str(x)).filter((x): x is string => !!x);
        if (a.length > 0) ssh.hostKeyAlgorithms = a;
      }
      const cv = str(p['client-version']);
      if (cv) ssh.clientVersion = cv;
      config.network = 'tcp';
      config.security = 'none';
      if (Object.keys(ssh).length > 0) config.sshSettings = ssh;
    }

    return { kind: 'server', server: config };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: 'fail', reason: `节点 "${name}" 映射异常: ${msg}` };
  }
}

// ── 批量解析 ─────────────────────────────────────────────────────────────────
/**
 * Clash proxies[] → ServerConfig[]，逐节点 try/catch，不整批失败。
 * 聚合两类告警：跳过的不支持类型/未知 ss-plugin、失败的缺字段节点。
 */
export function parseClashProxies(
  proxies: unknown,
  subscriptionId: string,
  now: string
): ClashParseResult {
  const servers: ServerConfig[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  let failed = 0;

  if (!Array.isArray(proxies)) {
    return { servers, skipped, failed, warnings };
  }

  const skipByReason = new Map<string, number>();
  const failReasons: string[] = [];

  for (const proxy of proxies) {
    const outcome = mapNode(proxy, subscriptionId, now);
    if (outcome.kind === 'server') {
      servers.push(outcome.server);
    } else if (outcome.kind === 'skip') {
      skipped++;
      skipByReason.set(outcome.reason, (skipByReason.get(outcome.reason) ?? 0) + 1);
    } else {
      failed++;
      failReasons.push(outcome.reason);
    }
  }

  if (skipByReason.size > 0) {
    const detail = [...skipByReason.entries()].map(([r, c]) => `${r}(${c})`).join(', ');
    warnings.push(`跳过 ${skipped} 个不支持/未知 plugin 节点: ${detail}`);
  }
  if (failReasons.length > 0) {
    warnings.push(`${failed} 个节点解析失败: ${failReasons.slice(0, 5).join('; ')}`);
  }

  return { servers, skipped, failed, warnings };
}

// ── proxy-providers filter / exclude / override ──────────────────────────────
/** ReDoS 轻量护栏（不引 re2）：pattern 与待匹配 name 的长度硬上限。
 *  机场可控 → 灾难性回溯能冻结主进程；超限即放弃该 filter / 跳过该 name。 */
export const MAX_FILTER_PATTERN_LEN = 200;
export const MAX_FILTER_NAME_LEN = 256;

/**
 * 裸编译正则（不加 i/u，匹 mihomo 大小写敏感 + emoji）。非法正则返回 null（调用方跳过+warn）。
 * ReDoS 护栏：pattern 超长（>MAX_FILTER_PATTERN_LEN）也返回 null（调用方按非法 filter 处理），
 * 避免恶意超长 pattern + 同步 test 触发灾难性回溯冻结主进程。
 */
export function compileProviderFilter(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  if (pattern.length > MAX_FILTER_PATTERN_LEN) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * 顺序对齐 mihomo：filter(留) → exclude-filter(剔)。作用在 parseClashProxies 之前的原始 proxy.name 上。
 * 非法正则跳过该 filter + warn（不整批失败）。
 */
export function applyProviderFilters(
  proxies: unknown[],
  filter: string | undefined,
  excludeFilter: string | undefined,
  warn: (msg: string) => void,
  providerName: string
): unknown[] {
  let result = proxies;

  // ReDoS 护栏：被匹配 name 截断到 MAX_FILTER_NAME_LEN，界定回溯输入规模（机场可控 name）。
  const safeName = (p: unknown): string => {
    const n = p && typeof p === 'object' ? str((p as Record<string, unknown>)['name']) : '';
    const s = n ?? '';
    return s.length > MAX_FILTER_NAME_LEN ? s.slice(0, MAX_FILTER_NAME_LEN) : s;
  };

  if (filter) {
    // 超长 pattern 经 compileProviderFilter 返回 null（ReDoS 护栏），按非法 filter 处理 + warn。
    const re = compileProviderFilter(filter);
    if (re) {
      result = result.filter((p) => re.test(safeName(p)));
    } else {
      warn(
        `provider [${providerName}] filter 非法或超长正则，已忽略该过滤: ${filter.slice(0, 80)}`
      );
    }
  }

  if (excludeFilter) {
    const re = compileProviderFilter(excludeFilter);
    if (re) {
      result = result.filter((p) => !re.test(safeName(p)));
    } else {
      warn(
        `provider [${providerName}] exclude-filter 非法或超长正则，已忽略该过滤: ${excludeFilter.slice(0, 80)}`
      );
    }
  }

  return result;
}

/**
 * override 白名单 3 键（浅合并到解析后的 ServerConfig）：
 *   skip-cert-verify → tlsSettings.allowInsecure
 *   up/down → hysteria2Settings.upMbps/downMbps（仅 hy2 有意义）
 */
export function applyOverride(servers: ServerConfig[], override: unknown): void {
  if (!override || typeof override !== 'object') return;
  const ov = override as Record<string, unknown>;
  const skipCert = bool(ov['skip-cert-verify']);
  const up = num(ov['up']);
  const down = num(ov['down']);

  for (const s of servers) {
    // 赋值语义：override 显式给出 skip-cert-verify 即覆盖（true→放行，false→强制校验），
    // 不再只在 ===true 时单向覆盖（否则机场 override:false 想收紧时被静默忽略）。
    if (skipCert !== undefined) {
      // 仅对「TLS 节点」注入/合并 tlsSettings。判定与 ProtocolParser 一致：
      // security ∈ {tls,reality}（reality 复用 TLS 传输层），或节点已带 tlsSettings/
      // realitySettings（兼容存量/手动节点未显式写 security 的情况）。
      // 非 TLS 节点（裸 vless/ss/socks/http/ssh）若注入空 tlsSettings，会产出
      // {allowInsecure:...} 这种本不该出现的 TLS 特征，构成代理指纹噪音。
      if (s.security === 'tls' || s.security === 'reality' || s.tlsSettings || s.realitySettings) {
        s.tlsSettings = { ...(s.tlsSettings || {}), allowInsecure: skipCert };
      }
    }
    if (s.protocol === 'hysteria2' && (up !== undefined || down !== undefined)) {
      const hy2 = { ...(s.hysteria2Settings || {}) };
      if (up !== undefined) hy2.upMbps = up;
      if (down !== undefined) hy2.downMbps = down;
      s.hysteria2Settings = hy2;
    }
  }
}

// ── provider 编排 ────────────────────────────────────────────────────────────
export interface ResolveProvidersResult {
  servers: ServerConfig[];
  warnings: string[];
  /** 是否有任一 provider 失败（供调用方判定 partial → merge-only 防穿仓）。 */
  anyFailed: boolean;
  /** M1：transient 失败的 provider 名（供调用方按 provider 精确 merge-only）。rejected 兜底等失败名未知时
   *  可能短于 anyFailed 蕴含的失败数 → 调用方据「anyFailed 但 failedProviders 空」退回整订阅级保守保留。 */
  failedProviders: string[];
  /** 成功 provider 数 / 尝试数。 */
  succeeded: number;
  attempted: number;
}

/**
 * proxy-providers 编排：Object.entries.slice(0, maxProviders) → Promise.allSettled 全并行。
 * 每 type:http provider：fetchText(AbortSignal.timeout) → parseContent(allowProviders:false)
 * → applyProviderFilters → parseClashProxies → applyOverride。
 * type:file 忽略+告警；其余非 http 跳过+告警。单 provider 失败/0 节点不拖垮其余。
 */
export async function resolveProxyProviders(
  providers: unknown,
  deps: ProviderDeps
): Promise<ResolveProvidersResult> {
  const warnings: string[] = [];
  if (!providers || typeof providers !== 'object') {
    return {
      servers: [],
      warnings,
      anyFailed: false,
      failedProviders: [],
      succeeded: 0,
      attempted: 0,
    };
  }

  const maxProviders = deps.maxProviders ?? DEFAULT_MAX_PROVIDERS;
  const timeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  const allEntries = Object.entries(providers as Record<string, unknown>);
  const entries = allEntries.slice(0, maxProviders);
  if (allEntries.length > maxProviders) {
    warnings.push(`proxy-providers 数量 ${allEntries.length} 超上限 ${maxProviders}，已截断`);
  }

  // permanent=true：配置面问题（type:file/非 http/非对象/缺 url/0 节点）→ 仅 warn，不触发 partial
  //   （这些不会因重试转好，置 anyFailed 会让 reconcile 永久 merge-only，机场下架节点无限滞留）。
  // permanent=false：拉取/解析失败（fetch throw/超时/parse throw）→ 置 anyFailed，调用方 merge-only 防穿仓。
  type Settled =
    | { ok: true; name: string; servers: ServerConfig[]; warnings: string[] }
    | { ok: false; name: string; reason: string; permanent: boolean };

  const tasks = entries.map(async ([name, rawProvider]): Promise<Settled> => {
    try {
      if (!rawProvider || typeof rawProvider !== 'object') {
        return { ok: false, name, reason: '配置非对象', permanent: true };
      }
      const prov = rawProvider as Record<string, unknown>;
      const type = str(prov['type'])?.toLowerCase();

      if (type === 'file') {
        return { ok: false, name, reason: 'type:file 不支持（安全面，忽略）', permanent: true };
      }
      if (type !== 'http') {
        return {
          ok: false,
          name,
          reason: `不支持的 provider type: ${type ?? '(缺省)'}`,
          permanent: true,
        };
      }

      const url = str(prov['url']);
      if (!url) {
        return { ok: false, name, reason: '缺 url', permanent: true };
      }

      // fetch（复用 SubscriptionService 路径 → 继承 SSRF guard + viaProxy + UA），单 fetch 超时。
      const text = await deps.fetchText(url, AbortSignal.timeout(timeoutMs));
      const trimmed = text.trim();

      // provider 响应再入主解析（allowProviders:false → 不递归 proxy-providers）。
      const parsed = await deps.parseContent(trimmed);
      const provWarnings = [...parsed.warnings];

      // filter/exclude 须作用在「原始 proxy.name」上，但本路径已经解析成 ServerConfig；
      // ServerConfig.name 即来源 proxy.name（buildBase 用 p.name），故可在解析后按 name 过滤，语义等价。
      // —— 为对齐 mihomo「filter 作用于原始 name」并支持非 Clash 形态（base64/url-list）provider，
      //    这里统一按 ServerConfig.name 过滤（base64/url-list 的 name 即节点显示名）。
      const filter = str(prov['filter']);
      const excludeFilter = str(prov['exclude-filter']);
      let servers = parsed.servers;
      if (filter || excludeFilter) {
        const asNamed = servers.map((s) => ({ name: s.name, _s: s }));
        const filtered = applyProviderFilters(
          asNamed,
          filter,
          excludeFilter,
          (m) => provWarnings.push(m),
          name
        ) as Array<{ name: string; _s: ServerConfig }>;
        servers = filtered.map((x) => x._s);
      }

      // override 白名单 3 键
      if (prov['override']) {
        applyOverride(servers, prov['override']);
      }

      if (servers.length === 0) {
        // HTTP 成功但解析/过滤后 0 节点：内容本就空（或被 filter 滤尽），重试不会变好 → permanent，仅 warn。
        return { ok: false, name, reason: '0 节点', permanent: true };
      }

      return { ok: true, name, servers, warnings: provWarnings };
    } catch (e) {
      // fetch throw / 超时 / parseContent throw → transient，置 anyFailed 触发调用方 merge-only 防穿仓。
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, name, reason: msg, permanent: false };
    }
  });

  const settled = await Promise.allSettled(tasks);
  const servers: ServerConfig[] = [];
  let succeeded = 0;
  let anyFailed = false;
  const failedProviders: string[] = [];
  const failureDetails: string[] = [];

  // 按声明序拼接（allSettled 保序）。
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      const v = r.value;
      if (v.ok) {
        succeeded++;
        // M1：标记节点归属 provider，供调用方按 provider 精确 merge-only（成功 provider 的下架节点可正常删）。
        for (const s of v.servers) s.providerName = v.name;
        servers.push(...v.servers);
        for (const w of v.warnings) warnings.push(`[${v.name}] ${w}`);
      } else {
        // 仅 transient（拉取/解析失败）触发 anyFailed；permanent（配置/0 节点）只记 warn 不阻止删除。
        if (!v.permanent) {
          anyFailed = true;
          failedProviders.push(v.name);
        }
        failureDetails.push(`${v.name}(${v.reason})`);
      }
    } else {
      // 理论上 task 已自吞异常；兜底（视为 transient，但失败 provider 名未知 → 不入 failedProviders，
      // 调用方据「anyFailed 但 failedProviders 空」退回整订阅级保守保留）。
      anyFailed = true;
      failureDetails.push(`未知(${String(r.reason)})`);
    }
  }

  const attempted = entries.length;
  if (failureDetails.length > 0) {
    warnings.push(
      `proxy-providers ${succeeded}/${attempted} 成功，失败: ${failureDetails.join(', ')}`
    );
  }

  return { servers, warnings, anyFailed, failedProviders, succeeded, attempted };
}
