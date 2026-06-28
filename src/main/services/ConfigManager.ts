/**
 * 配置管理服务
 * 负责用户配置的加载、保存、验证和管理
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { UserConfig, Rule, RuleCondition, LogLevel, Protocol } from '../../shared/types';
import type { LogManager } from './LogManager';
import { getConfigPath } from '../utils/paths';
import { writeFileAtomic } from '../utils/atomic-write';
import { readPrivacyHash, writePrivacyHash, hashPasswordSync } from '../utils/privacy-lock';
import {
  RULE_TYPE_IDS,
  validateRuleValue,
  isValidIpCidr,
  migrateCustomRules,
  customRulesNeedMigration,
} from '../../shared/rules';
import { defaultAppRules, seedDefaultAppRules } from '../../shared/app-rules-preset';
import { DEFAULT_SPEED_TEST_URL } from '../../shared/speed-test';
// 协议白名单 + 协议必填校验单一真值：与渲染侧首页连接闸门 isServerComplete 共用同一份
// shared/server-completeness，杜绝「新增协议时主/渲染各自枚举漂移」（WireGuard 漏列致连接按钮
// 恒置灰、anytls 曾在此漏校验，均属此类）。
import {
  ALL_PROTOCOLS as ALLOWED_PROTOCOLS,
  protocolRequirementError,
} from '../../shared/server-completeness';
import { isAccountBasedProtocol } from '../../shared/endpoint-routes';
import { isDirectSelection } from '../../shared/direct-selection';
import { TUN_STACK_VALUES, migrateTunStackConfig } from '../../shared/tun-stack';

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
  private tmpSwept = false;
  private diagnosticRestoreChecked = false;
  private logManager?: LogManager;

  /**
   * 注入 LogManager（由主流程在 index.ts 统一注入）。ConfigManager 可能早于 LogManager 初始化，
   * 故 logManager 为可选，注入前所有日志走 console fallback（见 this.log）。
   */
  setLogManager(lm: LogManager): void {
    this.logManager = lm;
  }

  /**
   * 统一日志出口：已注入 LogManager 则转发，否则按级别 fallback 到 console
   * （ConfigManager 可能早于 LogManager 初始化）。
   */
  private log(level: LogLevel, message: string): void {
    if (this.logManager) {
      this.logManager.addLog(level, message, 'ConfigManager');
      return;
    }
    if (level === 'error' || level === 'fatal') console.error(message);
    else if (level === 'warn') console.warn(message);
    else console.log(message);
  }

  /**
   * 清扫 saveConfig 原子写遗留的孤儿 tmp（进程在 writeFile 成功后、rename 前被硬杀/断电；随机名不会被下次写覆盖自愈）。
   * 仅首次 loadConfig 跑一次；mtime>60s 守卫避免误删并发 saveConfig 的在途 tmp；精确锚定文件名不碰 .pre-rule-migration.bak。best-effort，绝不抛。
   */
  private async sweepStaleTmpFiles(): Promise<void> {
    if (this.tmpSwept) return;
    this.tmpSwept = true;
    try {
      const dir = path.dirname(this.configPath);
      const base = path.basename(this.configPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^${base}\\.[0-9a-f]{12}\\.tmp$`);
      const now = Date.now();
      const entries = await fs.readdir(dir);
      await Promise.all(
        entries
          .filter((f) => re.test(f))
          .map(async (f) => {
            const p = path.join(dir, f);
            try {
              const st = await fs.stat(p);
              if (now - st.mtimeMs > 60_000) await fs.unlink(p).catch(() => {});
            } catch {
              /* 文件已消失/无权限：忽略 */
            }
          })
      );
    } catch {
      /* 目录不存在/无权限等：忽略 */
    }
  }

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
    void this.sweepStaleTmpFiles(); // 首次加载清扫原子写孤儿 tmp（fire-and-forget，不阻塞）
    try {
      // 检查配置文件是否存在
      await fs.access(this.configPath);

      // 读取配置文件
      const content = await fs.readFile(this.configPath, 'utf-8');
      const config = JSON.parse(content) as UserConfig;

      // 旧规则（DomainRule）→ 新规则（Rule）迁移前先备份原配置（仅首次，便于回滚）
      if (customRulesNeedMigration((config.customRules as unknown[]) || [])) {
        const backupPath = `${this.configPath}.pre-rule-migration.bak`;
        try {
          await fs.access(backupPath);
        } catch {
          await fs
            .copyFile(this.configPath, backupPath)
            .catch((e) => this.log('warn', `备份旧配置失败（不阻断迁移）: ${e}`));
        }
      }

      // 验证配置（内含旧规则 → 新规则迁移）
      this.validateConfig(config);

      // 旧配置回填 clash_api secret（首次升级时随机生成并持久化，后续稳定，供 external_ui/外部客户端复用）
      if (!config.clashApiSecret) {
        config.clashApiSecret = randomBytes(16).toString('hex');
        await this.saveConfig(config).catch((e) =>
          this.log('warn', `持久化 clashApiSecret 失败（不阻断）: ${e}`)
        );
      }

      // F29：旧明文 privacyPassword 一次性迁移到独立哈希文件（幂等、绝不抛）。
      // 先清内存明文——即便后续哈希落盘 fs 失败，明文也不会再经 CONFIG_GET_VALUE / configChanged 外泄；
      // 失败时磁盘明文留存，下次加载重试迁移（此期间无哈希=fail-open，与迁移失败语义一致）。
      if (typeof config.privacyPassword === 'string' && config.privacyPassword !== '') {
        const legacyPlain = config.privacyPassword;
        config.privacyPassword = '';
        try {
          if (!readPrivacyHash()) writePrivacyHash(hashPasswordSync(legacyPlain));
          await this.saveConfig(config).catch((e) =>
            this.log('warn', `隐私密码迁移后落盘失败（不阻断）: ${e}`)
          );
        } catch (e) {
          this.log('warn', `隐私密码迁移失败（明文已从内存清除，下次加载重试）: ${e}`);
        }
      }

      // FakeIP 开关统一一次性迁移（幂等、绝不抛）：存量旧默认 enableFakeIp:false 多非用户意图，
      // usesFakeIp 改为纯看开关后，TUN 存量用户若不迁移会从「恒 FakeIP-on」静默掉到 off（机场拒 IP 风险）。
      // 按迁移时刻 proxyModeType 写 effective 值，置标记防重复执行覆盖用户后续手动改的值。
      await this.migrateFakeIpToggle(config);

      // 节点域名解析器一次性迁移（issue #147，幂等、绝不抛）：旧单选档位 nodeDomainResolver → 新多源 race 模型
      // nodeResolverPool(on 多选)+nodeResolverSingle(off 单选)。须在 migrateFakeIpToggle 之后（依赖 dnsConfig 已补齐）。
      await this.migrateNodeResolver(config);

      // 订阅代理策略一次性迁移（已发布布尔字段 subscriptionUpdateViaProxy@4eccd59 → 新三态，幂等、绝不抛）：
      // 旧 true（订阅经代理，常因订阅地址被墙而开）若不迁移会随字段改名静默退化为直连（被墙订阅拉取失败、无感）。
      await this.migrateSubscriptionProxyPolicy(config);

      // TUN stack 一次性迁移（幂等、绝不抛）：存量旧强制默认 stack → 'auto'（行为零变化，见 migrateTunStack）。
      await this.migrateTunStack(config);

      // 应用分流默认预设一次性注入（幂等、flag 守卫）：为未配置的内置预设注入默认「代理·跟全局」规则，
      // 并剔除已下线预设（apple/bilibili）的残留。使每张卡片启动即有 rule-sel-app selector → 首次切节点即热切换，
      // 无需先手动触发一次创建规则。仅执行一次（置 appRulesSeeded），之后用户可自由增删不被回灌。
      if (!config.appRulesSeeded) {
        config.appRules = seedDefaultAppRules(config.appRules || []);
        config.appRulesSeeded = true;
        await this.saveConfig(config).catch((e) =>
          this.log('warn', `应用分流默认注入落盘失败（不阻断）: ${e}`)
        );
      }

      // 诊断采集还原（仅首次 loadConfig=app 启动触发，会话内 backup/诊断导出重载 config 不触发，避免误结束采集）：
      // 上次会话留有 diagnosticCapture（含采集前快照级别）→ 还原 logLevel=prevLogLevel 后清字段。
      // 还原到快照级别（可能是 error/warn），绝不硬编码 info。崩溃/强杀后下次启动据此自愈，不让 debug 长期记录明细。
      if (!this.diagnosticRestoreChecked) {
        this.diagnosticRestoreChecked = true;
        if (config.diagnosticCapture) {
          const prev = config.diagnosticCapture.prevLogLevel;
          config.logLevel = prev;
          delete config.diagnosticCapture;
          await this.saveConfig(config).catch((e) =>
            this.log('warn', `诊断采集还原落盘失败（不阻断）: ${e}`)
          );
          this.log('info', `诊断采集已结束，日志级别还原为 ${prev}`);
        }
      }

      // 缓存配置
      this.currentConfig = config;

      return config;
    } catch (error) {
      // 文件不存在或解析失败，返回默认配置
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log('error', `配置文件加载失败，使用默认配置: ${errorMessage}`);

      // 记录详细错误信息
      if (error instanceof SyntaxError) {
        this.log('error', `配置文件 JSON 格式错误: ${errorMessage}`);
      } else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.log('info', '配置文件不存在，将创建默认配置');
      } else if ((error as NodeJS.ErrnoException).code === 'EACCES') {
        this.log('error', '配置文件权限不足，无法读取');
      } else {
        this.log('error', `配置验证失败: ${errorMessage}`);
      }

      const defaultConfig = this.createDefaultConfig();
      this.currentConfig = defaultConfig;

      // 尝试保存默认配置
      try {
        await this.saveConfig(defaultConfig);
        this.log('info', `默认配置已保存到: ${this.configPath}`);
      } catch (saveError) {
        this.log('error', `保存默认配置失败: ${saveError}`);
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

    // 原子落盘：先写唯一 tmp（随机后缀防并发 saveConfig 互相覆盖半写）→ rename 替换。
    // 防崩溃/进程被杀写到一半截断 config.json → loadConfig 校验失败回落默认配置并覆盖落盘 → 整份配置丢失
    //（节点/订阅/规则全丢）。与本项目 .srs/catalog 落盘同原子写规范（同样无 fsync → 断电 durability 为尽力而为）。
    // 收敛到 writeFileAtomic：mode:0o600 在 open(2) 即生效（绝不出现 0644 携密窗口）+ 非 Win chmod 双保险；
    // 后缀保留 `<rand6hex>.tmp`（不带 pid）以匹配既有 sweepStaleTmpFiles 清扫正则（行为字节保持）。
    const content = JSON.stringify(config, null, 2);
    await writeFileAtomic(this.configPath, content, {
      mode: 0o600,
      makeTmpSuffix: () => randomBytes(6).toString('hex'),
    });

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

    // mixed-only 迁移 + 治理：本地端口收敛为单一 mixedPort（同口 HTTP+SOCKS）。
    // 种子：mixedPort 未设(>0) → 旧 httpPort（忽略历史 65533 哨兵；用户现 http 端口不变，仅 SOCKS app 需改指同口），
    //       再无则新装默认 7890。幂等：mixedPort 一旦 >0 不再改写。
    // 治理：彻底删除 deprecated httpPort/socksPort（不再写回持久化配置；运行时一律走 shared/proxy-ports#localProxyPort）。
    if (!config.mixedPort || config.mixedPort <= 0) {
      const legacyHttp =
        config.httpPort && config.httpPort > 0 && config.httpPort !== 65533
          ? config.httpPort
          : undefined;
      config.mixedPort = legacyHttp || 7890;
    }
    delete config.httpPort;
    delete config.socksPort;

    // 远程实例 feature 已移除（UserConfig 类型已删 remoteInstances/activeInstanceId）→ 彻底清除旧版升级用户
    // config.json 里的死字段残留。删除而非脱敏：feature 不存在，留着只会让明文 Bearer secret（remoteInstances[].secret）
    // 既继续写盘、又随 CONFIG_GET 内联回退（`{...cfg}`）下发渲染端，破坏「远程 secret 明文永不出主进程」不变量。
    // 经 saveConfig→validateConfig（loadConfig 与持久化两路径都过此）一次性清，下次落盘即不再写回。类型已无故 cast。
    delete (config as unknown as Record<string, unknown>).remoteInstances;
    delete (config as unknown as Record<string, unknown>).activeInstanceId;

    // 控制端口（clash_api external_controller）：未设(>0) → 默认 9090（DEFAULT_CONTROL_PORT）。可改以解端口冲突死局。
    // 防自撞：与本地端口同口则回退（9090，仍同则取 9091），杜绝 clash_api 与 mixed inbound 撞口致 sing-box FATAL。
    // 作用域：此 guard 护持久化/loadConfig 路径（saveConfig 亦经 validateConfig）。运行时 start() 收到的是渲染端
    // 内存 config、不经此重校验，那条路径的同口由 UI 两个 commit 守卫拦下。未来若加 config 导入，须在导入处复用本校验。
    if (!config.controlPort || config.controlPort <= 0) {
      config.controlPort = 9090;
    }
    if (config.controlPort === config.mixedPort) {
      config.controlPort = config.mixedPort === 9090 ? 9091 : 9090;
    }

    // 自动迁移：旧版自定义规则（DomainRule: domains+ipCidr）→ 新版 Rule（type+values）。
    // 必须在下方 customRules 校验之前（旧 shape 会被新校验判废 → loadConfig catch 覆盖保存 → 规则全丢）。
    // 幂等：已是新 shape 原样保留。
    if (Array.isArray(config.customRules) && customRulesNeedMigration(config.customRules)) {
      config.customRules = migrateCustomRules(config.customRules);
    }

    // 自动迁移：旧「排除进程」(bypassProcesses) → 自定义规则 processName+直连（功能等价，见设计评估）。
    // 追加到 customRules 末尾 → 在 rules 数组中的位置与旧 bypassProcesses 一致（所有自定义规则后、appRules 前），
    // 路由逐位等价。固定 id 天然幂等；清空 bypassProcesses 即迁移标记。必须在 customRules 软校验之前。
    if (Array.isArray(config.bypassProcesses) && config.bypassProcesses.length > 0) {
      // 非字符串元素（旁路 config:save/损坏备份导入可注入）走 typeof 守卫，避免 (123).trim() 抛错 →
      // validateConfig throw → loadConfig catch → 默认配置覆盖落盘 → servers/订阅/规则全丢（与 416 行同标准）。
      const values = Array.from(
        new Set(
          config.bypassProcesses.map((p) => (typeof p === 'string' ? p.trim() : '')).filter(Boolean)
        )
      );
      // 去重 id：仅手改/拼接配置可能让 customRules 已含同 id（正常路径成对落盘不会），防重复 id 致列表 React key 冲突 + 更新/删除只命中首条。
      const alreadyMigrated =
        Array.isArray(config.customRules) &&
        config.customRules.some((r) => r && r.id === 'migrated_bypass_processes');
      if (values.length > 0 && !alreadyMigrated) {
        if (!Array.isArray(config.customRules)) config.customRules = [];
        config.customRules.push({
          id: 'migrated_bypass_processes',
          type: 'processName',
          values,
          action: 'direct',
          enabled: true,
          remarks: '排除进程（自动迁移）',
        });
      }
      config.bypassProcesses = [];
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
    let droppedCidrs = 0; // endpoint 节点的非法 CIDR（allowedIPs/routes）一律丢弃而非 throw（见循环内说明）
    for (const server of config.servers) {
      if (!server.id || typeof server.id !== 'string') {
        throw new Error('Server id is required and must be a string');
      }
      if (!server.name || typeof server.name !== 'string') {
        throw new Error('Server name is required and must be a string');
      }
      const protocolLower = server.protocol?.toLowerCase();
      if (!protocolLower || !ALLOWED_PROTOCOLS.includes(protocolLower as Protocol)) {
        throw new Error(`Server protocol must be one of: ${ALLOWED_PROTOCOLS.join(', ')}`);
      }
      // 账号制协议（Tailscale，连控制面）/ custom（raw-JSON 自带 server/port）→ 豁免 address/port；其余必须有。
      if (!isAccountBasedProtocol(protocolLower) && protocolLower !== 'custom') {
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
      }

      // 协议特有必填校验（单一真值 shared/server-completeness.protocolRequirementError，与渲染侧
      // 首页连接闸门 isServerComplete 共用）。fail-fast：缺字段 throw（与原逐协议 throw 等价；额外补齐
      // 了原先漏校验的 anytls 密码——与 isServerComplete 一致，且 anytls 无密码本就连不通）。
      const protocolError = protocolRequirementError(server);
      if (protocolError) {
        throw new Error(protocolError);
      }

      // endpoint 节点的 CIDR/地址一律 sanitize 而非 throw：WG localAddress→endpoint.address、allowedIPs→
      // peer.allowed_ips、TS routes→force-route ip_cidr，脏值（缺掩码、含空格、八位组/掩码越界如 10.0.0.0/40）
      // 会让内核启动 FATAL。用 isValidIpCidr（含范围校验）丢弃非法项 + 告警，保留合法项——避免单条脏 CIDR 阻断
      // 全部启动，也避免 throw 走 loadConfig catch 回落默认配置致用户节点全丢（与 customRules 容错同型）。
      const sanitizeCidrs = (list: string[] | undefined): string[] | undefined => {
        if (!Array.isArray(list)) return list;
        const cleaned = list
          .map((c) => (typeof c === 'string' ? c.trim() : ''))
          .filter((c) => isValidIpCidr(c));
        droppedCidrs += list.length - cleaned.length;
        return cleaned;
      };
      // allowInternet（组网「允许访问外网」开关）：纯开关字段，非 boolean 一律剔除而非 throw（缺省=true，向后兼容
      // D5）。throw 在 loadConfig 路径会触发默认配置覆盖落盘致用户节点全丢，不值当（同 appRoutingEnabled 标准）。
      const sanitizeAllowInternet = (s: { allowInternet?: boolean } | undefined): void => {
        if (s && s.allowInternet !== undefined && typeof s.allowInternet !== 'boolean') {
          delete s.allowInternet;
        }
      };
      if (server.wireguardSettings) {
        // localAddress 是接口地址（进 endpoint.address），同样必须是合法 IP/CIDR，否则内核 FATAL。
        // localAddress 为必填 string[]（protocolRequirementError 已保证此处非空数组），仅在确为数组时回写。
        const cleanedLocal = sanitizeCidrs(server.wireguardSettings.localAddress);
        if (Array.isArray(cleanedLocal)) server.wireguardSettings.localAddress = cleanedLocal;
        server.wireguardSettings.allowedIPs = sanitizeCidrs(server.wireguardSettings.allowedIPs);
        sanitizeAllowInternet(server.wireguardSettings);
      }
      if (server.tailscaleSettings) {
        server.tailscaleSettings.routes = sanitizeCidrs(server.tailscaleSettings.routes);
        server.tailscaleSettings.advertiseRoutes = sanitizeCidrs(
          server.tailscaleSettings.advertiseRoutes
        );
        sanitizeAllowInternet(server.tailscaleSettings);
      }
    }
    if (droppedCidrs > 0) {
      this.log(
        'warn',
        `[ConfigManager] 丢弃 ${droppedCidrs} 处非法 CIDR（endpoint allowedIPs/routes）`
      );
    }

    // Tailscale 单节点硬限兜底归一：同设备所有 TS 账号共用同一段 tailnet 地址，多个会互相顶掉，全局只许一个。
    // UI 主拦截点（use-server-actions）已从源头挡住，正常配置不触发；此处仅对「已是非法多 TS 状态」（旁路
    // config:save / 损坏备份导入 / 手改配置）归一：保留第一个、丢弃其余。沿用 sanitize 不 throw 惯例——绝不连累
    // 整份配置回落默认（loadConfig catch 会用默认覆盖落盘致节点/订阅/规则全丢，与上方 CIDR/规则容错同标准）。
    let firstTailscaleSeen = false;
    let droppedTailscale = 0;
    config.servers = config.servers.filter((s) => {
      if (s.protocol?.toLowerCase() !== 'tailscale') return true;
      if (!firstTailscaleSeen) {
        firstTailscaleSeen = true;
        return true;
      }
      droppedTailscale++;
      return false;
    });
    if (droppedTailscale > 0) {
      this.log(
        'warn',
        `[ConfigManager] Tailscale 单节点硬限：丢弃 ${droppedTailscale} 个多余 Tailscale 节点（保留第一个）`
      );
    }

    // 验证 selectedServerId（'__direct__' 哨兵=全局直连，非真实节点，豁免存在性校验，见 shared/direct-selection）
    if (config.selectedServerId !== null && !isDirectSelection(config.selectedServerId)) {
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

    // subscriptionProxyPolicy（三态可选）sanitize（不 throw，与 dnsTimeoutMs/CIDR 同标准防整配置回落）：
    // 非 'follow'|'proxy'|'direct' 的脏值（手改 / 损坏备份跨设备导入，见 config-portability）→ 删除该字段，落回默认 follow。
    // resolveSubscriptionViaProxy 对未知值也会降级 follow，此处提前清洗使持久化不留脏值（saveConfig 亦经本校验）。
    if (
      config.subscriptionProxyPolicy !== undefined &&
      !(['follow', 'proxy', 'direct'] as string[]).includes(config.subscriptionProxyPolicy)
    ) {
      delete config.subscriptionProxyPolicy;
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
    if (!TUN_STACK_VALUES.includes(config.tunConfig.stack)) {
      throw new Error('tunConfig.stack must be auto, system, gvisor, or mixed');
    }
    if (typeof config.tunConfig.autoRoute !== 'boolean') {
      throw new Error('tunConfig.autoRoute must be a boolean');
    }
    if (typeof config.tunConfig.strictRoute !== 'boolean') {
      throw new Error('tunConfig.strictRoute must be a boolean');
    }

    // P2c DNS 查询超时 sanitize（一律不 throw，与上方 CIDR/规则同标准防整配置回落）：
    // dnsTimeoutMs 必为有限正整数且 ∈ [1, 60000]ms（>60s 无意义、解析早已该失败），否则删除该字段 → 回落核默认。
    // dns-builder 仅在 >0 时 emit "<n>ms"，此处提前清洗使持久化配置不留脏值（saveConfig 亦经本校验）。
    if (config.dnsConfig && config.dnsConfig.dnsTimeoutMs !== undefined) {
      const ms = config.dnsConfig.dnsTimeoutMs;
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 1 || ms > 60000) {
        delete config.dnsConfig.dnsTimeoutMs;
        this.log('warn', `[ConfigManager] 丢弃非法 dns.timeout（须 1..60000ms）: ${ms}`);
      } else if (!Number.isInteger(ms)) {
        config.dnsConfig.dnsTimeoutMs = Math.round(ms);
      }
    }

    // 校验 customRules（新 Rule shape）。**一律告警不 throw**：防单条脏数据触发整配置回落
    // 默认（loadConfig catch 会用默认配置覆盖保存 → 用户规则全丢）。结构非法的规则丢弃，值非法仅告警保留。
    // 单条脏配置可批量出现 → 丢弃/sanitize 事件累计计数，循环结束后各汇总一条，防逐条刷屏。
    if (!Array.isArray(config.customRules)) {
      config.customRules = [];
    }
    let droppedRules = 0; // 整条丢弃（无 id / 未知类型 / 结构非法）
    let sanitizedIssues = 0; // 保留但 sanitize（值可能非法保留、conditions/combineMode 清洗）
    config.customRules = (config.customRules as Rule[]).filter((rule) => {
      if (!rule || typeof rule.id !== 'string' || !rule.id) {
        droppedRules++;
        return false;
      }
      if (!RULE_TYPE_IDS.includes(rule.type)) {
        droppedRules++;
        return false;
      }
      if (
        !Array.isArray(rule.values) ||
        !['proxy', 'direct', 'block'].includes(rule.action) ||
        typeof rule.enabled !== 'boolean'
      ) {
        droppedRules++;
        return false;
      }
      // 过滤非字符串 values 元素（旁路 config:save/备份导入可注入），防生成期 v.trim()/v.startsWith() 崩溃
      rule.values = rule.values.filter((v) => typeof v === 'string');
      for (const v of rule.values) {
        if (v.trim() && !validateRuleValue(rule.type, v)) {
          sanitizedIssues++;
        }
      }
      // 多条件 conditions/combineMode sanitize（批J）：旁路注入可塞入非数组 conditions、非法
      // 类型 / 非字符串值 / 非法 combineMode，会让生成期 ruleConditions() 遍历崩溃。结构非法
      // 的整条 conditions 丢弃（退化为单条件 type/values），值非法仅告警保留（同 values 策略）。
      if (rule.conditions !== undefined) {
        if (!Array.isArray(rule.conditions)) {
          sanitizedIssues++;
          delete rule.conditions;
        } else {
          const cleaned: RuleCondition[] = [];
          for (const cond of rule.conditions) {
            if (
              !cond ||
              typeof cond !== 'object' ||
              !RULE_TYPE_IDS.includes((cond as RuleCondition).type)
            ) {
              sanitizedIssues++;
              continue;
            }
            const c = cond as RuleCondition;
            const vals = Array.isArray(c.values)
              ? c.values.filter((v) => typeof v === 'string')
              : [];
            if (vals.length === 0) {
              sanitizedIssues++;
              continue;
            }
            for (const v of vals) {
              if (v.trim() && !validateRuleValue(c.type, v)) {
                sanitizedIssues++;
              }
            }
            cleaned.push({ type: c.type, values: vals });
          }
          // 全部 condition 被丢弃 → 删除 conditions，退化为单条件（type/values 仍有效）；否则回写清洗后的
          if (cleaned.length === 0) {
            delete rule.conditions;
          } else {
            rule.conditions = cleaned;
            // 镜像同步：type/values 必须等于首条件（消费点/列表 Badge/回滚兼容均读镜像）。若 sanitize 丢了
            // 原 conditions[0]，镜像会指向一个不再参与生成的条件 → 强制重镜像 cleaned[0]，杜绝展示/生成错位。
            rule.type = cleaned[0].type;
            rule.values = [...cleaned[0].values];
          }
        }
      }
      if (
        rule.combineMode !== undefined &&
        rule.combineMode !== 'and' &&
        rule.combineMode !== 'or'
      ) {
        sanitizedIssues++;
        delete rule.combineMode;
      }
      return true;
    });
    // 汇总告警（替代逐条），防单份脏配置批量刷屏
    if (droppedRules > 0) {
      this.log('warn', `[ConfigManager] 丢弃 ${droppedRules} 条非法规则`);
    }
    if (sanitizedIssues > 0) {
      this.log('warn', `[ConfigManager] 清洗 ${sanitizedIssues} 处规则非法字段（已保留/重置默认）`);
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
    // appRoutingEnabled：undefined=关闭（默认关；不回填以减少 config 写放大；gate 用 !== true）。
    // 纯开关字段非法值 sanitize 而非 throw——throw 在 loadConfig 路径会触发默认配置覆盖落盘致全丢，不值当。
    if (config.appRoutingEnabled !== undefined && typeof config.appRoutingEnabled !== 'boolean') {
      this.log('warn', 'appRoutingEnabled must be a boolean; resetting to default (disabled)');
      delete config.appRoutingEnabled;
    }
    // singboxDashboard：纯开关字段（默认关）。非 boolean 一律删除而非 throw（同 appRoutingEnabled 标准，不回填默认）——
    // throw 在 loadConfig 路径会触发默认配置覆盖落盘致用户节点/订阅/规则全丢，不值当。
    if (config.singboxDashboard !== undefined && typeof config.singboxDashboard !== 'boolean') {
      this.log('warn', 'singboxDashboard must be a boolean; resetting to default (disabled)');
      delete config.singboxDashboard;
    }
    // singboxDashboardUrl：可选 download_url 覆盖。非字符串或空白一律删除（回落内置默认 URL）；sanitize 而非 throw。
    if (config.singboxDashboardUrl !== undefined) {
      if (
        typeof config.singboxDashboardUrl !== 'string' ||
        config.singboxDashboardUrl.trim() === ''
      ) {
        delete config.singboxDashboardUrl;
      } else {
        config.singboxDashboardUrl = config.singboxDashboardUrl.trim();
      }
    }

    // builtinGeoMeta 非法类型 sanitize 而非 throw（读取侧全容错、无爆炸半径，与 appRoutingEnabled 同型）
    if (
      config.builtinGeoMeta !== undefined &&
      (typeof config.builtinGeoMeta !== 'object' ||
        config.builtinGeoMeta === null ||
        Array.isArray(config.builtinGeoMeta))
    ) {
      this.log('warn', 'builtinGeoMeta must be an object; resetting to default');
      delete config.builtinGeoMeta;
    }
    // mainSessionViaProxy 新增字段：非法类型 sanitize（undefined=true 兼容老配置，gate 用 !== false）
    if (
      config.mainSessionViaProxy !== undefined &&
      typeof config.mainSessionViaProxy !== 'boolean'
    ) {
      this.log('warn', 'mainSessionViaProxy must be a boolean; resetting to default (enabled)');
      delete config.mainSessionViaProxy;
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
    // 默认启用（与 DEFAULT_CONFIG 一致）：未显式设置过的配置（含旧配置缺该键）按「记忆窗口大小」默认开启；
    // 显式设为 false 的用户配置不受影响（非 undefined，上面已放行）。
    if (config.rememberWindowSize === undefined) {
      config.rememberWindowSize = true;
    }

    // bypassProcesses 是可选字段，兼容旧配置
    if (config.bypassProcesses === undefined) {
      config.bypassProcesses = [];
    }
    if (!Array.isArray(config.bypassProcesses)) {
      throw new Error('bypassProcesses must be an array');
    }

    // 验证端口（mixed-only：canonical = mixedPort；http/socks 为 deprecated，仅在存在时宽松校验）
    if (typeof config.mixedPort !== 'number' || config.mixedPort < 1 || config.mixedPort > 65535) {
      throw new Error('mixedPort must be a number between 1 and 65535');
    }
    if (
      config.controlPort !== undefined &&
      (typeof config.controlPort !== 'number' ||
        config.controlPort < 1 ||
        config.controlPort > 65535)
    ) {
      throw new Error('controlPort must be a number between 1 and 65535');
    }
    if (
      config.socksPort !== undefined &&
      (typeof config.socksPort !== 'number' || config.socksPort < 1 || config.socksPort > 65535)
    ) {
      throw new Error('socksPort must be a number between 1 and 65535');
    }
    if (
      config.httpPort !== undefined &&
      (typeof config.httpPort !== 'number' || config.httpPort < 1 || config.httpPort > 65535)
    ) {
      throw new Error('httpPort must be a number between 1 and 65535');
    }

    // 验证日志级别
    if (!['debug', 'info', 'warn', 'error', 'fatal'].includes(config.logLevel)) {
      throw new Error('logLevel must be debug, info, warn, error, or fatal');
    }
  }

  /**
   * FakeIP 开关统一一次性迁移（幂等、绝不抛、不阻断启动）。
   *
   * 背景：usesFakeIp 由「非 systemProxy 恒开 / systemProxy 看开关」统一为「纯看 enableFakeIp，缺省 true」。
   * 存量配置普遍是旧默认 enableFakeIp:false（非用户主动关）——若不迁移，TUN 存量用户会从「恒 FakeIP-on」
   * 静默掉到 off，节点收到真实 IP，部分防滥用严格机场拒连（不变量被破坏）。
   *
   * 迁移规则（按【迁移时刻】proxyModeType 冻结 effective 值）：
   *  - tun / manual → enableFakeIp=true（保住改前恒开行为，机场兼容零回归）；
   *  - systemProxy  → 保留现值（改前后都看开关，零变化；FakeIP 在 systemProxy 下近 no-op）。
   * 缺 dnsConfig → 直接补一份「迁移完成」默认（enableFakeIp 按上述模式，标记 true），容错不抛。
   *
   * 幂等：fakeIpToggleMigrated===true 即跳过（含新装——createDefaultConfig 已置 true）。置标记后永不再改写，
   * 避免每次启动覆盖用户迁移后手动改的值。落盘 await saveConfig().catch（与 F29 同标准：best-effort、失败下次重试、
   * 标记未持久化即未迁移；await 确定迁移与落盘顺序，消除 fire-and-forget 期 currentConfig 读取的理论窗口）。
   */
  /**
   * 订阅代理策略迁移：旧布尔 subscriptionUpdateViaProxy（已发布字段 4eccd59）→ 新三态 subscriptionProxyPolicy。
   * 旧 true（订阅经代理）→ 'proxy'（全部经代理，最贴近旧全局语义）；false/缺省 → 不改（落回默认 follow=直连，语义等价）。
   * 幂等：仅旧字段存在时执行，消化后 delete 旧字段（不双字段共存）；新装无旧字段直接跳过、不落盘。绝不抛。
   * 不覆盖已设的新字段（用户升级后又手动改过 policy 的情形）：仅 subscriptionProxyPolicy===undefined 时才写。
   */
  private async migrateSubscriptionProxyPolicy(config: UserConfig): Promise<void> {
    try {
      const legacy = config as unknown as Record<string, unknown>;
      if (!('subscriptionUpdateViaProxy' in legacy)) return; // 无旧字段（含新装）：幂等跳过，不落盘
      if (
        config.subscriptionProxyPolicy === undefined &&
        legacy.subscriptionUpdateViaProxy === true
      ) {
        config.subscriptionProxyPolicy = 'proxy';
      }
      delete legacy.subscriptionUpdateViaProxy; // 消化后删除旧字段
      await this.saveConfig(config).catch((e) =>
        this.log('warn', `订阅代理策略迁移后落盘失败（不阻断，下次重试）: ${e}`)
      );
    } catch (e) {
      this.log('warn', `订阅代理策略迁移失败（吞掉，不影响启动）: ${e}`);
    }
  }

  private async migrateFakeIpToggle(config: UserConfig): Promise<void> {
    try {
      // 缺 dnsConfig：补默认并按模式冻结 effective 值，标记完成（与 createDefaultConfig 同语义但 enableFakeIp 按模式）。
      if (!config.dnsConfig) {
        const modeType = (config.proxyModeType || 'systemProxy').toLowerCase();
        config.dnsConfig = {
          domesticDns: 'https://doh.pub/dns-query',
          foreignDns: 'https://dns.google/dns-query',
          enableFakeIp: modeType !== 'systemproxy', // tun/manual → true；systemProxy → false（无现值可保留，回落开关默认）
          fakeIpToggleMigrated: true,
        };
      } else if (config.dnsConfig.fakeIpToggleMigrated !== true) {
        const modeType = (config.proxyModeType || 'systemProxy').toLowerCase();
        // tun/manual 写 true（保住改前恒开）。
        // systemProxy 冻结改前 effective：旧语义 !!enableFakeIp，故 undefined/false → false、true → true。
        //   不冻结则 enableFakeIp 缺失（undefined）会被新 usesFakeIp 的「?? true」缺省翻成 on，
        //   与「缺 dnsConfig（systemProxy）显式写 false」自相矛盾。冻结后 systemProxy 零变化、两分支语义一致。
        if (modeType !== 'systemproxy') {
          config.dnsConfig.enableFakeIp = true;
        } else {
          config.dnsConfig.enableFakeIp = config.dnsConfig.enableFakeIp === true;
        }
        config.dnsConfig.fakeIpToggleMigrated = true;
      } else {
        return; // 已迁移（含新装）：幂等跳过，不落盘
      }
      // best-effort 落盘标记；失败不阻断（下次加载重试，期间标记未持久 = 未迁移语义一致）。
      await this.saveConfig(config).catch((e) =>
        this.log('warn', `FakeIP 开关迁移后落盘失败（不阻断，下次重试）: ${e}`)
      );
    } catch (e) {
      this.log('warn', `FakeIP 开关迁移失败（吞掉，不影响启动）: ${e}`);
    }
  }

  /**
   * 节点域名解析器迁移（issue #147）：旧单选档位 nodeDomainResolver(auto/dnspod/system) → 新多源模型
   * nodeResolverPool(race on 多选)+nodeResolverSingle(race off 单选)。幂等(nodeResolverMigrated 守卫)、绝不抛。
   * 保留用户原意图：dnspod→[dnspod]/single dnspod；system→[system]/single system；auto/缺省→[ali,dnspod]/single ali。
   * 不删 nodeDomainResolver（@deprecated 留作迁移源，幂等防重复后不再读）。dnsConfig 由上游 migrateFakeIpToggle 补齐。
   */
  private async migrateNodeResolver(config: UserConfig): Promise<void> {
    try {
      const dns = config.dnsConfig;
      if (!dns || dns.nodeResolverMigrated === true) return; // 已迁移（含新装）幂等跳过；无 dnsConfig 理论不达（上游已补）
      const old = dns.nodeDomainResolver ?? 'auto';
      if (dns.nodeResolverPool === undefined) {
        dns.nodeResolverPool =
          old === 'dnspod' ? ['dnspod'] : old === 'system' ? ['system'] : ['ali', 'dnspod'];
      }
      if (dns.nodeResolverSingle === undefined) {
        dns.nodeResolverSingle = old === 'dnspod' ? 'dnspod' : old === 'system' ? 'system' : 'ali';
      }
      dns.nodeResolverMigrated = true;
      await this.saveConfig(config).catch((e) =>
        this.log('warn', `节点解析器迁移后落盘失败（不阻断，下次重试）: ${e}`)
      );
    } catch (e) {
      this.log('warn', `节点解析器迁移失败（吞掉，不影响启动）: ${e}`);
    }
  }

  /**
   * TUN stack 一次性迁移（幂等、绝不抛）：存量 stack 为旧强制默认（mac=gvisor / Win·Linux=system，
   * 旧版 UI 不暴露 stack → 这些是被迫默认、非用户真实选择）→ 一律归 'auto'。'auto' 经 resolveTunStack
   * 解析回各平台原默认（mac→gvisor / Win·Linux→system），故迁移【行为零变化】，仅语义干净 +
   * 后续平台默认演进自动惠及 + UI 显示「Auto」。迁移后用户在 UI 显式改的值（system/gvisor/mixed）
   * 不再被回灌（tunStackMigrated 守卫）。详见 docs/design/tun-stack-option.md §7。
   * 幂等：tunStackMigrated===true 即跳过（含新装——createDefaultConfig 已置 true）。
   */
  private async migrateTunStack(config: UserConfig): Promise<void> {
    try {
      // 纯逻辑收敛到 shared/tun-stack#migrateTunStackConfig（可单测）；本壳只负责落盘 + 吞异常。
      if (!migrateTunStackConfig(config)) return; // 幂等/无变更（含新装）→ 不落盘
      await this.saveConfig(config).catch((e) =>
        this.log('warn', `TUN stack 迁移后落盘失败（不阻断，下次重试）: ${e}`)
      );
    } catch (e) {
      this.log('warn', `TUN stack 迁移失败（吞掉，不影响启动）: ${e}`);
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
        mtu: process.platform === 'darwin' ? 1400 : 1350,
        // 'auto' = 跟随平台映射（resolveTunStack：mac→gvisor / Win·Linux→system），新装直接用新模型。
        stack: 'auto',
        autoRoute: true,
        strictRoute: true,
      },
      tunStackMigrated: true, // 新装即新模型，迁移幂等跳过（对齐 fakeIpToggleMigrated 新装置位）
      customRules: [],
      autoStart: false,
      silentStart: false,
      autoConnect: false,
      minimizeToTray: true,
      autoCheckUpdate: true, // 默认启用启动时自动检查更新
      autoLightweightMode: false, // 默认不启用自动轻量模式
      desktopNotifications: true, // 桌面通知总开关，默认开（仅严重错误事件发通知）
      autoUpdateSubscriptionOnStart: true, // 默认启用订阅自动更新（启动补更陈旧订阅 + 周期更新）
      subscriptionUpdateIntervalHours: 12, // 订阅自动更新周期/陈旧阈值（小时）
      subscriptionProxyPolicy: 'follow', // 默认跟随各订阅自身设定（per-sub updateViaProxy 默认关=直连）
      mainSessionViaProxy: true, // 更新检查/规则资源默认走代理（运行时）
      rememberWindowSize: true, // 默认启用记忆窗口大小（用户调整后下次沿用；已显式关闭的用户配置不受影响）
      enableIPv6: false, // 默认不启用 IPv6 解析（防假死兜底）
      autoPrivacyMode: false, // 默认不启用隐私模式
      privacyPassword: '', // 默认隐私模式密码为空

      // 默认 DNS 配置
      dnsConfig: {
        domesticDns: 'https://doh.pub/dns-query',
        foreignDns: 'https://dns.google/dns-query',
        enableFakeIp: true, // 新装默认开（usesFakeIp 已统一为纯看开关；存量经 migrateFakeIpToggle 一次性迁移）
        fakeIpToggleMigrated: true, // 新装无需迁移：直接落 effective 默认，标记防 migrate 再改写
        takeoverSystemDns: true, // TUN 模式接管系统 DNS 默认开（缺省本已 ?? true 视为开，此处显式声明）
        // issue #147 节点域名解析（多源 race）：新装默认 race-on、池=AliDNS+DNSPod；off 单选默认 Ali。
        nodeResolverPool: ['ali', 'dnspod'],
        nodeResolverSingle: 'ali',
        nodeResolverMigrated: true, // 新装无需迁移：直接落新模型默认，标记防 migrate 再改写
      },

      customRuleSets: [], // 默认空
      appRules: defaultAppRules(), // 默认为每个内置预设注入「代理·跟全局」规则 → 卡片启动即有 selector，首次切节点即热切换
      appRulesSeeded: true, // 新装已注入，loadConfig 迁移跳过
      appRoutingEnabled: false, // 应用分流总开关默认关闭（仅影响新装/回落；undefined 亦视为关闭，见 effectiveAppRules/UI 读取端）
      ruleResourceAutoUpdate: true, // 规则资源自动更新默认开启（老配置 undefined 亦视为开启，见 scheduler/UI 读取端）
      ruleResourceUpdateIntervalHours: 12, // 自动更新间隔默认 12h
      fakeIpFilter: true, // fake-ip-filter 默认清单默认开启（NTP/STUN/Captive 走真实解析；老配置 undefined 亦视为开）
      blockQuic: true, // 阻断 QUIC(UDP443) 默认开（reject 逼浏览器回退 TCP，防 QUIC 绕过分流/泄漏）
      singboxDashboard: true, // sing-box 1.14 官方面板默认开（services dashboard 本地 serve，零联网拉取）
      speedTestUrl: DEFAULT_SPEED_TEST_URL, // 节点测速端点默认 generate_204（用户可在设置·网络改）

      mixedPort: 7890, // mixed-only canonical 本地端口（同口 HTTP+SOCKS）；新装默认对齐业内 7890（存量经迁移沿用原 httpPort）。
      controlPort: 9090, // clash_api 外部控制端口（对齐业内 9090）；可改以解端口冲突死局。
      // 注：不再设 httpPort/socksPort（mixed-only 已治理；旧配置经 loadConfig 迁移删除这两个 deprecated 字段）。
      logLevel: 'info',
      disableLogFile: false,
      clashApiSecret: randomBytes(16).toString('hex'),
      uiTheme: 'system',
    };
  }
}
