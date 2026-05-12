/**
 * 代理管理服务
 * 负责 sing-box 进程的生命周期管理和配置生成
 */

import { BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { UserConfig, ServerConfig, ProxyStatus } from '../../shared/types';
import type { ILogManager } from './LogManager';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { resourceManager } from './ResourceManager';
import { retry } from '../utils/retry';
import { getUserDataPath } from '../utils/paths';
import { getAppPreset } from '../../shared/app-rules-preset';

/**
 * 私有 IP 地址段（CIDR 格式）
 * 用于路由规则中的直连配置
 */
const PRIVATE_IP_CIDRS = [
  // IPv4 私有地址
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '224.0.0.0/4',
  '240.0.0.0/4',
  // IPv6 私有地址
  '::1/128', // loopback
  'fc00::/7', // unique local address (ULA)
  'fe80::/10', // link-local
  'ff00::/8', // multicast
];

/**
 * 私有 IP 地址正则表达式
 * 用于日志过滤中识别内网请求
 */
const PRIVATE_IP_PATTERNS = [
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  /\b172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}/,
  /\b192\.168\.\d{1,3}\.\d{1,3}/,
  /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  /\b169\.254\.\d{1,3}\.\d{1,3}/,
];

/**
 * 国内常见网银 U盾插件及本地证券/炒股软件的专属域名
 * 用于绕过代理，防止被 FakeIP 劫持或因协议不兼容（如二进制协议通过 HTTP 代理）被阻断
 */
const DOMESTIC_BANK_AND_STOCK_DOMAINS = [
  // U盾及网银相关（通常指向 127.0.0.1）
  '.microdone.cn', // 微动（杭州银行、中信银行等地方和股份制网银插件常用）
  '.icbc.com.cn', // 工商银行
  '.boc.cn', // 中国银行
  '.ccb.com', // 建设银行
  '.abchina.com',
  '.abchina.com.cn', // 农业银行
  '.bankcomm.com', // 交通银行
  '.cmbchina.com', // 招商银行
  '.psbc.com', // 邮储银行
  '.spdb.com.cn', // 浦发银行
  '.cebbank.com', // 光大银行
  '.citicbank.com', // 中信银行
  '.pingan.com', // 平安银行
  '.cib.com.cn', // 兴业银行
  '.hxb.com.cn', // 华夏银行
  '.cmbc.com.cn', // 民生银行
  '.hzbank.com.cn', // 杭州银行

  // 证券炒股软件相关（经常使用定制化的 TCP 二进制协议通信，在 SOCKS/HTTP 系统代理模式下会导致握手失败并被代理核心主动断开）
  '.10jqka.com.cn',
  '.thsi.cn', // 同花顺
  '.eastmoney.com',
  '.1234567.com.cn', // 东方财富
  '.gw.com.cn', // 大智慧
  '.tdx.com.cn', // 通达信
];

/**
 * sing-box 1.12.x / 1.13.x 配置类型定义
 */

interface SingBoxLogConfig {
  level: string;
  timestamp: boolean;
  output?: string;
}

interface SingBoxDnsServer {
  tag: string;
  type?: string;
  server?: string;
  server_port?: number;
  /** DoH path, e.g. "/dns-query" */
  path?: string;
  /** Bootstrap resolver tag: required when server is a domain name (sing-box 1.12+ new format) */
  domain_resolver?: string;
  detour?: string;
  // Legacy / compat fields (not emitted in new format)
  address?: string;
  address_resolver?: string;
  // FakeIP specific
  inet4_range?: string;
  inet6_range?: string;
}

interface SingBoxDnsRule {
  rule_set?: string;
  query_type?: string[];
  domain?: string[];
  domain_suffix?: string[];
  domain_keyword?: string[];
  server: string;
}

interface SingBoxFakeIPConfig {
  enabled: boolean;
  inet4_range?: string;
  inet6_range?: string;
}

interface SingBoxDnsConfig {
  servers: SingBoxDnsServer[];
  rules?: SingBoxDnsRule[];
  final?: string;
  strategy?: string;
  fakeip?: SingBoxFakeIPConfig;
}

interface SingBoxInbound {
  type: string;
  tag: string;
  listen?: string;
  listen_port?: number;
  // TUN 模式
  interface_name?: string;
  address?: string[];
  mtu?: number;
  auto_route?: boolean;
  strict_route?: boolean;
  stack?: string;
  sniff?: boolean;
  sniff_override_destination?: boolean; // Keep for interface compatibility if needed by types, but won't be used for 1.13+
  route_exclude_address?: string[];
  platform?: {
    http_proxy?: {
      enabled: boolean;
      server: string;
      server_port: number;
    };
  };
}

interface SingBoxOutbound {
  type: string;
  tag: string;
  detour?: string; // 代理链
  server?: string;
  server_port?: number;
  override_address?: string;
  // Shadowsocks
  method?: string;
  password?: string;
  username?: string;
  plugin?: string;
  plugin_opts?: string;
  // VLESS / VMess
  uuid?: string;
  security?: string; // vmess specific
  alter_id?: number; // vmess specific
  flow?: string;
  packet_encoding?: string;
  // Trojan and Hysteria2
  // password?: string; // Shared with SS
  // Hysteria2 specific
  up_mbps?: number;
  down_mbps?: number;
  obfs?: {
    type: string;
    password: string;
  };
  network?: string;
  // TUIC specific
  congestion_control?: string;
  udp_relay_mode?: string;
  zero_rtt_handshake?: boolean;
  heartbeat?: string;
  // ShadowTLS specific
  version?: number;
  // AnyTLS specific
  idle_session_check_interval?: string;
  idle_session_timeout?: string;
  min_idle_session?: number;
  // TLS
  tls?: {
    enabled: boolean;
    server_name?: string;
    insecure?: boolean;
    alpn?: string[];
    utls?: {
      enabled: boolean;
      fingerprint: string;
    };
    reality?: {
      enabled: boolean;
      public_key: string;
      short_id: string;
    };
  };
  // Transport
  transport?: {
    type: string;
    path?: string;
    headers?: Record<string, string | string[]>;
    service_name?: string;
  };
  // DNS resolver for outbound server domain
  domain_resolver?: string;
  // UDP over TCP (UoT)
  udp_over_tcp?: {
    enabled: boolean;
    version: number;
  };
  // Direct outbound: UDP fragmentation (also used to mark outbound as "non-empty" for sing-box 1.13+ validation)
  udp_fragment?: boolean;
}

interface SingBoxRouteRule {
  protocol?: string;
  network?: string[];
  rule_set?: string | string[];
  domain?: string[];
  domain_suffix?: string[];
  domain_keyword?: string[];
  geosite?: string[];
  ip_cidr?: string[];
  port?: number | number[];
  process_name?: string | string[];
  process_name_not?: string | string[]; // sing-box 1.13+
  inbound?: string | string[]; // sing-box 1.13+
  action: string;
  outbound?: string;
  sniffer?: string[];
  rewrite_target?: boolean; // sing-box 1.12+
  timeout?: string;
  domain_resolver?: string; // sing-box 1.13+: 指定该规则使用的 DNS 解析器
  override_address?: string; // sing-box 1.13+: 在规则层强制修改目标地址
}

interface SingBoxRuleSet {
  tag: string;
  type: string;
  format: string;
  path?: string;
  url?: string;
  download_detour?: string;
}

interface SingBoxRouteConfig {
  rule_set?: SingBoxRuleSet[];
  rules: SingBoxRouteRule[];
  default_domain_resolver?: string;
  auto_detect_interface?: boolean;
  final?: string;
}

interface SingBoxExperimental {
  cache_file?: {
    enabled: boolean;
    path: string;
    store_fakeip?: boolean;
    store_rdrc?: boolean;
  };
}

interface SingBoxConfig {
  log: SingBoxLogConfig;
  dns?: SingBoxDnsConfig;
  inbounds: SingBoxInbound[];
  outbounds: SingBoxOutbound[];
  route?: SingBoxRouteConfig;
  experimental?: SingBoxExperimental & {
    clash_api?: {
      external_controller: string;
      external_ui?: string;
      secret?: string;
      external_ui_download_url?: string;
      external_ui_download_detour?: string;
      default_mode?: string;
      cache_file?: string;
    };
  };
}

export interface IProxyManager {
  start(config: UserConfig): Promise<void>;
  stop(): Promise<void>;
  restart(config: UserConfig): Promise<void>;
  getStatus(): ProxyStatus;
  generateSingBoxConfig(config: UserConfig, resolvedIps?: Record<string, string>): SingBoxConfig;
  on(event: 'started' | 'stopped' | 'error', listener: (...args: any[]) => void): void;
  off(event: 'started' | 'stopped' | 'error', listener: (...args: any[]) => void): void;
  getCoreVersion(): Promise<string>;
}

/**
 * 用户「本地开发域名」→ sing-box DNS 规则列表（dns-local，含系统 hosts）。
 * 完整域名（如 me.dev.com）仅生成 domain 规则；*.x / .x 仅生成 domain_suffix。
 * 避免「同一条规则里 domain + domain_suffix」在部分版本下对 apex 主机名匹配异常（*.dev.com 仍可用即 suffix 路径正常）。
 */
function buildLocalDevDnsRules(localDevDomains: string[] | undefined): SingBoxDnsRule[] {
  const tokens = (localDevDomains ?? [])
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0 && !d.startsWith('#'));

  if (tokens.length === 0) {
    return [];
  }

  const exact = new Set<string>();
  const suffix = new Set<string>();

  const addSuffixPair = (base: string) => {
    suffix.add(base);
    suffix.add(`.${base}`);
  };

  for (const t of tokens) {
    if (t.startsWith('*.')) {
      const base = t.slice(2);
      if (base) addSuffixPair(base);
    } else if (t.startsWith('.')) {
      const base = t.slice(1);
      if (base) addSuffixPair(base);
    } else {
      exact.add(t);
    }
  }

  const rules: SingBoxDnsRule[] = [];
  if (exact.size > 0) {
    rules.push({ domain: [...exact], server: 'dns-local' } as SingBoxDnsRule);
  }
  if (suffix.size > 0) {
    rules.push({ domain_suffix: [...suffix], server: 'dns-local' } as SingBoxDnsRule);
  }
  return rules;
}

export class ProxyManager extends EventEmitter implements IProxyManager {
  private singboxProcess: ChildProcess | null = null;
  private startTime: Date | null = null;
  private pid: number | null = null;
  private singboxPid: number | null = null; // macOS TUN 模式下实际的 sing-box PID
  private currentConfig: UserConfig | null = null;
  private configPath: string;
  private singboxPath: string;
  private logManager: ILogManager | null = null;
  private lastLogMessage: string = '';
  private lastLogCount: number = 0;
  private lastLogTime: number = 0;
  private mainWindow: BrowserWindow | null = null;
  private lastErrorOutput: string = '';
  private logFileWatcher: ReturnType<typeof setInterval> | null = null;
  private lastLogFileSize: number = 0;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly HEALTH_CHECK_INTERVAL = 10000; // 10秒检查一次

  // 自动重启相关
  private autoRestartEnabled: boolean = true;
  private restartCount: number = 0;
  private lastRestartTime: number = 0;
  private static readonly MAX_RESTART_COUNT = 3; // 最大重启次数
  private static readonly RESTART_COOLDOWN = 60000; // 重启冷却时间（1分钟内最多重启3次）
  private isRestarting: boolean = false;
  private coreVersion: string = 'unknown';

  constructor(
    logManager?: ILogManager,
    mainWindow?: BrowserWindow,
    configPath?: string,
    singboxPath?: string
  ) {
    super();
    this.logManager = logManager || null;
    this.mainWindow = mainWindow || null;

    // 配置文件路径
    if (configPath) {
      this.configPath = configPath;
    } else {
      const userDataPath = getUserDataPath();
      this.configPath = path.join(userDataPath, 'singbox_config.json');
    }

    // sing-box 可执行文件路径
    if (singboxPath) {
      this.singboxPath = singboxPath;
    } else {
      this.singboxPath = this.getSingBoxPath();
    }
  }

  /**
   * 启动代理
   */
  async start(config: UserConfig): Promise<void> {
    // 如果已经在运行，先停止
    if (this.singboxProcess || this.singboxPid) {
      await this.stop();
    }

    // 用户手动启动时重置重启计数
    if (!this.isRestarting) {
      this.resetRestartCount();
    }

    // 先保存当前配置（needsRootPrivilege 等方法需要用到）
    this.currentConfig = config;

    // 仅在 TUN 模式下清理可能残留的 sing-box 进程
    // 系统代理模式不需要管理员权限，也不会有残留的 TUN 进程问题
    const isTunMode = config.proxyModeType === 'tun';
    if (isTunMode) {
      await this.killOrphanedSingBoxProcesses();
    }

    // 0. 获取核心版本（用于后续生成兼容的配置文件）
    this.coreVersion = await this.getCoreVersion();
    this.logToManager('info', `检测到 sing-box 核心版本: ${this.coreVersion}`);

    // 修复可能被 root 创建的文件权限（从 TUN 模式切换到系统代理模式时）
    await this.fixFilePermissions();

    // 检查是否选择了服务器
    if (!config.selectedServerId) {
      throw new Error('No server selected');
    }

    // 查找选中的服务器
    const selectedServer = config.servers.find((s) => s.id === config.selectedServerId);
    if (!selectedServer) {
      throw new Error('Selected server not found');
    }

    // 3. 准备规则文件（必须在生成配置前完成）
    await this.copyRuleSetsToUserData();

    // 3.5. 预解析所有节点的域名为 IP（仅针对 TUN 模式），防止 Windows 下回流死循环
    const resolvedServerIps: Record<string, string> = {};
    if (isTunMode && process.platform === 'win32') {
      this.logToManager('info', '正在预解析节点域名以防止 TUN 回流...');
      const dns = require('dns').promises;
      const allServerIds = new Set([
        config.selectedServerId as string,
        ...(config.appRules || []).map((r) => r.targetServerId),
      ]);

      const resolvePromises = Array.from(allServerIds).map(async (serverId) => {
        if (!serverId) return;
        const server = config.servers.find((s) => s.id === serverId);
        if (
          server?.address &&
          !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(server.address) &&
          !server.address.includes(':')
        ) {
          try {
            const { address } = await dns.lookup(server.address);
            if (address) {
              resolvedServerIps[serverId] = address;
            }
          } catch {
            /* ignore */
          }
        }
      });
      await Promise.all(resolvePromises);
    }

    // 4. 生成 sing-box 配置文件
    const singboxConfig = this.generateSingBoxConfig(config, resolvedServerIps);

    // 写入配置文件
    await this.writeSingBoxConfig(singboxConfig);
    this.logToManager('info', 'sing-box 配置文件已生成');

    // TUN 模式下，删除旧的 PID 文件，确保不会读到旧的 PID
    if (this.needsOsascript() || this.needsWindowsUAC()) {
      await this.deletePidFile();
    }

    // 5. 启动 sing-box 进程
    await retry(() => this.startSingBoxProcess(), {
      maxRetries: 2,
      delay: 2000,
      exponentialBackoff: true,
      shouldRetry: (error) => {
        // 只对特定错误进行重试
        const message = error.message.toLowerCase();

        // 不重试的错误类型
        const nonRetryableErrors = [
          '找不到',
          '权限',
          'permission',
          'enoent',
          'eacces',
          'eperm',
          '配置文件格式错误',
          'invalid config',
        ];

        // 如果是不可重试的错误，直接失败
        if (nonRetryableErrors.some((pattern) => message.includes(pattern))) {
          return false;
        }

        // 其他错误可以重试
        return true;
      },
      onRetry: (error, attempt) => {
        this.logToManager('warn', `启动失败，正在进行第 ${attempt} 次重试: ${error.message}`);
      },
    });

    // 如果是系统代理模式，设置系统代理
    if (config.proxyModeType === 'systemProxy') {
      await this.setSystemProxy(config);
    }
  }

  /**
   * 停止代理
   */
  async stop(): Promise<void> {
    // macOS TUN 模式：即使 singboxProcess 为 null，也可能有后台进程在运行
    if (!this.singboxProcess && !this.singboxPid) {
      return;
    }

    // 如果当前是系统代理模式，取消系统代理
    if (this.currentConfig && this.currentConfig.proxyModeType === 'systemProxy') {
      await this.unsetSystemProxy();
    }

    await this.stopSingBoxProcess();
  }

  /**
   * 重启代理
   */
  async restart(config: UserConfig): Promise<void> {
    await this.stop();
    await this.start(config);
  }

  /**
   * 切换代理模式
   * 检测模式变化，如果代理正在运行则重启
   */
  async switchMode(newConfig: UserConfig): Promise<void> {
    // 检查是否有模式变化
    const modeChanged = this.hasModeChanged(newConfig);

    if (!modeChanged) {
      // 模式没有变化，只更新配置
      this.currentConfig = newConfig;
      return;
    }

    // 如果代理正在运行，需要重启
    if (this.singboxProcess) {
      this.logToManager('info', '代理模式已更改，正在重启代理...');
      await this.restart(newConfig);
    } else {
      // 代理未运行，只更新配置
      this.currentConfig = newConfig;
    }
  }

  /**
   * 检查模式是否变化
   */
  private hasModeChanged(newConfig: UserConfig): boolean {
    if (!this.currentConfig) {
      return true;
    }

    // 检查代理模式
    if (this.currentConfig.proxyMode !== newConfig.proxyMode) {
      return true;
    }

    // 检查代理模式类型
    if (this.currentConfig.proxyModeType !== newConfig.proxyModeType) {
      return true;
    }

    // 检查选中的服务器
    if (this.currentConfig.selectedServerId !== newConfig.selectedServerId) {
      return true;
    }

    // 检查端口
    if (
      this.currentConfig.socksPort !== newConfig.socksPort ||
      this.currentConfig.httpPort !== newConfig.httpPort
    ) {
      return true;
    }

    // 检查 TUN 配置（如果是 TUN 模式）
    if (newConfig.proxyModeType === 'tun') {
      const oldTun = this.currentConfig.tunConfig;
      const newTun = newConfig.tunConfig;

      if (
        oldTun.mtu !== newTun.mtu ||
        oldTun.stack !== newTun.stack ||
        oldTun.autoRoute !== newTun.autoRoute ||
        oldTun.strictRoute !== newTun.strictRoute
      ) {
        return true;
      }
    }

    // 检查自定义规则
    if (JSON.stringify(this.currentConfig.customRules) !== JSON.stringify(newConfig.customRules)) {
      return true;
    }

    return false;
  }

  /**
   * 获取代理状态
   */
  getStatus(): ProxyStatus {
    // TUN 模式下只检查 singboxPid（sing-box 的实际 PID）
    // 系统代理模式下检查 pid（直接启动的进程 PID）
    // 注意：TUN 模式下 this.pid 是 osascript/PowerShell 的 PID，不是 sing-box 的
    const isTunMode = this.currentConfig?.proxyModeType === 'tun';
    const activePid = isTunMode ? this.singboxPid : this.singboxPid || this.pid;

    // 验证进程是否真正存活
    const isRunning = activePid !== null && this.isProcessAlive(activePid);

    if (!isRunning || !activePid) {
      return {
        running: false,
      };
    }

    // 计算运行时间
    let uptime: number | undefined;
    if (this.startTime) {
      uptime = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
    }

    return {
      running: true,
      pid: activePid,
      startTime: this.startTime || undefined,
      uptime,
      currentServer: this.currentConfig?.servers.find(
        (s) => s.id === this.currentConfig?.selectedServerId
      ),
    };
  }

  /**
   * 获取核心版本
   */
  async getCoreVersion(): Promise<string> {
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      const { stdout } = await execAsync(`"${this.singboxPath}" version`);
      // 输出示例: sing-box version 1.13.0 ... 或 v1.13.0 ...
      const match = stdout.match(/(?:version\s+|v)(\d+\.\d+(\.\d+)?)/i);
      if (match) {
        return match[1];
      }

      // 备选方案：尝试直接取第一组连续的数字版本号
      const secondMatch = stdout.match(/(\d+\.\d+\.\d+)/);
      return secondMatch ? secondMatch[1] : '1.13.0';
    } catch (error) {
      this.logToManager('error', `获取核心版本失败: ${(error as any).message}`);
      return '1.13.0';
    }
  }

  /**
   * 生成 sing-box 配置（sing-box 1.12.x / 1.13.x 兼容格式）
   */
  generateSingBoxConfig(config: UserConfig, resolvedIps?: Record<string, string>): SingBoxConfig {
    const selectedServer = config.servers.find((s) => s.id === config.selectedServerId);
    if (!selectedServer) {
      throw new Error('Selected server not found');
    }

    // 调试日志
    console.log('[ProxyManager] Generating config with:', {
      proxyMode: config.proxyMode,
      proxyModeType: config.proxyModeType,
      selectedServerId: config.selectedServerId,
      serverProtocol: selectedServer.protocol,
    });

    // 获取用户数据目录用于缓存文件
    const userDataPath = getUserDataPath();
    const cachePath = path.join(userDataPath, 'cache.db');

    // 关键优化：预先生成 ID 到 Tag 的唯一映射，使用服务器名称作为 Tag，确保拓扑和日志显示友好名称
    // 这样做之后内容拓扑（Clash API）和日志中显示的将是“香港 01”而不是“proxy-uuid”
    const idToTagMap = new Map<string, string>();
    const usedTags = new Set<string>();

    const getUniqueTag = (server: ServerConfig) => {
      let baseTag = server.name.trim() || '未命名节点';
      let tag = baseTag;
      let count = 1;
      while (usedTags.has(tag)) {
        tag = `${baseTag} (${count})`;
        count++;
      }
      usedTags.add(tag);
      return tag;
    };

    // 为所有服务器预生成 Tag
    for (const s of config.servers) {
      idToTagMap.set(s.id, getUniqueTag(s));
    }

    const singboxConfig: SingBoxConfig = {
      log: this.generateLogConfig(config),
      dns: this.generateDnsConfig(
        config,
        idToTagMap.get(config.selectedServerId as string) || 'proxy'
      ),
      inbounds: this.generateInbounds(config, resolvedIps),
      outbounds: this.generateOutbounds(selectedServer, config, idToTagMap),
      route: this.generateRouteConfig(config, idToTagMap),
      experimental: {
        cache_file: {
          enabled: true,
          path: cachePath,
          store_fakeip: true,
          store_rdrc: true,
        },
        clash_api: {
          external_controller: '127.0.0.1:9090',
          external_ui: path.join(userDataPath, 'ui'),
          secret: '', // 为空以保持与现有渲染进程 fetch 逻辑兼容
          default_mode: 'rule',
        },
      },
    };

    // 调试日志
    console.log('[ProxyManager] Generated inbounds count:', singboxConfig.inbounds.length);
    console.log('[ProxyManager] Generated outbounds count:', singboxConfig.outbounds.length);
    console.log('[ProxyManager] Route rule_set count:', singboxConfig.route?.rule_set?.length || 0);

    return singboxConfig;
  }

  /**
   * 生成日志配置
   */
  private generateLogConfig(config: UserConfig): SingBoxLogConfig {
    // 默认使用 debug 级别以显示路由决策（哪些请求走代理/直连）
    // 应用层会过滤掉不重要的日志，只保留有价值的信息
    const logConfig: SingBoxLogConfig = {
      level: config.logLevel || 'debug',
      timestamp: true,
    };

    // 在 TUN 模式下（macOS 和 Windows），使用权限提升运行时无法捕获 stdout
    // 需要将日志输出到文件，然后通过文件监控读取
    // 注意：这里直接根据 config 参数判断，而不是 this.currentConfig
    const isTunMode = config.proxyModeType?.toLowerCase() !== 'systemproxy';
    const isMacTunMode = process.platform === 'darwin' && isTunMode;
    const isWindowsTunMode = process.platform === 'win32' && isTunMode;

    if (isMacTunMode || isWindowsTunMode) {
      logConfig.output = this.getLogFilePath();
    }

    return logConfig;
  }

  /**
   * 获取 sing-box 日志文件路径
   */
  private getLogFilePath(): string {
    const userDataPath = getUserDataPath();
    return path.join(userDataPath, 'singbox.log');
  }

  /**
   * 清空 sing-box 日志文件
   * 在 Windows 和 macOS 上都能工作
   */
  async clearSingBoxLogFile(): Promise<void> {
    const logFilePath = this.getLogFilePath();
    try {
      // 清空日志文件（截断为空）
      await fs.writeFile(logFilePath, '', 'utf-8');
      this.logToManager('info', 'sing-box 日志文件已清空');
    } catch (error: any) {
      // 文件不存在，忽略
      if (error.code !== 'ENOENT') {
        this.logToManager('error', `清空 sing-box 日志文件失败: ${error.message}`);
      }
    }
  }

  private generateDnsConfig(config: UserConfig, selectedServerTag: string): SingBoxDnsConfig {
    const proxyMode = (config.proxyMode || 'smart').toLowerCase();

    // 获取用户 DNS 配置，不存在则使用默认值
    const userDnsConfig = config.dnsConfig || {
      domesticDns: 'https://doh.pub/dns-query',
      foreignDns: 'https://dns.google/dns-query',
      enableFakeIp: false,
    };

    // 决定是否开启 FakeIP。
    // 在 TUN 模式下强制开启 FakeIP。
    // 原因：很多第三方机场的节点防滥用严格，如果收到纯 IP 地址而非域名，会直接拒绝连接并抛出无效证书或拦截页面。
    // 配合我们刚刚修复的 macOS gvisor strict_route DHCP DNS 劫持逻辑，
    // FakeIP 现在能够 100% 完美的用内部 cache 把假 IP 还原成真域名丢给代理节点。
    // 从而完美避开机场对纯 IP 请求的无情封杀！
    const enableFakeIp =
      config.proxyModeType?.toLowerCase() !== 'systemproxy' ? true : userDnsConfig.enableFakeIp;

    // sing-box 1.13+ 新格式：每个 server 必须有显式 type 字段
    //
    // 关键架构说明：
    // - 在 TUN 下，Windows 的系统 DNS (svchost) 发出的解析请求会被 TUN 劫持。如果该系统 DNS 配置为公共 IP，
    //   此时 type: 'local' (调用系统 getaddrinfo) 就会进入死循环。
    // - 为了彻底解决这个问题，同时避免 UDP 53 屏蔽（之前使用 223.5.5.5 UDP 的缺陷），
    //   我们引入一个坚不可摧的 DoH IP Bootstrap：向 223.5.5.5(HTTP) 直接发包，并且 detour: 'direct' 强制绕过 TUN。
    const dnsServers: SingBoxDnsServer[] = [
      {
        // 引导解析：专门用于解析代理节点的 IP 解析器（UDP，最稳健）
        tag: 'dns-bootstrap-udp',
        type: 'udp',
        server: '223.5.5.5',
        server_port: 53,
      },
      {
        // 引导解析（DoH）：作为 UDP 的备份
        tag: 'dns-bootstrap',
        type: 'https',
        server: '223.5.5.5',
        server_port: 443,
        path: '/dns-query',
        domain_resolver: 'dns-bootstrap-udp',
      },
      {
        // 兼容性和兜底的系统 DNS
        tag: 'dns-local',
        type: 'local',
      },
      {
        // 国内直连 DNS (推荐 DoH)
        tag: 'dns-domestic',
        type: 'https',
        server: 'doh.pub',
        server_port: 443,
        path: '/dns-query',
        domain_resolver: 'dns-bootstrap-udp',
      },
      {
        // 远程代理 DNS (推荐 DoH)
        tag: 'dns-remote',
        type: 'https',
        server: 'dns.google',
        server_port: 443,
        path: '/dns-query',
        domain_resolver: 'dns-bootstrap-udp',
        // 关键核心：远程解析必须走代理，否则在境内直接发起会因 GFW 拦截/污染导致 FakeIP 映射失败或由于 TTL 极短产生大量无效解析。
        detour: selectedServerTag,
      },
    ];

    if (enableFakeIp) {
      dnsServers.push({
        // FakeIP 服务器：返回虚假 IP，由 sniff 识别真实域名
        tag: 'fakeip',
        type: 'fakeip',
        inet4_range: '198.18.0.0/15',
        inet6_range: 'fc00::/18',
      });
    }

    const dnsConfig: SingBoxDnsConfig = {
      servers: dnsServers,
      rules: [],
      // 默认使用国内 DNS 解析
      final: 'dns-domestic',
      // macOS 使用 RealIP 模式（嗅探），Windows 依然使用高效的 FakeIP
      strategy: process.platform === 'darwin' || config.enableIPv6 ? 'prefer_ipv4' : 'ipv4_only',
    };
    const dnsRules: SingBoxDnsRule[] = [];

    // 代理服务器域名必须使用真实 DNS 解析（避免 FakeIP 劫持产生死循环）
    const selectedServer = config.servers.find((s) => s.id === config.selectedServerId);
    if (selectedServer?.address) {
      const proxyDomains = [selectedServer.address];
      if (selectedServer.tlsSettings?.serverName) {
        proxyDomains.push(selectedServer.tlsSettings.serverName);
      }
      const uniqueDomains = Array.from(new Set(proxyDomains));

      dnsRules.push({
        domain: uniqueDomains,
        domain_suffix: uniqueDomains.flatMap((d) => [d, `.${d}`]),
        domain_keyword: uniqueDomains,
        server: 'dns-domestic', // 强制使用 DoH 解析节点域名，防止 UDP 53 被运营商劫持/丢包导致 TTL 过期后断网
      } as SingBoxDnsRule);
    }

    // 处理基础 DNS 服务的地址解析，确保它们走引导解析器
    dnsRules.push({
      domain: ['doh.pub', 'dns.google', 'cloudflare-dns.com', 'one.one.one.one'],
      server: 'dns-bootstrap-udp',
    } as SingBoxDnsRule);

    // 解决 mDNS 和本地反向解析导致的 context deadline exceeded 超时问题
    // 拦截 .arpa 等反向解析请求交由本地系统 DNS 快速返回，防止泄漏到公网 DNS 而引起解析超时
    // 拦截国内常见网银 U盾 驱动的本地环回解析，防止 FakeIP 拦截产生 NXDOMAIN
    dnsRules.push({
      domain_suffix: ['.local', '.arpa', '.lan', '.home.arpa', ...DOMESTIC_BANK_AND_STOCK_DOMAINS],
      server: 'dns-local',
    } as SingBoxDnsRule);

    // 处理本地开发域名
    const localDevRules = buildLocalDevDnsRules(userDnsConfig.localDevDomains);
    for (const r of localDevRules) {
      dnsRules.push(r);
    }

    // 处理自定义规则中的 bypassFakeIP
    if (config.customRules && enableFakeIp) {
      const bypassDomains: string[] = [];
      for (const rule of config.customRules) {
        if (rule.enabled && rule.bypassFakeIP && rule.domains.length > 0) {
          for (const d of rule.domains) {
            if (!d.startsWith('geosite:')) {
              bypassDomains.push(d.startsWith('*.') ? d.slice(2) : d);
            }
          }
        }
      }

      if (bypassDomains.length > 0) {
        dnsRules.push({
          domain: bypassDomains,
          domain_suffix: bypassDomains.flatMap((d) => [d, `.${d}`]),
          server: 'dns-bootstrap', // 使用真实 DNS 绕过 FakeIP
        } as SingBoxDnsRule);
      }
    }

    // 智能分流/全局代理模式下的 DNS 规则
    if (proxyMode === 'smart' || proxyMode === 'global') {
      if (enableFakeIp) {
        // [原版 Fork 核心精髓：Clash-style 全局 FakeIP]
        // 让所有的 A/AAAA（IPv4/IPv6）解析无脑走 FakeIP 返回 198.18 的伪装 IP。
        // 等浏览器连过来以后，Sing-box 靠伪装 IP 查缓存恢复域名，然后交给下面的 Route 引擎。
        // Route 引擎看到域名，如果命中 geosite-cn，就走 direct 出口，走 direct 时再真正发起本地 DNS 查询拿到淘宝的真实 IP。
        // 如果查不到 cn 规则，自然落入 proxy，连同域名一起完好无损发给代理节点！极其稳如泰山！
        dnsRules.push({
          query_type: ['A', 'AAAA'],
          server: 'fakeip',
        } as SingBoxDnsRule);
      } else {
        // 如果实在没开 FakeIP（比如系统代理模式），那就用 geosite 规则让它各自拿正确的 IP 吧（但也容易被墙污染）
        if (proxyMode === 'smart') {
          dnsRules.push({
            rule_set: 'geosite-cn',
            server: 'dns-domestic',
          } as SingBoxDnsRule);

          // 此处移除了 rule_set: 'geosite-geolocation-!cn'，因为 1.12 的 singbox 在
          // dns block 里跑规则集会导致某些内置不支持的匹配失效或报错，一律 fallthrough 给 dns-remote
          dnsRules.push({
            server: 'dns-remote',
          } as SingBoxDnsRule);
        } else {
          dnsRules.push({
            query_type: ['A', 'AAAA'],
            server: 'dns-remote',
          } as SingBoxDnsRule);
        }
      }
    }

    dnsConfig.rules = dnsRules;
    return dnsConfig;
  }

  /**
   * 生成 AppRule 路由规则
   */

  /**
   * 生成 Inbound 配置（sing-box 1.12.x / 1.13.x 兼容格式）
   */
  private generateInbounds(
    config: UserConfig,
    resolvedIps?: Record<string, string>
  ): SingBoxInbound[] {
    const inbounds: SingBoxInbound[] = [];

    // 使用小写比较，兼容 SystemProxy/systemProxy 和 Tun/tun
    const modeType = (config.proxyModeType || 'systemProxy').toLowerCase();

    const listenAddr = config.allowLan ? '::' : '127.0.0.1';

    // 无论哪种模式，都添加 HTTP + SOCKS inbound
    // 这样用户在终端配置的代理环境变量在切换模式后仍然可用
    //
    // 关键修复：必须启用流量嗅探（sniff），否则 sing-box 无法从 TLS ClientHello 中
    // 提取域名（SNI），导致路由引擎只看到 IP 地址，无法匹配 geosite 规则正确分流。
    // 症状：Instagram 消息中心无网络、WhatsApp 二维码无法扫码等 WebSocket 类应用异常。
    // NekoBox 等 sing-box 客户端默认开启 sniff，FlowZ 之前遗漏了。
    //
    // 版本兼容：
    //   1.12.x → sniff/sniff_override_destination 是 inbound 级别字段
    //   1.13.x → 这些字段已移除，改由路由层 action: 'sniff' + override_destination: true 实现
    const inboundVer = this.coreVersion.match(/^(\d+\.\d+)/);
    const inboundVerNum = inboundVer ? parseFloat(inboundVer[1]) : 1.13;
    const useLegacySniff = !isNaN(inboundVerNum) && inboundVerNum < 1.13;

    const httpInbound: SingBoxInbound = {
      type: 'http',
      tag: 'http-in',
      listen: listenAddr,
      listen_port: config.httpPort || 2080,
    };
    const socksInbound: SingBoxInbound = {
      type: 'socks',
      tag: 'socks-in',
      listen: listenAddr,
      listen_port: config.socksPort || 2081,
    };

    if (useLegacySniff) {
      httpInbound.sniff = true;
      httpInbound.sniff_override_destination = true;
      socksInbound.sniff = true;
      socksInbound.sniff_override_destination = true;
    }

    inbounds.push(httpInbound, socksInbound);

    // Mixed 端口（可选）：同时接受 HTTP 和 SOCKS5 请求
    if (config.mixedPort && config.mixedPort > 0) {
      const mixedInbound: SingBoxInbound = {
        type: 'mixed',
        tag: 'mixed-in',
        listen: listenAddr,
        listen_port: config.mixedPort,
      };
      if (useLegacySniff) {
        mixedInbound.sniff = true;
        mixedInbound.sniff_override_destination = true;
      }
      inbounds.push(mixedInbound);
    }

    // TUN 模式额外添加 TUN inbound
    if (modeType === 'tun') {
      const isIpv4 = (host: string) => /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host);
      const isIpv6 = (host: string) => /^[0-9a-fA-F:]+$/.test(host) && host.includes(':');

      const shouldBypassLAN = config.bypassLAN !== false; // 默认为 true
      // 恢复 3.3.18 能完美工作的排除列表。
      // 注意：macOS 下绝对不能在底层排除物理局域网段，否则 macOS NetworkExtension 的路由逆向拦截机制会导致从 TUN (172.19.0.1) 发回 192.168.x.x 的 TCP 回执包被当作非法源 IP 丢弃，导致网页无限 HANG。
      // 但是在 Windows 下，Wintun 如果不排除局域网物理网关，发往本地路由器的 DHCP/网关查询会被死循环拦截，导致全局断网。
      const excludeAddr =
        process.platform === 'win32' && shouldBypassLAN
          ? [...PRIVATE_IP_CIDRS]
          : ['127.0.0.0/8', '::1/128'];

      // Windows 下额外排除核心 DNS IP，防止 WFP 进程匹配失效时产生回流死循环
      if (process.platform === 'win32') {
        excludeAddr.push(
          '223.5.5.5/32',
          '223.6.6.6/32',
          '119.29.29.29/32',
          '119.28.28.28/32',
          '114.114.114.114/32',
          '8.8.8.8/32',
          '1.1.1.1/32'
        );
      }

      // 绝杀级修复（多服务器版本）：如果在 应用分流 (App Policy) 中选择了其他节点，那么这些节点的 IP 也必须被排除。
      // 否则，FlowZ 去连接这些次选节点的流量也会回流进入 TUN 产生死循环。
      const allServerIds = new Set([
        config.selectedServerId as string,
        ...(config.appRules || []).map((r) => r.targetServerId),
      ]);

      // 去除会导致 macOS 崩溃的 shouldBypassLAN 全局排除逻辑，回到 3.3.18 时代的精简状态
      for (const serverId of allServerIds) {
        if (!serverId) continue;
        const server = config.servers.find((s) => s.id === serverId);
        if (server?.address) {
          if (isIpv4(server.address)) {
            excludeAddr.push(`${server.address}/32`);
          } else if (isIpv6(server.address)) {
            excludeAddr.push(`${server.address}/128`);
          } else if (resolvedIps && resolvedIps[serverId]) {
            // 使用预解析的 IP
            const addr = resolvedIps[serverId];
            excludeAddr.push(isIpv6(addr) ? `${addr}/128` : `${addr}/32`);
          }
        }
      }

      // 恢复至对应平台最稳定的网段。Windows 在 v3.4.0 使用 /16 时非常完美；Mac 在 v3.3.18 使用 /30 时最完美。
      const tunAddress = [
        config.tunConfig?.inet4Address ||
          (process.platform === 'darwin' ? '172.19.0.1/30' : '172.19.0.1/16'),
      ];
      // macOS 默认分配 IPv6 以提高与本地网络服务的兼容性，与 3.3.18 保持一致
      if (config.enableIPv6 && process.platform !== 'darwin') {
        tunAddress.push(config.tunConfig?.inet6Address || 'fdfe:dcba:9876::1/126');
      } else if (config.enableIPv6 && process.platform === 'darwin') {
        tunAddress.push(config.tunConfig?.inet6Address || 'fdfe:dcba:9876::1/126');
      }

      const tunInbound: SingBoxInbound = {
        type: 'tun',
        tag: 'tun-in',
        address: tunAddress,
        // macOS (3.3.18) 最稳定 MTU 为 1400。Windows (3.4.0) 下 MTU=1350 最完美。
        mtu: config.tunConfig?.mtu || (process.platform === 'darwin' ? 1400 : 1350),
        auto_route: config.tunConfig?.autoRoute ?? true,
        strict_route: config.tunConfig?.strictRoute ?? true,
        // macOS 必须使用 gvisor 栈(3.3.18)。Windows 下 system 栈配合 Wintun 性能最强且稳定(3.4.0)。
        stack: config.tunConfig?.stack || (process.platform === 'darwin' ? 'gvisor' : 'system'),
        route_exclude_address: excludeAddr,
      };

      // 兼容 sing-box 1.12.x 版本 (即 Windows 上的 1.12.13)，必须在 inbound 定义 sniff 否则无法域名分流。
      // 对于 1.13.0+，嗅探逻辑已经统一由后方 route.rules 承担，但在入站开启会报错，因此需精准版本判断。
      const inboundVersionMatch = this.coreVersion.match(/^(\d+\.\d+)/);
      const inboundVersionNum = inboundVersionMatch ? parseFloat(inboundVersionMatch[1]) : 1.13;
      if (!isNaN(inboundVersionNum) && inboundVersionNum < 1.13) {
        (tunInbound as any).sniff = true;
      }

      // macOS 平台特定配置
      if (process.platform === 'darwin') {
        tunInbound.platform = {
          http_proxy: {
            enabled: true,
            server: '127.0.0.1',
            server_port: config.httpPort || 2080,
          },
        };
      }

      inbounds.push(tunInbound);
    }

    return inbounds;
  }

  /**
   * 递归获取代理链中的所有前置节点
   */
  private getDetourChain(server: ServerConfig, allServers: ServerConfig[]): ServerConfig[] {
    const chain: ServerConfig[] = [];
    const visitedIds = new Set<string>();
    visitedIds.add(server.id);

    let currentServer = server;
    while (currentServer.detour) {
      if (visitedIds.has(currentServer.detour)) {
        console.warn(
          `[ProxyManager] Detected proxy chain loop: ${currentServer.name} -> ${currentServer.detour}`
        );
        break;
      }

      const detourServer = allServers.find((s) => s.id === currentServer.detour);
      if (!detourServer) {
        console.warn(`[ProxyManager] Detour server not found: ${currentServer.detour}`);
        break;
      }

      chain.push(detourServer);
      visitedIds.add(detourServer.id);
      currentServer = detourServer;
    }

    return chain;
  }

  private generateOutbounds(
    selectedServer: ServerConfig,
    config: UserConfig,
    idToTagMap: Map<string, string>
  ): SingBoxOutbound[] {
    const outbounds: SingBoxOutbound[] = [];

    if (config) {
      // 1. 生成主选节点的 Outbound 及其前置节点
      const mainChain = this.getDetourChain(selectedServer, config.servers);

      // 添加前置节点
      for (const detourServer of mainChain.reverse()) {
        const detourOutbound = this.generateProxyOutbound(detourServer, idToTagMap);
        detourOutbound.tag = idToTagMap.get(detourServer.id) || `proxy-${detourServer.id}`;
        // 避免重复添加
        if (!outbounds.some((o) => o.tag === detourOutbound.tag)) {
          outbounds.push(detourOutbound);
        }
      }

      // 添加主节点
      const mainOutbound = this.generateProxyOutbound(selectedServer, idToTagMap);
      // 主节点默认使用 'proxy' tag，为了兼容老的路由规则
      // 但对于拓扑显示，我们希望看到名称，所以这里我们保留一个名为 'proxy' 的 outbound
      // 并在最后将其 tag 设为服务器名称（或者通过 detour 链处理）
      // 这里的策略是：主选节点 tag 设为人类可读名称，并同步给路由规则使用。
      const selectedServerTag = idToTagMap.get(selectedServer.id) || 'proxy';
      mainOutbound.tag = selectedServerTag;

      if (selectedServer.detour && config.servers.some((s) => s.id === selectedServer.detour)) {
        mainOutbound.detour = idToTagMap.get(selectedServer.detour);
      }
      outbounds.push(mainOutbound);

      // 2. 生成自定义规则中指定的目标节点的 Outbound
      // 遍历所有启用且指定了 targetServerId 的规则（包括 customRules 和 appRules）
      const targetServerIds = new Set<string>();
      if (config.customRules) {
        for (const rule of config.customRules) {
          if (rule.enabled && rule.action === 'proxy' && rule.targetServerId) {
            targetServerIds.add(rule.targetServerId);
          }
        }
      }
      if (config.appRules) {
        for (const rule of config.appRules) {
          if (rule.enabled && rule.action === 'proxy' && rule.targetServerId) {
            targetServerIds.add(rule.targetServerId);
          }
        }
      }

      for (const targetId of Array.from(targetServerIds)) {
        // 如果目标节点就是主节点，不需要额外添加（主节点已有 'proxy' tag）
        if (targetId === selectedServer.id) continue;

        // 查找目标服务器配置
        const targetServer = config.servers.find((s) => s.id === targetId);
        if (!targetServer) continue;

        // 获取目标节点的前置链
        const targetChain = this.getDetourChain(targetServer, config.servers);

        // 添加目标节点的前置节点
        for (const detourServer of targetChain.reverse()) {
          const detourOutbound = this.generateProxyOutbound(detourServer, idToTagMap);
          detourOutbound.tag = idToTagMap.get(detourServer.id) || `proxy-${detourServer.id}`;
          // 避免重复添加
          if (!outbounds.some((o) => o.tag === detourOutbound.tag)) {
            outbounds.push(detourOutbound);
          }
        }

        // 添加目标节点本身
        const targetOutbound = this.generateProxyOutbound(targetServer, idToTagMap);
        targetOutbound.tag = idToTagMap.get(targetServer.id) || `proxy-${targetServer.id}`; // 使用节点名称作为 Tag
        if (targetServer.detour && config.servers.some((s) => s.id === targetServer.detour)) {
          targetOutbound.detour = idToTagMap.get(targetServer.detour);
        }

        // 避免重复添加
        if (!outbounds.some((o) => o.tag === targetOutbound.tag)) {
          outbounds.push(targetOutbound);
        }
      }
    } else {
      // Fallback if config is missing (shouldn't happen)
      outbounds.push(this.generateProxyOutbound(selectedServer, idToTagMap));
    }

    // 直连出站
    outbounds.push({
      type: 'direct',
      tag: 'direct',
    });

    // 版本条件：sing-box 1.12.x 需要在 outbound 层面做 override_address
    // 因为 1.12 的路由规则不支持 override_address 字段（会被静默忽略）。
    // 1.13+ 已将此功能迁移到路由规则，不需要额外的 outbound。
    const vArr = this.coreVersion.split('.');
    const vNum = parseFloat(vArr[0] + '.' + (vArr[1] || '0'));
    if (isNaN(vNum) || vNum < 1.13) {
      outbounds.push({
        type: 'direct',
        tag: 'direct-loopback',
        override_address: '127.0.0.1',
      });
    }

    // 阻断出站
    outbounds.push({
      type: 'block',
      tag: 'block',
    });

    // Shadow-TLS 后处理：如果主节点或任意辅助节点使用了 Shadow-TLS，
    // 为每个使用 Shadow-TLS 的节点插入内层 SS outbound
    const stlsOutbounds: SingBoxOutbound[] = [];
    for (const ob of outbounds) {
      // 根据 tag 找到对应的 ServerConfig
      const srv =
        ob.tag === 'proxy'
          ? selectedServer
          : config?.servers.find((s) => `proxy-${s.id}` === ob.tag);
      if (srv?.shadowTlsSettings) {
        // 创建独立的外层 ShadowTLS outbound
        const stlsTag = `stls-out-${srv.id}`;
        const stlsOutbound: SingBoxOutbound = {
          type: 'shadowtls',
          tag: stlsTag,
          server: srv.address,
          server_port: srv.shadowTlsSettings.port || srv.port,
          version: 3,
          password: srv.shadowTlsSettings.password,
          tls: {
            enabled: true,
            server_name: srv.shadowTlsSettings.sni || undefined,
            utls: {
              enabled: true,
              fingerprint: srv.shadowTlsSettings.fingerprint || 'chrome',
            },
          },
        };
        stlsOutbounds.push(stlsOutbound);

        // 主 outbound (原本的 shadowsocks) 必须作为应用的路由目标
        // 所以我们保留它为 proxy (shadowsocks)，但将其 detour 指向新增的 shadowtls outbound
        ob.detour = stlsTag;

        // 当配置了 detour 后，sing-box 通常期望主 outbound 的 server/port 被忽略
        // 但为了规范，我们可以保留 shadowsocks 的原参数或统一指向实际伪装的地址
        // 在 ShadowTLS 架构中，外层负责 TLS 握手连接真实服务器地址，内层 SS 则是被保护的流量
      }
    }
    outbounds.push(...stlsOutbounds);

    return outbounds;
  }

  /**
   * 生成代理 Outbound 配置（sing-box 1.12.x / 1.13.x 兼容格式）
   */
  private generateProxyOutbound(
    server: ServerConfig,
    idToTagMap: Map<string, string>
  ): SingBoxOutbound {
    // sing-box 要求协议类型必须是小写
    const protocol = server.protocol.toLowerCase();
    const protocolLower = protocol;
    const tlsProtocols = ['trojan', 'anytls', 'hysteria2', 'tuic'];

    const outbound: SingBoxOutbound = {
      type: protocol,
      tag: idToTagMap.get(server.id) || `proxy-${server.id}`,
      server: server.address,
      server_port: server.port,
      // 代理服务器使用 IP-based 引导解析器，防止因 dns-local 死循环导致的连接挂起
      domain_resolver: 'dns-bootstrap-udp',
    };

    // VLESS 特定配置
    if (protocol === 'vless') {
      outbound.uuid = server.uuid;
      if (server.flow) {
        outbound.flow = server.flow;
      }
      outbound.packet_encoding = 'xudp';
    }

    // VMess 特定配置
    if (protocol === 'vmess') {
      outbound.uuid = server.uuid;
      outbound.security = server.vmessSecurity || 'auto';
      outbound.alter_id = server.alterId || 0;
      outbound.packet_encoding = 'xudp';
    }

    // Trojan 特定配置
    if (protocol === 'trojan') {
      outbound.password = server.password;
    }

    // Hysteria2 特定配置
    if (protocol === 'hysteria2') {
      outbound.password = server.password;

      // 带宽限制
      if (server.hysteria2Settings?.upMbps) {
        outbound.up_mbps = server.hysteria2Settings.upMbps;
      }
      if (server.hysteria2Settings?.downMbps) {
        outbound.down_mbps = server.hysteria2Settings.downMbps;
      }

      // 混淆配置
      if (server.hysteria2Settings?.obfs?.type && server.hysteria2Settings?.obfs?.password) {
        outbound.obfs = {
          type: server.hysteria2Settings.obfs.type,
          password: server.hysteria2Settings.obfs.password,
        };
      }

      // 网络类型 (tcp/udp)
      if (server.hysteria2Settings?.network) {
        outbound.network = server.hysteria2Settings.network;
      }
    }

    // AnyTLS 特定配置
    if (protocol === 'anytls') {
      outbound.password = server.password;
      // AnyTLS 的 TLS 永远开启，这里不需要额外处理，类型检查结尾部分统一生成
      // AnyTLS 会话参数
      if (server.anyTlsSettings?.idleSessionCheckInterval) {
        outbound.idle_session_check_interval = server.anyTlsSettings.idleSessionCheckInterval;
      }
      if (server.anyTlsSettings?.idleSessionTimeout) {
        outbound.idle_session_timeout = server.anyTlsSettings.idleSessionTimeout;
      }
      if (server.anyTlsSettings?.minIdleSession !== undefined) {
        outbound.min_idle_session = server.anyTlsSettings.minIdleSession;
      }
    }

    // Shadowsocks 特定配置
    if (protocol === 'shadowsocks') {
      if (!server.shadowsocksSettings) {
        throw new Error(`Shadowsocks server ${server.name} missing settings`);
      }
      outbound.method = server.shadowsocksSettings.method;
      outbound.password = server.shadowsocksSettings.password;
      if (server.shadowsocksSettings.plugin) {
        outbound.plugin = server.shadowsocksSettings.plugin;
        outbound.plugin_opts = server.shadowsocksSettings.pluginOptions;
      }
    }

    // TUIC 特定配置
    if (server.protocol === 'tuic') {
      outbound.uuid = server.uuid;
      outbound.password = server.password;

      if (server.tuicSettings) {
        if (server.tuicSettings.congestionControl) {
          outbound.congestion_control = server.tuicSettings.congestionControl;
        }
        if (server.tuicSettings.udpRelayMode) {
          outbound.udp_relay_mode = server.tuicSettings.udpRelayMode;
        }
        if (server.tuicSettings.zeroRttHandshake !== undefined) {
          outbound.zero_rtt_handshake = server.tuicSettings.zeroRttHandshake;
        }
        if (server.tuicSettings.heartbeat) {
          outbound.heartbeat = server.tuicSettings.heartbeat;
        }
      }
    }

    // NaiveProxy 特定配置
    if (server.protocol === 'naive') {
      outbound.username = server.username;
      outbound.password = server.password;

      // NaiveProxy specific configuration
      // 1. Force TLS enabled (NaiveProxy usually uses H2/TLS)
      // 2. Default server_name to server address if not specified
      outbound.tls = {
        enabled: true,
        server_name: server.tlsSettings?.serverName || server.address,
        insecure: server.tlsSettings?.allowInsecure || false,
        alpn: server.tlsSettings?.alpn || undefined,
      };

      // 3. Naive handles its own fingerprint/transport, typically does not use uTLS settings
    }

    // SOCKS 特定配置
    if (server.protocol === 'socks') {
      if (server.username) outbound.username = server.username;
      if (server.password) outbound.password = server.password;
      // 默认 SOCKS 版本
      (outbound as any).version = '5';
    }

    // HTTP 特定配置
    if (server.protocol === 'http') {
      if (server.username) outbound.username = server.username;
      if (server.password) outbound.password = server.password;

      // HTTP outbound headers mapping can be added if needed via server.httpSettings.headers
      if (server.httpSettings?.headers) {
        if (!outbound.transport) outbound.transport = { type: 'http' };
        outbound.transport.headers = server.httpSettings.headers;
      }
      if (server.httpSettings?.path) {
        if (!outbound.transport) outbound.transport = { type: 'http' };
        outbound.transport.path = server.httpSettings.path;
      }
    }

    // TLS 配置 (非 Naive 协议，因为 Naive 已在前一段处理了 tls 结构)
    if (
      server.protocol !== 'naive' &&
      (server.security === 'tls' || server.tlsSettings || tlsProtocols.includes(protocol))
    ) {
      // 为 Trojan 设置默认 ALPN ["http/1.1"] 以提高兼容性
      let finalAlpn = server.tlsSettings?.alpn;
      if (!finalAlpn && protocolLower === 'trojan') {
        finalAlpn = ['http/1.1'];
      }

      outbound.tls = {
        enabled: true,
        server_name: server.tlsSettings?.serverName || server.address,
        insecure: server.tlsSettings?.allowInsecure || false,
        alpn: finalAlpn,
      };

      // uTLS 仅适用于基于 TCP 的协议，Hysteria2 和 TUIC 使用 QUIC (UDP) 不支持 uTLS
      const fingerprint = server.tlsSettings?.fingerprint;

      // 默认行为：VLESS 等协议默认开启 chrome 指纹，Trojan 默认不开启（none）以通过标准 TLS 握手
      let finalFingerprint = fingerprint;
      if (!finalFingerprint) {
        if (protocolLower === 'vless' || protocolLower === 'anytls') {
          finalFingerprint = 'chrome';
        } else {
          finalFingerprint = 'none';
        }
      }

      if (
        server.protocol !== 'hysteria2' &&
        server.protocol !== 'tuic' &&
        finalFingerprint !== 'none'
      ) {
        outbound.tls.utls = {
          enabled: true,
          fingerprint: finalFingerprint,
        };
      }

      // ALPN 仅在支持的协议上设置
      if (server.tlsSettings?.alpn) {
        outbound.tls.alpn = server.tlsSettings.alpn;
      }
    }

    // Reality 配置
    if (server.security === 'reality' && server.realitySettings) {
      outbound.tls = {
        enabled: true,
        server_name: server.tlsSettings?.serverName || undefined,
        utls: {
          enabled: true,
          fingerprint: server.tlsSettings?.fingerprint || 'chrome',
        },
        reality: {
          enabled: true,
          public_key: server.realitySettings.publicKey,
          short_id: server.realitySettings.shortId || '',
        },
      };
    }

    // 传输层配置（不适用于 hysteria2、anytls、naive）
    if (
      server.protocol !== 'hysteria2' &&
      server.protocol !== 'anytls' &&
      server.protocol !== 'naive' &&
      server.network &&
      server.network !== 'tcp'
    ) {
      outbound.transport = this.generateTransportConfig(server);
    }

    return outbound;
  }

  /**
   * 生成传输层配置
   */
  private generateTransportConfig(server: ServerConfig): SingBoxOutbound['transport'] {
    if (server.network === 'ws' && server.wsSettings) {
      return {
        type: 'ws',
        path: server.wsSettings.path || '/',
        headers: server.wsSettings.headers,
      };
    }

    if (server.network === 'grpc' && server.grpcSettings) {
      return {
        type: 'grpc',
        service_name: server.grpcSettings.serviceName || '',
      };
    }

    return undefined;
  }

  /**
   * 生成路由配置（sing-box 1.12.x / 1.13.x 兼容格式）
   */
  private generateRouteConfig(
    config: UserConfig,
    idToTagMap: Map<string, string>
  ): SingBoxRouteConfig {
    const rules: SingBoxRouteRule[] = [];
    const proxyMode = (config.proxyMode || 'smart').toLowerCase();

    const selectedServerTag = idToTagMap.get(config.selectedServerId as string) || 'proxy';
    // 获取当前选中的服务器，用于排除代理服务器域名
    const selectedServer = config.servers.find((s) => s.id === config.selectedServerId);

    const versionArr = this.coreVersion.split('.');
    const versionNum = parseFloat(versionArr[0] + '.' + (versionArr[1] || '0'));

    // A. 嗅探规则（必须在前，用于识别域名）
    // 1.13+ 必须在路由层开启 sniff，替代已移除的 inbound 级别 sniff 字段
    // sing-box 1.13.x 嗅探后自动将域名用于路由匹配（等效旧版 sniff_override_destination）
    if (!isNaN(versionNum) && versionNum >= 1.13) {
      rules.push({
        action: 'sniff',
      } as any);
    }

    // 1. 强制放行 FlowZ 及其核心进程：防止 DNS 回流死循环
    // 必须放在最高优先级，确保核心组件的 DNS 请求能直连物理网卡
    rules.push({
      process_name: [
        'sing-box',
        'sing-box.exe',
        'FlowZ',
        'FlowZ.exe',
        'FlowZ Helper',
        'FlowZ Helper.exe',
        'FlowZ Helper (Plugin)',
        'FlowZ Helper (Plugin).exe',
      ],
      action: 'route',
      outbound: 'direct',
    });

    // C. 强制引导核心 DNS 直连（必须在 hijack-dns 之前！）
    // 把已知 bootstrap DNS IP 放在 hijack-dns 之前，无论哪个进程发包都走直连，彻底断环。
    rules.push({
      ip_cidr: [
        '223.5.5.5/32',
        '223.6.6.6/32',
        '119.29.29.29/32',
        '119.28.28.28/32',
        '114.114.114.114/32',
        '8.8.8.8/32',
        '1.1.1.1/32',
      ],
      port: [53, 443],
      action: 'route',
      outbound: 'direct',
    });

    // D. DNS 劫持（必须在引导 DNS IP 直连之后）
    // 劫持所有其余 port 53 流量（浏览器/系统 DNS），返回 FakeIP
    rules.push({
      port: [53],
      action: 'hijack-dns',
    });

    // F. 静默屏蔽 ICMP 流量（FakeIP 下常见，但代理节点通常不支持）
    // 放置在靠前位置，防止 ICMP 流量误入不支持的代理出站引发报错
    rules.push({
      protocol: 'icmp',
      action: 'reject',
    } as any);

    rules.push({
      process_name: [
        'Surge',
        'Surge 4',
        'Surge 5',
        'Clash',
        'Clash for Windows',
        'ClashX',
        'ClashX Pro',
        'clash-meta',
        'Quantumult X',
        'FlowZ',
        'FlowZ.exe',
        'FlowZ Helper',
        'FlowZ Helper.exe',
        'FlowZ Helper (Plugin)',
        'FlowZ Helper (Plugin).exe',
        'sing-box',
        'sing-box.exe',
        'mDNSResponder',
        'apsd',
        'nsurlsessiond',
        'airportd',
        'syspolicyd',
        'trustd',
        'ocspd',
        'securityd',
        'taskgated',
        'findmydeviced',
        'cloudd',
      ],
      action: 'route',
      outbound: 'direct',
    });

    const routeConfig: SingBoxRouteConfig = {
      rules,
      // 核心修复：macOS 下 default_domain_resolver 必须使用 IP-based 引导解析器 (dns-bootstrap-udp)
      // 避免解析 doh.pub 域名时产生的死循环。
      default_domain_resolver: 'dns-bootstrap-udp',
      auto_detect_interface: true,
      // 如果模式是全局代理 (global/proxy)，则最终出口是所选节点
      final: proxyMode === 'direct' ? 'direct' : selectedServerTag,
    };

    // 【DNS 引导与辅助直连】：
    // 确保以下公共 DNS IP 不会被后面的 block 规则拦截，从而保证 DoH 握手和初次域名解析。
    rules.push({
      ip_cidr: [
        '8.8.8.8/32',
        '8.8.4.4/32',
        '1.1.1.1/32',
        '1.0.0.1/32',
        '9.9.9.9/32',
        '149.112.112.112/32',
        '208.67.222.222/32',
        '208.67.220.220/32',
        // IPv6 Public DNS
        '2001:4860:4860::8888/128',
        '2001:4860:4860::8844/128',
        '2606:4700:4700::1111/128',
        '2606:4700:4700::1001/128',
      ],
      port: [53, 443, 853],
      action: 'route',
      outbound: 'direct',
    });

    // 【终极绝杀隐私 DoH 泄漏】：
    // 现代浏览器会尝试通过常规 HTTPS 端口向特定域名发起 DoH 请求。
    // 我们在这里将这些特定的 DoH 域名强制阻断（Block），从而迫使浏览器退回到系统标准的 UDP 53。
    // 这样流量就能重新被 hijack-dns 捕获并进入我们的 DNS 分流/FakeIP 体系。
    rules.push({
      domain_keyword: [
        'dns.google',
        'cloudflare-dns.com',
        'doh.opendns.com',
        'dns.quad9.net',
        'one.one.one.one',
      ],
      port: [443, 853],
      action: 'route',
      outbound: 'block',
    });

    // 排除代理服务器域名，确保代理服务器的连接走直连
    // 这必须放在其他规则之前，否则可能被 geosite-cn 匹配导致死循环
    if (selectedServer?.address) {
      const proxyHosts = [selectedServer.address];
      if (selectedServer.tlsSettings?.serverName) {
        proxyHosts.push(selectedServer.tlsSettings.serverName);
      }
      const uniqueHosts = Array.from(new Set(proxyHosts));

      const ips: string[] = [];
      const domains: string[] = [];

      const isIpv4 = (host: string) => /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host);
      const isIpv6 = (host: string) => /^[0-9a-fA-F:]+$/.test(host) && host.includes(':');

      uniqueHosts.forEach((host) => {
        if (isIpv4(host)) ips.push(`${host}/32`);
        else if (isIpv6(host)) ips.push(`${host}/128`);
        else domains.push(host);
      });

      if (domains.length > 0) {
        rules.push({
          domain: domains,
          domain_suffix: domains.flatMap((d) => [d, `.${d}`]),
          domain_keyword: domains,
          action: 'route',
          outbound: 'direct',
        });
      }

      if (ips.length > 0) {
        rules.push({
          ip_cidr: ips,
          action: 'route',
          outbound: 'direct',
        });
      }
    }

    // 0a. U盾/安全插件的本地伪域名 → 强制 127.0.0.1，完全跳过 DNS
    // windows10.microdone.cn 等域名是 U盾厂商注册在本地的专用域名，公网 DNS 中不存在。
    // 普通 direct outbound 会先做 DNS 解析 → NXDOMAIN → 连接失败。
    // 版本分支：
    //   1.12.x → 使用 direct-loopback outbound（outbound 层面 override_address）
    //   1.13+  → 使用路由规则层面的 override_address（outbound 层面已移除此功能）
    const UKEY_LOCAL_DOMAINS = ['.microdone.cn'];
    const otherBankDomains = DOMESTIC_BANK_AND_STOCK_DOMAINS.filter(
      (d) => !UKEY_LOCAL_DOMAINS.includes(d)
    );

    if (!isNaN(versionNum) && versionNum >= 1.13) {
      // 1.13+：路由规则支持 override_address
      rules.push({
        domain_suffix: UKEY_LOCAL_DOMAINS,
        action: 'route',
        outbound: 'direct',
        override_address: '127.0.0.1',
      });
    } else {
      // 1.12.x：使用专用的 direct-loopback outbound
      rules.push({
        domain_suffix: UKEY_LOCAL_DOMAINS,
        action: 'route',
        outbound: 'direct-loopback',
      });
    }

    // 0b. 其余银行/证券域名 → 普通 direct（正常 DNS 解析，这些域名在公网真实存在）
    if (otherBankDomains.length > 0) {
      rules.push({
        domain_suffix: otherBankDomains,
        action: 'route',
        outbound: 'direct',
      });
    }

    // 1. 私有 IP 段直连（内网地址不应该经过代理，优先级最高）
    // 仅当用户未关闭"绕过局域网"时添加
    if (config.bypassLAN !== false) {
      rules.push({
        ip_cidr: PRIVATE_IP_CIDRS,
        action: 'route',
        outbound: 'direct',
      });
    }

    // Bug 4 修复：删除此处重复的 QUIC 阻断规则
    // 第一条 QUIC reject 规则已在上方（生成 routeConfig 之前）添加，此处重复添加会造成规则冗余
    // reject 比 block 更合适（发 TCP RST 让浏览器立即回退到 TCP，而不是静默丢弃造成等待超时）

    // 3. 自定义规则（优先级次之，允许用户覆盖后续默认行为）
    if (proxyMode !== 'direct') {
      const { rules: customRules, ruleSets: customRuleSets } = this.generateCustomRules(
        config.customRules || [],
        config.customRuleSets || [],
        config.selectedServerId || undefined,
        idToTagMap,
        selectedServerTag
      );
      rules.push(...customRules);

      if (customRuleSets.length > 0) {
        if (!routeConfig.rule_set) {
          routeConfig.rule_set = [];
        }
        routeConfig.rule_set.push(...customRuleSets);
      }

      // 排除进程规则：优先级最高，在应用分流之前插入，确保用户明确指定绕过的进程不被任何规则覆盖
      if (config.bypassProcesses && config.bypassProcesses.length > 0) {
        rules.push({
          process_name: config.bypassProcesses,
          action: 'route',
          outbound: 'direct',
        });
      }

      // 应用分流规则（真·应用分流，基于进程名）
      // 优先级高于后续的智能分流/全局分流，确保特定应用的流量始终走用户指定的出口
      for (const appRule of config.appRules || []) {
        if (!appRule.enabled) continue;
        const preset = getAppPreset(appRule.appId, config.customAppPresets);
        if (!preset) continue;

        // 确定出站方式
        let outbound = 'direct';
        if (appRule.action === 'proxy') {
          if (appRule.targetServerId && appRule.targetServerId !== config.selectedServerId) {
            const serverExists = config.servers.some((s) => s.id === appRule.targetServerId);
            outbound = serverExists
              ? idToTagMap.get(appRule.targetServerId) || `proxy-${appRule.targetServerId}`
              : selectedServerTag;
          } else {
            outbound = selectedServerTag;
          }
        } else if (appRule.action === 'block') {
          outbound = 'block';
        }

        // a. 基于进程名的规则（最精准，适用于 macOS/Windows TUN 模式）
        if (preset.processNames && preset.processNames.length > 0) {
          rules.push({
            process_name: preset.processNames,
            action: 'route',
            outbound,
          });
        }

        // b. 基于原有 rule_set 的规则（兜底，基于域名/IP 识别）
        const ruleSets = [
          ...preset.geositeTags.map((tag) => `geosite-${tag}`),
          ...(preset.geoipTags || []).map((tag) => `geoip-${tag}`),
        ];

        if (ruleSets.length > 0) {
          rules.push({
            rule_set: ruleSets,
            action: 'route',
            outbound,
          });
        }
      }
    }

    // 【QUIC 阻断】：放在自定义规则和应用分流之后，确保用户的 direct/proxy 规则优先级更高
    // 这样游戏设为直连时，进程名匹配在前，游戏的 UDP 流量不会被误拒。
    // 仅阻断浏览器的 DoH over QUIC，迫使浏览器回退到系统 UDP 53 + hijack-dns 体系。
    // 重要：不能全量 reject 所有 UDP 443，否则 Hysteria2/TUIC 等 QUIC 协议节点会被误伤。
    rules.push({
      domain_keyword: [
        'dns.google',
        'cloudflare-dns.com',
        'doh.opendns.com',
        'dns.quad9.net',
        'one.one.one.one',
      ],
      network: ['udp'],
      port: [443],
      action: 'reject',
    } as any);

    // 【DNS 死循环防范】：sing-box 本地 DNS 解析器的请求必须强制直连，否则在全局代理模式下会产生死循环
    // 兼容 Windows 1.12.x 版本，不使用 DNS 配置里的 detour
    rules.push({
      protocol: 'dns',
      action: 'route',
      outbound: 'direct',
    } as any);

    rules.push({
      ip_cidr: ['223.5.5.5/32'],
      port: [53, 443],
      action: 'route',
      outbound: 'direct',
    });

    rules.push({
      domain_suffix: ['doh.pub'],
      action: 'route',
      outbound: 'direct',
    });

    // 【通用修复：Chrome/Edge 心跳 beacon 域名强制直连 —— global 和 smart 模式均生效】
    // gvt2.com / gvt1.com 是 Google CDN 心跳；clientservices / oauthaccountmanager /
    // optimizationguide-pa 是 Chrome 账号同步、FCM Push 和优化引导的后台服务。
    // 这些域名对代理节点出口通常限速或屏蔽（非浏览行为），一旦持续超时会耗尽连接池，
    // 导致所有正常网页也超时 —— 即"过一会就断网"现象。
    // 在 global 和 smart 两种模式下均强制直连，彻底消除对连接池的占用。
    if (proxyMode !== 'direct') {
      rules.push({
        domain_suffix: [
          // Google CDN 心跳
          'gvt2.com',
          'gvt1.com',
          // Chrome 账号同步 / FCM Push 后台
          'oauthaccountmanager.googleapis.com',
          'clientservices.googleapis.com',
          // Chrome 优化引导服务
          'optimizationguide-pa.googleapis.com',
          // Google FCM 推送 (port 5228)
          'mtalk.google.com',
          // Android 客户端服务
          'android.clients.google.com',
          // Chrome / GMS clients
          'clients1.google.com',
          'clients2.google.com',
          'clients3.google.com',
          'clients4.google.com',
          'clients5.google.com',
          'clients6.google.com',
          // 自动更新检查
          'update.googleapis.com',
        ],
        action: 'reject',
      });
    }

    // 智能分流规则（仅在智能分流模式下启用）
    if (proxyMode === 'smart') {
      // 已移除 ::/0 block，因为 block 是静默丢包，会导致 Chrome 等浏览器在发起 TCP SYN 包时陷入漫长的 21 秒重传等待（Happy Eyeballs 假死），
      // 从而让用户以为“所有的海外网站全都打不开了”。我们必须依靠浏览器的原生 fallback，或者直接让 Mac 本机关闭 IPv6 分配。

      // 针对 Google 核心服务（搜索/YouTube/Gmail 等）的关键词兜底规则（仅在未专门设置应用分流时作为备份）
      // 注意：这些规则在 AppRules 之后，所以不会覆盖用户手动指定的节点
      rules.push({
        domain_keyword: ['google', 'gmail', 'youtube', 'gstatic', 'googleapis', 'googlevideo'],
        action: 'route',
        outbound: selectedServerTag,
      });

      // 国外域名走代理
      rules.push({
        rule_set: 'geosite-geolocation-!cn',
        action: 'route',
        outbound: selectedServerTag,
      });
      // 中国域名直连
      rules.push({
        rule_set: 'geosite-cn',
        action: 'route',
        outbound: 'direct',
      });
      // 中国 IP 直连
      rules.push({
        rule_set: 'geoip-cn',
        action: 'route',
        outbound: 'direct',
      });
    }

    // 添加 rule_set（除非是直连模式）
    // 直连模式下不需要 rule_set，因为全部走 direct
    if (proxyMode !== 'direct') {
      if (!routeConfig.rule_set) {
        routeConfig.rule_set = [];
      }
      routeConfig.rule_set.push(
        {
          tag: 'geosite-cn',
          type: 'local',
          format: 'binary',
          path: path.join(getUserDataPath(), 'rules', 'geosite-cn.srs'),
        },
        {
          tag: 'geosite-geolocation-!cn',
          type: 'local',
          format: 'binary',
          path: path.join(getUserDataPath(), 'rules', 'geosite-geolocation-!cn.srs'),
        },
        {
          tag: 'geoip-cn',
          type: 'local',
          format: 'binary',
          path: path.join(getUserDataPath(), 'rules', 'geoip-cn.srs'),
        }
      );
    }

    // 添加自定义规则和应用分流所需的 Geosite/GeoIP rule_set
    const { geosite: customGeositeCategories, geoip: customGeoipCategories } =
      this.getRequiredGeoCategories(
        config.customRules || [],
        config.appRules || [],
        config.customAppPresets || []
      );

    if (customGeositeCategories.size > 0 || customGeoipCategories.size > 0) {
      if (!routeConfig.rule_set) {
        routeConfig.rule_set = [];
      }

      // Bug 2 修复：
      // 1. 使用 fastly.jsdelivr.net CDN 加速，替代直连 raw.githubusercontent.com（在中国大陆常被封锁）
      // 2. download_detour 改为 'direct'，避免循环依赖（代理需要规则集才能启动，规则集需要代理才能下载）
      //    sing-box 启动时规则集下载必须走直连，后续更新可以走代理
      // 3. 注意：不是所有 geosite 标签都有独立的 .srs 文件（如 geosite-bbc.srs 不存在）
      //    如果下载失败，sing-box 会使用缓存版本，如无缓存则跳过该规则集

      // 添加 Geosite 远程规则集
      for (const category of Array.from(customGeositeCategories)) {
        // 构建镜像 URL：优先使用 fastly CDN，提升中国大陆可用性
        const geositeUrl =
          category === 'category-ai'
            ? 'https://fastly.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-category-ai-!cn.srs'
            : `https://fastly.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-${category}.srs`;

        routeConfig.rule_set.push({
          tag: `geosite-${category}`,
          type: 'remote',
          format: 'binary',
          url: geositeUrl,
          // 必须走直连下载，避免启动时循环依赖
          download_detour: 'direct',
        } as any);
      }

      // 添加 GeoIP 远程规则集
      for (const category of Array.from(customGeoipCategories)) {
        routeConfig.rule_set.push({
          tag: `geoip-${category}`,
          type: 'remote',
          format: 'binary',
          url: `https://fastly.jsdelivr.net/gh/SagerNet/sing-geoip@rule-set/geoip-${category}.srs`,
          // 必须走直连下载，避免启动时循环依赖
          download_detour: 'direct',
        } as any);
      }
    }

    return routeConfig;
  }

  /**
   * 收集自定义规则中使用的 Geosite 类别（同时扫描 customRules 和 appRules）
   */
  /**
   * 收集自定义规则中使用的 Geosite 和 GeoIP 类别（同时扫描 customRules 和 appRules）
   */
  private getRequiredGeoCategories(
    customRules: import('../../shared/types').DomainRule[],
    appRules: import('../../shared/types').AppRule[] = [],
    customAppPresets: import('../../shared/types').CustomAppPreset[] = []
  ): { geosite: Set<string>; geoip: Set<string> } {
    const geositeCategories = new Set<string>();
    const geoipCategories = new Set<string>();

    // 扫描手动定义的 geosite: 域名规则
    for (const rule of customRules) {
      if (!rule.enabled) continue;
      for (const domain of rule.domains) {
        if (domain.startsWith('geosite:')) {
          geositeCategories.add(domain.slice(8));
        }
      }
    }

    // 扫描应用分流规则
    for (const appRule of appRules) {
      if (!appRule.enabled) continue;
      const preset = getAppPreset(appRule.appId, customAppPresets);
      if (preset) {
        preset.geositeTags.forEach((tag) => geositeCategories.add(tag));
        if (preset.geoipTags) {
          preset.geoipTags.forEach((tag) => geoipCategories.add(tag));
        }
      }
    }
    return { geosite: geositeCategories, geoip: geoipCategories };
  }

  private generateCustomRules(
    customRules: import('../../shared/types').DomainRule[],
    customRuleSets: import('../../shared/types').CustomRuleSet[] = [],
    selectedServerId?: string,
    idToTagMap?: Map<string, string>,
    selectedServerTag: string = 'proxy'
  ): { rules: SingBoxRouteRule[]; ruleSets: SingBoxRuleSet[] } {
    const rules: SingBoxRouteRule[] = [];
    const ruleSets: SingBoxRuleSet[] = [];

    // 处理旧的 DomainRule (纯文本域名/geosite类)
    for (const rule of customRules) {
      if (
        !rule.enabled ||
        (rule.domains.length === 0 && (!rule.ipCidr || rule.ipCidr.length === 0))
      )
        continue;

      // 统一使用 domain_suffix，匹配域名及其所有子域名
      // 如 google.com 会匹配 google.com、www.google.com、mail.google.com 等
      // 同时支持 geosite: 前缀，转换为 rule_set
      const domainSuffix: string[] = [];
      const geositeTags: string[] = [];

      for (const d of rule.domains) {
        if (d.startsWith('geosite:')) {
          const category = d.slice(8);
          geositeTags.push(`geosite-${category}`);
        } else {
          domainSuffix.push(d.startsWith('*.') ? d.slice(2) : d);
        }
      }

      // 如果有普通域名或 IP CIDR，创建一条规则
      if (domainSuffix.length > 0 || (rule.ipCidr && rule.ipCidr.length > 0)) {
        const singboxRule: SingBoxRouteRule = {
          action: 'route',
        };

        if (domainSuffix.length > 0) {
          // domain_suffix 匹配该域名及所有子域名（如 bbc.com 匹配 www.bbc.com）
          singboxRule.domain_suffix = domainSuffix;
        }

        if (rule.ipCidr && rule.ipCidr.length > 0) {
          singboxRule.ip_cidr = rule.ipCidr;
        }

        // Bug 1 修复：必须传入 idToTagMap 和 selectedServerTag，
        // 否则 selectedServerTag 默认为 'proxy'，而实际出站标签是节点名称，导致 sing-box 启动失败
        this.applyRuleAction(
          singboxRule,
          rule.action,
          rule.targetServerId,
          selectedServerId,
          idToTagMap,
          selectedServerTag
        );
        rules.push(singboxRule);
      }

      // 如果有 Geosite 引用，创建一条规则
      if (geositeTags.length > 0) {
        const singboxRule: SingBoxRouteRule = {
          action: 'route',
          rule_set: geositeTags,
        };
        // Bug 1 修复：同上，必须传入完整参数确保 outbound 标签正确
        this.applyRuleAction(
          singboxRule,
          rule.action,
          rule.targetServerId,
          selectedServerId,
          idToTagMap,
          selectedServerTag
        );
        rules.push(singboxRule);
      }
    }

    // 处理新的 Remote RuleSet
    let ruleSetIndex = 1;
    for (const ruleSet of customRuleSets) {
      if (!ruleSet.enabled || !ruleSet.url) continue;

      const tag = `custom-ruleset-${ruleSetIndex++}`;
      ruleSets.push({
        tag,
        type: 'remote',
        format: 'binary',
        url: ruleSet.url,
        download_detour: selectedServerTag, // 默认通过当前选中的代理下载自定义规则集
      } as any);

      const singboxRule: SingBoxRouteRule = {
        action: 'route',
        rule_set: [tag],
      };

      // 此处的 CustomRuleSet 只包含 action 而无 targetServerId，不过统一走 applyRuleAction 判断
      this.applyRuleAction(
        singboxRule,
        ruleSet.action,
        undefined,
        selectedServerId,
        idToTagMap,
        selectedServerTag
      );
      rules.push(singboxRule);
    }

    return { rules, ruleSets };
  }

  /**
   * 应用规则动作到 sing-box 规则对象
   */
  private applyRuleAction(
    singboxRule: SingBoxRouteRule,
    action: string,
    targetServerId?: string,
    selectedServerId?: string,
    idToTagMap?: Map<string, string>,
    selectedServerTag: string = 'proxy'
  ): void {
    // 设置出站
    if (action === 'proxy') {
      // 如果指定了目标服务器，且不是主节点，则路由到特定的 outbound tag
      if (targetServerId && selectedServerId !== targetServerId) {
        const targetTag = idToTagMap?.get(targetServerId);
        singboxRule.outbound = targetTag || `proxy-${targetServerId}`;
      } else {
        singboxRule.outbound = selectedServerTag;
      }
    } else if (action === 'direct') {
      singboxRule.outbound = 'direct';
    } else if (action === 'block') {
      singboxRule.outbound = 'block';
    } else {
      // 如果没有指定，默认使用主节点
      singboxRule.outbound = selectedServerTag;
    }
  }

  /**
   * 写入 sing-box 配置文件
   */
  private async writeSingBoxConfig(config: SingBoxConfig): Promise<void> {
    const content = JSON.stringify(config, null, 2);
    await fs.writeFile(this.configPath, content, 'utf-8');
  }

  /**
   * 检查当前配置是否需要 root/admin 权限（TUN 模式）
   * Windows 和 macOS 的 TUN 模式都需要管理员权限
   */
  private needsRootPrivilege(): boolean {
    const isTunMode = this.currentConfig?.proxyModeType === 'tun';
    // Windows, macOS, and Linux TUN 模式都需要管理员权限
    return (
      isTunMode &&
      (process.platform === 'darwin' ||
        process.platform === 'win32' ||
        process.platform === 'linux')
    );
  }

  /**
   * 检查是否需要使用 osascript 运行（仅 macOS）
   */
  private needsOsascript(): boolean {
    return process.platform === 'darwin' && this.needsRootPrivilege();
  }

  /**
   * 检查是否需要使用 UAC 提升权限运行（仅 Windows TUN 模式）
   */
  private needsWindowsUAC(): boolean {
    return process.platform === 'win32' && this.needsRootPrivilege();
  }

  /**
   * 修复可能被 root 创建的文件权限（macOS）
   * 当从 TUN 模式切换到系统代理模式时，某些文件可能仍然属于 root
   * 需要在普通用户模式下修复这些文件的权限
   */
  private async fixFilePermissions(): Promise<void> {
    // 只在 macOS 上需要处理
    if (process.platform !== 'darwin') {
      return;
    }

    // 如果是 TUN 模式，不需要修复（会以 root 权限运行）
    if (this.needsRootPrivilege()) {
      return;
    }

    const userDataPath = getUserDataPath();
    const filesToFix = [
      path.join(userDataPath, 'cache.db'),
      path.join(userDataPath, 'singbox.log'),
      path.join(userDataPath, 'singbox.pid'),
      path.join(userDataPath, 'singbox_startup.log'),
    ];

    const fsSync = require('fs');
    const { execSync } = require('child_process');

    for (const filePath of filesToFix) {
      try {
        if (fsSync.existsSync(filePath)) {
          const stats = fsSync.statSync(filePath);
          // 检查文件是否属于 root (uid 0)
          if (stats.uid === 0) {
            this.logToManager('info', `修复文件权限: ${filePath}`);
            // 使用 chown 修改文件所有权为当前用户
            const currentUser = process.env.USER || process.env.LOGNAME;
            if (currentUser) {
              try {
                // 尝试使用 chown（可能需要密码）
                execSync(`chown ${currentUser} "${filePath}"`, { stdio: 'ignore' });
              } catch {
                // 如果 chown 失败，尝试删除文件让 sing-box 重新创建
                try {
                  fsSync.unlinkSync(filePath);
                  this.logToManager('info', `已删除需要重新创建的文件: ${filePath}`);
                } catch {
                  this.logToManager(
                    'warn',
                    `无法修复文件权限: ${filePath}，请手动删除或运行: sudo chown ${currentUser} "${filePath}"`
                  );
                }
              }
            }
          }
        }
      } catch {
        // 忽略检查错误
      }
    }
  }

  /**
   * 启动 sing-box 进程
   */
  private async startSingBoxProcess(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // 检查 sing-box 可执行文件是否存在
        const fs = require('fs');
        if (!fs.existsSync(this.singboxPath)) {
          const error = new Error(`找不到 sing-box 可执行文件: ${this.singboxPath}`);
          this.logToManager('error', error.message);
          reject(error);
          return;
        }

        // 根据平台和模式选择启动方式：
        // - macOS TUN 模式: 使用 osascript 请求管理员权限
        // - Windows TUN 模式: 使用 PowerShell Start-Process -Verb RunAs 请求 UAC 权限
        // - 其他情况: 直接运行
        let command: string;
        let args: string[];

        if (this.needsOsascript()) {
          // macOS: 使用 osascript 请求管理员权限运行
          // 注意：路径中可能包含空格，需要使用转义引号
          // sing-box 配置中已经设置了 log.output，日志会写入文件
          // 使用 & 让进程在后台运行，并将 PID 写入文件
          const pidFile = path.join(getUserDataPath(), 'singbox.pid');
          const startupLogFile = path.join(getUserDataPath(), 'singbox_startup.log');
          command = '/usr/bin/osascript';

          // 如果开启了局域网共享且是 TUN 模式，同时开启系统的 IP 转发功能
          const forwardCmd = this.currentConfig?.allowLan
            ? 'sysctl -w net.ipv4.ip_forward=1; sysctl -w net.ipv6.conf.all.forwarding=1; '
            : '';

          // 使用 bash -c 来执行后台命令，确保 & 正常工作
          // 重定向 stdout 和 stderr 到日志文件，以便排查启动失败原因
          args = [
            '-e',
            `do shell script "/bin/bash -c '${forwardCmd}\\"${this.singboxPath}\\" run -c \\"${this.configPath}\\" > \\"${startupLogFile}\\" 2>&1 & echo $! > \\"${pidFile}\\"'" with administrator privileges`,
          ];
          this.logToManager(
            'info',
            `TUN 模式需要管理员权限${this.currentConfig?.allowLan ? '及开启 IP 转发' : ''}，正在请求...`
          );
        } else if (this.needsWindowsUAC()) {
          // Windows TUN 模式: 使用 PowerShell 请求 UAC 权限运行
          // 使用 Start-Process -Verb RunAs 来请求管理员权限
          const pidFile = path.join(getUserDataPath(), 'singbox.pid');
          command = 'powershell.exe';

          // PowerShell 脚本：以管理员权限启动 sing-box 并记录 PID
          // 使用数组构建脚本避免模板字符串中 $ 被 JS 解析
          // 详细日志输出到 singbox_startup.log 帮助诊断启动问题
          const startupLogFile = path.join(getUserDataPath(), 'singbox_startup.log');
          const singboxPathEsc = this.singboxPath.replace(/'/g, "''");
          const configPathEsc = this.configPath.replace(/'/g, "''");
          const pidFileEsc = pidFile.replace(/'/g, "''");
          const logFileEsc = startupLogFile.replace(/'/g, "''");

          // Windows 局域网转发支持
          const forwardPsCmd = this.currentConfig?.allowLan
            ? 'Set-NetIPInterface -Forwarding Enabled; Set-NetIPInterface -AddressFamily IPv6 -Forwarding Enabled; '
            : '';

          const psScript = [
            "$ErrorActionPreference = 'Stop'",
            "$logFile = '" + logFileEsc + "'",
            "$pidFile = '" + pidFileEsc + "'",
            "$singboxPath = '" + singboxPathEsc + "'",
            "$configPath = '" + configPathEsc + "'",
            'try {',
            "  'Starting sing-box...' | Out-File -FilePath $logFile -Encoding UTF8",
            forwardPsCmd
              ? "  'Enabling IP Forwarding...' | Out-File -FilePath $logFile -Append -Encoding UTF8"
              : '',
            forwardPsCmd,
            "  'SingboxPath: ' + $singboxPath | Out-File -FilePath $logFile -Append -Encoding UTF8",
            "  'ConfigPath: ' + $configPath | Out-File -FilePath $logFile -Append -Encoding UTF8",
            "  if (-not (Test-Path $singboxPath)) { 'ERROR: sing-box not found' | Out-File -FilePath $logFile -Append -Encoding UTF8; exit 1 }",
            "  if (-not (Test-Path $configPath)) { 'ERROR: config not found' | Out-File -FilePath $logFile -Append -Encoding UTF8; exit 1 }",
            "  'Starting with UAC...' | Out-File -FilePath $logFile -Append -Encoding UTF8",
            "  $process = Start-Process -FilePath $singboxPath -ArgumentList 'run','-c',$configPath -Verb RunAs -PassThru -WindowStyle Hidden",
            '  if ($process -and $process.Id) {',
            "    'Process started PID: ' + $process.Id | Out-File -FilePath $logFile -Append -Encoding UTF8",
            '    $process.Id | Out-File -FilePath $pidFile -Encoding ASCII -NoNewline',
            '    exit 0',
            '  } else {',
            "    'ERROR: Start-Process returned null' | Out-File -FilePath $logFile -Append -Encoding UTF8",
            '    exit 1',
            '  }',
            '} catch {',
            "  'ERROR: ' + $_.Exception.Message | Out-File -FilePath $logFile -Append -Encoding UTF8",
            '  exit 1',
            '}',
          ].join('; ');

          args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript];
          this.logToManager(
            'info',
            `TUN 模式需要管理员权限${
              this.currentConfig?.allowLan ? '及开启 IP 转发' : ''
            }，正在请求 UAC 授权...`
          );
        } else {
          // 系统代理模式或 Linux：直接运行
          command = this.singboxPath;
          args = ['run', '-c', this.configPath];
        }

        // 启动进程
        // 关键：为 sing-box 1.12.x 注入环境变量以启用已弃用的 override_address 功能
        // 这是银行 U盾本地域名（如 windows10.microdone.cn → 127.0.0.1）正常工作的前提。
        // 1.13+ 已将此功能迁移到路由规则，不需要此环境变量。
        const spawnEnv = { ...process.env };
        const cvArr = this.coreVersion.split('.');
        const cvNum = parseFloat(cvArr[0] + '.' + (cvArr[1] || '0'));
        if (isNaN(cvNum) || cvNum < 1.13) {
          spawnEnv['ENABLE_DEPRECATED_DESTINATION_OVERRIDE_FIELDS'] = 'true';
        }

        this.singboxProcess = spawn(command, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: spawnEnv,
        });

        // 记录启动信息
        this.pid = this.singboxProcess.pid || null;
        this.startTime = new Date();

        // macOS/Windows TUN 模式下，这个 PID 是 osascript/PowerShell 的 PID，不是 sing-box 的
        // 实际的 sing-box PID 会在 waitForPidFile 中从 PID 文件读取
        if (this.needsOsascript() || this.needsWindowsUAC()) {
          this.logToManager('info', `正在启动 sing-box（权限提升进程 PID: ${this.pid}）...`);
        } else {
          this.logToManager('info', `正在启动 sing-box 进程 (PID: ${this.pid})...`);
        }

        // 监听进程输出
        if (this.singboxProcess.stdout) {
          this.singboxProcess.stdout.on('data', (data: Buffer) => {
            this.handleProcessOutput(data.toString());
          });
        }

        if (this.singboxProcess.stderr) {
          this.singboxProcess.stderr.on('data', (data: Buffer) => {
            const output = data.toString();
            this.lastErrorOutput = output;
            this.handleProcessOutput(output);
          });
        }

        // 监听进程事件
        this.singboxProcess.on('error', (error) => {
          console.error('sing-box process error:', error);
          const friendlyError = this.parseLaunchError(error);
          this.logToManager('error', friendlyError);
          this.handleProcessError(error);
          reject(new Error(friendlyError));
        });

        this.singboxProcess.on('exit', (code, signal) => {
          console.log(`sing-box process exited with code ${code}, signal ${signal}`);

          // 对于 macOS TUN 模式，osascript 退出码为 0 表示成功启动了后台进程
          if (this.needsOsascript()) {
            if (code === 0) {
              // osascript 成功执行，sing-box 在后台运行
              // PID 文件读取由 setTimeout 中的 waitForPidFile 统一处理
              return; // 不调用 handleProcessExit，因为 sing-box 还在运行
            } else {
              // osascript 执行失败（用户取消或其他错误）
              const errorMessage =
                code === 1 ? '用户取消了管理员权限请求' : `启动失败，退出码: ${code}`;
              this.logToManager('error', errorMessage);
              reject(new Error(errorMessage));
              this.handleProcessExit(code, signal);
              return;
            }
          }

          // 对于 Windows TUN 模式，PowerShell 退出码为 0 表示成功启动了 sing-box
          if (this.needsWindowsUAC()) {
            if (code === 0) {
              // PowerShell 成功执行，sing-box 以管理员权限在后台运行
              // PID 文件读取由 setTimeout 中的 waitForPidFile 统一处理
              return; // 不调用 handleProcessExit，因为 sing-box 还在运行
            } else {
              // PowerShell 执行失败（用户取消 UAC 或其他错误）
              const errorMessage =
                code === 1 ? '用户取消了管理员权限请求' : `UAC 授权失败，退出码: ${code}`;
              this.logToManager('error', errorMessage);
              reject(new Error(errorMessage));
              this.handleProcessExit(code, signal);
              return;
            }
          }

          // 如果在启动阶段就退出了，说明启动失败
          const startupTime = Date.now() - (this.startTime?.getTime() || Date.now());
          if (startupTime < 2000 && code !== null && code !== 0) {
            const errorMessage = this.parseStartupError(code, this.lastErrorOutput);
            this.logToManager('error', errorMessage);
            reject(new Error(errorMessage));
          }

          this.handleProcessExit(code, signal);
        });

        // 等待一小段时间确保进程启动成功
        setTimeout(async () => {
          // macOS TUN 模式或 Windows TUN 模式：检查 singboxPid（从 PID 文件读取）
          // 其他模式：检查 singboxProcess 和 pid
          const isMacTunMode = this.needsOsascript();
          const isWindowsTunMode = this.needsWindowsUAC();

          if (isMacTunMode || isWindowsTunMode) {
            // TUN 模式：等待 PID 文件被写入
            await this.waitForPidFile();

            if (this.singboxPid) {
              // 启动日志文件监控（macOS 和 Windows TUN 模式都需要，因为后台进程的 stdout 无法被捕获）
              this.startLogFileWatcher();
              // 启动健康检查定时器
              this.startHealthCheck();

              // 触发启动事件
              this.emit('started');
              this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STARTED, {
                pid: this.singboxPid,
                startTime: this.startTime,
              });
              this.logToManager('info', 'sing-box 进程启动成功');
              resolve();
            } else {
              const error = '启动 sing-box 进程失败：无法获取进程 PID';
              this.logToManager('error', error);
              // 启动失败，清理状态，避免健康检查使用错误的 PID
              this.cleanup();
              reject(new Error(error));
            }
          } else {
            // 系统代理模式或 Linux
            if (this.singboxProcess && this.pid) {
              // 启动健康检查定时器
              this.startHealthCheck();

              // 触发启动事件
              this.emit('started');
              this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STARTED, {
                pid: this.pid,
                startTime: this.startTime,
              });
              this.logToManager('info', 'sing-box 进程启动成功');
              resolve();
            } else {
              const error = '启动 sing-box 进程失败：进程未能正常启动';
              this.logToManager('error', error);
              // 启动失败，清理状态
              this.cleanup();
              reject(new Error(error));
            }
          }
        }, 1000);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logToManager('error', `启动 sing-box 进程时发生异常: ${errorMessage}`);
        // 异常时也要清理状态
        this.cleanup();
        reject(error);
      }
    });
  }

  /**
   * 解析进程启动错误
   */
  private parseLaunchError(error: Error): string {
    const errorCode = (error as NodeJS.ErrnoException).code;

    switch (errorCode) {
      case 'ENOENT':
        return '找不到 sing-box 可执行文件，请检查安装是否完整';
      case 'EACCES':
        return 'sing-box 可执行文件没有执行权限，请检查文件权限';
      case 'EPERM':
        return '权限不足，无法启动 sing-box 进程。TUN 模式需要管理员权限';
      default:
        return `启动 sing-box 进程失败: ${error.message}`;
    }
  }

  /**
   * 解析启动阶段的错误
   */
  private parseStartupError(exitCode: number, errorOutput: string): string {
    // 首先尝试从错误输出中提取有用信息
    if (errorOutput) {
      const lowerOutput = errorOutput.toLowerCase();

      if (lowerOutput.includes('permission denied') || lowerOutput.includes('access denied')) {
        return `TUN 模式需要管理员权限，请以管理员身份运行应用 [${errorOutput}]`;
      }

      if (lowerOutput.includes('address already in use') || lowerOutput.includes('bind')) {
        return `端口已被占用，请在设置中更换其他端口或关闭占用端口的程序 [${errorOutput}]`;
      }

      if (
        lowerOutput.includes('invalid config') ||
        lowerOutput.includes('parse') ||
        lowerOutput.includes('json')
      ) {
        return `sing-box 配置文件格式错误，请检查服务器配置 [${errorOutput}]`;
      }

      if (lowerOutput.includes('connection refused') || lowerOutput.includes('dial')) {
        return `无法连接到代理服务器，请检查服务器地址和端口 [${errorOutput}]`;
      }

      if (lowerOutput.includes('certificate') || lowerOutput.includes('tls')) {
        return `TLS 证书验证失败，请检查服务器 TLS 配置 [${errorOutput}]`;
      }

      // 如果有具体的错误信息，翻译后返回
      const friendlyMessage = this.translateErrorMessage(errorOutput);
      if (friendlyMessage !== errorOutput) {
        return `sing-box 启动失败: ${friendlyMessage}`;
      }
    }

    // 根据退出码返回通用错误信息
    switch (exitCode) {
      case 1:
        return 'sing-box 启动失败，请检查配置文件和服务器设置';
      case 2:
        return 'sing-box 配置文件格式错误，请检查服务器配置';
      case 126:
        return 'sing-box 可执行文件没有执行权限';
      case 127:
        return '找不到 sing-box 可执行文件';
      default:
        return `sing-box 启动失败，退出码: ${exitCode}`;
    }
  }

  /**
   * 停止 sing-box 进程
   */
  private async stopSingBoxProcess(): Promise<void> {
    // macOS TUN 模式：sing-box 以 root 权限在后台运行，需要用 osascript 终止
    if (this.singboxPid && process.platform === 'darwin') {
      return this.stopSingBoxWithSudo();
    }

    // Windows TUN 模式：sing-box 以管理员权限在后台运行，使用 taskkill 终止
    if (this.singboxPid && process.platform === 'win32') {
      return this.stopSingBoxOnWindows();
    }

    if (!this.singboxProcess) {
      return;
    }

    return new Promise((resolve) => {
      const proc = this.singboxProcess!;

      // 设置超时强制终止
      const killTimeout = setTimeout(() => {
        if (proc.killed === false) {
          console.warn('sing-box process did not exit gracefully, force killing');
          proc.kill('SIGKILL');
        }
      }, 5000);

      // 监听退出事件
      proc.once('exit', () => {
        clearTimeout(killTimeout);
        this.cleanup();
        resolve();
      });

      // 发送 SIGTERM 信号优雅终止
      proc.kill('SIGTERM');
    });
  }

  /**
   * 使用 sudo 停止 sing-box 进程（macOS TUN 模式）
   */
  private async stopSingBoxWithSudo(): Promise<void> {
    if (!this.singboxPid) {
      this.cleanup();
      return;
    }

    const pidToKill = this.singboxPid;
    this.logToManager('info', `正在停止 sing-box 进程 (PID: ${pidToKill})...`);

    return new Promise((resolve) => {
      // 先尝试 SIGTERM 优雅终止
      const killProcess = spawn('/usr/bin/osascript', [
        '-e',
        `do shell script "kill -TERM ${pidToKill}" with administrator privileges`,
      ]);

      killProcess.on('exit', async (code) => {
        if (code === 0) {
          // 等待进程退出
          await this.waitForProcessExit(pidToKill, 3000);

          // 检查进程是否真的退出了
          if (this.isProcessAlive(pidToKill)) {
            this.logToManager('warn', '进程未响应 SIGTERM，尝试强制终止...');
            await this.forceKillProcess(pidToKill);
          } else {
            this.logToManager('info', 'sing-box 进程已停止');
          }
        } else {
          this.logToManager('warn', `停止 sing-box 进程可能失败，退出码: ${code}`);
          // 尝试强制终止
          await this.forceKillProcess(pidToKill);
        }

        // 清理 PID 文件
        const fsSync = require('fs');
        try {
          fsSync.unlinkSync(this.getPidFilePath());
        } catch {
          // 忽略错误
        }

        this.cleanup();

        // 触发停止事件
        this.emit('stopped');
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});

        resolve();
      });

      killProcess.on('error', async (error) => {
        this.logToManager('error', `停止 sing-box 进程失败: ${error.message}`);
        // 尝试强制终止
        await this.forceKillProcess(pidToKill);
        this.cleanup();
        resolve();
      });
    });
  }

  /**
   * 停止 sing-box 进程（Windows TUN 模式）
   * sing-box 以管理员权限（UAC）启动，停止时也需要管理员权限
   * 使用 PowerShell Start-Process -Verb RunAs 来请求 UAC 权限执行 taskkill
   */
  private async stopSingBoxOnWindows(): Promise<void> {
    if (!this.singboxPid) {
      this.cleanup();
      return;
    }

    const pidToKill = this.singboxPid;
    this.logToManager('info', `正在停止 sing-box 进程 (PID: ${pidToKill})，需要管理员权限...`);

    return new Promise((resolve) => {
      // 直接使用 PowerShell 以管理员权限执行 taskkill
      // sing-box 以 UAC 启动，必须用 UAC 权限才能终止
      const psScript =
        "Start-Process -FilePath 'taskkill' -ArgumentList '/F','/PID','" +
        pidToKill.toString() +
        "' -Verb RunAs -Wait -WindowStyle Hidden";

      const killProcess = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
        {
          windowsHide: true,
        }
      );

      killProcess.stderr?.on('data', (data) => {
        this.logToManager('warn', `taskkill stderr: ${data.toString()}`);
      });

      killProcess.on('exit', (code) => {
        if (code === 0) {
          this.logToManager('info', 'sing-box 进程已停止');
        } else {
          // 非零退出码可能是进程已退出或用户取消 UAC
          this.logToManager('warn', `停止进程结果: code=${code}`);
        }

        // 清理 PID 文件
        const fsSync = require('fs');
        try {
          fsSync.unlinkSync(this.getPidFilePath());
        } catch {
          // 忽略错误
        }

        this.cleanup();

        // 触发停止事件
        this.emit('stopped');
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});

        resolve();
      });

      killProcess.on('error', (error) => {
        this.logToManager('error', `停止 sing-box 进程失败: ${error.message}`);
        this.cleanup();
        resolve();
      });
    });
  }

  /**
   * 等待进程退出
   */
  private async waitForProcessExit(pid: number, timeout: number): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (!this.isProcessAlive(pid)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !this.isProcessAlive(pid);
  }

  /**
   * 强制终止进程
   */
  private async forceKillProcess(pid: number): Promise<void> {
    return new Promise((resolve) => {
      const killProcess = spawn('/usr/bin/osascript', [
        '-e',
        `do shell script "kill -9 ${pid}" with administrator privileges`,
      ]);

      killProcess.on('close', () => {
        resolve();
      });

      killProcess.on('error', () => {
        // 最后尝试普通 kill
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // 忽略错误
        }
        resolve();
      });
    });
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    this.stopLogFileWatcher();
    this.stopHealthCheck();
    this.singboxProcess = null;
    this.pid = null;
    this.singboxPid = null;
    this.startTime = null;
  }

  /**
   * 清理可能残留的 sing-box 进程
   * 这是解决"重启代理后网络不恢复"问题的关键
   */
  private async killOrphanedSingBoxProcesses(): Promise<void> {
    if (process.platform === 'darwin') {
      await this.killOrphanedProcessesMac();
    } else if (process.platform === 'win32') {
      await this.killOrphanedProcessesWindows();
    }
  }

  /**
   * macOS: 清理残留的 sing-box 进程
   * 优化：排除当前正在管理的进程，避免误杀
   *
   * 注意：TUN 模式下 sing-box 以 root 权限运行，必须用 osascript 请求管理员权限才能终止
   */
  private async killOrphanedProcessesMac(): Promise<void> {
    return new Promise((resolve) => {
      // 使用 pgrep 查找所有 sing-box 进程
      const pgrep = spawn('/usr/bin/pgrep', ['-f', 'sing-box']);
      let pids = '';

      pgrep.stdout.on('data', (data: Buffer) => {
        pids += data.toString();
      });

      pgrep.on('close', async () => {
        let pidList = pids
          .trim()
          .split('\n')
          .filter((p) => p.trim())
          .map((p) => parseInt(p.trim(), 10))
          .filter((p) => !isNaN(p) && p > 0);

        // 排除当前正在管理的进程（避免误杀）
        const currentPid = this.singboxPid || this.pid;
        if (currentPid) {
          pidList = pidList.filter((p) => p !== currentPid);
        }

        if (pidList.length === 0) {
          resolve();
          return;
        }

        this.logToManager(
          'warn',
          `发现 ${pidList.length} 个残留的 sing-box 进程，正在清理: ${pidList.join(', ')}`
        );

        // TUN 模式下 sing-box 以 root 权限运行，必须用 osascript 请求管理员权限终止
        const killCmd = pidList.map((p) => `kill -9 ${p}`).join('; ');
        const killProcess = spawn('/usr/bin/osascript', [
          '-e',
          `do shell script "${killCmd}" with administrator privileges`,
        ]);

        killProcess.on('close', async (code) => {
          if (code === 0) {
            this.logToManager('info', '残留进程已清理');
          } else {
            this.logToManager('warn', `清理残留进程可能失败，退出码: ${code}`);
          }
          // 等待系统完全清理 TUN 接口和路由表
          await this.waitForNetworkCleanup();
          resolve();
        });

        killProcess.on('error', async (error) => {
          this.logToManager('warn', `清理残留进程失败: ${error.message}`);
          await this.waitForNetworkCleanup();
          resolve();
        });
      });

      pgrep.on('error', () => {
        resolve();
      });
    });
  }

  /**
   * 等待网络清理完成
   * sing-box 进程终止后，系统需要时间清理 TUN 接口和路由表
   */
  private async waitForNetworkCleanup(): Promise<void> {
    // 等待 2 秒让系统清理 TUN 接口
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 可选：刷新 DNS 缓存（macOS）
    if (process.platform === 'darwin') {
      try {
        const { exec } = require('child_process');
        exec('dscacheutil -flushcache; killall -HUP mDNSResponder', (error: Error | null) => {
          if (error) {
            this.logToManager('debug', `刷新 DNS 缓存失败: ${error.message}`);
          } else {
            this.logToManager('debug', 'DNS 缓存已刷新');
          }
        });
      } catch {
        // 忽略错误
      }
    }
  }

  /**
   * Windows: 清理残留的 sing-box 进程
   * 优化：排除当前正在管理的进程，避免误杀
   */
  private async killOrphanedProcessesWindows(): Promise<void> {
    return new Promise((resolve) => {
      const { execSync } = require('child_process');

      try {
        // 使用 wmic 获取所有 sing-box.exe 进程的 PID
        const result = execSync(
          'wmic process where "name=\'sing-box.exe\'" get ProcessId /format:list',
          {
            encoding: 'utf-8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
          }
        );

        // 解析 PID 列表
        const pidMatches = result.match(/ProcessId=(\d+)/g);
        if (!pidMatches || pidMatches.length === 0) {
          resolve();
          return;
        }

        let pidList = pidMatches
          .map((m: string) => parseInt(m.replace('ProcessId=', ''), 10))
          .filter((p: number) => !isNaN(p) && p > 0);

        // 排除当前正在管理的进程
        const currentPid = this.singboxPid || this.pid;
        if (currentPid) {
          pidList = pidList.filter((p: number) => p !== currentPid);
        }

        if (pidList.length === 0) {
          resolve();
          return;
        }

        this.logToManager(
          'warn',
          `发现 ${pidList.length} 个残留的 sing-box 进程，正在清理: ${pidList.join(', ')}`
        );

        // 逐个终止进程
        for (const pid of pidList) {
          try {
            execSync(`taskkill /F /PID ${pid}`, {
              windowsHide: true,
              stdio: 'ignore',
            });
          } catch {
            // 忽略单个进程终止失败
          }
        }

        this.logToManager('info', '残留进程已清理');

        // 等待一小段时间让系统清理
        setTimeout(resolve, 500);
      } catch {
        // wmic 命令失败，可能没有残留进程
        resolve();
      }
    });
  }

  /**
   * 检查进程是否存活
   *
   * 统一使用系统命令检测进程，避免 Node.js process.kill(pid, 0) 在检测
   * 特权进程时的不可靠性（macOS/Windows TUN 模式下 sing-box 以管理员权限运行）
   */
  private isProcessAlive(pid: number): boolean {
    try {
      const { execSync } = require('child_process');

      if (process.platform === 'win32') {
        // Windows: 使用 tasklist 检测进程
        // /FI "PID eq xxx" 过滤指定 PID，/NH 不显示表头
        const result = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
          encoding: 'utf-8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        // 如果进程存在，输出会包含进程信息；不存在则输出 "INFO: No tasks..."
        return !result.includes('No tasks') && result.includes(String(pid));
      } else {
        // macOS/Linux: 使用 ps 检测进程
        const result = execSync(`ps -p ${pid} -o pid=`, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return result.trim() === String(pid);
      }
    } catch {
      // 命令执行失败，进程不存在
      return false;
    }
  }

  /**
   * 启动健康检查定时器
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      return;
    }

    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, ProxyManager.HEALTH_CHECK_INTERVAL);

    this.logToManager('debug', '已启动进程健康检查');
  }

  /**
   * 停止健康检查定时器
   */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * 执行健康检查
   */
  private performHealthCheck(): void {
    // 如果正在重启中，跳过检查
    if (this.isRestarting) {
      return;
    }

    // TUN 模式下只检查 singboxPid（sing-box 的实际 PID）
    // 系统代理模式下检查 pid（直接启动的进程 PID）
    // 注意：TUN 模式下 this.pid 是 osascript/PowerShell 的 PID，不是 sing-box 的
    const isTunMode = this.currentConfig?.proxyModeType === 'tun';
    const activePid = isTunMode ? this.singboxPid : this.singboxPid || this.pid;

    if (!activePid) {
      return;
    }

    if (!this.isProcessAlive(activePid)) {
      // 尝试获取更多退出信息
      const exitInfo = this.getProcessExitInfo();
      this.logToManager(
        'error',
        `检测到 sing-box 进程 (PID: ${activePid}) 已意外退出${exitInfo ? `，${exitInfo}` : ''}`
      );

      // 清理资源（但不停止健康检查，因为可能要重启）
      this.singboxProcess = null;
      this.pid = null;
      this.singboxPid = null;
      this.stopLogFileWatcher();

      // 尝试自动重启
      if (this.shouldAutoRestart()) {
        this.attemptAutoRestart();
      } else {
        // 无法自动重启，通知用户
        this.emit('error', {
          message: 'sing-box 进程意外退出，已达到最大重启次数，请手动重启',
          code: -1,
        });

        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
          message: 'sing-box 进程多次异常退出，请检查网络或服务器配置后手动重启',
          code: -1,
        });

        this.emit('stopped');
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});

        // 完全清理
        this.cleanup();
      }
    }
  }

  /**
   * 检查是否应该自动重启
   */
  private shouldAutoRestart(): boolean {
    if (!this.autoRestartEnabled || !this.currentConfig) {
      return false;
    }

    const now = Date.now();

    // 如果距离上次重启超过冷却时间，重置计数
    if (now - this.lastRestartTime > ProxyManager.RESTART_COOLDOWN) {
      this.restartCount = 0;
    }

    // 检查是否超过最大重启次数
    return this.restartCount < ProxyManager.MAX_RESTART_COUNT;
  }

  /**
   * 尝试自动重启
   */
  private async attemptAutoRestart(): Promise<void> {
    if (!this.currentConfig) {
      return;
    }

    this.isRestarting = true;
    this.restartCount++;
    this.lastRestartTime = Date.now();

    this.logToManager(
      'warn',
      `正在尝试自动重启 sing-box (第 ${this.restartCount}/${ProxyManager.MAX_RESTART_COUNT} 次)...`
    );

    // 通知前端正在重启
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
      message: `sing-box 进程异常退出，正在自动重启 (${this.restartCount}/${ProxyManager.MAX_RESTART_COUNT})...`,
      code: -2, // 特殊代码表示正在重启
    });

    try {
      // 等待一小段时间让系统清理
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // 重新启动
      await this.start(this.currentConfig);

      this.logToManager('info', 'sing-box 自动重启成功');

      // 通知前端重启成功
      this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STARTED, {
        pid: this.singboxPid || this.pid,
        startTime: this.startTime,
        autoRestarted: true,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logToManager('error', `自动重启失败: ${errorMessage}`);

      // 如果还有重试机会，会在下次健康检查时再次尝试
      if (this.restartCount >= ProxyManager.MAX_RESTART_COUNT) {
        this.emit('error', {
          message: `自动重启失败: ${errorMessage}`,
          code: -1,
        });

        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
          message: `自动重启失败，请手动重启: ${errorMessage}`,
          code: -1,
        });

        this.emit('stopped');
        this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});
        this.cleanup();
      }
    } finally {
      this.isRestarting = false;
    }
  }

  /**
   * 设置是否启用自动重启
   */
  setAutoRestartEnabled(enabled: boolean): void {
    this.autoRestartEnabled = enabled;
    this.logToManager('info', `自动重启已${enabled ? '启用' : '禁用'}`);
  }

  /**
   * 重置重启计数（用于用户手动启动后）
   */
  private resetRestartCount(): void {
    this.restartCount = 0;
    this.lastRestartTime = 0;
  }

  /**
   * 获取进程退出信息（用于诊断）
   * 尝试从系统日志或 sing-box 日志文件中获取退出原因
   */
  private getProcessExitInfo(): string {
    const info: string[] = [];

    try {
      const fsSync = require('fs');
      const logFilePath = this.getLogFilePath();

      // 读取 sing-box 日志文件的最后几行
      if (fsSync.existsSync(logFilePath)) {
        const logContent = fsSync.readFileSync(logFilePath, 'utf-8');
        const lines = logContent.trim().split('\n');
        const lastLines = lines.slice(-10); // 最后 10 行

        // 查找错误或警告信息
        for (const line of lastLines) {
          const lowerLine = line.toLowerCase();
          if (
            lowerLine.includes('error') ||
            lowerLine.includes('fatal') ||
            lowerLine.includes('panic') ||
            lowerLine.includes('failed')
          ) {
            info.push(`日志: ${line.substring(0, 200)}`);
          }
        }
      }

      // macOS: 尝试从系统日志获取信息
      if (process.platform === 'darwin') {
        const { execSync } = require('child_process');
        try {
          // 查询最近的 sing-box 相关系统日志
          const sysLog = execSync(
            `log show --predicate 'process == "sing-box"' --last 1m --style compact 2>/dev/null | tail -5`,
            { encoding: 'utf-8', timeout: 3000 }
          ).trim();
          if (sysLog) {
            info.push(`系统日志: ${sysLog.substring(0, 300)}`);
          }
        } catch {
          // 忽略系统日志查询失败
        }
      }
    } catch {
      // 忽略诊断错误
    }

    return info.length > 0 ? info.join('; ') : '';
  }

  /**
   * 等待 PID 文件被写入（macOS/Windows TUN 模式）
   *
   * 重要：在调用此方法前，必须先删除旧的 PID 文件，否则可能读到旧的 PID
   */
  private async waitForPidFile(): Promise<void> {
    const pidFile = this.getPidFilePath();
    const maxWaitTime = 60000; // 最多等待 60 秒（给 macOS 权限提升过程留足时间）
    const checkInterval = 200; // 每 200ms 检查一次
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const pidContent = await fs.readFile(pidFile, 'utf-8');
        const pid = parseInt(pidContent.trim(), 10);
        if (!isNaN(pid) && pid > 0) {
          // 验证这个 PID 对应的进程确实存在且是 sing-box
          if (this.isProcessAlive(pid)) {
            this.singboxPid = pid;
            this.pid = pid;
            this.logToManager('info', `sing-box 后台进程 PID: ${pid}`);
            return;
          }
        }
      } catch {
        // 文件还不存在，继续等待
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    this.logToManager('warn', 'PID 文件等待超时');
  }

  /**
   * 删除 PID 文件
   * 在启动新进程前调用，确保不会读到旧的 PID
   */
  private async deletePidFile(): Promise<void> {
    try {
      await fs.unlink(this.getPidFilePath());
    } catch {
      // 文件不存在，忽略
    }
  }

  /**
   * 获取 PID 文件路径
   */
  private getPidFilePath(): string {
    return path.join(getUserDataPath(), 'singbox.pid');
  }

  /**
   * 将规则文件复制到 User Data 目录
   * 解决 macOS TUN 模式下特权进程无法读取 Downloads/Documents 目录的问题
   */
  private async copyRuleSetsToUserData(): Promise<void> {
    const rulesDir = path.join(getUserDataPath(), 'rules');

    // 确保目录存在
    try {
      if (!require('fs').existsSync(rulesDir)) {
        require('fs').mkdirSync(rulesDir, { recursive: true });
      }
    } catch (error) {
      this.logToManager('error', `创建规则目录失败: ${error}`);
      return;
    }

    const filesToCopy = [
      { src: resourceManager.getGeoSiteCNPath(), dest: 'geosite-cn.srs' },
      { src: resourceManager.getGeoSiteNonCNPath(), dest: 'geosite-geolocation-!cn.srs' },
      { src: resourceManager.getGeoIPPath(), dest: 'geoip-cn.srs' },
    ];

    const fs = require('fs/promises');

    for (const file of filesToCopy) {
      try {
        const destPath = path.join(rulesDir, file.dest);

        // 检查源文件是否存在
        if (!require('fs').existsSync(file.src)) {
          this.logToManager('warn', `源规则文件不存在: ${file.src}`);
          continue;
        }

        // 复制文件（覆盖）
        await fs.copyFile(file.src, destPath);
        // this.logToManager('debug', `已复制规则文件: ${file.dest}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logToManager('error', `复制规则文件失败 ${file.dest}: ${errorMessage}`);
      }
    }
  }

  /**
   * 启动日志文件监控（用于 macOS TUN 模式）
   */
  private startLogFileWatcher(): void {
    if (this.logFileWatcher) {
      return;
    }

    const logFilePath = this.getLogFilePath();
    this.lastLogFileSize = 0;

    // 清空旧的日志文件
    const fsSync = require('fs');
    try {
      fsSync.writeFileSync(logFilePath, '');
    } catch {
      // 忽略错误
    }

    // 每 500ms 检查一次日志文件
    this.logFileWatcher = setInterval(async () => {
      try {
        const stats = await fs.stat(logFilePath);

        // 如果文件大小变小了，说明文件被清空或截断了
        if (stats.size < this.lastLogFileSize) {
          this.lastLogFileSize = 0;
        }

        if (stats.size > this.lastLogFileSize) {
          // 读取新增的内容
          const fd = await fs.open(logFilePath, 'r');
          const buffer = Buffer.alloc(stats.size - this.lastLogFileSize);
          await fd.read(buffer, 0, buffer.length, this.lastLogFileSize);
          await fd.close();

          const newContent = buffer.toString('utf-8');
          this.lastLogFileSize = stats.size;

          // 处理日志内容
          if (newContent.trim()) {
            this.handleProcessOutput(newContent);
          }
        }
      } catch {
        // 文件可能还不存在，忽略错误
      }
    }, 500);
  }

  /**
   * 停止日志文件监控
   */
  private stopLogFileWatcher(): void {
    if (this.logFileWatcher) {
      clearInterval(this.logFileWatcher);
      this.logFileWatcher = null;
    }
    this.lastLogFileSize = 0;
  }

  /**
   * 处理进程输出
   */
  private handleProcessOutput(data: string): void {
    // 移除 ANSI 颜色代码
    const cleanData = this.removeAnsiCodes(data);

    // 按行分割
    const lines = cleanData.split('\n').filter((line) => line.trim());

    for (const line of lines) {
      this.parseAndLogLine(line);
    }
  }

  /**
   * 移除 ANSI 颜色代码
   */
  private removeAnsiCodes(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*m/g, '');
  }

  /**
   * 解析并记录日志行
   */
  private parseAndLogLine(line: string): void {
    // 过滤重复日志
    if (this.isDuplicateLog(line)) {
      return;
    }

    // 过滤低价值日志（连接建立、DNS 查询等频繁日志）
    if (this.isLowValueLog(line)) {
      return;
    }

    // 解析 sing-box 日志格式
    const logInfo = this.parseSingBoxLog(line);

    if (logInfo) {
      // 先翻译消息中的代理标签
      const resolvedMessage = this.resolveTagsToNames(logInfo.message);

      // 再转换为友好的中文提示
      const friendlyMessage = this.translateErrorMessage(resolvedMessage);

      // 空消息不记录（如私有 IP 超时）
      if (friendlyMessage) {
        this.logToManager(logInfo.level, friendlyMessage);
      }
    } else {
      // 无法解析的日志，尝试对原始行也进行标签转换
      const resolvedLine = this.resolveTagsToNames(line);
      this.logToManager('info', resolvedLine);
    }
  }

  /**
   * 检查是否为低价值日志（应该被过滤）
   * 保留：路由决策、错误、启动/停止等重要日志
   * 过滤：频繁的连接关闭、握手细节等日志
   */
  private isLowValueLog(line: string): boolean {
    const lowerLine = line.toLowerCase();

    // 优先过滤的噪音日志（即使包含其他关键词也要过滤）
    const noisePatterns = [
      'connection upload closed',
      'connection download closed',
      'forcibly closed',
      'connection closed',
      'connection established',
      'tls handshake',
      'handshake completed',
    ];

    for (const pattern of noisePatterns) {
      if (lowerLine.includes(pattern)) {
        return true; // 过滤掉
      }
    }

    // 高价值日志模式 - 这些日志应该保留
    const keepPatterns = [
      'started', // 启动完成
      'stopped', // 停止
      'sing-box started', // sing-box 启动
      'error', // 错误
      'fatal', // 致命错误
      'warn', // 警告
      'failed', // 失败
      'updated default interface', // 网络接口变化
      // 路由决策相关 - 关键日志
      'match rule', // 匹配规则
      'final rule', // 最终规则
      'rule-set', // 规则集匹配
      'outbound/proxy', // 代理出站 - 用户关心的
    ];

    // 检查是否包含高价值模式
    for (const pattern of keepPatterns) {
      if (lowerLine.includes(pattern)) {
        return false; // 不过滤，保留这条日志
      }
    }

    // 检查是否为内网IP的直连连接（这些太频繁，需要过滤）
    if (lowerLine.includes('outbound/direct')) {
      // 检查是否连接到私有IP地址
      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(line)) {
          return true; // 过滤内网直连
        }
      }
      // 公网直连保留（如 CDN、国内网站等）
      return false;
    }

    // 过滤的低价值日志模式
    const filterPatterns = [
      'dns query', // DNS 查询
      'dns response', // DNS 响应
      'dns: exchanged', // DNS 交换
      'dns: cached', // DNS 缓存
      'resolved', // DNS 解析完成
      'udp packet', // UDP 包
      'inbound/tun[tun-in]', // TUN 入站细节
      'inbound/http[http-in]', // HTTP 入站细节
      'inbound/socks[socks-in]', // SOCKS 入站细节
    ];

    for (const pattern of filterPatterns) {
      if (lowerLine.includes(pattern)) {
        return true; // 过滤掉
      }
    }

    return false; // 默认保留
  }

  /** 最近处理过的日志消息，用于去重，最多缓存 10 条 */
  private recentLogHistory: string[] = [];

  /**
   * 检查是否为重复日志
   */
  private isDuplicateLog(message: string): boolean {
    const now = Date.now();
    const trimmedMessage = message.trim();

    // 过滤掉日志中的时间戳部分进行对比（例如：+0800 2026-04-05 12:05:01 ）
    // 这样即便 stdout 和 logFile 的时间戳有微秒级差异，也能正确去重
    const stripTimestamp = (msg: string) =>
      msg.replace(/\+\d{4}\s\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}\s/, '');
    const cleanMessage = stripTimestamp(trimmedMessage);

    // 1. 如果新消息与缓冲区中的任意消息内容（忽略时间戳）相同，则认为是重复
    const normalizedHistory = this.recentLogHistory.map((m) => stripTimestamp(m));
    if (normalizedHistory.includes(cleanMessage) && now - this.lastLogTime < 1000) {
      return true;
    }

    // 2. 特殊情况：如果消息完全相同且在 1 秒内（由于并发到达）
    if (trimmedMessage === this.lastLogMessage && now - this.lastLogTime < 1000) {
      this.lastLogCount++;
      if (this.lastLogCount > 1) return true;
    }

    // 新消息，入队并重置
    this.recentLogHistory.push(trimmedMessage);
    if (this.recentLogHistory.length > 10) {
      this.recentLogHistory.shift();
    }

    this.lastLogMessage = trimmedMessage;
    this.lastLogCount = 1;
    this.lastLogTime = now;

    return false;
  }

  /**
   * 解析 sing-box 日志
   */
  private parseSingBoxLog(
    line: string
  ): { level: 'debug' | 'info' | 'warn' | 'error' | 'fatal'; message: string } | null {
    // sing-box 日志格式示例：
    // 2024-01-01 12:00:00 INFO message
    // 2024-01-01 12:00:00 [INFO] message

    // 尝试匹配日志级别
    const levelMatch = line.match(/\b(DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/i);
    if (!levelMatch) {
      return null;
    }

    let level = levelMatch[1].toUpperCase();
    if (level === 'WARNING') {
      level = 'WARN';
    }

    // 提取消息内容（去掉时间戳和级别）
    const message = line
      .replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/, '')
      .replace(/\[?(DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\]?/i, '')
      .trim();

    return {
      level: level.toLowerCase() as 'debug' | 'info' | 'warn' | 'error' | 'fatal',
      message,
    };
  }

  /**
   * 将日志中的 proxy 标签（UUID 或 "proxy"）转换为人类可读的服务器名称
   */
  private resolveTagsToNames(message: string): string {
    if (!this.currentConfig || !this.currentConfig.servers) {
      return message;
    }

    let resolvedMessage = message;

    // 1. 处理这种格式：proxy-2cef4913-84f6-41f9-a251-d1f49767cef6
    const uuidPattern = /proxy-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
    resolvedMessage = resolvedMessage.replace(uuidPattern, (match, id) => {
      const server = this.currentConfig?.servers.find((s) => s.id === id);
      return server ? server.name : match;
    });

    // 2. 处理单独的 [proxy] 或 outbound/proxy 标识
    const selectedServer = this.currentConfig.servers.find(
      (s) => s.id === this.currentConfig?.selectedServerId
    );

    if (selectedServer) {
      // 替换方括号中的 [proxy]
      resolvedMessage = resolvedMessage.replace(/\[proxy\]/g, `[${selectedServer.name}]`);

      // 替换 outbound/proxy
      resolvedMessage = resolvedMessage.replace(
        /outbound\/proxy/g,
        `outbound/${selectedServer.name}`
      );

      // 替换 outbound: proxy
      resolvedMessage = resolvedMessage.replace(
        /outbound: proxy/g,
        `outbound: ${selectedServer.name}`
      );
    }

    return resolvedMessage;
  }

  /**
   * 翻译错误消息为友好的中文提示
   * 返回格式：友好提示 + 原始错误（如果有翻译）
   */
  private translateErrorMessage(message: string): string {
    console.error(message);
    const lowerMessage = message.toLowerCase();

    // 常见错误模式匹配
    if (lowerMessage.includes('report handshake success: connection refused')) {
      return `目标连接被拒绝：代理节点已连接，但目标服务器拒绝了连接（可能是节点限制或失效） [${message}]`;
    }

    if (
      lowerMessage.includes('connection refused') ||
      lowerMessage.includes('connect: connection refused')
    ) {
      return `连接被拒绝：无法连接到代理服务器，请检查服务器地址和端口是否正确 [${message}]`;
    }

    if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
      // 尝试提取目标地址
      const match = message.match(/connection.*?to\s+([^\s:]+(?::\d+)?)/i);
      const target = match ? match[1] : '';
      // 私有 IP 超时不显示（内网服务走代理必然超时）
      if (target && /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(target)) {
        return ''; // 返回空字符串，后续会被过滤
      }
      return target ? `连接超时: ${target}` : '连接超时：服务器响应超时';
    }

    if (lowerMessage.includes('dns') && lowerMessage.includes('fail')) {
      return `DNS 解析失败：无法解析服务器域名，请检查 DNS 设置 [${message}]`;
    }

    if (
      (lowerMessage.includes('certificate') ||
        lowerMessage.includes('tls') ||
        lowerMessage.includes('ssl')) &&
      !lowerMessage.includes('anytls') &&
      !lowerMessage.includes('shadowtls')
    ) {
      // 保留原始错误信息，帮助用户诊断具体的证书问题
      return `TLS 证书错误：服务器证书验证失败 [${message}]`;
    }

    if (lowerMessage.includes('authentication failed') || lowerMessage.includes('auth fail')) {
      return `认证失败：用户名或密码错误，请检查服务器配置 [${message}]`;
    }

    if (lowerMessage.includes('permission denied') || lowerMessage.includes('access denied')) {
      return `权限不足：需要管理员权限才能启动 TUN 模式 [${message}]`;
    }

    if (
      lowerMessage.includes('address already in use') ||
      lowerMessage.includes('bind: address already in use')
    ) {
      return `端口已被占用：请更换其他端口或关闭占用端口的程序 [${message}]`;
    }

    if (lowerMessage.includes('invalid config') || lowerMessage.includes('config error')) {
      return `配置错误：sing-box 配置文件格式不正确 [${message}]`;
    }

    // 如果没有匹配到特定错误，返回原始消息
    return message;
  }

  /**
   * 记录日志到 LogManager
   */
  private logToManager(
    level: 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: string
  ): void {
    if (this.logManager) {
      this.logManager.addLog(level, message, 'sing-box');
    }
  }

  /**
   * 处理进程错误
   */
  private handleProcessError(error: Error): void {
    const errorMessage = this.translateErrorMessage(error.message);

    // 触发错误事件
    this.emit('error', {
      message: errorMessage,
      error: error.message,
    });

    // 发送到前端
    this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
      message: errorMessage,
      error: error.message,
    });
  }

  /**
   * 处理进程退出
   */
  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    // 解析退出原因
    const exitReason = this.parseExitReason(code, signal);

    this.logToManager('info', `sing-box process exited: ${exitReason}`);

    // 如果是异常退出（非正常停止）
    if (code !== null && code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      const errorMessage = this.parseExitError(code);

      this.logToManager('error', `sing-box异常退出: ${errorMessage}`);

      // 触发错误事件
      this.emit('error', {
        message: errorMessage,
        code,
        signal,
      });

      // 发送到前端
      this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_ERROR, {
        message: errorMessage,
        code,
        signal,
      });
    } else {
      // 正常退出，触发停止事件
      this.emit('stopped');
      this.sendEventToRenderer(IPC_CHANNELS.EVENT_PROXY_STOPPED, {});
    }

    this.cleanup();
  }

  /**
   * 解析退出原因
   */
  private parseExitReason(code: number | null, signal: NodeJS.Signals | null): string {
    if (signal) {
      return `信号 ${signal}`;
    }
    if (code !== null) {
      return `退出码 ${code}`;
    }
    return '未知原因';
  }

  /**
   * 解析退出错误
   */
  private parseExitError(code: number): string {
    // 尝试从最后的错误输出中提取错误信息
    if (this.lastErrorOutput) {
      const friendlyMessage = this.translateErrorMessage(this.lastErrorOutput);
      if (friendlyMessage !== this.lastErrorOutput) {
        return friendlyMessage;
      }
    }

    // 根据退出码返回通用错误信息
    switch (code) {
      case 1:
        return 'sing-box 启动失败，请检查配置文件';
      case 2:
        return 'sing-box 配置文件格式错误';
      case 126:
        return 'sing-box 可执行文件没有执行权限';
      case 127:
        return '找不到 sing-box 可执行文件';
      case 137:
        return 'sing-box 进程被强制终止';
      case 143:
        return 'sing-box 进程被正常终止';
      default:
        return `sing-box 异常退出，退出码: ${code}`;
    }
  }

  /**
   * 发送事件到渲染进程
   */
  private sendEventToRenderer(channel: string, data: any): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * 获取 sing-box 可执行文件路径
   */
  private getSingBoxPath(): string {
    return resourceManager.getSingBoxPath();
  }

  /**
   * 设置系统代理
   */
  private async setSystemProxy(config: UserConfig): Promise<void> {
    const port = config.httpPort || 2080;
    const host = '127.0.0.1';

    this.logToManager('info', `正在设置系统代理 (${host}:${port})...`);

    if (process.platform === 'win32') {
      try {
        const { exec } = require('child_process');
        const runCommand = (cmd: string) =>
          new Promise((resolve, reject) => {
            exec(cmd, (error: any) => {
              if (error) reject(error);
              else resolve(null);
            });
          });

        // 启用代理
        await runCommand(
          `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f`
        );
        // 设置代理服务器
        await runCommand(
          `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "${host}:${port}" /f`
        );
        // 设置代理忽略列表（例外），对每个域名同时生成三种格式以最大化兼容性：
        //   *.domain.com → WinINet 标准格式（传统 C++ 应用如同花顺/网银客户端）
        //   *domain.com  → Chrome/Chromium 内核专用格式（无点前缀，解决 Chrome 不认带点通配符的问题）
        //   domain.com   → 精确根域名匹配（兜底，确保根域名本身也被旁路）
        const domainBypassEntries = DOMESTIC_BANK_AND_STOCK_DOMAINS.flatMap((d) => {
          const base = d.startsWith('.') ? d.slice(1) : d;
          return [`*.${base}`, `*${base}`, base];
        }).join(';');
        const bypassDomains =
          '<local>;localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;' +
          domainBypassEntries;
        await runCommand(
          `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride /t REG_SZ /d "${bypassDomains}" /f`
        );

        // 核心修复：修改注册表后必须通过 WinINet API 向操作系统发送刷新广播，否则各大浏览器和后台服务（包括网银插件）会一直使用旧的代理缓存，遇到重启必失效。
        const refreshCmd = `powershell -NoProfile -Command "$sig = '[DllImport(\\"wininet.dll\\")] public static extern bool InternetSetOption(int hInternet, int dwOption, int lpBuffer, int dwBufferLength);'; $type = Add-Type -MemberDefinition $sig -Name 'WinInet' -Namespace 'Proxy' -PassThru; $type::InternetSetOption(0, 39, 0, 0); $type::InternetSetOption(0, 37, 0, 0);"`;
        try {
          await runCommand(refreshCmd);
        } catch (e) {
          this.logToManager('warn', `WinINet 代理缓存刷新失败 (可能被阻止): ${e}`);
        }

        this.logToManager('info', 'Windows 系统代理已设置 (附带例外清单并刷新缓存)');
      } catch (error) {
        this.logToManager('error', `设置 Windows 系统代理失败: ${error}`);
      }
    } else if (process.platform === 'darwin') {
      try {
        const { execSync } = require('child_process');
        const socksPort = config.socksPort || 2081;

        // 动态获取所有网络服务名称，避免硬编码导致部分网卡失效
        const servicesOutput = execSync('networksetup -listallnetworkservices').toString();
        const services = servicesOutput
          .split('\n')
          .filter(
            (s: string) =>
              s &&
              !s.includes('*') &&
              s !== 'An asterisk (*) denotes that a network service is disabled.'
          );

        for (const service of services) {
          try {
            const s = service.trim();
            execSync(`networksetup -setwebproxy "${s}" ${host} ${port}`);
            execSync(`networksetup -setsecurewebproxy "${s}" ${host} ${port}`);
            execSync(`networksetup -setsocksfirewallproxy "${s}" ${host} ${socksPort}`);
          } catch {
            // ignore
          }
        }
        this.logToManager('info', 'macOS 系统代理已设置');
      } catch (error) {
        this.logToManager('error', `设置 macOS 系统代理失败: ${error}`);
      }
    }
  }

  /**
   * 取消系统代理
   */
  private async unsetSystemProxy(): Promise<void> {
    this.logToManager('info', '正在取消系统代理...');

    if (process.platform === 'win32') {
      try {
        const { exec } = require('child_process');
        const runCommand = (cmd: string) =>
          new Promise((resolve, reject) => {
            exec(cmd, (error: any) => {
              if (error) reject(error);
              else resolve(null);
            });
          });

        // 禁用代理
        await runCommand(
          `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`
        );

        // 核心修复：修改注册表后必须通过 WinINet API 向操作系统发送刷新广播
        const refreshCmd = `powershell -NoProfile -Command "$sig = '[DllImport(\\"wininet.dll\\")] public static extern bool InternetSetOption(int hInternet, int dwOption, int lpBuffer, int dwBufferLength);'; $type = Add-Type -MemberDefinition $sig -Name 'WinInet' -Namespace 'Proxy' -PassThru; $type::InternetSetOption(0, 39, 0, 0); $type::InternetSetOption(0, 37, 0, 0);"`;
        try {
          await runCommand(refreshCmd);
        } catch {
          // ignore
        }

        this.logToManager('info', 'Windows 系统代理已取消 (并刷新系统缓存)');
      } catch (error) {
        this.logToManager('error', `取消 Windows 系统代理失败: ${error}`);
      }
    } else if (process.platform === 'darwin') {
      try {
        const { execSync } = require('child_process');
        // 动态获取所有服务并关闭代理
        const servicesOutput = execSync('networksetup -listallnetworkservices').toString();
        const services = servicesOutput
          .split('\n')
          .filter(
            (s: string) =>
              s &&
              !s.includes('*') &&
              s !== 'An asterisk (*) denotes that a network service is disabled.'
          );

        for (const service of services) {
          try {
            const s = service.trim();
            execSync(`networksetup -setwebproxystate "${s}" off`);
            execSync(`networksetup -setsecurewebproxystate "${s}" off`);
            execSync(`networksetup -setsocksfirewallproxystate "${s}" off`);
          } catch {
            // ignore
          }
        }
        this.logToManager('info', 'macOS 系统代理已取消');
      } catch (error) {
        this.logToManager('error', `取消 macOS 系统代理失败: ${error}`);
      }
    }
  }
}
