import { randomUUID } from 'crypto';
import { app, net, session, type Session } from 'electron';
import type {
  ServerConfig,
  SubscriptionConfig,
  ImportParseResult,
  ImportFormat,
} from '../../shared/types';
import { ProtocolParser } from './ProtocolParser';
import { LogManager } from './LogManager';
import { safeRedirectFetch } from '../safe-redirect-fetch';
import {
  CLASH_PROBE_RE,
  tryLoadClashDoc,
  parseClashProxies,
  resolveProxyProviders,
  type ClashDoc,
} from './ClashSubscriptionParser';
import { parseXrayOutbounds } from './xray-import';
import { isServerComplete } from '../../shared/server-completeness';
import { normalizeDuration } from '../../shared/duration';
import {
  classifySubscriptionError,
  type SubscriptionPreviewResult,
} from '../../shared/subscription-preview';

/** 默认订阅 UA：纯中性 `FlowZ/<版本>`（去除 clash.meta/mihomo 标识，陈先生 2026-06-12 决策）。 */
export function defaultSubscriptionUserAgent(): string {
  // 订阅伪装中性 UA（FlowZ/<版本>），规避机场拦截。**勿用于 GitHub API/资源下载**——带版本会泄漏，
  // 用 shared/constants.ts 的 APP_USER_AGENT（应用自标识）。app.getVersion() 仅打包后可用；测试不消费本函数（UA 拼接在 fetch 路径，已 mock）。
  let version = '0.0.0';
  try {
    version = app.getVersion();
  } catch {
    // app 不可用（极早期/非 electron 上下文）兜底
  }
  return `FlowZ/${version}`;
}

export interface SubscriptionUpdateResult {
  success: boolean;
  addedServers: number;
  updatedServers: number;
  deletedServers: number;
  error?: string;
  userInfo?: SubscriptionConfig['userInfo'];
  /** §16.3.4：304/无内容变化 → true（UI 可弹「订阅无变化」toast，不 force-restart）。 */
  unchanged?: boolean;
}

// ── Sing-box outbound types we support ──────────────────────────────────────
type SingboxTls = {
  enabled?: boolean;
  server_name?: string;
  insecure?: boolean;
  alpn?: string[];
  utls?: { enabled?: boolean; fingerprint?: string };
  reality?: { enabled?: boolean; public_key?: string; short_id?: string };
  ech?: { enabled?: boolean };
  fragment?: boolean;
};
type SingboxTransport = {
  type?: string;
  path?: string;
  host?: string;
  headers?: Record<string, string>;
  service_name?: string;
};
type SingboxMultiplex = {
  enabled?: boolean;
  protocol?: string;
  max_connections?: number;
  min_streams?: number;
  padding?: boolean;
};
type SingboxOutbound = {
  type: string;
  tag: string;
  server?: string;
  server_port?: number;
  server_ports?: string[];
  hop_interval?: string;
  uuid?: string;
  flow?: string;
  packet_encoding?: string;
  username?: string;
  password?: string;
  method?: string;
  plugin?: string;
  plugin_opts?: string;
  obfs?: { type?: string; password?: string };
  // naive：是否启用 HTTP/3 (QUIC) 传输
  quic?: boolean;
  // vmess
  alter_id?: number;
  security?: string;
  // tuic
  congestion_control?: string;
  udp_relay_mode?: string;
  zero_rtt_handshake?: boolean;
  heartbeat?: string;
  // anytls
  idle_session_check_interval?: string;
  idle_session_timeout?: string;
  min_idle_session?: number;
  // ssh（private_key_path 属本机文件路径，跨设备订阅无意义，不收；其余 sing-box ssh outbound 字段全收）
  user?: string;
  private_key?: string;
  private_key_passphrase?: string;
  host_key?: string[];
  host_key_algorithms?: string[];
  client_version?: string;
  cipher?: string[];
  mac?: string[];
  kex_algorithm?: string[];
  // snell（sing-box 1.14.0-alpha.38+；version 与 ShadowTLS 共用字段名）
  version?: number;
  psk?: string;
  userkey?: string;
  reuse?: boolean;
  obfs_mode?: string;
  obfs_host?: string;
  mode?: string;
  network?: string;
  tls?: SingboxTls;
  transport?: SingboxTransport;
  multiplex?: SingboxMultiplex;
};

/** parseSingboxOutbounds 能直接映射的 sing-box outbound type（其余在本地导入时透传为 custom 或跳过）。 */
const SINGBOX_SUPPORTED_TYPES = new Set([
  'shadowsocks',
  'vless',
  'trojan',
  'hysteria2',
  'naive',
  'vmess',
  'tuic',
  'anytls',
  'snell',
  'socks',
  'http',
  'ssh',
]);

/** sing-box transport.type → ServerConfig.network 可承载的传输（其余 sing-box 不支持/FlowZ 无落点，整节点跳过）。 */
const SINGBOX_SUPPORTED_TRANSPORTS = new Set(['ws', 'grpc', 'http', 'httpupgrade']);
/** sing-box 非代理内部 outbound type（本地导入忽略，不作节点、不透传 custom）。 */
const SINGBOX_INTERNAL_TYPES = new Set(['direct', 'block', 'dns', 'selector', 'urltest']);

export class SubscriptionService {
  // 响应体积上限：超大响应直接 OOM（兼缓解 YAML 锚点炸弹的输入面）。content-length 预检 + 读取后字节校验双闸。
  private static readonly MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB
  // 主订阅 fetch 超时（比 provider 15s 宽）：防 slow-loris 挂死、scheduler isRunning 永真卡死后续更新。
  private static readonly MAIN_FETCH_TIMEOUT_MS = 30_000;

  private protocolParser: ProtocolParser;
  private logManager: LogManager;
  // 直连会话：强制 mode:'direct'，无视默认会话/系统代理，供 viaProxy=false 的订阅拉取使用
  private directSession: Session | null = null;
  // 经代理会话：Phase 2/§8 改 pin 到专用 update-in socks 入站（127.0.0.1:<动态端口>），与应用更新/资源链路统一
  // 经核 route 头部按 proxyMode 决策（取代原 pin mixed inbound http）。独立于 defaultSession → 不受「更新检查走
  // 代理」总开关(mainSessionViaProxy)影响（订阅有独立开关 subscriptionUpdateViaProxy）。
  private proxiedSession: Session | null = null;
  private proxiedSessionPort: number | null = null;
  // update-in inbound 端口读取器（proxyManager.getUpdateInPort）；构造后由 index.ts 注入，未注入/端口不可用 → 退直连。
  private updateInPortProvider: (() => number | null) | null = null;

  constructor(protocolParser: ProtocolParser, logManager: LogManager) {
    this.protocolParser = protocolParser;
    this.logManager = logManager;
  }

  /** Phase 2/§8：注入 update-in inbound 端口读取器。订阅经代理 pin 此口（socks）。 */
  setUpdateInPortProvider(provider: () => number | null): void {
    this.updateInPortProvider = provider;
  }

  /** 懒加载强制直连会话（默认会话在代理运行时会走代理，直连拉取须绕开它）。 */
  private async getDirectSession(): Promise<Session> {
    if (this.directSession) return this.directSession;
    const s = session.fromPartition('flowz-subscription-direct');
    await s.setProxy({ mode: 'direct' });
    this.directSession = s;
    return s;
  }

  /** 懒加载经代理会话（pin 到本机 update-in socks 入站，动态端口）；端口变化时重设。loopback 隐式 bypass。 */
  private async getProxiedSession(port: number): Promise<Session> {
    if (this.proxiedSession && this.proxiedSessionPort === port) return this.proxiedSession;
    const s = this.proxiedSession ?? session.fromPartition('flowz-subscription-proxied');
    await s.setProxy({ proxyRules: `socks5://127.0.0.1:${port}` });
    this.proxiedSession = s;
    this.proxiedSessionPort = port;
    return s;
  }

  /**
   * 节点稳定指纹：协议 + 地址 + 端口 + 凭据（uuid/password/username）。
   * 刻意排除显示名 name 与本地自定义 detour —— 订阅方常改名/调顺序，用 name 做键会把
   * 同一物理节点误判为「删旧增新」，导致 id 抖动、selectedServerId 丢失、本地编辑被清。
   * 凭据可区分同 host:port 的并列节点，几乎不随更新变化。
   */
  static serverFingerprint(s: ServerConfig): string {
    // 凭据按协议落点取：vless/vmess/tuic→uuid；trojan/hy2/anytls→password；ss→shadowsocksSettings.password；
    // naive/socks/http→username；ssh→sshSettings.password。覆盖嵌套落点，避免 SS 等凭据落空致同 host:port 误并。
    const cred =
      s.uuid ||
      s.password ||
      s.shadowsocksSettings?.password ||
      s.username ||
      s.sshSettings?.password ||
      s.wireguardSettings?.peerPublicKey ||
      '';
    // network 维度：同 host:port:cred 但传输不同（tcp vs ws vs grpc）是不同节点，缺此维度会被误并静默吞节点。
    // 指纹不持久化——reconcile 对新旧两侧用同一函数现算，归一化（h2→http/raw→tcp）对两侧等价，
    // 存量节点 id / selectedServerId 不受本次加维度影响。
    return `${(s.protocol || '').toLowerCase()}|${s.address}|${s.port}|${cred}|${(s.network || 'tcp').toLowerCase()}`;
  }

  /**
   * 订阅节点对账：按稳定指纹匹配新旧节点。
   * - 命中：原地更新（保留旧 id/createdAt），其余字段（含 name、detour）以订阅最新值为准
   *   —— 订阅节点不保留本地 detour，需长期自定义请用「克隆到自建」。
   * - 仅新订阅有：新增。
   * - 仅旧配置有：删除（id 收入 deletedIds 供清理 selectedServerId）。
   * 用桶（数组）承接同指纹的多个节点，按出现顺序成对匹配，避免 Map 覆盖丢 id。
   */
  static reconcileServers(
    oldServers: ServerConfig[],
    fetchedServers: ServerConfig[],
    now: string
  ): {
    servers: ServerConfig[];
    added: number;
    updated: number;
    deleted: number;
    deletedIds: Set<string>;
    /** §16.3.4b：节点集是否真变化（added>0 ‖ deleted>0 ‖ 任一命中节点内容变）——手动订阅刷新据此决定是否 force-restart
     *  入池、渲染层据此决定是否全量刷新。顺序重排/时间戳刷新等无实质变化恒 false（与 configGenerationNorm 双保险）。 */
    contentChanged: boolean;
  } {
    // 内容键（忽略 id/时间戳/归属元数据）：判「无变化更新」保 updatedAt 不投毒 + 聚合 contentChanged。
    const contentKey = (s: ServerConfig) => {
      const copy: Record<string, unknown> = { ...s };
      delete copy.id;
      delete copy.createdAt;
      delete copy.updatedAt;
      delete copy.providerName; // M1：归属元数据非节点连接内容，不计入比较（否则加该字段会让存量节点首次升级误刷 updatedAt）
      return JSON.stringify(copy);
    };
    const oldBuckets = new Map<string, ServerConfig[]>();
    for (const s of oldServers) {
      const key = SubscriptionService.serverFingerprint(s);
      const bucket = oldBuckets.get(key);
      if (bucket) bucket.push(s);
      else oldBuckets.set(key, [s]);
    }

    const kept: ServerConfig[] = [];
    let added = 0;
    let updated = 0;
    let anyContentChanged = false;
    for (const ns of fetchedServers) {
      const key = SubscriptionService.serverFingerprint(ns);
      const bucket = oldBuckets.get(key);
      const old = bucket && bucket.length > 0 ? bucket.shift() : undefined;
      if (old) {
        // 内容相同（忽略 id/时间戳）则保留 old.updatedAt，避免无变化也刷新 updatedAt「投毒」纯切节点热切换
        const same = contentKey(ns) === contentKey(old);
        if (!same) anyContentChanged = true;
        kept.push({
          ...ns,
          id: old.id,
          createdAt: old.createdAt,
          updatedAt: same ? old.updatedAt : now,
        });
        updated++;
      } else {
        kept.push(ns);
        added++;
      }
    }

    const leftover: ServerConfig[] = [];
    for (const bucket of oldBuckets.values()) leftover.push(...bucket);
    const deletedIds = new Set(leftover.map((s) => s.id));
    const contentChanged = added > 0 || leftover.length > 0 || anyContentChanged;
    return { servers: kept, added, updated, deleted: leftover.length, deletedIds, contentChanged };
  }

  /**
   * M1：partial 失败时的 merge-only leftover（provider 级精确）。被删旧节点中只保留「失败 provider 名下」的
   * （防该 provider 临时故障穿仓），成功 provider 的真下架节点不在此列、正常删除。providerName=undefined 的
   * 旧节点（迁移前存量 / 内联 proxies / 非 Clash 订阅）无归属信息 → 保守保留，不冒误删风险。failedProviders
   * 缺失/空（rejected 兜底等 partial 但失败名未知）→ 全部保守保留，退回旧的整订阅级 merge-only。
   */
  static leftoverToKeep(
    oldServers: ServerConfig[],
    deletedIds: Set<string>,
    failedProviders?: string[]
  ): ServerConfig[] {
    const failed = failedProviders && failedProviders.length > 0 ? new Set(failedProviders) : null;
    return oldServers.filter(
      (s) =>
        deletedIds.has(s.id) &&
        (failed === null || s.providerName === undefined || failed.has(s.providerName))
    );
  }

  /**
   * 解析 Subscription-UserInfo header
   * 格式: upload=xxx; download=xxx; total=xxx; expire=xxx
   */
  private parseUserInfo(header: string | null): SubscriptionConfig['userInfo'] | undefined {
    if (!header) return undefined;
    const result: SubscriptionConfig['userInfo'] = {};
    const parts = header.split(';').map((s) => s.trim());
    for (const part of parts) {
      const [key, value] = part.split('=').map((s) => s.trim());
      const num = parseInt(value, 10);
      if (isNaN(num)) continue;
      if (key === 'upload') result.upload = num;
      else if (key === 'download') result.download = num;
      else if (key === 'total') result.total = num;
      else if (key === 'expire') result.expire = num;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  /**
   * 将 sing-box outbounds 数组转换为 ServerConfig 列表
   * 支持: shadowsocks, vless, trojan, hysteria2
   */
  private parseSingboxOutbounds(
    outbounds: SingboxOutbound[],
    subscriptionId: string
  ): ServerConfig[] {
    const SUPPORTED = SINGBOX_SUPPORTED_TYPES;
    const servers: ServerConfig[] = [];
    const now = new Date().toISOString();

    // 丢弃可见性（issue #263 调查项）：原三类 silent continue（不支持 type / 缺 server·port / 不支持 transport）
    // 完全无日志——「8 进 4 出」用户无从察觉。聚合计数，函数尾统一 warn。
    const skipByType = new Map<string, number>();
    let missingFields = 0;
    const skipByTransport = new Map<string, number>();

    for (const ob of outbounds) {
      if (!SUPPORTED.has(ob.type)) {
        // direct/block/selector 等内部 outbound 是配置结构而非节点，不计入「丢弃」噪声。
        if (!SINGBOX_INTERNAL_TYPES.has(ob.type)) {
          skipByType.set(ob.type, (skipByType.get(ob.type) ?? 0) + 1);
        }
        continue;
      }
      // 支持仅含 server_ports（端口跳跃、无 server_port）的 Hy2 节点：从首个范围的低位端口推导 port
      const effectivePort =
        ob.server_port ??
        (ob.server_ports?.[0] ? parseInt(ob.server_ports[0].split(':')[0], 10) : undefined);
      if (!ob.server || !effectivePort) {
        missingFields++;
        continue;
      }
      // 不支持的 transport（quic 等）：入库会静默降级裸 TCP 产假节点，整节点跳过（与分享链/Clash 路径统一口径）。
      if (ob.transport?.type && !SINGBOX_SUPPORTED_TRANSPORTS.has(ob.transport.type)) {
        skipByTransport.set(ob.transport.type, (skipByTransport.get(ob.transport.type) ?? 0) + 1);
        continue;
      }

      try {
        const base: Partial<ServerConfig> = {
          id: randomUUID(),
          name: ob.tag || `${ob.server}:${effectivePort}`,
          address: ob.server,
          port: effectivePort,
          subscriptionId,
          createdAt: now,
          updatedAt: now,
        };

        // vless/vmess UDP 封装：JSON 订阅显式携带时透传（缺省时不写，由 ProxyManager 默认 xudp）
        if (ob.packet_encoding !== undefined) {
          base.packetEncoding = ob.packet_encoding;
        }

        // TLS / Reality
        if (ob.tls && ob.tls.enabled !== false) {
          const hasReality = ob.tls.reality?.enabled && ob.tls.reality.public_key;
          base.security = hasReality ? 'reality' : 'tls';
          base.tlsSettings = {
            serverName: ob.tls.server_name,
            allowInsecure: ob.tls.insecure ?? false,
            alpn: ob.tls.alpn,
            fingerprint: ob.tls.utls?.fingerprint,
            ech: ob.tls.ech?.enabled === true ? true : undefined,
            fragment: ob.tls.fragment === true ? true : undefined,
          };
          if (hasReality && ob.tls.reality) {
            base.realitySettings = {
              publicKey: ob.tls.reality.public_key!,
              shortId: ob.tls.reality.short_id,
            };
          }
        }

        // Transport
        if (ob.transport?.type) {
          const t = ob.transport;
          const netType = t.type as 'ws' | 'grpc' | 'http' | 'httpupgrade';
          base.network = netType;
          if (netType === 'ws') {
            // 与 httpupgrade 对齐：transport.host 折叠进 Host header（部分配置把 ws Host 放在 t.host），
            // 避免同一节点经 JSON 订阅 vs 分享链解析出不一致的 wsSettings（丢 Host）。
            base.wsSettings = { path: t.path, headers: t.host ? { Host: t.host } : t.headers };
          } else if (netType === 'grpc') {
            base.grpcSettings = { serviceName: t.service_name };
          } else if (netType === 'http') {
            base.httpSettings = { path: t.path };
          } else if (netType === 'httpupgrade') {
            // httpupgrade 复用 ws 设置承载 path/Host
            base.wsSettings = { path: t.path, headers: t.host ? { Host: t.host } : t.headers };
          }
        }

        // Multiplex（vless/trojan/vmess/ss）
        if (ob.multiplex?.enabled) {
          base.multiplexSettings = {
            enabled: true,
            protocol: (ob.multiplex.protocol as 'smux' | 'yamux' | 'h2mux') || 'h2mux',
            maxConnections: ob.multiplex.max_connections,
            minStreams: ob.multiplex.min_streams,
            padding: ob.multiplex.padding,
          };
        }

        // Protocol-specific
        if (ob.type === 'shadowsocks') {
          servers.push({
            ...(base as ServerConfig),
            protocol: 'shadowsocks',
            shadowsocksSettings: {
              method: ob.method ?? 'aes-256-gcm',
              password: ob.password ?? '',
              plugin: ob.plugin,
              pluginOptions: ob.plugin_opts,
            },
          });
        } else if (ob.type === 'vless') {
          servers.push({
            ...(base as ServerConfig),
            protocol: 'vless',
            uuid: ob.uuid ?? '',
            flow: ob.flow,
          });
        } else if (ob.type === 'trojan') {
          servers.push({
            ...(base as ServerConfig),
            protocol: 'trojan',
            password: ob.password ?? '',
          });
        } else if (ob.type === 'hysteria2') {
          const hy2: ServerConfig = {
            ...(base as ServerConfig),
            protocol: 'hysteria2',
            password: ob.password ?? '',
            security: 'tls',
          };
          const hy2Settings: NonNullable<ServerConfig['hysteria2Settings']> = {};
          if (ob.obfs?.type === 'salamander' && ob.obfs.password) {
            hy2Settings.obfs = { type: 'salamander', password: ob.obfs.password };
          }
          // 端口跳跃：server_ports 形如 ["20000:30000"]，存为逗号分隔字符串
          if (ob.server_ports && ob.server_ports.length > 0) {
            hy2Settings.serverPorts = ob.server_ports.join(',');
            if (ob.hop_interval) hy2Settings.hopInterval = ob.hop_interval;
          }
          if (Object.keys(hy2Settings).length > 0) {
            hy2.hysteria2Settings = hy2Settings;
          }
          servers.push(hy2);
        } else if (ob.type === 'naive') {
          // sing-box naive 的 quic:true 表示走 HTTP/3 (QUIC) 传输（h3 节点）
          servers.push({
            ...(base as ServerConfig),
            protocol: 'naive',
            username: ob.username ?? '',
            password: ob.password ?? '',
            naiveSettings: ob.quic ? { useHttp3: true } : undefined,
          });
        } else if (ob.type === 'vmess') {
          servers.push({
            ...(base as ServerConfig),
            protocol: 'vmess',
            uuid: ob.uuid ?? '',
            alterId: ob.alter_id,
            vmessSecurity: ob.security,
          });
        } else if (ob.type === 'tuic') {
          const tuic: ServerConfig = {
            ...(base as ServerConfig),
            protocol: 'tuic',
            uuid: ob.uuid ?? '',
            password: ob.password ?? '',
          };
          const ts: NonNullable<ServerConfig['tuicSettings']> = {};
          if (ob.congestion_control)
            ts.congestionControl = ob.congestion_control as NonNullable<
              ServerConfig['tuicSettings']
            >['congestionControl'];
          if (ob.udp_relay_mode)
            ts.udpRelayMode = ob.udp_relay_mode as NonNullable<
              ServerConfig['tuicSettings']
            >['udpRelayMode'];
          if (ob.zero_rtt_handshake !== undefined) ts.zeroRttHandshake = ob.zero_rtt_handshake;
          // heartbeat 规整：纯数字(毫秒)补 ms，否则透传 → 防 sing-box ParseDuration "missing unit"。
          const hb = normalizeDuration(ob.heartbeat);
          if (hb) ts.heartbeat = hb;
          if (Object.keys(ts).length > 0) tuic.tuicSettings = ts;
          servers.push(tuic);
        } else if (ob.type === 'anytls') {
          const anytls: ServerConfig = {
            ...(base as ServerConfig),
            protocol: 'anytls',
            password: ob.password ?? '',
          };
          const as: NonNullable<ServerConfig['anyTlsSettings']> = {};
          if (ob.idle_session_check_interval)
            as.idleSessionCheckInterval = ob.idle_session_check_interval;
          if (ob.idle_session_timeout) as.idleSessionTimeout = ob.idle_session_timeout;
          if (ob.min_idle_session !== undefined) as.minIdleSession = ob.min_idle_session;
          if (Object.keys(as).length > 0) anytls.anyTlsSettings = as;
          servers.push(anytls);
        } else if (ob.type === 'socks') {
          servers.push({
            ...(base as ServerConfig),
            protocol: 'socks',
            username: ob.username,
            password: ob.password,
          });
        } else if (ob.type === 'http') {
          servers.push({
            ...(base as ServerConfig),
            protocol: 'http',
            username: ob.username,
            password: ob.password,
          });
        } else if (ob.type === 'ssh') {
          // ssh：与 Clash 路径（ClashSubscriptionParser mapNode ssh 分支）对齐的落点；
          // private_key_path 是本机文件路径、跨设备订阅无意义，刻意不映射。
          const ssh: NonNullable<ServerConfig['sshSettings']> = {};
          if (ob.user) ssh.user = ob.user;
          if (ob.password) ssh.password = ob.password;
          if (ob.private_key) ssh.privateKey = ob.private_key;
          if (ob.private_key_passphrase) ssh.privateKeyPassphrase = ob.private_key_passphrase;
          if (ob.host_key && ob.host_key.length > 0) ssh.hostKey = ob.host_key;
          if (ob.host_key_algorithms && ob.host_key_algorithms.length > 0)
            ssh.hostKeyAlgorithms = ob.host_key_algorithms;
          if (ob.client_version) ssh.clientVersion = ob.client_version;
          // 算法协商覆盖（对接老/特定 SSH 服务端）：丢弃会静默退回默认算法集、连不上且无从排查。
          if (ob.cipher && ob.cipher.length > 0) ssh.cipher = ob.cipher;
          if (ob.mac && ob.mac.length > 0) ssh.mac = ob.mac;
          if (ob.kex_algorithm && ob.kex_algorithm.length > 0) ssh.kexAlgorithm = ob.kex_algorithm;
          servers.push({
            ...(base as ServerConfig),
            protocol: 'ssh',
            network: 'tcp',
            security: 'none',
            sshSettings: Object.keys(ssh).length > 0 ? ssh : undefined,
          });
        } else if (ob.type === 'snell') {
          // sing-box 官方 snell（1.14.0-alpha.38+）：version 仅 4/6；psk 复用 password 落点。
          // 超出能力（旧版本号/缺 psk）warn 跳过——validateConfig 对 snell 必填强校验，坏节点入库会连累整份订阅保存失败。
          if (ob.version !== 4 && ob.version !== 6) {
            this.logManager.addLog(
              'warn',
              `跳过 snell outbound "${ob.tag}"：版本 ${ob.version ?? '(缺失)'} 不受支持（sing-box 仅支持 4/6）`,
              'Subscription'
            );
            continue;
          }
          if (!ob.psk?.trim()) {
            // trim 语义与 protocolRequirementError 的 password?.trim() 对齐：空白 psk 穿闸入库会连累整份订阅保存。
            this.logManager.addLog('warn', `跳过 snell outbound "${ob.tag}"：缺 psk`, 'Subscription');
            continue;
          }
          const snell: NonNullable<ServerConfig['snellSettings']> = { version: ob.version };
          // obfs 仅 v4（SnellSettings 不变量）：v6 携带 obfs_mode 的脏 JSON 不落库，与 URL/Clash 路口径一致。
          if (ob.version === 4 && ob.obfs_mode === 'http') {
            snell.obfsMode = 'http';
            if (ob.obfs_host) snell.obfsHost = ob.obfs_host;
          }
          if (ob.version === 6 && (ob.mode === 'unshaped' || ob.mode === 'unsafe-raw')) {
            snell.mode = ob.mode;
          }
          if (ob.reuse) snell.reuse = true;
          if (ob.network === 'tcp' || ob.network === 'udp') snell.network = ob.network;
          if (ob.userkey) snell.userkey = ob.userkey;
          servers.push({
            ...(base as ServerConfig),
            protocol: 'snell',
            password: ob.psk,
            snellSettings: snell,
          });
        }
      } catch (e: any) {
        this.logManager.addLog(
          'warn',
          `解析 sing-box outbound "${ob.tag}" 失败: ${e.message}`,
          'Subscription'
        );
      }
    }
    if (skipByType.size > 0) {
      const detail = [...skipByType.entries()].map(([t, c]) => `${t}(${c})`).join(', ');
      this.logManager.addLog('warn', `跳过不支持的 outbound 类型: ${detail}`, 'Subscription');
    }
    if (skipByTransport.size > 0) {
      const detail = [...skipByTransport.entries()].map(([t, c]) => `${t}(${c})`).join(', ');
      this.logManager.addLog('warn', `跳过不支持的传输层类型: ${detail}`, 'Subscription');
    }
    if (missingFields > 0) {
      this.logManager.addLog(
        'warn',
        `跳过 ${missingFields} 个缺 server/port 的 outbound`,
        'Subscription'
      );
    }
    return servers;
  }

  /** URL query 脱敏（去整段 query，常含 ?token=），仅用于日志，防 token 落 app.log。 */
  private static redactUrl(url: string): string {
    try {
      const u = new URL(url);
      return u.search ? `${u.origin}${u.pathname}?<redacted>` : `${u.origin}${u.pathname}`;
    } catch {
      // 非法 URL：截断到 ? 前，兜底去 query
      const q = url.indexOf('?');
      return q >= 0 ? `${url.slice(0, q)}?<redacted>` : url;
    }
  }

  /** 同指纹去重（Map 首见保留）：内联在前、provider 按声明序在后 → 同节点多源留内联那份。
   *  收口放 Service 侧（防 Parser→Service 反向 import 成环）。 */
  private dedupeByFingerprint(servers: ServerConfig[]): ServerConfig[] {
    const seen = new Map<string, ServerConfig>();
    for (const s of servers) {
      const key = SubscriptionService.serverFingerprint(s);
      if (!seen.has(key)) seen.set(key, s);
    }
    return [...seen.values()];
  }

  /**
   * 第一层（网络）：拉取订阅文本。含 SSRF guard + 会话选择 + ok 校验。
   * 抽出供 proxy-providers 编排复用——provider url 来自订阅正文(远端可控)，复用同一 fetch 路径
   * 天然继承 SSRF guard（这是"必须复用"的安全硬理由）。
   * @returns { text, userInfo }（仅主订阅消费 userInfo；provider 调用忽略）。
   */
  private async fetchSubscriptionText(
    url: string,
    viaProxy: boolean,
    userAgent: string,
    signal?: AbortSignal,
    conditional?: { etag?: string; lastModified?: string }
  ): Promise<{
    text: string;
    userInfo?: SubscriptionConfig['userInfo'];
    /** §16.3.4：本次 200 响应的验证器（回写 sub，下次条件 GET 用）。 */
    etag?: string;
    lastModified?: string;
    /** §16.3.4：304 Not Modified（条件 GET 命中）→ text 空、调用方短路 parse/reconcile。 */
    notModified?: boolean;
  }> {
    // 解析初始 URL：限 http(s)。
    const parse = (u: string): URL => {
      let urlObj: URL | null = null;
      try {
        urlObj = new URL(u);
      } catch {
        urlObj = null;
      }
      if (!urlObj || (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:')) {
        throw new Error(
          `订阅地址协议不支持（仅允许 http/https）: ${SubscriptionService.redactUrl(u)}`
        );
      }
      return urlObj;
    };

    // viaProxy=true → pin 到 update-in socks 入站（动态端口，proxyManager.getUpdateInPort）：与应用更新/资源链路
    // 统一经核 route 按 proxyMode 决策。端口不可用（核未起/未分配/未注入）→ 退直连（自举友好）。viaProxy=false → 直连。
    // 订阅经代理唯一入口 = update-in 端口（旧 httpPort/mixedPort 参数已彻底移除，L1）。
    let fetchImpl: typeof net.fetch;
    // 实际是否走 proxied（经核 update-in socks，远程出口、本机内网不可达）——SSRF guard 的 FakeIP 豁免须键于此，
    // 而非 viaProxy 意图：viaProxy=true 但 update-in 端口不可用时回退 direct，那时不能豁免 FakeIP（防本机内网 SSRF）。
    let viaProxiedSession = false;
    if (viaProxy) {
      const updateInPort = this.updateInPortProvider?.() ?? 0;
      if (updateInPort > 0) {
        const ps = await this.getProxiedSession(updateInPort);
        fetchImpl = ps.fetch.bind(ps);
        viaProxiedSession = true;
      } else {
        const ds = await this.getDirectSession();
        fetchImpl = ds.fetch.bind(ds);
      }
    } else {
      const ds = await this.getDirectSession();
      fetchImpl = ds.fetch.bind(ds);
    }

    // H1+H2：初始 URL + 每跳 Location 都过 SSRF guard，收口到 safeRedirectFetch（首跳 + 逐跳复检防 redirect
    // 跳到内网的 SSRF 绕过）。先 parse 校验协议（保留订阅特有「订阅地址协议不支持」文案 + 脱敏），再交 helper。
    // 仅实际走 proxied（viaProxiedSession）才豁免 FlowZ FakeIP（系统 DNS 把公网域名解析成假 IP、经核反查真实、
    // 本机内网不可达）；直连/端口回退不豁免，防域名真实解析到本机内网的 SSRF。helper 的安全拒绝（含「重定向
    // 次数超过上限」「本机/内网」）按原文案冒泡给 UI。
    parse(url); // 初始 URL 协议校验（http/https）
    // §16.3.4 条件 GET：带上次 validator（If-None-Match / If-Modified-Since，缓存验证器非凭据，逐跳携带无泄漏面）。
    const condHeaders: Record<string, string> = {};
    if (conditional?.etag) condHeaders['If-None-Match'] = conditional.etag;
    if (conditional?.lastModified) condHeaders['If-Modified-Since'] = conditional.lastModified;
    const response = await safeRedirectFetch<GlobalResponse>({
      fetchImpl: (u, init) => fetchImpl(u, init),
      url,
      userAgent,
      exemptFakeIp: viaProxiedSession,
      ...(Object.keys(condHeaders).length ? { headers: condHeaders } : {}),
      ...(signal ? { signal } : {}),
    });
    // §16.3.4：304 Not Modified → 短路，不读 body、不 parse/reconcile（零节点扰动、省流省渲染）。
    // **仅当本次确实发了条件头才认 304**（M-2 fail-safe）：provider 拉取从不带条件头，若某 CDN/缓存对无验证器请求
    // 违规返 304，认它会得空 body→0 节点→permanent 删节点；此时应维持原「304 非 ok → throw」→ transient → merge-only 保留。
    if (response.status === 304 && Object.keys(condHeaders).length > 0) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
      return { text: '', notModified: true };
    }
    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
    }

    // M2：content-length 预检（早拒超大响应）。
    const cl = response.headers.get('content-length');
    if (cl) {
      const n = parseInt(cl, 10);
      if (Number.isFinite(n) && n > SubscriptionService.MAX_BODY_BYTES) {
        try {
          await response.body?.cancel();
        } catch {
          // ignore
        }
        throw new Error(
          `订阅响应体积 ${n} 字节超过上限 ${SubscriptionService.MAX_BODY_BYTES}，已拒绝`
        );
      }
    }

    const userInfo = this.parseUserInfo(response.headers.get('subscription-userinfo'));
    // §16.3.4：回传本次 200 的验证器供回写 sub（下次条件 GET）。
    const etag = response.headers.get('etag') ?? undefined;
    const lastModified = response.headers.get('last-modified') ?? undefined;
    // M2：流式读取并按字节累计上限（content-length 可缺失/撒谎，读取侧硬校验兜底）。
    const text = await this.readBodyCapped(response);
    return { text, userInfo, etag, lastModified };
  }

  /**
   * 流式读取响应体，累计字节超 MAX_BODY_BYTES 即 abort + throw（防 OOM；缓解 YAML 锚点炸弹输入面）。
   * 无 body（如某些 204）→ 退回 response.text()。
   */
  private async readBodyCapped(response: GlobalResponse): Promise<string> {
    const max = SubscriptionService.MAX_BODY_BYTES;
    const body = response.body;
    if (!body) {
      const t = await response.text();
      if (Buffer.byteLength(t, 'utf-8') > max) {
        throw new Error(`订阅响应体积超过上限 ${max}，已拒绝`);
      }
      return t;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > max) {
            try {
              await reader.cancel();
            } catch {
              // ignore
            }
            throw new Error(`订阅响应体积超过上限 ${max}，已拒绝`);
          }
          chunks.push(value);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
  }

  /**
   * 第二层（解析）：trimmed 内容 → ServerConfig[]。四分支：
   *   ① Sing-box JSON(outbounds) / JSON 编码 Clash(proxies / proxy-providers)
   *   ② Clash YAML(proxies / proxy-providers)
   *   ③ 明文 URL-list
   *   ④ Base64 URL-list
   * ctx.allowProviders：主订阅 true；provider 响应以 false 再入本函数 → 不递归 proxy-providers（深度硬封顶 2 层）。
   * @returns servers + partial（任一 provider 失败 → 调用方 reconcile 改 merge-only 防穿仓）。
   */
  private async parseSubscriptionContent(
    trimmed: string,
    subscriptionId: string,
    ctx: {
      allowProviders: boolean;
      viaProxy: boolean;
      userAgent: string;
      // throwOnEmpty=false：provider 复用路径用（0 节点返回空集而非 throw，让 resolveProxyProviders
      // 按 permanent 0-node 处理；真正的 YAML/JSON 结构错误仍由 tryLoadClashDoc 上抛）。默认 true。
      throwOnEmpty?: boolean;
    }
  ): Promise<{ servers: ServerConfig[]; partial?: boolean; failedProviders?: string[] }> {
    const throwOnEmpty = ctx.throwOnEmpty !== false;
    // ── 1. JSON: sing-box outbounds 或 JSON 编码的 Clash ──────────────
    // HIGH-1（数据穿仓）：try 只包 JSON.parse 本身，catch 仅消化「非 JSON」(SyntaxError) 以 fall through；
    // 分流调用（parseSingboxOutbounds/handleClashDoc）移出 catch 作用域 —— 否则 handleClashDoc 的
    // 「0 节点必须 throw」会被这个 catch 吞掉，fall through 到 Base64 返回空集，reconcile 删光节点。
    let json: unknown;
    let isJson = false;
    try {
      json = JSON.parse(trimmed);
      isJson = true;
    } catch {
      // 非 JSON（SyntaxError）→ fall through 到 YAML / URL-list 分支
    }
    if (isJson && json && typeof json === 'object') {
      const obj = json as Record<string, unknown>;
      if (Array.isArray(obj.outbounds)) {
        this.logManager.addLog(
          'info',
          '检测到 sing-box JSON 格式，解析 outbounds...',
          'Subscription'
        );
        const servers = this.parseSingboxOutbounds(obj.outbounds, subscriptionId);
        // M5：0 节点必须 throw（与 Clash 分支对齐），不返回空集 → 防 reconcile 删光存量 + 清 selectedServerId。
        if (servers.length === 0) {
          if (throwOnEmpty) throw new Error('sing-box 订阅解析得到 0 个可用节点');
          return { servers: [] };
        }
        this.logManager.addLog(
          'info',
          `成功从 sing-box 订阅解析了 ${servers.length} 个节点`,
          'Subscription'
        );
        return { servers };
      }
      if (
        Array.isArray(obj.proxies) ||
        (obj['proxy-providers'] && typeof obj['proxy-providers'] === 'object')
      ) {
        this.logManager.addLog(
          'info',
          '检测到 JSON 编码的 Clash 配置，解析 proxies...',
          'Subscription'
        );
        // handleClashDoc 的 0 节点 throw 在此正常上抛（不再被 catch 吞）。
        return await this.handleClashDoc(obj as ClashDoc, subscriptionId, ctx);
      }
    }

    // ── 2. Clash YAML（命中 proxies: 或 proxy-providers:）─────────────
    if (CLASH_PROBE_RE.test(trimmed)) {
      this.logManager.addLog('info', '检测到 Clash YAML 格式，解析 proxies...', 'Subscription');
      const doc = tryLoadClashDoc(trimmed); // 解析失败上抛，不静默落 Base64
      const hasProxies = Array.isArray(doc.proxies);
      const hasProviders = !!doc['proxy-providers'] && typeof doc['proxy-providers'] === 'object';
      if (!hasProxies && !hasProviders) {
        throw new Error('检测到 Clash 订阅特征，但 proxies/proxy-providers 结构异常');
      }
      return await this.handleClashDoc(doc, subscriptionId, ctx);
    }

    // ── 3/4. URL list (plain or Base64-encoded) ──────────────────────
    let decodedContent = trimmed;
    if (!decodedContent.includes('://')) {
      try {
        decodedContent = Buffer.from(decodedContent, 'base64').toString('utf-8');
      } catch {
        this.logManager.addLog('warn', '尝试 Base64 解码失败，可能原本就是明文', 'Subscription');
      }
    }

    // trim 每行（与 parseLocalContent 口径一致）：前导空白的合法链接否则被 startsWith 误判「不支持 scheme」。
    const lines = decodedContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const servers: ServerConfig[] = [];
    const now = new Date().toISOString();

    // 丢弃可见性（issue #263）：逐行 warn 之外聚合两类丢弃计数——①scheme 不受支持的行（原完全静默）
    // ②解析失败的行（原只有散落 warn）——最终 info 一并给出，用户不翻告警也能看出「导入不全」。
    let failedLines = 0;
    const unsupportedSchemes = new Map<string, number>();
    for (const line of lines) {
      if (this.protocolParser.isSupported(line)) {
        try {
          const server = this.protocolParser.parseUrl(line);
          server.subscriptionId = subscriptionId;
          server.createdAt = now;
          server.updatedAt = now;
          servers.push(server);
        } catch (e: any) {
          failedLines++;
          this.logManager.addLog('warn', `解析订阅中的节点失败: ${e.message}`, 'Subscription');
        }
      } else if (line.includes('://')) {
        const scheme = line.split('://')[0].trim().toLowerCase();
        unsupportedSchemes.set(scheme, (unsupportedSchemes.get(scheme) ?? 0) + 1);
      }
    }
    if (unsupportedSchemes.size > 0) {
      const detail = [...unsupportedSchemes.entries()].map(([s, c]) => `${s}(${c})`).join(', ');
      this.logManager.addLog(
        'warn',
        `跳过不支持的协议链接: ${detail}`,
        'Subscription'
      );
    }

    if (servers.length === 0) {
      // M5：URL-list/Base64 分支 0 节点也必须 throw（与 Clash/sing-box 对齐），不返回空集 →
      // 防 reconcile 删光存量节点 + 清 selectedServerId（正常订阅不会 0 节点）。
      const hadUrlLines = lines.some((l) => l.includes('://'));
      if (throwOnEmpty) {
        throw new Error(
          hadUrlLines
            ? '订阅中的节点 URL 均无法解析（协议不支持或格式错误），解析得到 0 个可用节点'
            : '无法识别订阅格式：既非 sing-box JSON，也未发现可解析的节点 URL（可能 Base64 解码失败或格式不受支持）'
        );
      }
      return { servers: [] };
    }
    const skippedTotal = failedLines + [...unsupportedSchemes.values()].reduce((a, b) => a + b, 0);
    this.logManager.addLog(
      'info',
      `成功从订阅解析了 ${servers.length} 个节点${skippedTotal > 0 ? `（另有 ${skippedTotal} 条被跳过/失败，详见上方告警）` : ''}`,
      'Subscription'
    );
    return { servers };
  }

  /**
   * Clash 文档统一收口：解析内联 proxies + 编排 proxy-providers + 合并去重。
   * 合计 0 节点必须 throw（防穿仓：空数组经 reconcile 会删光该订阅节点）。
   * @returns partial=true 当任一 provider 失败（调用方 reconcile 改 merge-only 不删 leftover）。
   */
  private async handleClashDoc(
    doc: ClashDoc,
    subscriptionId: string,
    ctx: {
      allowProviders: boolean;
      viaProxy: boolean;
      userAgent: string;
      throwOnEmpty?: boolean;
    }
  ): Promise<{ servers: ServerConfig[]; partial?: boolean; failedProviders?: string[] }> {
    const now = new Date().toISOString();

    // 内联 proxies
    const inline = parseClashProxies(doc.proxies, subscriptionId, now);
    for (const w of inline.warnings) this.logManager.addLog('warn', w, 'Subscription');

    let providerServers: ServerConfig[] = [];
    let partial = false;
    let failedProviders: string[] = [];

    const providers = doc['proxy-providers'];
    if (providers && typeof providers === 'object') {
      if (!ctx.allowProviders) {
        // 深度硬封顶 2 层：provider 内容再含 proxy-providers → 只取内联 + warn。
        this.logManager.addLog(
          'warn',
          'provider 内容再嵌套 proxy-providers，已忽略（不递归，深度封顶 2 层）',
          'Subscription'
        );
      } else {
        const result = await resolveProxyProviders(providers, {
          fetchText: async (url, signal) => {
            const { text } = await this.fetchSubscriptionText(
              url,
              ctx.viaProxy,
              ctx.userAgent,
              signal
            );
            return text;
          },
          parseContent: async (text) => {
            // LOW-1：provider 响应复用主解析（allowProviders:false → 不递归 providers；触发 handleClashDoc
            // 的「再嵌套 proxy-providers → warn 不递归」活分支）。throwOnEmpty:false → 0 节点返回空集，
            // 交由 resolveProxyProviders 按 permanent 0-node 处理（不消失成功节点、不误判 transient）。
            const r = await this.parseSubscriptionContent(text, subscriptionId, {
              allowProviders: false,
              viaProxy: ctx.viaProxy,
              userAgent: ctx.userAgent,
              throwOnEmpty: false,
            });
            return { servers: r.servers, skipped: 0, failed: 0, warnings: [] };
          },
          log: (level, message) => this.logManager.addLog(level, message, 'Subscription'),
          subscriptionId,
          now,
          maxProviders: 8,
          fetchTimeoutMs: 15_000,
        });
        providerServers = result.servers;
        partial = result.anyFailed;
        failedProviders = result.failedProviders;
        for (const w of result.warnings) this.logManager.addLog('warn', w, 'Subscription');
      }
    }

    // 内联在前、provider 在后 → 去重留内联那份。
    const merged = this.dedupeByFingerprint([...inline.servers, ...providerServers]);

    if (merged.length === 0) {
      // 防穿仓：Clash 分支(内联+provider)合计 0 必须 throw，不静默落 Base64。
      // throwOnEmpty=false（provider 复用路径）时返回空集，交由 resolveProxyProviders 按 permanent 0-node 处理。
      if (ctx.throwOnEmpty !== false) {
        throw new Error(
          `Clash 订阅解析得到 0 个可用节点（跳过 ${inline.skipped}、失败 ${inline.failed}）`
        );
      }
      return {
        servers: [],
        partial: partial || undefined,
        failedProviders: failedProviders.length ? failedProviders : undefined,
      };
    }

    this.logManager.addLog(
      'info',
      `Clash 订阅解析完成：内联 ${inline.servers.length} + provider ${providerServers.length} → 去重后 ${merged.length} 个节点${partial ? '（部分 provider 失败，本次将 merge-only 防穿仓）' : ''}`,
      'Subscription'
    );
    return {
      servers: merged,
      partial: partial || undefined,
      failedProviders: failedProviders.length ? failedProviders : undefined,
    };
  }

  /**
   * 拉取并解析订阅 URL，返回 ServerConfig 列表。
   * 支持格式:
   *   1. Sing-box JSON (带 outbounds 数组) — GlaDOS /singbox/ 等
   *   2. Clash / mihomo YAML（proxies / proxy-providers）
   *   3. 明文 URL 列表 (每行一个 vless:// / ss:// / trojan:// ...)
   *   4. Base64 编码的 URL 列表
   * @param userAgent 可选 UA（per-sub ?? 全局 ?? 默认）；缺省时用 defaultSubscriptionUserAgent()。
   * @returns partial=true 当 Clash provider 部分失败 → 调用方 reconcile 改 merge-only 防穿仓。
   */
  async fetchSubscription(
    url: string,
    subscriptionId: string,
    viaProxy: boolean = false,
    userAgent?: string,
    conditional?: { etag?: string; lastModified?: string }
  ): Promise<{
    servers: ServerConfig[];
    userInfo?: SubscriptionConfig['userInfo'];
    partial?: boolean;
    failedProviders?: string[];
    /** §16.3.4：本次 200 响应验证器 + 是否含 provider（供调用方回写 sub）。 */
    etag?: string;
    lastModified?: string;
    hasProviders?: boolean;
    /** §16.3.4：304 命中 → servers 空、调用方短路 reconcile（仅刷元数据）。 */
    notModified?: boolean;
  }> {
    try {
      // M6：url 常含 ?token=，日志脱敏（去 query）防 token 落 app.log。
      this.logManager.addLog(
        'info',
        `正在拉取订阅: ${SubscriptionService.redactUrl(url)}（${viaProxy ? '经代理' : '直连'}）`,
        'Subscription'
      );

      const ua = userAgent?.trim() || defaultSubscriptionUserAgent();
      // M3：主订阅 fetch 加超时（30s，比 provider 15s 宽）→ 防 slow-loris 挂死 scheduler.isRunning 永真。
      // §16.3.4：conditional 由调用方决定是否传（provider 型订阅豁免——见 subscription-handlers/scheduler）。
      const {
        text,
        userInfo,
        etag,
        lastModified,
        notModified,
      } = await this.fetchSubscriptionText(
        url,
        viaProxy,
        ua,
        AbortSignal.timeout(SubscriptionService.MAIN_FETCH_TIMEOUT_MS),
        conditional
      );
      // §16.3.4：304 → 内容无变化，短路 parse/reconcile（零节点扰动）。
      if (notModified) {
        this.logManager.addLog('info', '订阅无变化（304），跳过解析', 'Subscription');
        return { servers: [], notModified: true, etag, lastModified };
      }
      if (userInfo) {
        this.logManager.addLog('info', '订阅流量信息已获取', 'Subscription');
      }

      const trimmed = text.trim();
      // §16.3.4：hasProviders=含 Clash proxy-providers → 回写 sub，下次豁免条件 GET（主正文 304 会掩盖 provider 独立变化）。
      // M-1：兼容 YAML（行首 `proxy-providers:`）与 JSON 形态（`"proxy-providers":`，同支持路径 handleClashDoc）两种键形，
      // 避免 JSON 型 provider 订阅漏检 → 误发条件头 → 主正文恒 304 掩盖 provider 变化 → 节点无限期陈旧。宁可误判 true
      //（多一次全量拉取，零回归）不可漏判。
      const hasProviders =
        /(^|\n)\s*proxy-providers\s*:/.test(trimmed) || /"proxy-providers"\s*:/.test(trimmed);
      const { servers, partial, failedProviders } = await this.parseSubscriptionContent(
        trimmed,
        subscriptionId,
        {
          allowProviders: true,
          viaProxy,
          userAgent: ua,
        }
      );

      return { servers, userInfo, partial, failedProviders, etag, lastModified, hasProviders };
    } catch (error: any) {
      // M6：失败日志同样脱敏 url。
      this.logManager.addLog(
        'error',
        `拉取订阅失败 (${SubscriptionService.redactUrl(url)}): ${error.message}`,
        'Subscription'
      );
      throw error;
    }
  }

  /**
   * 订阅预检（新增订阅前先行）。动机（先加后删闪现/竞态 + 失败无原因）：add 原为「先建记录 → 再拉节点」，
   * 拉取失败要么留空订阅要么删记录（闪现），且只有布尔无原因。改为**预检先行**——用 URL **拉取 + 解析但
   * 不写 config、不建订阅记录、不碰 reconcile**；成功返回节点数，失败返回**分类错误**供 UI 说清原因 + 留窗。
   *
   * 复用 fetchSubscriptionText（含 SSRF guard——安全硬要求，绝不自写 fetch）+ parseSubscriptionContent
   * （throwOnEmpty:true → 0 节点抛错，经 classifySubscriptionError 落 empty 分类）。tempSubId 随机、仅供解析
   * 用不入库（预检产物整体丢弃，只取 servers.length）。
   */
  async previewSubscription(
    url: string,
    opts: { viaProxy?: boolean; userAgent?: string }
  ): Promise<SubscriptionPreviewResult> {
    const viaProxy = opts.viaProxy ?? false;
    const userAgent = opts.userAgent?.trim() || defaultSubscriptionUserAgent();
    const tempSubId = randomUUID(); // 不入库
    try {
      const { text } = await this.fetchSubscriptionText(
        url,
        viaProxy,
        userAgent,
        AbortSignal.timeout(SubscriptionService.MAIN_FETCH_TIMEOUT_MS)
      );
      const { servers } = await this.parseSubscriptionContent(text.trim(), tempSubId, {
        allowProviders: true,
        viaProxy,
        userAgent,
        throwOnEmpty: true,
      });
      return { ok: true, nodeCount: servers.length };
    } catch (err: any) {
      // 摊平错误信号交纯分类器（不自己判分类）：message + code(err.code ?? cause.code) + 从
      // 'HTTP Error: NNN'（fetchSubscriptionText 的 HTTP 失败文案 `HTTP Error: ${status} ${statusText}`）提 status。
      const message: string = err?.message ?? '';
      const httpMatch = /HTTP Error:\s*(\d{3})/.exec(message);
      const httpStatus = httpMatch ? parseInt(httpMatch[1], 10) : undefined;
      const cls = classifySubscriptionError({
        message,
        code: err?.code ?? err?.cause?.code,
        httpStatus,
      });
      return {
        ok: false,
        errorKind: cls.errorKind,
        httpStatus: cls.httpStatus,
        message: SubscriptionService.redactUrl(message), // 脱敏，仅诊断
      };
    }
  }

  /**
   * 本地导入解析（不联网）：文件/文本字符串 → 自建节点 + （仅 Clash）订阅条目 + 统计。
   * 复用订阅解析的同款探测与解析器（sing-box JSON / Clash / base64 / 分享链接），新增 Xray 分支。
   *  - 节点一律剥离 subscriptionId/providerName → 归入「自建」（可编辑、可删除）。
   *  - sing-box JSON 中未映射但合法的 outbound type → 透传为 custom（使用时经启动 gate 置灰）；Xray/Clash 未支持 → 跳过报告。
   *  - proxy-providers 仅提取 {name,url}，**不拉取**（导入订阅默认不自动更新/直连）。
   *  - 最终用 isServerComplete 过滤掉会让 saveConfig.validateConfig throw 的节点（计 failed），保证批量入库不整体失败。
   *  - 不可识别格式 → throw（门控，调用方提示报错）。
   */
  async parseLocalContent(text: string): Promise<ImportParseResult> {
    const trimmed = (text || '').trim();
    // 体积闸（与网络订阅 MAX_BODY_BYTES 同口径）：防超大文件 / YAML 锚点炸弹经 IPC 进主进程 OOM。
    if (trimmed.length > SubscriptionService.MAX_BODY_BYTES) {
      throw new Error('导入内容过大');
    }
    const now = new Date().toISOString();
    const candidates: ServerConfig[] = [];
    const subscriptions: { name: string; url: string }[] = [];
    const warnings: string[] = [];
    let customWrapped = 0;
    let skipped = 0;
    let failed = 0;
    let format: ImportFormat = 'unknown';

    if (trimmed) {
      // 1. JSON：sing-box（outbounds[].type）/ Xray（outbounds[].protocol）/ JSON 编码 Clash
      let json: unknown;
      let isJson = false;
      try {
        json = JSON.parse(trimmed);
        isJson = true;
      } catch {
        /* 非 JSON，fall through */
      }
      if (isJson && json && typeof json === 'object') {
        const obj = json as Record<string, unknown>;
        if (Array.isArray(obj.outbounds)) {
          const obs = obj.outbounds as Array<Record<string, unknown>>;
          const looksXray = obs.some(
            (o) =>
              o && typeof o === 'object' && typeof o.protocol === 'string' && o.type === undefined
          );
          if (looksXray) {
            format = 'xray';
            const r = parseXrayOutbounds(obs, now);
            candidates.push(...r.servers);
            skipped += r.skipped;
            failed += r.failed;
            warnings.push(...r.warnings);
          } else {
            format = 'singbox';
            const mapped = this.parseSingboxOutbounds(obs as unknown as SingboxOutbound[], '');
            for (const s of mapped) {
              s.subscriptionId = undefined;
              s.providerName = undefined;
              s.createdAt = now;
              s.updatedAt = now;
              candidates.push(s);
            }
            // 未映射但合法的 type → 透传 custom（内部 type 如 direct/selector 忽略）
            for (const ob of obs) {
              if (!ob || typeof ob !== 'object') continue;
              const t = ob.type;
              if (typeof t !== 'string' || !t.trim()) continue;
              if (SINGBOX_SUPPORTED_TYPES.has(t) || SINGBOX_INTERNAL_TYPES.has(t)) continue;
              candidates.push(this.makeCustomNode(ob, now));
              customWrapped++;
            }
            // 受支持 type 但缺 server/port 被 parseSingboxOutbounds 丢弃的节点计入 failed（统计准确，对齐 xray/clash 分支）。
            const supportedInputs = obs.filter(
              (o) =>
                o &&
                typeof o === 'object' &&
                typeof o.type === 'string' &&
                SINGBOX_SUPPORTED_TYPES.has(o.type)
            ).length;
            failed += Math.max(0, supportedInputs - mapped.length);
          }
        } else if (
          Array.isArray(obj.proxies) ||
          (obj['proxy-providers'] && typeof obj['proxy-providers'] === 'object')
        ) {
          format = 'clash';
          const c = this.collectClashLocal(obj as ClashDoc, now);
          candidates.push(...c.nodes);
          subscriptions.push(...c.subscriptions);
          skipped += c.skipped;
          failed += c.failed;
          warnings.push(...c.warnings);
        }
      }

      // 2. Clash YAML
      if (format === 'unknown' && CLASH_PROBE_RE.test(trimmed)) {
        format = 'clash';
        const doc = tryLoadClashDoc(trimmed); // 解析失败上抛 = 门控
        const c = this.collectClashLocal(doc, now);
        candidates.push(...c.nodes);
        subscriptions.push(...c.subscriptions);
        skipped += c.skipped;
        failed += c.failed;
        warnings.push(...c.warnings);
      }

      // 3/4. 分享链接 / Base64
      if (format === 'unknown') {
        // Base64 解码（Node 对非字母表字符宽松忽略、不抛；非 base64 文本解出乱码后下方 includes('://') 自然不命中）。
        let decoded = trimmed;
        if (!decoded.includes('://')) {
          decoded = Buffer.from(decoded, 'base64').toString('utf-8');
        }
        if (decoded.includes('://')) {
          format = 'links';
          const lines = decoded
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);
          for (const line of lines) {
            if (!this.protocolParser.isSupported(line)) {
              skipped++;
              continue;
            }
            try {
              const s = this.protocolParser.parseUrl(line);
              s.subscriptionId = undefined;
              s.providerName = undefined;
              s.createdAt = now;
              s.updatedAt = now;
              candidates.push(s);
            } catch {
              failed++;
            }
          }
        }
      }
    }

    if (format === 'unknown') {
      throw new Error('无法识别文件格式');
    }

    // 最终 gate：仅保留 saveConfig.validateConfig 不会 throw 的节点（与渲染侧 isServerComplete 同口径）。
    // 透传 custom 必含合法 type → 必过 gate；故 unsupported = customWrapped。
    const nodes: ServerConfig[] = [];
    for (const n of candidates) {
      // 与 ConfigManager.validateConfig 对齐：isServerComplete 缺端口上界、不校验 name，这里补齐——
      // 否则 port>65535 / 空 name 的节点会过 gate 却让 SERVER_ADD_BULK 的 saveConfig throw → 整批失败。
      const p = (n.protocol || '').toLowerCase();
      const portOk =
        p === 'custom' || (typeof n.port === 'number' && n.port >= 1 && n.port <= 65535);
      const nameOk = !!n.name && n.name.trim().length > 0;
      if (isServerComplete(n) && portOk && nameOk) nodes.push(n);
      else failed++;
    }

    return {
      nodes,
      subscriptions,
      stats: { imported: nodes.length, unsupported: customWrapped, skipped, failed },
      warnings,
      format,
    };
  }

  /** Clash 文档（本地，不拉取）：proxies → 自建节点；proxy-providers(type:http) → {name,url} 订阅。 */
  private collectClashLocal(
    doc: ClashDoc,
    now: string
  ): {
    nodes: ServerConfig[];
    subscriptions: { name: string; url: string }[];
    skipped: number;
    failed: number;
    warnings: string[];
  } {
    const r = parseClashProxies(doc.proxies, '', now);
    const nodes = r.servers.map((s) => {
      s.subscriptionId = undefined;
      s.providerName = undefined;
      return s;
    });
    const subscriptions: { name: string; url: string }[] = [];
    const providers = doc['proxy-providers'];
    if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
      for (const [name, v] of Object.entries(providers as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') continue;
        const pv = v as Record<string, unknown>;
        const type = typeof pv.type === 'string' ? pv.type.toLowerCase() : '';
        const url = typeof pv.url === 'string' ? pv.url.trim() : '';
        // type 缺省按 http 处理（机场常省略）；type:file 等本地源忽略；url 必须 http(s)（拒 file:// 等伪源）。
        if ((type === 'http' || type === '') && /^https?:\/\//i.test(url)) {
          subscriptions.push({ name, url });
        }
      }
    }
    return { nodes, subscriptions, skipped: r.skipped, failed: r.failed, warnings: r.warnings };
  }

  /** 不支持的 sing-box outbound → custom 透传节点（原始 outbound 进 customSettings.outbound）。 */
  private makeCustomNode(ob: Record<string, unknown>, now: string): ServerConfig {
    const type = String(ob.type ?? '');
    const tag = typeof ob.tag === 'string' && ob.tag.trim() ? ob.tag.trim() : type || 'custom';
    return {
      id: randomUUID(),
      name: tag,
      protocol: 'custom',
      address: typeof ob.server === 'string' ? ob.server : '',
      port: typeof ob.server_port === 'number' ? ob.server_port : 0,
      customSettings: { outbound: ob },
      createdAt: now,
      updatedAt: now,
    };
  }
}
