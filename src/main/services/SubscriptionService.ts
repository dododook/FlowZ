import { randomUUID } from 'crypto';
import { app, net, session, type Session } from 'electron';
import type { ServerConfig, SubscriptionConfig } from '../../shared/types';
import { ProtocolParser } from './ProtocolParser';
import { LogManager } from './LogManager';
import { promises as dnsPromises } from 'dns';
import { assertHostAllowed } from '../../shared/ssrf-guard';
import {
  CLASH_PROBE_RE,
  tryLoadClashDoc,
  parseClashProxies,
  resolveProxyProviders,
  type ClashDoc,
} from './ClashSubscriptionParser';
import { normalizeDuration } from '../../shared/duration';

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
  tls?: SingboxTls;
  transport?: SingboxTransport;
  multiplex?: SingboxMultiplex;
};

export class SubscriptionService {
  // 响应体积上限：超大响应直接 OOM（兼缓解 YAML 锚点炸弹的输入面）。content-length 预检 + 读取后字节校验双闸。
  private static readonly MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB
  // 重定向链最大跳数：每跳 Location 重跑 SSRF guard（含 DNS 解析），超过即拒（防无限跳/绕 guard）。
  private static readonly MAX_REDIRECTS = 5;
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
    return `${(s.protocol || '').toLowerCase()}|${s.address}|${s.port}|${cred}`;
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
  } {
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
    for (const ns of fetchedServers) {
      const key = SubscriptionService.serverFingerprint(ns);
      const bucket = oldBuckets.get(key);
      const old = bucket && bucket.length > 0 ? bucket.shift() : undefined;
      if (old) {
        // 内容相同（忽略 id/时间戳）则保留 old.updatedAt，避免无变化也刷新 updatedAt「投毒」纯切节点热切换
        const contentKey = (s: ServerConfig) => {
          const copy: Record<string, unknown> = { ...s };
          delete copy.id;
          delete copy.createdAt;
          delete copy.updatedAt;
          delete copy.providerName; // M1：归属元数据非节点连接内容，不计入比较（否则加该字段会让存量节点首次升级误刷 updatedAt）
          return JSON.stringify(copy);
        };
        kept.push({
          ...ns,
          id: old.id,
          createdAt: old.createdAt,
          updatedAt: contentKey(ns) === contentKey(old) ? old.updatedAt : now,
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
    return { servers: kept, added, updated, deleted: leftover.length, deletedIds };
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
    const SUPPORTED = new Set([
      'shadowsocks',
      'vless',
      'trojan',
      'hysteria2',
      'naive',
      'vmess',
      'tuic',
      'anytls',
    ]);
    const servers: ServerConfig[] = [];
    const now = new Date().toISOString();

    for (const ob of outbounds) {
      if (!SUPPORTED.has(ob.type)) continue;
      // 支持仅含 server_ports（端口跳跃、无 server_port）的 Hy2 节点：从首个范围的低位端口推导 port
      const effectivePort =
        ob.server_port ??
        (ob.server_ports?.[0] ? parseInt(ob.server_ports[0].split(':')[0], 10) : undefined);
      if (!ob.server || !effectivePort) continue;

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
          const netType = t.type as 'ws' | 'grpc' | 'http' | 'httpupgrade' | 'tcp';
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
        }
      } catch (e: any) {
        this.logManager.addLog(
          'warn',
          `解析 sing-box outbound "${ob.tag}" 失败: ${e.message}`,
          'Subscription'
        );
      }
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
    signal?: AbortSignal
  ): Promise<{ text: string; userInfo?: SubscriptionConfig['userInfo'] }> {
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

    // H2：redirect:'manual' 自管重定向链——每跳 Location 重跑 SSRF guard（含 H1 DNS 解析），
    // 通过才续跳，最多 MAX_REDIRECTS 跳。默认 follow 会让首跳过 guard 后跳到内网不复检。
    let currentUrl = url;
    // 仅实际走 proxied（viaProxiedSession）才豁免 FlowZ FakeIP（TUN+FakeIP 下系统 DNS 把公网域名解析成假 IP，
    // 经核反查真实；直连/端口不可用回退直连不豁免，防域名真实解析到本机内网的 SSRF）。
    await assertHostAllowed(
      parse(currentUrl),
      (h) => dnsPromises.lookup(h, { all: true }),
      viaProxiedSession
    ); // H1：初始 URL 解析后逐 IP 校验

    let response: GlobalResponse | null = null;
    for (let hop = 0; hop <= SubscriptionService.MAX_REDIRECTS; hop++) {
      response = await fetchImpl(currentUrl, {
        headers: { 'User-Agent': userAgent },
        redirect: 'manual',
        ...(signal ? { signal } : {}),
      });

      // 30x：取 Location，重跑 guard 后续跳。
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        if (hop >= SubscriptionService.MAX_REDIRECTS) {
          throw new Error(`订阅重定向次数超过上限（${SubscriptionService.MAX_REDIRECTS}），已拒绝`);
        }
        const loc = response.headers.get('location')!;
        // 相对 Location 以当前 URL 为基准解析；再校验协议 + 解析后 IP。
        let nextObj: URL;
        try {
          nextObj = new URL(loc, currentUrl);
        } catch {
          throw new Error('订阅重定向目标非法，已拒绝');
        }
        if (nextObj.protocol !== 'http:' && nextObj.protocol !== 'https:') {
          throw new Error('订阅重定向目标协议不支持（仅允许 http/https），已拒绝');
        }
        await assertHostAllowed(
          nextObj,
          (h) => dnsPromises.lookup(h, { all: true }),
          viaProxiedSession
        ); // 重定向目标过同一 guard（含 DNS 解析）
        // 释放上一跳响应体，避免泄漏。
        try {
          await response.body?.cancel();
        } catch {
          // ignore
        }
        currentUrl = nextObj.toString();
        continue;
      }

      break; // 非 30x（或无 Location）→ 终态响应
    }

    if (!response) {
      throw new Error('订阅拉取未获得响应');
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
    // M2：流式读取并按字节累计上限（content-length 可缺失/撒谎，读取侧硬校验兜底）。
    const text = await this.readBodyCapped(response);
    return { text, userInfo };
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

    const lines = decodedContent.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const servers: ServerConfig[] = [];
    const now = new Date().toISOString();

    for (const line of lines) {
      if (this.protocolParser.isSupported(line)) {
        try {
          const server = this.protocolParser.parseUrl(line);
          server.subscriptionId = subscriptionId;
          server.createdAt = now;
          server.updatedAt = now;
          servers.push(server);
        } catch (e: any) {
          this.logManager.addLog('warn', `解析订阅中的节点失败: ${e.message}`, 'Subscription');
        }
      }
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
    this.logManager.addLog('info', `成功从订阅解析了 ${servers.length} 个节点`, 'Subscription');
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
    userAgent?: string
  ): Promise<{
    servers: ServerConfig[];
    userInfo?: SubscriptionConfig['userInfo'];
    partial?: boolean;
    failedProviders?: string[];
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
      const { text, userInfo } = await this.fetchSubscriptionText(
        url,
        viaProxy,
        ua,
        AbortSignal.timeout(SubscriptionService.MAIN_FETCH_TIMEOUT_MS)
      );
      if (userInfo) {
        this.logManager.addLog('info', '订阅流量信息已获取', 'Subscription');
      }

      const trimmed = text.trim();
      const { servers, partial, failedProviders } = await this.parseSubscriptionContent(
        trimmed,
        subscriptionId,
        {
          allowProviders: true,
          viaProxy,
          userAgent: ua,
        }
      );

      return { servers, userInfo, partial, failedProviders };
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
}
