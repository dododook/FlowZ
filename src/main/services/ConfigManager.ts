/**
 * 配置管理服务
 * 负责用户配置的加载、保存、验证和管理
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { UserConfig } from '../../shared/types';
import { getConfigPath } from '../utils/paths';

export interface IConfigManager {
  loadConfig(): Promise<UserConfig>;
  saveConfig(config: UserConfig): Promise<void>;
  get<T>(key: keyof UserConfig): T | undefined;
  set(key: keyof UserConfig, value: any): Promise<void>;
  validateConfig(config: UserConfig): void;
  getConfigPath(): string;
}

export class ConfigManager implements IConfigManager {
  private configPath: string;
  private currentConfig: UserConfig | null = null;

  constructor(customConfigPath?: string) {
    if (customConfigPath) {
      this.configPath = customConfigPath;
    } else {
      // 使用统一的路径工具，确保始终使用正确的用户数据路径
      this.configPath = getConfigPath();
    }
  }

  /**
   * 获取配置文件路径
   */
  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * 加载配置文件
   * 如果文件不存在或损坏，返回默认配置
   */
  async loadConfig(): Promise<UserConfig> {
    try {
      // 检查配置文件是否存在
      await fs.access(this.configPath);

      // 读取配置文件
      const content = await fs.readFile(this.configPath, 'utf-8');
      const config = JSON.parse(content) as UserConfig;

      // 验证配置
      this.validateConfig(config);

      // 缓存配置
      this.currentConfig = config;

      return config;
    } catch (error) {
      // 文件不存在或解析失败，返回默认配置
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn('配置文件加载失败，使用默认配置:', errorMessage);

      // 记录详细错误信息
      if (error instanceof SyntaxError) {
        console.error('配置文件 JSON 格式错误:', errorMessage);
      } else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.info('配置文件不存在，将创建默认配置');
      } else if ((error as NodeJS.ErrnoException).code === 'EACCES') {
        console.error('配置文件权限不足，无法读取');
      } else {
        console.error('配置验证失败:', errorMessage);
      }

      const defaultConfig = this.createDefaultConfig();
      this.currentConfig = defaultConfig;

      // 尝试保存默认配置
      try {
        await this.saveConfig(defaultConfig);
        console.info('默认配置已保存到:', this.configPath);
      } catch (saveError) {
        console.error('保存默认配置失败:', saveError);
        // 即使保存失败，也返回默认配置，让应用继续运行
      }

      return defaultConfig;
    }
  }

  /**
   * 保存配置文件
   */
  async saveConfig(config: UserConfig): Promise<void> {
    // 验证配置
    this.validateConfig(config);

    // 确保配置目录存在
    const configDir = path.dirname(this.configPath);
    await fs.mkdir(configDir, { recursive: true });

    // 写入配置文件
    const content = JSON.stringify(config, null, 2);
    await fs.writeFile(this.configPath, content, 'utf-8');

    // 设置文件权限（仅所有者可读写）
    if (process.platform !== 'win32') {
      await fs.chmod(this.configPath, 0o600);
    }

    // 更新缓存
    this.currentConfig = config;
  }

  /**
   * 获取配置项
   */
  get<T>(key: keyof UserConfig): T | undefined {
    if (!this.currentConfig) {
      return undefined;
    }
    return this.currentConfig[key] as T;
  }

  /**
   * 设置配置项
   */
  async set(key: keyof UserConfig, value: any): Promise<void> {
    if (!this.currentConfig) {
      this.currentConfig = this.createDefaultConfig();
    }

    // 更新配置项
    (this.currentConfig as any)[key] = value;

    // 保存配置
    await this.saveConfig(this.currentConfig);
  }

  /**
   * 验证配置有效性
   */
  validateConfig(config: UserConfig): void {
    // 验证必填字段
    if (!config) {
      throw new Error('Config is null or undefined');
    }

    // 自动迁移：强制将旧版本默认的高位端口（65533/65534）升级为标准端口（2080/2081）
    // 解决方法：如果用户当前设置的是旧默认值，自动将其重置为新默认值
    if (config.httpPort === 65533 || !config.httpPort) {
      config.httpPort = 2080;
    }
    if (config.socksPort === 65534 || !config.socksPort) {
      config.socksPort = 2081;
    }

    // 验证 subscriptions 数组 (兼容旧配置)
    if (config.subscriptions) {
      if (!Array.isArray(config.subscriptions)) {
        throw new Error('subscriptions must be an array');
      }
      for (const sub of config.subscriptions) {
        if (!sub.id || typeof sub.id !== 'string') {
          throw new Error('Subscription id is required and must be a string');
        }
        if (!sub.name || typeof sub.name !== 'string') {
          throw new Error('Subscription name is required and must be a string');
        }
        if (!sub.url || typeof sub.url !== 'string') {
          throw new Error('Subscription url is required and must be a string');
        }
      }
    } else {
      config.subscriptions = [];
    }

    // 验证 servers 数组
    if (!Array.isArray(config.servers)) {
      throw new Error('servers must be an array');
    }

    // 验证每个服务器配置
    for (const server of config.servers) {
      if (!server.id || typeof server.id !== 'string') {
        throw new Error('Server id is required and must be a string');
      }
      if (!server.name || typeof server.name !== 'string') {
        throw new Error('Server name is required and must be a string');
      }
      const protocolLower = server.protocol?.toLowerCase();
      if (
        !protocolLower ||
        ![
          'vless',
          'vmess',
          'trojan',
          'hysteria2',
          'shadowsocks',
          'anytls',
          'tuic',
          'naive',
          'socks',
          'http',
        ].includes(protocolLower)
      ) {
        throw new Error(
          'Server protocol must be vless, vmess, trojan, hysteria2, shadowsocks, anytls, tuic, naive, socks, or http'
        );
      }
      if (!server.address || typeof server.address !== 'string') {
        throw new Error('Server address is required and must be a string');
      }
      if (
        !server.port ||
        typeof server.port !== 'number' ||
        server.port < 1 ||
        server.port > 65535
      ) {
        throw new Error('Server port must be a number between 1 and 65535');
      }

      // VLESS 特定验证
      if (protocolLower === 'vless') {
        if (!server.uuid || typeof server.uuid !== 'string') {
          throw new Error('VLESS server requires uuid');
        }
      }

      // VMess 特定验证
      if (protocolLower === 'vmess') {
        if (!server.uuid || typeof server.uuid !== 'string') {
          throw new Error('VMess server requires uuid');
        }
      }

      // Trojan 特定验证
      if (protocolLower === 'trojan') {
        if (!server.password || typeof server.password !== 'string') {
          throw new Error('Trojan server requires password');
        }
      }

      // Hysteria2 特定验证
      if (protocolLower === 'hysteria2') {
        if (!server.password || typeof server.password !== 'string') {
          throw new Error('Hysteria2 server requires password');
        }
      }

      // TUIC 特定验证
      if (protocolLower === 'tuic') {
        if (!server.uuid || typeof server.uuid !== 'string') {
          throw new Error('TUIC server requires uuid');
        }
        if (!server.password || typeof server.password !== 'string') {
          throw new Error('TUIC server requires password');
        }
      }

      // Naive 特定验证
      if (protocolLower === 'naive') {
        if (!server.username || typeof server.username !== 'string') {
          throw new Error('Naive server requires username');
        }
        if (!server.password || typeof server.password !== 'string') {
          throw new Error('Naive server requires password');
        }
      }

      // Shadowsocks 特定验证
      if (protocolLower === 'shadowsocks') {
        if (!server.shadowsocksSettings) {
          throw new Error('Shadowsocks server requires shadowsocksSettings');
        }
        if (
          !server.shadowsocksSettings.method ||
          typeof server.shadowsocksSettings.method !== 'string'
        ) {
          throw new Error('Shadowsocks server requires encryption method');
        }
        if (
          !server.shadowsocksSettings.password ||
          typeof server.shadowsocksSettings.password !== 'string'
        ) {
          throw new Error('Shadowsocks server requires password');
        }
      }
    }

    // 验证 selectedServerId
    if (config.selectedServerId !== null) {
      if (typeof config.selectedServerId !== 'string') {
        throw new Error('selectedServerId must be a string or null');
      }
      // 检查服务器是否存在
      const serverExists = config.servers.some((s) => s.id === config.selectedServerId);
      if (!serverExists) {
        throw new Error('selectedServerId references a non-existent server');
      }
    }

    // 验证 proxyMode（不区分大小写）
    const proxyModeLower = config.proxyMode?.toLowerCase();
    if (!proxyModeLower || !['global', 'smart', 'direct'].includes(proxyModeLower)) {
      throw new Error('proxyMode must be global, smart, or direct');
    }

    // 验证 proxyModeType（不区分大小写）
    const modeTypeLower = config.proxyModeType?.toLowerCase();
    if (!modeTypeLower || !['systemproxy', 'tun', 'manual'].includes(modeTypeLower)) {
      throw new Error('proxyModeType must be systemProxy, tun, or manual');
    }

    // 验证 tunConfig
    if (!config.tunConfig) {
      throw new Error('tunConfig is required');
    }
    if (
      typeof config.tunConfig.mtu !== 'number' ||
      config.tunConfig.mtu < 1280 ||
      config.tunConfig.mtu > 65535
    ) {
      throw new Error('tunConfig.mtu must be a number between 1280 and 65535');
    }
    if (!['system', 'gvisor', 'mixed'].includes(config.tunConfig.stack)) {
      throw new Error('tunConfig.stack must be system, gvisor, or mixed');
    }
    if (typeof config.tunConfig.autoRoute !== 'boolean') {
      throw new Error('tunConfig.autoRoute must be a boolean');
    }
    if (typeof config.tunConfig.strictRoute !== 'boolean') {
      throw new Error('tunConfig.strictRoute must be a boolean');
    }

    // 验证 customRules
    if (!Array.isArray(config.customRules)) {
      throw new Error('customRules must be an array');
    }
    for (const rule of config.customRules) {
      if (!rule.id || typeof rule.id !== 'string') {
        throw new Error('Rule id is required and must be a string');
      }
      if (!Array.isArray(rule.domains)) {
        throw new Error('Rule domains must be an array');
      }

      const hasDomains = rule.domains.length > 0;
      const hasIpCidr = Array.isArray(rule.ipCidr) && rule.ipCidr.length > 0;

      if (!hasDomains && !hasIpCidr) {
        throw new Error('Rule must have at least one domain or IP CIDR');
      }

      if (hasDomains) {
        for (const domain of rule.domains) {
          if (typeof domain !== 'string' || !domain.trim()) {
            throw new Error('Each domain must be a non-empty string');
          }
        }
      }
      if (!['proxy', 'direct', 'block'].includes(rule.action)) {
        throw new Error('Rule action must be proxy, direct, or block');
      }
      if (typeof rule.enabled !== 'boolean') {
        throw new Error('Rule enabled must be a boolean');
      }
    }

    // 验证布尔值字段
    if (typeof config.autoStart !== 'boolean') {
      throw new Error('autoStart must be a boolean');
    }
    // silentStart 是新增字段，兼容旧配置
    if (config.silentStart !== undefined && typeof config.silentStart !== 'boolean') {
      throw new Error('silentStart must be a boolean');
    }
    if (config.silentStart === undefined) {
      config.silentStart = false; // 默认值
    }
    if (typeof config.autoConnect !== 'boolean') {
      throw new Error('autoConnect must be a boolean');
    }
    if (typeof config.minimizeToTray !== 'boolean') {
      throw new Error('minimizeToTray must be a boolean');
    }
    // autoCheckUpdate 是可选字段，兼容旧配置
    if (config.autoCheckUpdate !== undefined && typeof config.autoCheckUpdate !== 'boolean') {
      throw new Error('autoCheckUpdate must be a boolean');
    }
    // 如果未定义，设置默认值
    if (config.autoCheckUpdate === undefined) {
      config.autoCheckUpdate = true;
    }

    // autoLightweightMode 是可选字段，兼容旧配置
    if (
      config.autoLightweightMode !== undefined &&
      typeof config.autoLightweightMode !== 'boolean'
    ) {
      throw new Error('autoLightweightMode must be a boolean');
    }
    // 如果未定义，设置默认值
    if (config.autoLightweightMode === undefined) {
      config.autoLightweightMode = false;
    }

    // rememberWindowSize 是可选字段，兼容旧配置
    if (config.rememberWindowSize !== undefined && typeof config.rememberWindowSize !== 'boolean') {
      throw new Error('rememberWindowSize must be a boolean');
    }
    if (config.rememberWindowSize === undefined) {
      config.rememberWindowSize = false;
    }

    // bypassProcesses 是可选字段，兼容旧配置
    if (config.bypassProcesses === undefined) {
      config.bypassProcesses = [];
    }
    if (!Array.isArray(config.bypassProcesses)) {
      throw new Error('bypassProcesses must be an array');
    }

    // 验证端口
    if (typeof config.socksPort !== 'number' || config.socksPort < 1 || config.socksPort > 65535) {
      throw new Error('socksPort must be a number between 1 and 65535');
    }
    if (typeof config.httpPort !== 'number' || config.httpPort < 1 || config.httpPort > 65535) {
      throw new Error('httpPort must be a number between 1 and 65535');
    }

    // 验证日志级别
    if (!['debug', 'info', 'warn', 'error', 'fatal'].includes(config.logLevel)) {
      throw new Error('logLevel must be debug, info, warn, error, or fatal');
    }
  }

  /**
   * 创建默认配置
   */
  private createDefaultConfig(): UserConfig {
    return {
      subscriptions: [],
      servers: [],
      selectedServerId: null,
      proxyMode: 'global',
      proxyModeType: 'systemProxy', // 默认使用系统代理模式，不需要管理员权限
      tunConfig: {
        mtu: 9000,
        stack: 'system',
        autoRoute: true,
        strictRoute: true,
      },
      customRules: [],
      autoStart: false,
      silentStart: false,
      autoConnect: false,
      minimizeToTray: true,
      autoCheckUpdate: true, // 默认启用启动时自动检查更新
      autoLightweightMode: false, // 默认不启用自动轻量模式
      autoUpdateSubscriptionOnStart: false, // 默认不启用启动时更新订阅
      rememberWindowSize: false, // 默认不启用记忆窗口大小
      enableIPv6: false, // 默认不启用 IPv6 解析（防假死兜底）
      autoPrivacyMode: false, // 默认不启用隐私模式
      privacyPassword: '', // 默认隐私模式密码为空

      // 默认 DNS 配置
      dnsConfig: {
        domesticDns: 'https://doh.pub/dns-query',
        foreignDns: 'https://dns.google/dns-query',
        enableFakeIp: false,
        localDevDomains: [],
      },

      customRuleSets: [], // 默认空
      appRules: [], // 应用分流规则（实验性）默认空

      socksPort: 2081,
      httpPort: 2080,
      logLevel: 'info',
      uiTheme: 'system',
    };
  }
}
