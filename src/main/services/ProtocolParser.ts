import { randomUUID } from 'crypto';
import { isIPv6 } from 'net';
import type {
  ServerConfig,
  Protocol,
  Security,
  TlsSettings,
  RealitySettings,
  WebSocketSettings,
  GrpcSettings,
  HttpSettings,
  Hysteria2Settings,
  Hysteria2Network,
  AnyTlsSettings,
  SnellSettings,
  LogLevel,
} from '../../shared/types';
import { normalizeDuration } from '../../shared/duration';
import { dedupeTrim } from '../../shared/collections';
import { isSupportedShareUrl } from '../../shared/protocol-url-schemes';
import type { LogManager } from './LogManager';

export interface IProtocolParser {
  isSupported(url: string): boolean;
  parseUrl(url: string): ServerConfig;
  generateUrl(config: ServerConfig): string;
}

export class ProtocolParser implements IProtocolParser {
  private logManager?: LogManager;

  /**
   * 注入 LogManager（由主流程在 index.ts 统一注入）。注入前日志走 console fallback。
   */
  setLogManager(lm: LogManager): void {
    this.logManager = lm;
  }

  /**
   * 统一日志出口：已注入 LogManager 则转发，否则按级别 fallback 到 console。
   */
  private log(level: LogLevel, message: string): void {
    if (this.logManager) {
      this.logManager.addLog(level, message, 'ProtocolParser');
      return;
    }
    if (level === 'error' || level === 'fatal') console.error(message);
    else if (level === 'warn') console.warn(message);
    else console.log(message);
  }

  isSupported(url: string): boolean {
    return isSupportedShareUrl(url);
  }

  /**
   * 预处理分享 URL，将裸 IPv6 地址（无方括号）转换为标准格式（全协议通用；无 '@' 时原样返回）。
   * 例: ss://user@2001:db8::1:8388?... → ss://user@[2001:db8::1]:8388?...
   */
  private preprocessBareIpv6(raw: string): string {
    const atIdx = raw.indexOf('@');
    if (atIdx === -1) return raw;

    const beforeAt = raw.substring(0, atIdx + 1);
    const afterAt = raw.substring(atIdx + 1);

    // Split off path / query / fragment so we only work on the host:port part
    // （SIP002 plugin 形态 `…:port/?plugin=…` 的 `/` 在 `?` 前是标准写法，不截断会使 hostPort 携 `/` 双判定皆失败）
    const qIdx = afterAt.search(/[/?#]/);
    const hostPort = qIdx >= 0 ? afterAt.substring(0, qIdx) : afterAt;
    const suffix = qIdx >= 0 ? afterAt.substring(qIdx) : '';

    // If already bracketed, no action needed
    if (hostPort.startsWith('[')) return raw;

    // IPv6 addresses have multiple colons; find the last colon as port separator
    const parts = hostPort.split(':');
    if (parts.length >= 4) {
      const lastColon = hostPort.lastIndexOf(':');
      const potentialPort = hostPort.substring(lastColon + 1);
      const remainder = hostPort.substring(0, lastColon);
      // 「地址 vs 地址:端口」文法固有歧义（2001:db8::1:8388 两种读法都合法），消解启发式：
      //  1) 末段为 2-5 位十进制且 ≤65535 且余段是合法 IPv6 → 按 地址+端口 拆（分享链几乎恒带端口）。
      //     单数字末段（如 ::1）按地址整段——真实代理端口不用 1-9，而地址末段 '1' 极常见。
      //  2) 否则整段本身合法 IPv6（无端口形态）→ 只加括号，端口缺省交 parseBase（与域名无端口同语义）。
      //  3) 两者皆非 → 原样返回，交 new URL 抛错（丢弃可见，不静默入库截断地址的假节点）。
      if (
        /^\d{2,5}$/.test(potentialPort) &&
        parseInt(potentialPort, 10) <= 65535 &&
        isIPv6(remainder)
      ) {
        return `${beforeAt}[${remainder}]:${potentialPort}${suffix}`;
      }
      if (isIPv6(hostPort)) {
        return `${beforeAt}[${hostPort}]${suffix}`;
      }
    }
    return raw;
  }

  parseUrl(url: string): ServerConfig {
    if (!this.isSupported(url)) {
      throw new Error(`不支持的协议: ${url.split('://')[0]}`);
    }

    try {
      // 裸 IPv6（无方括号）预处理泛化到全协议：原仅 ss:// 处理，vless/trojan/hy2 等裸 IPv6 链接
      // 会在 new URL() 直接 throw 整节点丢（issue #263 调查项）。无 '@' 的形态（vmess base64）原样返回。
      url = this.preprocessBareIpv6(url);

      const urlObj = new URL(url);
      let protocolStr = urlObj.protocol.replace(':', '');

      // hy2 是 hysteria2 的别名
      if (protocolStr === 'hy2') {
        protocolStr = 'hysteria2';
      }

      // ss 是 shadowsocks 的别名
      if (protocolStr === 'ss') {
        protocolStr = 'shadowsocks';
      }

      // naive 是 http2 或者 naive+https 的内部别名
      // 同时兼容一些客户端使用的 https://...#naive 格式，以及标准的 naive://
      if (
        protocolStr === 'http2' ||
        protocolStr === 'naive+https' ||
        protocolStr === 'naive' ||
        (protocolStr === 'https' && urlObj.hash.toLowerCase().includes('naive'))
      ) {
        protocolStr = 'naive';
      }

      const protocol = protocolStr as Protocol;

      if (protocol === 'vless') {
        return this.parseVless(urlObj);
      } else if (protocol === 'trojan') {
        return this.parseTrojan(urlObj);
      } else if (protocol === 'hysteria2') {
        return this.parseHysteria2(urlObj);
      } else if (protocol === 'shadowsocks') {
        return this.parseShadowsocks(urlObj);
      } else if (protocol === 'anytls') {
        return this.parseAnyTls(urlObj);
      } else if (protocol === 'snell') {
        return this.parseSnell(urlObj);
      } else if (protocol === 'tuic') {
        return this.parseTuic(urlObj);
      } else if (protocol === 'naive') {
        return this.parseNaive(urlObj);
      } else if (protocol === 'vmess') {
        return this.parseVmess(url);
      } else if (protocol === 'socks' || protocolStr === 'socks5' || protocolStr === 's5') {
        return this.parseSocks(urlObj);
      } else if (protocol === 'http' || protocolStr === 'https') {
        return this.parseHttp(urlObj);
      }

      throw new Error(`不支持的协议: ${protocol}`);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`URL 解析失败: ${error.message}`);
      }
      throw error;
    }
  }

  private stripIpv6Brackets(hostname: string): string {
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      return hostname.slice(1, -1);
    }
    return hostname;
  }

  /**
   * 解析标准 `scheme://cred@host:port?params#name` URL 的公共头部：去括号地址 / 端口缺省 /
   * 查询参数 / 名称缺省回落 address:port。服务 vless/trojan/hysteria2/anytls/snell/naive/socks/http；
   * VMess(base64 JSON)、Shadowsocks(名称缺省 'Shadowsocks')、TUIC(名称缺省 'TUIC Node') 名称/凭据形态各异，不走此助手。
   */
  private parseBase(
    url: URL,
    defaultPort = 443
  ): { address: string; port: number; params: URLSearchParams; name: string } {
    const address = this.stripIpv6Brackets(url.hostname);
    const port = parseInt(url.port) || defaultPort;
    const params = new URLSearchParams(url.search);
    const name = decodeURIComponent(url.hash.slice(1)) || `${address}:${port}`;
    return { address, port, params, name };
  }

  /** 格式: vless://uuid@address:port?encryption=none&security=tls&type=ws&host=example.com&path=/path#name */
  private parseVless(url: URL): ServerConfig {
    const uuid = url.username;
    const { address, port, params, name } = this.parseBase(url);

    if (!uuid) {
      throw new Error('VLESS URL 缺少 UUID');
    }

    const config: ServerConfig = {
      id: randomUUID(),
      name,
      protocol: 'vless',
      address,
      port,
      uuid,
      encryption: params.get('encryption') || 'none',
      flow: params.get('flow') || undefined,
    };

    // 归一化/白名单收口于 parseTransportSettings（未知类型 throw 整节点拒绝）。
    const network = params.get('type');
    if (network) {
      this.parseTransportSettings(config, params, network);
    }

    const security = params.get('security') as Security | null;
    if (security) {
      config.security = security;
      if (security === 'tls' || security === 'reality') {
        config.tlsSettings = this.parseTlsSettings(params);
      }
      if (security === 'reality') {
        config.realitySettings = this.parseRealitySettings(params);
        if (!config.realitySettings) {
          // 缺 pbk 的 reality 节点无法握手（builder 不生成 reality tls 块 → 退化裸 TCP 假节点），整节点拒绝。
          throw new Error('Reality 节点缺少 pbk（public key）参数');
        }
      }
    }

    return config;
  }

  /** 格式: trojan://password@address:port?security=tls&type=ws&host=example.com&path=/path#name */
  private parseTrojan(url: URL): ServerConfig {
    const password = decodeURIComponent(url.username);
    const { address, port, params, name } = this.parseBase(url);

    const config: ServerConfig = {
      id: randomUUID(),
      name,
      protocol: 'trojan',
      address,
      port,
      password,
    };

    // 归一化/白名单收口于 parseTransportSettings（未知类型 throw 整节点拒绝）。
    const network = params.get('type');
    if (network) {
      this.parseTransportSettings(config, params, network);
    }

    // Trojan 默认即 TLS
    const security = (params.get('security') as Security | null) || 'tls';
    config.security = security;

    if (security === 'tls' || security === 'reality') {
      config.tlsSettings = this.parseTlsSettings(params);
    }
    if (security === 'reality') {
      config.realitySettings = this.parseRealitySettings(params);
      if (!config.realitySettings) {
        // 缺 pbk 的 reality 节点无法握手（builder 不生成 reality tls 块 → 退化裸 TCP 假节点），整节点拒绝。
        throw new Error('Reality 节点缺少 pbk（public key）参数');
      }
    }

    return config;
  }

  /**
   * 格式: hysteria2://password@address:port?obfs=salamander&obfs-password=xxx&sni=example.com&insecure=1#name
   * 或者: hy2://password@address:port?...
   */
  private parseHysteria2(url: URL): ServerConfig {
    const password = decodeURIComponent(url.username);
    const { address, port, params, name } = this.parseBase(url);

    if (!password) {
      throw new Error('Hysteria2 URL 缺少密码');
    }

    const config: ServerConfig = {
      id: randomUUID(),
      name,
      protocol: 'hysteria2',
      address,
      port,
      password,
      // Hysteria2 协议必须使用 TLS
      security: 'tls',
    };

    // 解析 Hysteria2 特定配置
    const hysteria2Settings: Hysteria2Settings = {};

    // 解析带宽限制
    const upMbps = params.get('up_mbps') || params.get('up');
    const downMbps = params.get('down_mbps') || params.get('down');
    if (upMbps) {
      hysteria2Settings.upMbps = parseInt(upMbps);
    }
    if (downMbps) {
      hysteria2Settings.downMbps = parseInt(downMbps);
    }

    // 解析混淆配置
    const obfs = params.get('obfs');
    const obfsPassword = params.get('obfs-password');
    if (obfs === 'salamander' && obfsPassword) {
      hysteria2Settings.obfs = {
        type: 'salamander',
        password: obfsPassword,
      };
    } else if (obfs === 'salamander') {
      // 声明 salamander 即服务端强制混淆，缺 obfs-password 剥离后裸连必死（假节点）——
      // 与 reality 缺 pbk 同判据（凭据残缺=整节点拒绝）。
      throw new Error('Hysteria2 obfs=salamander 缺少 obfs-password');
    } else if (obfs) {
      // 非 salamander 值（sing-box hy2 无对应混淆类型/参数噪声）：剥离 + warn 留痕。
      this.log(
        'warn',
        `Hysteria2 节点 "${name}" 的 obfs 参数（${obfs}）不受支持，已忽略混淆配置`
      );
    }

    // 解析网络类型（tcp 或 udp）
    const network = params.get('network') as Hysteria2Network | null;
    if (network) {
      hysteria2Settings.network = network;
    }

    // 只有在有设置时才添加
    if (Object.keys(hysteria2Settings).length > 0) {
      config.hysteria2Settings = hysteria2Settings;
    }

    // 解析 TLS 配置
    config.tlsSettings = this.parseTlsSettings(params);
    // Hysteria2 必须开启 TLS，如果 parseTlsSettings 没解析到 SNI，设置默认 SNI
    if (!config.tlsSettings.serverName) {
      config.tlsSettings.serverName = params.get('sni') || params.get('peer') || address;
    }

    return config;
  }

  /** 格式: tuic://uuid:password@address:port?congestion_control=bbr&alpn=h3&sni=link.apple.com&udp_relay_mode=native&allow_insecure=1#name */
  private parseTuic(url: URL): ServerConfig {
    const params = url.searchParams;
    const name = decodeURIComponent(url.hash ? url.hash.slice(1) : '');

    // Credentials format: tuic://uuid:password@...
    const credentials = decodeURIComponent(url.username + (url.password ? ':' + url.password : ''));
    const [uuid, ...passwordParts] = credentials.split(':');
    const password = passwordParts.join(':');

    if (!uuid || !password) {
      throw new Error('TUIC 协议缺少 uuid 或 password');
    }

    const config: ServerConfig = {
      id: randomUUID(),
      name: name || 'TUIC Node',
      protocol: 'tuic',
      address: this.stripIpv6Brackets(url.hostname),
      port: parseInt(url.port, 10),
      uuid,
      password,
      network: 'tcp', // sing-box tuic default network isn't strictly necessary but keeping for consistency
      security: 'tls',
      tuicSettings: {},
      tlsSettings: this.parseTlsSettings(params),
    };

    // 如果没解析到 SNI，设置默认
    if (!config.tlsSettings!.serverName) {
      config.tlsSettings!.serverName = params.get('sni') || url.hostname;
    }

    // Alpn (typically 'h3' for TUIC v5)
    // 逗号串拆分后统一 dedupeTrim：与 VMess/parseTlsSettings 口径一致，保序去重，空值产出空数组。
    const alpnParam = params.get('alpn');
    if (alpnParam) {
      config.tlsSettings!.alpn = dedupeTrim(alpnParam.split(','));
    }

    // Congestion control
    const congestionControl = params.get('congestion_control');
    if (
      congestionControl === 'bbr' ||
      congestionControl === 'cubic' ||
      congestionControl === 'new_reno'
    ) {
      config.tuicSettings!.congestionControl = congestionControl;
    }

    // UDP Relay Mode
    const udpRelayMode = params.get('udp_relay_mode');
    if (udpRelayMode === 'native' || udpRelayMode === 'quic') {
      config.tuicSettings!.udpRelayMode = udpRelayMode;
    }

    // Others like zero_rtt_handshake / heartbeat
    // heartbeat 经 normalizeDuration（与同文件 parseAnyTls idle 对齐）：订阅写裸毫秒整数（如 "10000"）补 ms 单位，
    // 防 sing-box "missing unit"；已带单位（10s/500ms）透传。
    const heartbeat = normalizeDuration(params.get('heartbeat'));
    if (heartbeat) {
      config.tuicSettings!.heartbeat = heartbeat;
    }
    const zrtt = params.get('zero_rtt_handshake');
    if (zrtt) {
      config.tuicSettings!.zeroRttHandshake = zrtt === '1' || zrtt === 'true';
    }

    return config;
  }

  /** 格式: anytls://password@address:port?security=tls&sni=...&fp=chrome&pbk=...&sid=...#name */
  private parseAnyTls(url: URL): ServerConfig {
    const password = decodeURIComponent(url.username);
    const { address, port, params, name } = this.parseBase(url);

    if (!password) {
      throw new Error('AnyTLS URL 缺少密码');
    }

    const config: ServerConfig = {
      id: randomUUID(),
      name,
      protocol: 'anytls',
      address,
      port,
      password,
    };

    const anyTlsSettings: AnyTlsSettings = {};
    const idleCheckInterval = normalizeDuration(params.get('idle_session_check_interval'));
    const idleTimeout = normalizeDuration(params.get('idle_session_timeout'));
    // min_idle_session 口径对齐 ClashSubscriptionParser 的 num()（非空数字串→Number，否则 undefined）+
    // 生成侧 generateAnyTlsUrl 的 `!== undefined`：min=0 是合法值（须保留），而 parseInt('abc')=NaN 必须丢弃
    // （旧 `if(minIdle) parseInt(...)` 会把非数字串写成 NaN，且形态与 Clash/生成两路不一致）。
    const minIdleRaw = params.get('min_idle_session');
    const minIdle =
      minIdleRaw !== null && minIdleRaw.trim() !== '' && !isNaN(Number(minIdleRaw))
        ? Number(minIdleRaw)
        : undefined;
    if (idleCheckInterval) anyTlsSettings.idleSessionCheckInterval = idleCheckInterval;
    if (idleTimeout) anyTlsSettings.idleSessionTimeout = idleTimeout;
    if (minIdle !== undefined) anyTlsSettings.minIdleSession = minIdle;
    if (Object.keys(anyTlsSettings).length > 0) {
      config.anyTlsSettings = anyTlsSettings;
    }

    const security = params.get('security') as Security | null;
    if (security) {
      config.security = security;
      if (security === 'tls' || security === 'reality') {
        config.tlsSettings = this.parseTlsSettings(params);
      }
      if (security === 'reality') {
        config.realitySettings = this.parseRealitySettings(params);
        if (!config.realitySettings) {
          // 缺 pbk 的 reality 节点无法握手（builder 不生成 reality tls 块 → 退化裸 TCP 假节点），整节点拒绝。
          throw new Error('Reality 节点缺少 pbk（public key）参数');
        }
      }
    } else {
      // AnyTLS 默认就是 TLS
      config.security = 'tls';
      config.tlsSettings = this.parseTlsSettings(params);
    }

    return config;
  }

  /**
   * 解析 Snell URL（无标准 scheme；对齐 Surge 生态工具 sub-store 等的事实形态）
   * 格式: snell://psk@address:port?version=4&obfs=http&obfs-host=bing.com&reuse=1&userkey=uk#name
   * version 缺省 4；sing-box 官方 snell 仅支持 4/6（v1-3 为 Surge/mihomo 旧协议版本），
   * 版本/混淆超出能力（如 obfs=tls）→ 整节点拒绝（入库也连不上，防假节点；订阅逐行 catch 聚合告警）。
   */
  private parseSnell(url: URL): ServerConfig {
    // psk 含未编码 ':' 时 URL 引擎会拆成 username:password——两段拼回，避免 psk 静默截断成假节点。
    const psk = decodeURIComponent(
      url.password ? `${url.username}:${url.password}` : url.username
    );
    const { address, port, params, name } = this.parseBase(url);

    if (!psk.trim()) {
      // trim 语义与 completeness 闸门（password?.trim()）对齐。
      throw new Error('Snell URL 缺少 psk');
    }
    const rawVersion = params.get('version') ?? params.get('v') ?? '4';
    const version = parseInt(rawVersion, 10);
    if (version !== 4 && version !== 6) {
      throw new Error(`Snell 版本不受支持（sing-box 仅支持 4/6）: ${rawVersion}`);
    }

    const snell: SnellSettings = { version };
    const obfs = (params.get('obfs') ?? params.get('obfs-mode'))?.toLowerCase();
    if (obfs && obfs !== 'none') {
      if (version === 4 && obfs === 'http') {
        snell.obfsMode = 'http';
        const host = params.get('obfs-host');
        if (host) snell.obfsHost = host;
      } else {
        // v4 tls 混淆（Surge 旧形态）/ v6 带 obfs：sing-box snell 无对应能力。
        throw new Error(`Snell obfs 不受支持: ${obfs}`);
      }
    }
    if (version === 6) {
      const mode = params.get('mode');
      if (mode === 'unshaped' || mode === 'unsafe-raw') snell.mode = mode;
    }
    const reuse = params.get('reuse');
    if (reuse === '1' || reuse === 'true') snell.reuse = true;
    const network = params.get('network');
    if (network === 'tcp' || network === 'udp') snell.network = network;
    const userkey = params.get('userkey');
    if (userkey) snell.userkey = userkey;

    return {
      id: randomUUID(),
      name,
      protocol: 'snell',
      address,
      port,
      password: psk, // psk 复用 password 字段（同 trojan/hysteria2 惯例）
      snellSettings: snell,
    };
  }

  private parseShadowsocks(urlObj: URL): ServerConfig {
    const config: ServerConfig = {
      id: randomUUID(),
      protocol: 'shadowsocks',
      name: decodeURIComponent(urlObj.hash.slice(1)) || 'Shadowsocks',
      address: this.stripIpv6Brackets(urlObj.hostname),
      port: parseInt(urlObj.port, 10),
      shadowsocksSettings: {
        method: '',
        password: '',
      },
    };

    // Shadowsocks URL 支持两种格式:
    // 1. 传统格式: ss://base64(method:password)@server:port#remarks
    // 2. SIP002 格式: ss://method:password@server:port?plugin=xxx#remarks
    const userInfo = urlObj.username;
    const userPassword = urlObj.password;

    if (userInfo) {
      try {
        let method = '';
        let password = '';

        // 首先尝试 Base64 解码（传统格式）
        try {
          const decodedUserInfo = decodeURIComponent(userInfo);
          const decoded = Buffer.from(decodedUserInfo, 'base64').toString('utf-8');

          // 检查解码结果是否是可打印的 ASCII 字符（避免乱码）
          const isPrintable = /^[\x20-\x7E]+$/.test(decoded);

          if (isPrintable && decoded.includes(':')) {
            // Base64 解码成功，使用解码后的结果
            const colonIndex = decoded.indexOf(':');
            method = decoded.substring(0, colonIndex).trim();
            password = decoded.substring(colonIndex + 1).trim();
          } else {
            // Base64 解码失败或结果不合理，尝试明文格式
            throw new Error('Not Base64 or invalid result');
          }
        } catch {
          // Base64 解码失败，尝试 SIP002 明文格式: method:password
          if (userPassword) {
            // URL 格式为 ss://method:password@server:port
            method = decodeURIComponent(userInfo).trim();
            password = decodeURIComponent(userPassword).trim();
          } else if (userInfo.includes(':')) {
            // 有些实现可能把 method:password 都放在 username 里
            const colonIndex = userInfo.indexOf(':');
            method = decodeURIComponent(userInfo.substring(0, colonIndex)).trim();
            password = decodeURIComponent(userInfo.substring(colonIndex + 1)).trim();
          } else {
            throw new Error('无法解析加密方法和密码：既不是 Base64 编码，也不是明文格式');
          }
        }

        // 验证 method 和 password 是否存在
        if (!method) {
          throw new Error('加密方法为空');
        }
        if (!password) {
          throw new Error('密码为空');
        }

        if (config.shadowsocksSettings) {
          config.shadowsocksSettings.method = method;
          config.shadowsocksSettings.password = password;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Shadowsocks URL 格式错误: ${errorMessage}`);
      }
    } else {
      throw new Error('Shadowsocks URL 缺少加密信息');
    }

    // 解析查询参数
    const params = new URLSearchParams(urlObj.search);

    // 插件
    const plugin = params.get('plugin');
    if (plugin && config.shadowsocksSettings) {
      const pluginParts = plugin.split(';');
      const pluginName = pluginParts[0];
      config.shadowsocksSettings.plugin = pluginName;

      if (pluginParts.length > 1) {
        config.shadowsocksSettings.pluginOptions = pluginParts.slice(1).join(';');
      }

      // 提取 Shadow-TLS 插件配置 (基于 Shadow-TLS v3 常用参数)
      if (pluginName.includes('shadow-tls')) {
        const shadowTlsPassword = params.get('shadow-tls-password');
        const shadowTlsSni = params.get('shadow-tls-sni');
        const shadowTlsFingerprint = params.get('shadow-tls-fp'); // 可选

        if (shadowTlsPassword && shadowTlsSni) {
          config.shadowTlsSettings = {
            password: shadowTlsPassword,
            sni: shadowTlsSni,
            fingerprint: shadowTlsFingerprint || 'chrome',
          };
          const tlsPort = params.get('shadow-tls-port');
          if (tlsPort) {
            config.shadowTlsSettings.port = parseInt(tlsPort);
          }
        }
      }
    }

    // 支持直接以 shadow-tls-* 查询参数传递（无需 plugin 字段）
    // 格式: ?shadow-tls-password=xxx&shadow-tls-sni=xxx&shadow-tls-fp=chrome&shadow-tls-port=xxx
    if (!config.shadowTlsSettings) {
      const stPassword = params.get('shadow-tls-password');
      const stSni = params.get('shadow-tls-sni');
      const stFp = params.get('shadow-tls-fp');
      const stPort = params.get('shadow-tls-port');
      if (stPassword && stSni) {
        config.shadowTlsSettings = {
          password: stPassword,
          sni: stSni,
          fingerprint: stFp || 'chrome',
        };
        if (stPort) {
          config.shadowTlsSettings.port = parseInt(stPort);
        }
      }
    }

    // 支持直接以 shadow-tls 查询参数传递 JSON 配置 (Base64 编码)
    const shadowTlsParam = params.get('shadow-tls');
    if (shadowTlsParam) {
      try {
        const decodedParam = Buffer.from(shadowTlsParam, 'base64').toString('utf-8');
        const stlsConfig = JSON.parse(decodedParam);
        if (stlsConfig.password && stlsConfig.host) {
          config.shadowTlsSettings = {
            password: stlsConfig.password,
            sni: stlsConfig.host,
            fingerprint: 'chrome', // 默认值，由于 JSON 中可能没有 fingerprint
          };
          if (stlsConfig.port) {
            config.shadowTlsSettings.port = parseInt(stlsConfig.port);
          }
          if (stlsConfig.version && stlsConfig.version.toString() === '3') {
            // version 3 is expected
          }
        }
      } catch (e) {
        this.log('error', `解析 shadow-tls Base64 JSON 参数失败: ${e}`);
      }
    }

    return config;
  }

  /** 格式: http2://username:password@address:port#name */
  private parseNaive(urlObj: URL): ServerConfig {
    const username = decodeURIComponent(urlObj.username);
    const password = decodeURIComponent(urlObj.password);
    const { address, port, params, name } = this.parseBase(urlObj);

    if (!username || !password) {
      throw new Error('NaiveProxy URL 缺少用户名或密码');
    }

    const config: ServerConfig = {
      id: randomUUID(),
      name,
      protocol: 'naive',
      address,
      port,
      username,
      password,
    };

    // 归一化/白名单收口于 parseTransportSettings（未知类型 throw 整节点拒绝）。
    const network = params.get('type');
    if (network) {
      this.parseTransportSettings(config, params, network);
    }

    config.security = 'tls';
    config.tlsSettings = this.parseTlsSettings(params);
    if (!config.tlsSettings.serverName) {
      config.tlsSettings.serverName = address;
    }

    return config;
  }

  /**
   * 解析 VMess URL (V2RayN 格式: vmess://base64(json))
   */
  private parseVmess(url: string): ServerConfig {
    try {
      const base64Data = url.slice(8); // Remove 'vmess://'
      const jsonStr = Buffer.from(base64Data, 'base64').toString('utf-8');
      const vmessData = JSON.parse(jsonStr);

      const address = vmessData.add;
      const port = parseInt(vmessData.port);
      const uuid = vmessData.id;
      const name = vmessData.ps || `${address}:${port}`;

      if (!address || !port || !uuid) {
        throw new Error('VMess 配置信息不完整');
      }

      const config: ServerConfig = {
        id: randomUUID(),
        name,
        protocol: 'vmess',
        address,
        port,
        uuid,
        alterId: parseInt(vmessData.aid) || 0,
        vmessSecurity: vmessData.scy || 'auto',
      };

      const net = (vmessData.net || 'tcp').toLowerCase();
      if (net === 'ws') {
        config.network = 'ws';
        config.wsSettings = {
          path: vmessData.path || '/',
          headers: vmessData.host ? { Host: vmessData.host } : undefined,
        };
      } else if (net === 'httpupgrade') {
        // v2rayN 生态 net:"httpupgrade" 在野常见；sing-box 支持 vmess+httpupgrade，与 ws 同款 path/host 承载。
        config.network = 'httpupgrade';
        config.wsSettings = {
          path: vmessData.path || '/',
          headers: vmessData.host ? { Host: vmessData.host } : undefined,
        };
      } else if (net === 'h2' || net === 'http') {
        config.network = 'http';
        config.httpSettings = {
          path: vmessData.path || '/',
          host: vmessData.host ? vmessData.host.split(',') : undefined,
        };
      } else if (net === 'grpc') {
        config.network = 'grpc';
        config.grpcSettings = {
          serviceName: vmessData.path || '',
        };
      } else if (net === 'tcp' || net === 'raw' || net === 'none') {
        config.network = 'tcp';
      } else {
        // kcp/quic（V2Ray mKCP·QUIC 传输）/xhttp 等 sing-box 不支持——入库也连不上，
        // 整节点拒绝（与 vless/trojan 统一口径，订阅逐行 catch 聚合告警）。
        throw new Error(`不支持的传输层类型: ${net}`);
      }

      if (vmessData.tls === 'tls') {
        config.security = 'tls';
        config.tlsSettings = {
          serverName: vmessData.sni || vmessData.host || address,
          allowInsecure:
            vmessData.insecure === true ||
            vmessData.insecure === 1 ||
            vmessData.allowInsecure === true,
          fingerprint: vmessData.fp || 'chrome',
        };
        if (vmessData.alpn) {
          // alpn 可能是逗号串或已是数组；两路都过 dedupeTrim 统一口径（保序去重 + 丢弃空白项），
          // 与 TUIC/parseTlsSettings 保持一致，杜绝带前导空格的 ALPN 原样进 sing-box 致协商失败。
          const rawAlpn: string[] = Array.isArray(vmessData.alpn)
            ? vmessData.alpn.map((x: unknown) => String(x))
            : String(vmessData.alpn).split(',');
          config.tlsSettings.alpn = dedupeTrim(rawAlpn);
        }
      } else {
        config.security = 'none';
      }

      return config;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`VMess URL 解析失败: ${error.message}`);
      }
      throw error;
    }
  }

  /** 格式: socks5://username:password@address:port#name */
  private parseSocks(urlObj: URL): ServerConfig {
    const { address, port, name } = this.parseBase(urlObj, 1080);

    const credentials = decodeURIComponent(
      urlObj.username + (urlObj.password ? ':' + urlObj.password : '')
    );
    const username = urlObj.username ? credentials.split(':')[0] : undefined;
    const password = urlObj.password ? credentials.split(':').slice(1).join(':') : undefined;

    const config: ServerConfig = {
      id: randomUUID(),
      name,
      protocol: 'socks',
      address,
      port,
      username,
      password,
      network: 'tcp',
      security: 'none',
    };
    return config;
  }

  /** 格式: http://username:password@address:port#name  或者 https://... */
  private parseHttp(urlObj: URL): ServerConfig {
    const defaultPort = urlObj.protocol.includes('https') ? 443 : 80;
    const { address, port, params, name } = this.parseBase(urlObj, defaultPort);

    const credentials = decodeURIComponent(
      urlObj.username + (urlObj.password ? ':' + urlObj.password : '')
    );
    const username = urlObj.username ? credentials.split(':')[0] : undefined;
    const password = urlObj.password ? credentials.split(':').slice(1).join(':') : undefined;

    const isHttps = urlObj.protocol.includes('https');

    const config: ServerConfig = {
      id: randomUUID(),
      name,
      protocol: 'http',
      address,
      port,
      username,
      password,
      network: 'tcp',
      security: isHttps ? 'tls' : 'none',
    };

    if (isHttps) {
      config.tlsSettings = this.parseTlsSettings(params);
      if (!config.tlsSettings.serverName) {
        config.tlsSettings.serverName = address;
      }
    }

    return config;
  }

  /**
   * 解析传输层配置（vless/trojan/naive 共用）。接收原始 type 参数：小写归一 → 别名映射 → 写 config.network。
   * 已知别名：h2→http（builder 兼容口径，见 generateTransportConfig）、raw/none→tcp（Xray 1.8.24+ 把 tcp
   * 更名 raw，二者在野共存）。httpupgrade 复用 ws 形态的 path/host 承载（与 sing-box JSON 导入、outbound
   * builder 同款，见 SubscriptionService.parseSingboxOutbounds / generateTransportConfig）。
   * 未知值（xhttp/splithttp/kcp/quic 等 Xray 专属传输）sing-box 内核不支持——入库也连不上，整节点 throw
   * 拒绝（订阅逐行 catch 聚合告警；消息保持「不支持的传输层类型」可检索，issue #263）。
   */
  private parseTransportSettings(
    config: ServerConfig,
    params: URLSearchParams,
    rawNetwork: string
  ): void {
    const network = rawNetwork.toLowerCase();
    switch (network) {
      case 'ws':
        config.network = 'ws';
        config.wsSettings = this.parseWebSocketSettings(params);
        break;
      case 'httpupgrade':
        config.network = 'httpupgrade';
        config.wsSettings = this.parseWebSocketSettings(params);
        break;
      case 'grpc':
        config.network = 'grpc';
        config.grpcSettings = this.parseGrpcSettings(params);
        break;
      case 'h2':
      case 'http':
        config.network = 'http';
        config.httpSettings = this.parseHttpSettings(params);
        break;
      case 'tcp':
      case 'raw':
      case 'none':
        config.network = 'tcp'; // TCP 不需要额外配置
        break;
      default:
        throw new Error(`不支持的传输层类型: ${network}`);
    }
  }

  private parseWebSocketSettings(params: URLSearchParams): WebSocketSettings {
    const settings: WebSocketSettings = {};

    const path = params.get('path');
    if (path) {
      settings.path = path;
    }

    const host = params.get('host');
    if (host) {
      settings.headers = { Host: host };
    }

    const maxEarlyData = params.get('maxEarlyData');
    if (maxEarlyData) {
      settings.maxEarlyData = parseInt(maxEarlyData);
    }

    const earlyDataHeaderName = params.get('earlyDataHeaderName');
    if (earlyDataHeaderName) {
      settings.earlyDataHeaderName = earlyDataHeaderName;
    }

    return settings;
  }

  private parseGrpcSettings(params: URLSearchParams): GrpcSettings {
    const settings: GrpcSettings = {};

    const serviceName = params.get('serviceName');
    if (serviceName) {
      settings.serviceName = serviceName;
    }

    const multiMode = params.get('mode');
    if (multiMode === 'multi') {
      settings.multiMode = true;
    }

    return settings;
  }

  private parseHttpSettings(params: URLSearchParams): HttpSettings {
    const settings: HttpSettings = {};

    const host = params.get('host');
    if (host) {
      settings.host = host.split(',');
    }

    const path = params.get('path');
    if (path) {
      settings.path = path;
    }

    const method = params.get('method');
    if (method) {
      settings.method = method;
    }

    return settings;
  }

  private parseTlsSettings(params: URLSearchParams): TlsSettings {
    const settings: TlsSettings = {};

    const sni = params.get('sni') || params.get('host') || params.get('peer');
    if (sni) {
      settings.serverName = sni;
    }

    // 支持多种常见别名
    const allowInsecure =
      params.get('allowInsecure') || params.get('insecure') || params.get('allow_insecure');
    if (allowInsecure !== null) {
      settings.allowInsecure = allowInsecure === '1' || allowInsecure === 'true';
    }

    // dedupeTrim：逗号串拆分后修剪空白 + 保序去重，空值/纯空白产出空数组而非 ['']，
    // 避免带前导空格的 ALPN（如 'h2, http/1.1'）原样进 sing-box tls.alpn 致按字面匹配失败。
    const alpn = params.get('alpn');
    if (alpn) {
      settings.alpn = dedupeTrim(alpn.split(','));
    }

    const fingerprint = params.get('fp') || params.get('fingerprint');
    if (fingerprint) {
      settings.fingerprint = fingerprint;
    }

    return settings;
  }

  private parseRealitySettings(params: URLSearchParams): RealitySettings | undefined {
    const publicKey = params.get('pbk');
    if (!publicKey) {
      return undefined;
    }

    const settings: RealitySettings = {
      publicKey,
    };

    const shortId = params.get('sid');
    if (shortId) {
      settings.shortId = shortId;
    }

    return settings;
  }

  generateUrl(config: ServerConfig): string {
    const protocol = config.protocol?.toLowerCase();

    if (protocol === 'vless') {
      return this.generateVlessUrl(config);
    } else if (protocol === 'trojan') {
      return this.generateTrojanUrl(config);
    } else if (protocol === 'hysteria2') {
      return this.generateHysteria2Url(config);
    } else if (protocol === 'shadowsocks') {
      return this.generateShadowsocksUrl(config);
    } else if (protocol === 'anytls') {
      return this.generateAnyTlsUrl(config);
    } else if (protocol === 'snell') {
      return this.generateSnellUrl(config);
    } else if (protocol === 'tuic') {
      return this.generateTuicUrl(config);
    } else if (protocol === 'naive') {
      return this.generateNaiveUrl(config);
    } else if (protocol === 'vmess') {
      return this.generateVmessUrl(config);
    } else if (protocol === 'socks') {
      return this.generateSocksUrl(config);
    } else if (protocol === 'http') {
      return this.generateHttpUrl(config);
    }
    throw new Error(`不支持的协议: ${config.protocol}`);
  }

  /** 分享名编码：config.name 缺省回落 address:port（与各 parse 的 name 缺省对称）。 */
  private encodeShareName(config: ServerConfig): string {
    return encodeURIComponent(config.name || `${config.address}:${config.port}`);
  }

  /**
   * 生成 Snell URL（与 parseSnell 对称的事实形态）：version 恒写；obfs 仅 v4+http；mode 仅 v6 非 default。
   */
  private generateSnellUrl(config: ServerConfig): string {
    const params = new URLSearchParams();
    const s = config.snellSettings;
    params.set('version', String(s?.version ?? 4));
    if (s?.version === 4 && s.obfsMode === 'http') {
      params.set('obfs', 'http');
      if (s.obfsHost) params.set('obfs-host', s.obfsHost);
    }
    if (s?.version === 6 && s.mode && s.mode !== 'default') {
      params.set('mode', s.mode);
    }
    if (s?.reuse) params.set('reuse', '1');
    if (s?.network) params.set('network', s.network);
    if (s?.userkey) params.set('userkey', s.userkey);
    const psk = encodeURIComponent(config.password || '');
    return this.buildShareUrl('snell', psk, config, params);
  }

  /**
   * 组装标准分享 URL：`scheme://credentials@address:port[?query]#name`（凭据由各 generate 自行算好后传入）。
   * 服务 vless/trojan/hysteria2/anytls/snell/naive/shadowsocks；socks/http 凭据可选（无 @ 前缀）、
   * tuic/vmess 名称或整体形态特殊，不走此助手。
   */
  private buildShareUrl(
    scheme: string,
    credentials: string,
    config: ServerConfig,
    params: URLSearchParams
  ): string {
    const queryString = params.toString();
    const queryPart = queryString ? `?${queryString}` : '';
    return `${scheme}://${credentials}@${config.address}:${config.port}${queryPart}#${this.encodeShareName(
      config
    )}`;
  }

  private generateAnyTlsUrl(config: ServerConfig): string {
    const params = new URLSearchParams();

    this.appendSecurityParams(params, config);

    if (config.anyTlsSettings) {
      if (config.anyTlsSettings.idleSessionCheckInterval) {
        params.set('idle_session_check_interval', config.anyTlsSettings.idleSessionCheckInterval);
      }
      if (config.anyTlsSettings.idleSessionTimeout) {
        params.set('idle_session_timeout', config.anyTlsSettings.idleSessionTimeout);
      }
      if (config.anyTlsSettings.minIdleSession !== undefined) {
        params.set('min_idle_session', String(config.anyTlsSettings.minIdleSession));
      }
    }

    const password = encodeURIComponent(config.password || '');
    return this.buildShareUrl('anytls', password, config, params);
  }

  private generateSocksUrl(config: ServerConfig): string {
    const username = encodeURIComponent(config.username || '');
    const password = encodeURIComponent(config.password || '');
    const credentials = username || password ? `${username}:${password}@` : '';
    return `socks5://${credentials}${config.address}:${config.port}#${this.encodeShareName(config)}`;
  }

  private generateHttpUrl(config: ServerConfig): string {
    const isHttps = config.security === 'tls';
    const protocolPrefix = isHttps ? 'https://' : 'http://';
    const username = encodeURIComponent(config.username || '');
    const password = encodeURIComponent(config.password || '');
    const credentials = username || password ? `${username}:${password}@` : '';
    return `${protocolPrefix}${credentials}${config.address}:${config.port}#${this.encodeShareName(config)}`;
  }

  private generateVlessUrl(config: ServerConfig): string {
    const params = new URLSearchParams();

    if (config.encryption) {
      params.set('encryption', config.encryption);
    }

    if (config.flow) {
      params.set('flow', config.flow);
    }

    this.appendTransportParams(params, config);

    this.appendSecurityParams(params, config);

    return this.buildShareUrl('vless', config.uuid || '', config, params);
  }

  private generateTrojanUrl(config: ServerConfig): string {
    const params = new URLSearchParams();

    this.appendTransportParams(params, config);

    this.appendSecurityParams(params, config);

    const password = encodeURIComponent(config.password || '');
    return this.buildShareUrl('trojan', password, config, params);
  }

  private generateHysteria2Url(config: ServerConfig): string {
    const params = new URLSearchParams();

    if (config.hysteria2Settings) {
      if (config.hysteria2Settings.upMbps) {
        params.set('up_mbps', config.hysteria2Settings.upMbps.toString());
      }
      if (config.hysteria2Settings.downMbps) {
        params.set('down_mbps', config.hysteria2Settings.downMbps.toString());
      }
      if (config.hysteria2Settings.obfs) {
        params.set('obfs', config.hysteria2Settings.obfs.type || 'salamander');
        if (config.hysteria2Settings.obfs.password) {
          params.set('obfs-password', config.hysteria2Settings.obfs.password);
        }
      }
      if (config.hysteria2Settings.network) {
        params.set('network', config.hysteria2Settings.network);
      }
    }

    if (config.tlsSettings) {
      if (config.tlsSettings.serverName) {
        params.set('sni', config.tlsSettings.serverName);
      }
      if (config.tlsSettings.allowInsecure) {
        params.set('insecure', '1');
      }
      if (config.tlsSettings.alpn && config.tlsSettings.alpn.length > 0) {
        params.set('alpn', config.tlsSettings.alpn.join(','));
      }
    }

    const password = encodeURIComponent(config.password || '');
    return this.buildShareUrl('hysteria2', password, config, params);
  }

  private generateTuicUrl(config: ServerConfig): string {
    const params = new URLSearchParams();
    const name = encodeURIComponent(config.name || '');

    const uuid = config.uuid || '';
    const password = config.password || '';

    if (config.tlsSettings) {
      if (config.tlsSettings.serverName) {
        params.set('sni', config.tlsSettings.serverName);
      }
      if (config.tlsSettings.allowInsecure) {
        params.set('allow_insecure', '1');
      }
      if (config.tlsSettings.alpn && config.tlsSettings.alpn.length > 0) {
        params.set('alpn', config.tlsSettings.alpn.join(','));
      }
    }

    if (config.tuicSettings) {
      if (config.tuicSettings.congestionControl) {
        params.set('congestion_control', config.tuicSettings.congestionControl);
      }
      if (config.tuicSettings.udpRelayMode) {
        params.set('udp_relay_mode', config.tuicSettings.udpRelayMode);
      }
      if (config.tuicSettings.heartbeat) {
        params.set('heartbeat', config.tuicSettings.heartbeat);
      }
      // 往返守恒：解析侧 parseTuic 把 zero_rtt_handshake=0 读成显式 false，旧 truthy 检查丢弃 false →
      // 再解析得 undefined（生成-解析往返不守恒）。显式 false 写 =0（对称解析侧 '0'→false）；
      // 未设(undefined)不写。对内核 false 与不写虽等价，但保配置序列化往返一致 + UI 区分「显式关/未设」。
      if (config.tuicSettings.zeroRttHandshake === true) {
        params.set('zero_rtt_handshake', '1');
      } else if (config.tuicSettings.zeroRttHandshake === false) {
        params.set('zero_rtt_handshake', '0');
      }
    }

    const queryStr = params.toString();
    const queryPart = queryStr ? `?${queryStr}` : '';
    const credentials = encodeURIComponent(`${uuid}:${password}`);

    return `tuic://${credentials}@${config.address}:${config.port}${queryPart}#${name}`;
  }

  private generateNaiveUrl(config: ServerConfig): string {
    const username = encodeURIComponent(config.username || '');
    const password = encodeURIComponent(config.password || '');
    // NaiveUrl scheme is http2:// taking username:password@host:port（无 query）
    return this.buildShareUrl('http2', `${username}:${password}`, config, new URLSearchParams());
  }

  /** V2RayN 格式（对称 parseVmess）。 */
  private generateVmessUrl(config: ServerConfig): string {
    const vmessData: any = {
      v: '2',
      ps: config.name,
      add: config.address,
      port: config.port.toString(),
      id: config.uuid,
      aid: (config.alterId || 0).toString(),
      scy: config.vmessSecurity || 'auto',
      net: config.network || 'tcp',
      type: 'none',
      host: '',
      path: '',
      tls: config.security === 'tls' ? 'tls' : '',
    };

    // httpupgrade 与 ws 同款 wsSettings 承载（parse 侧对称，见 parseVmess）——漏此臂会导出丢 path/Host。
    if ((config.network === 'ws' || config.network === 'httpupgrade') && config.wsSettings) {
      vmessData.path = config.wsSettings.path || '/';
      vmessData.host = config.wsSettings.headers?.Host || '';
    } else if (config.network === 'http' && config.httpSettings) {
      vmessData.path = config.httpSettings.path || '/';
      vmessData.host = config.httpSettings.host ? config.httpSettings.host.join(',') : '';
    } else if (config.network === 'grpc' && config.grpcSettings) {
      vmessData.path = config.grpcSettings.serviceName || '';
    }

    if (config.security === 'tls' && config.tlsSettings) {
      vmessData.sni = config.tlsSettings.serverName || '';
      vmessData.fp = config.tlsSettings.fingerprint || '';
      if (config.tlsSettings.alpn && config.tlsSettings.alpn.length > 0) {
        vmessData.alpn = config.tlsSettings.alpn.join(',');
      }
    }

    const jsonStr = JSON.stringify(vmessData);
    const base64Data = Buffer.from(jsonStr).toString('base64');
    return `vmess://${base64Data}`;
  }

  private generateShadowsocksUrl(config: ServerConfig): string {
    if (!config.shadowsocksSettings) {
      throw new Error('Shadowsocks 配置不完整');
    }

    const { method, password, plugin, pluginOptions } = config.shadowsocksSettings;
    const userInfo = `${method}:${password}`;
    // 但很多客户端也支持明文，这里遵循 SIP002 标准使用 Base64
    const userInfoBase64 = Buffer.from(userInfo).toString('base64');

    // 在 URL 中必须安全编码
    // 注意：ss:// 后面通常直接跟 base64，不带 user:pass 这种格式，而是整个 userinfo 部分 base64
    // 格式: ss://BASE64(method:password)@hostname:port

    const params = new URLSearchParams();
    if (plugin) {
      let pluginStr = plugin;
      if (pluginOptions) {
        pluginStr += `;${pluginOptions}`;
      }
      params.set('plugin', pluginStr);
    }

    if (config.shadowTlsSettings) {
      params.set('shadow-tls-password', config.shadowTlsSettings.password);
      params.set('shadow-tls-sni', config.shadowTlsSettings.sni);
      if (config.shadowTlsSettings.fingerprint) {
        params.set('shadow-tls-fp', config.shadowTlsSettings.fingerprint);
      }
      if (config.shadowTlsSettings.port) {
        params.set('shadow-tls-port', config.shadowTlsSettings.port.toString());
      }
    }

    // 使用 ss://base64(method:password)@host:port 格式（base64 userinfo，兼容性优先）
    return this.buildShareUrl('ss', userInfoBase64, config, params);
  }

  private appendTransportParams(params: URLSearchParams, config: ServerConfig): void {
    if (config.network) {
      params.set('type', config.network);
    }

    // WebSocket / HTTPUpgrade 配置（httpupgrade 复用 ws 形态的 path/host 承载，见 parseTransportSettings）
    if ((config.network === 'ws' || config.network === 'httpupgrade') && config.wsSettings) {
      if (config.wsSettings.path) {
        params.set('path', config.wsSettings.path);
      }
      if (config.wsSettings.headers?.Host) {
        params.set('host', config.wsSettings.headers.Host);
      }
      if (config.wsSettings.maxEarlyData) {
        params.set('maxEarlyData', config.wsSettings.maxEarlyData.toString());
      }
      if (config.wsSettings.earlyDataHeaderName) {
        params.set('earlyDataHeaderName', config.wsSettings.earlyDataHeaderName);
      }
    }

    if (config.network === 'grpc' && config.grpcSettings) {
      if (config.grpcSettings.serviceName) {
        params.set('serviceName', config.grpcSettings.serviceName);
      }
      if (config.grpcSettings.multiMode) {
        params.set('mode', 'multi');
      }
    }

    if (config.network === 'http' && config.httpSettings) {
      if (config.httpSettings.host) {
        params.set('host', config.httpSettings.host.join(','));
      }
      if (config.httpSettings.path) {
        params.set('path', config.httpSettings.path);
      }
      if (config.httpSettings.method) {
        params.set('method', config.httpSettings.method);
      }
    }
  }

  private appendSecurityParams(params: URLSearchParams, config: ServerConfig): void {
    if (config.security) {
      params.set('security', config.security);
    }

    if (config.tlsSettings) {
      if (config.tlsSettings.serverName) {
        params.set('sni', config.tlsSettings.serverName);
      }
      if (config.tlsSettings.allowInsecure) {
        params.set('allowInsecure', '1');
      }
      if (config.tlsSettings.alpn && config.tlsSettings.alpn.length > 0) {
        params.set('alpn', config.tlsSettings.alpn.join(','));
      }
      if (config.tlsSettings.fingerprint) {
        params.set('fp', config.tlsSettings.fingerprint);
      }
    }

    if (config.security === 'reality' && config.realitySettings) {
      params.set('pbk', config.realitySettings.publicKey);
      if (config.realitySettings.shortId) {
        params.set('sid', config.realitySettings.shortId);
      }
    }
  }
}
