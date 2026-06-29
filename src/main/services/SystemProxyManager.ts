/**
 * 系统代理管理服务
 * 负责跨平台的系统代理设置和管理
 */

import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { retry } from '../utils/retry';
import { getUserDataPath } from '../utils/paths';
import { system32, powershellPath, isCommandNotFoundError } from '../utils/win-system32';
import type { LogManager } from './LogManager';
import type { LogLevel } from '../../shared/types';
import {
  formatBypassForMac,
  formatBypassForWindows,
  formatBypassForLinux,
} from '../../shared/system-proxy-bypass';

const execAsync = promisify(exec);
// notifyProxyChange 用 execFile（不经 cmd /c）直起 PowerShell：彻底消除 cmd 引号歧义，
// 并保留脚本换行使 Add-Type here-string(@"..."@) 语法成立（原 exec 路径把换行压成空格会破坏 here-string）。
const execFileAsync = promisify(execFile);

/**
 * 系统代理状态
 */
export interface SystemProxyStatus {
  enabled: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  socksProxy?: string;
}

/**
 * 系统代理管理器接口
 */
export interface ISystemProxyManager {
  /**
   * 启用系统代理。bypassList = 「绕过局域网」清单（ProxyManager 传入：bypassLAN 关→[]，否则 bypassLANList ?? DEFAULT_BYPASS_LAN）；按平台格式化下发。
   */
  enableProxy(
    address: string,
    httpPort: number,
    socksPort: number,
    bypassList?: string[]
  ): Promise<void>;

  /**
   * 禁用系统代理
   */
  disableProxy(): Promise<void>;

  /**
   * 同步禁用系统代理（用于关机/退出等紧急场景）
   */
  disableProxySync(): void;

  /**
   * 获取代理状态
   */
  getProxyStatus(): Promise<SystemProxyStatus>;

  /** 注入日志 sink（批次 B：系统代理日志改走 LogManager 进 app.log）。 */
  setLogManager(lm: LogManager): void;
}

/**
 * 系统代理管理器基类
 */
export abstract class SystemProxyBase implements ISystemProxyManager {
  protected originalSettings: SystemProxyStatus | null = null;

  private logManager?: LogManager;
  setLogManager(lm: LogManager): void {
    this.logManager = lm;
  }

  /**
   * 统一日志出口；LogManager 未注入时 fallback console（SystemProxyManager 可能早于 LogManager 初始化，不 brick）
   */
  protected log(level: LogLevel, message: string): void {
    if (this.logManager) {
      this.logManager.addLog(level, message, 'SystemProxy');
      return;
    }
    if (level === 'error' || level === 'fatal') console.error(message);
    else if (level === 'warn') console.warn(message);
    else console.log(message);
  }

  /** 持久化 marker 文件路径（userData/system-proxy.marker.json） */
  private static getMarkerPath(): string {
    return path.join(getUserDataPath(), 'system-proxy.marker.json');
  }

  /**
   * 写入持久化 marker（enableProxy 成功后调用）
   * 记录"系统代理由 FlowZ 设置"，供崩溃/强杀后下次启动恢复与退出兜底门控使用。
   * 同步 fs API（文件极小）；失败仅告警，绝不抛出影响代理设置结果。
   */
  protected writeMarker(ourHostPort: string): void {
    try {
      fs.writeFileSync(
        SystemProxyBase.getMarkerPath(),
        JSON.stringify({ ourHostPort, at: Date.now() })
      );
    } catch (error) {
      this.log('warn', `写入系统代理 marker 失败: ${error}`);
    }
  }

  /**
   * 删除持久化 marker（disableProxy / disableProxySync 成功后调用）
   * 同步 fs API，可安全用于 process'exit' 等同步退出路径；失败仅告警，绝不抛出。
   */
  protected clearMarker(): void {
    SystemProxyBase.clearMarkerFile();
  }

  /** 删除持久化 marker（静态入口，供启动恢复清理失效 marker）；失败仅告警，绝不抛出 */
  static clearMarkerFile(): void {
    try {
      fs.rmSync(SystemProxyBase.getMarkerPath(), { force: true });
    } catch (error) {
      console.warn('删除系统代理 marker 失败:', error);
    }
  }

  /** 读取持久化 marker；文件不存在或内容损坏一律返回 null（启动恢复/退出门控用） */
  static readMarker(): { ourHostPort: string } | null {
    try {
      const raw = fs.readFileSync(SystemProxyBase.getMarkerPath(), 'utf-8');
      const data = JSON.parse(raw);
      if (data && typeof data.ourHostPort === 'string' && data.ourHostPort) {
        return { ourHostPort: data.ourHostPort };
      }
      return null;
    } catch {
      // ENOENT / JSON 损坏 → 视为无 marker
      return null;
    }
  }

  /**
   * 防自指：若"原始设置"已指向我们自己的代理（127.0.0.1:&lt;httpPort&gt; 或同 marker），返回 null（视为无原始）。
   * 杜绝 enableProxy 把自己设的代理当原始保存 → 之后 disableProxy 的 restore 把死端口代理设回去致全网断。
   */
  protected static stripSelf(
    status: SystemProxyStatus | null,
    address: string,
    httpPort: number
  ): SystemProxyStatus | null {
    if (!status?.enabled) return status;
    const ours = `${address}:${httpPort}`;
    const markerHostPort = SystemProxyBase.readMarker()?.ourHostPort;
    const pointsToUs = (p?: string): boolean =>
      !!p && (p === ours || (!!markerHostPort && p === markerHostPort));
    if (
      pointsToUs(status.httpProxy) ||
      pointsToUs(status.httpsProxy) ||
      pointsToUs(status.socksProxy)
    ) {
      return null;
    }
    return status;
  }

  abstract enableProxy(
    address: string,
    httpPort: number,
    socksPort: number,
    bypassList?: string[]
  ): Promise<void>;
  abstract disableProxy(): Promise<void>;
  abstract disableProxySync(): void;
  abstract getProxyStatus(): Promise<SystemProxyStatus>;
}

/**
 * Windows 系统代理管理器
 * 使用注册表修改 Internet Settings
 */
export class WindowsSystemProxy extends SystemProxyBase {
  private readonly regPath =
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

  // 用 System32 绝对路径调系统二进制，规避部分设备 PATH 缺失 C:\Windows\System32 致
  //「'reg' 不是内部或外部命令」（根因见 utils/win-system32）。构造时解析一次。
  private readonly regExe = system32('reg.exe');
  private readonly netshExe = system32('netsh.exe');
  private readonly ipconfigExe = system32('ipconfig.exe');
  private readonly psExe = powershellPath();

  /**
   * 启用系统代理
   */
  async enableProxy(
    address: string,
    httpPort: number,
    _socksPort: number,
    bypassList?: string[]
  ): Promise<void> {
    this.log('info', '正在设置 Windows 系统代理');

    // marker 提前写（intent）：enable 期间崩溃也留 marker，供下次启动恢复。
    this.writeMarker(`${address}:${httpPort}`);

    // 保存原始设置（防自指：已指向我们自己的代理 → 视为无原始，杜绝 disable restore 死端口致断网）
    try {
      this.originalSettings = SystemProxyBase.stripSelf(
        await this.getProxyStatus(),
        address,
        httpPort
      );
      this.log('info', '已保存原始代理设置');
    } catch (error) {
      this.log('warn', `无法获取原始代理设置: ${error}`);
      // 继续执行，即使无法获取原始设置
    }

    try {
      // 使用重试机制设置代理
      await retry(
        async () => {
          // 设置代理服务器地址
          // 关键修复：只设置 HTTP/HTTPS 代理，不设置 socks=
          // 原因：当 Windows 注册表包含 socks= 时，部分应用（尤其是 Chromium 内核）
          // 会将 WebSocket 等连接通过 SOCKS5 发送，而 SOCKS5 客户端可能先本地解析 DNS
          //（被 GFW 污染），再将污染后的 IP 发给代理 → 路由失败。
          // NekoBox 等工具也不在系统代理中设置 socks=。
          // mixed-only：SOCKS5 与 HTTP 同口（mixed inbound），需 SOCKS 的应用主动指向同一端口即可。
          const proxyServer = `http=${address}:${httpPort};https=${address}:${httpPort}`;
          await execAsync(
            `"${this.regExe}" add "${this.regPath}" /v ProxyServer /t REG_SZ /d "${proxyServer}" /f`
          );

          // 启用代理
          await execAsync(
            `"${this.regExe}" add "${this.regPath}" /v ProxyEnable /t REG_DWORD /d 1 /f`
          );

          // 代理覆盖（忽略代理列表）= 用户配置的 bypass 清单（缺省业内聚合清单，含私网/保留段 + Apple 连通性 +
          // 国内会被代理打断的 App/网银）。Windows ProxyOverride 不支持 CIDR → CIDR 转通配（v6 CIDR 跳过）、域名原样、补 <local>。
          // 对齐 Clash/Stash 系：保存原列表→开启写入→关闭还原（restoreProxySettings 负责还原）。
          const proxyOverride = formatBypassForWindows(bypassList ?? [], (e) =>
            this.log(
              'warn',
              `Windows 代理 bypass 含 cmd 非法字符，已跳过该项（不静默改写主机名）: ${e}`
            )
          );
          await execAsync(
            `"${this.regExe}" add "${this.regPath}" /v ProxyOverride /t REG_SZ /d "${proxyOverride}" /f`
          );

          // 系统代理**不写防火墙拦 QUIC**（设计决策）：CONNECT 是 TCP-only 隧道、承载不了 QUIC(UDP)→守规矩的 app
          // 在显式系统代理下会自禁 QUIC、回退 TCP→CONNECT（正确走代理）。旧版的「防火墙 block 全部 UDP443」是**blanket**、
          // 会误杀国内 QUIC（与「只拦海外代理域名 QUIC」的 route 设计不符）→ 已移除。选择性 QUIC 阻断（仅海外代理域名、
          // CN 豁免）由 sing-box route 规则在 TUN 模式实现（系统代理下 QUIC 不进核、route 够不着，靠上述 app 自禁）。
          // 仅保留 delete：清理历史版本残留的 FlowZ_Block_QUIC 规则（升级迁移），不再 add。
          await execAsync(
            `"${this.netshExe}" advfirewall firewall delete rule name="FlowZ_Block_QUIC"`
          ).catch(() => {});

          // 通知系统代理设置已更改
          await this.notifyProxyChange();
        },
        {
          maxRetries: 2,
          delay: 500,
          shouldRetry: (error) => {
            // 权限错误不重试
            const message = error.message.toLowerCase();
            if (message.includes('access denied') || message.includes('permission')) {
              return false;
            }
            // 命令未找到（PATH 缺 System32 等）重试无意义——绝对路径化后本不应出现，纵深防御
            if (isCommandNotFoundError(error)) {
              return false;
            }
            return true;
          },
          onRetry: (error, attempt) => {
            this.log('warn', `设置系统代理失败，正在进行第 ${attempt} 次重试: ${error.message}`);
          },
        }
      );

      // marker 已在 enable 前置写入（崩溃/强杀后下次启动据此恢复）
      this.log('info', 'Windows 系统代理设置成功');
    } catch (error) {
      this.log('error', `设置 Windows 系统代理失败: ${error}`);

      // 失败兜底（fail-closed）经 disableProxy 统一收口：有真实旧代理 → 恢复；originalSettings 为 null
      //（原本无代理 / 旧代理是我们自己被 stripSelf 置 null）→ ProxyEnable=0 简单关 + 清 QUIC 规则。
      // 杜绝「ProxyEnable=1 + ProxyServer 半指向我们、又无 marker」的自指残留 → 崩溃后死端口断网（H3）。
      // disableProxy 内部成功后会 clearMarker；失败则补清一次。
      try {
        await this.disableProxy();
      } catch (rollbackError) {
        this.log('error', `失败兜底关闭/恢复系统代理失败: ${rollbackError}`);
        this.clearMarker();
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      // command-not-found 的根因是 PATH 缺 System32 而非权限——给对症诊断，避免误导用户去开管理员
      if (isCommandNotFoundError(error)) {
        throw new Error(
          `设置 Windows 系统代理失败: ${errorMessage}\n\n可能的原因:\n1. 系统命令 reg/netsh 未找到，PATH 可能缺失 C:\\Windows\\System32\n2. 系统环境变量被第三方工具损坏（如 Path 值类型被改为 REG_SZ 致 %SystemRoot% 不展开）\n3. 安全软件拦截了系统命令调用`
        );
      }
      throw new Error(
        `设置 Windows 系统代理失败: ${errorMessage}\n\n可能的原因:\n1. 权限不足，请以管理员身份运行\n2. 注册表访问被阻止\n3. 系统策略限制`
      );
    }
  }

  /**
   * 禁用系统代理
   */
  async disableProxy(): Promise<void> {
    this.log('info', '正在禁用 Windows 系统代理');

    // 禁用代理时务必清除 QUIC 阻断规则
    await execAsync(
      `"${this.netshExe}" advfirewall firewall delete rule name="FlowZ_Block_QUIC"`
    ).catch(() => {});

    try {
      if (this.originalSettings) {
        // 恢复原始设置
        this.log('info', '正在恢复原始代理设置');
        await this.restoreProxySettings(this.originalSettings);
        this.originalSettings = null;
        this.log('info', '已恢复原始代理设置');
      } else {
        // 简单禁用代理
        await execAsync(
          `"${this.regExe}" add "${this.regPath}" /v ProxyEnable /t REG_DWORD /d 0 /f`
        );
        await this.notifyProxyChange();
        this.log('info', '已禁用系统代理');
      }
      // 拆除成功 → 删除持久化 marker
      this.clearMarker();
    } catch (error) {
      this.log('error', `禁用 Windows 系统代理失败: ${error}`);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`禁用 Windows 系统代理失败: ${errorMessage}\n\n建议手动检查系统代理设置`);
    }
  }

  /**
   * 同步禁用系统代理（用于关机/退出等紧急场景）
   */
  disableProxySync(): void {
    const { execSync } = require('child_process');
    try {
      // 禁用代理时务必清除 QUIC 阻断规则
      execSync(`"${this.netshExe}" advfirewall firewall delete rule name="FlowZ_Block_QUIC"`, {
        stdio: 'ignore',
      });
    } catch {
      /* ignore */
    }

    try {
      execSync(`"${this.regExe}" add "${this.regPath}" /v ProxyEnable /t REG_DWORD /d 0 /f`, {
        stdio: 'ignore',
      });
      // 禁用成功 → 删除持久化 marker（clearMarker 内部为同步 fs API 且不抛）
      this.clearMarker();
      // 尝试刷新设置
      execSync(`"${this.ipconfigExe}" /flushdns`, { stdio: 'ignore' });
    } catch (error) {
      this.log('error', `同步禁用 Windows 系统代理失败: ${error}`);
    }
  }

  /**
   * 获取代理状态
   */
  async getProxyStatus(): Promise<SystemProxyStatus> {
    try {
      // 查询 ProxyEnable
      const enableResult = await execAsync(
        `"${this.regExe}" query "${this.regPath}" /v ProxyEnable`
      );
      const enabled = enableResult.stdout.includes('0x1');

      if (!enabled) {
        return { enabled: false };
      }

      // 查询 ProxyServer
      const serverResult = await execAsync(
        `"${this.regExe}" query "${this.regPath}" /v ProxyServer`
      );
      const proxyServerMatch = serverResult.stdout.match(/ProxyServer\s+REG_SZ\s+(.+)/);

      if (!proxyServerMatch) {
        return { enabled: true };
      }

      const proxyServer = proxyServerMatch[1].trim();
      const status: SystemProxyStatus = { enabled: true };

      // 解析代理服务器字符串
      // 格式: http=127.0.0.1:8080;https=127.0.0.1:8080;socks=127.0.0.1:1080
      const parts = proxyServer.split(';');
      for (const part of parts) {
        const [protocol, address] = part.split('=');
        if (protocol && address) {
          const key = `${protocol.toLowerCase()}Proxy` as keyof SystemProxyStatus;
          if (key === 'httpProxy' || key === 'httpsProxy' || key === 'socksProxy') {
            status[key] = address;
          }
        }
      }

      return status;
    } catch {
      // 查询失败，返回禁用状态
      return { enabled: false };
    }
  }

  /**
   * 恢复代理设置
   */
  private async restoreProxySettings(settings: SystemProxyStatus): Promise<void> {
    if (settings.enabled && (settings.httpProxy || settings.httpsProxy || settings.socksProxy)) {
      // 恢复代理服务器设置
      const parts: string[] = [];
      if (settings.httpProxy) parts.push(`http=${settings.httpProxy}`);
      if (settings.httpsProxy) parts.push(`https=${settings.httpsProxy}`);
      if (settings.socksProxy) parts.push(`socks=${settings.socksProxy}`);

      if (parts.length > 0) {
        const proxyServer = parts.join(';');
        await execAsync(
          `"${this.regExe}" add "${this.regPath}" /v ProxyServer /t REG_SZ /d "${proxyServer}" /f`
        );
      }

      // 启用代理
      await execAsync(`"${this.regExe}" add "${this.regPath}" /v ProxyEnable /t REG_DWORD /d 1 /f`);
    } else {
      // 禁用代理
      await execAsync(`"${this.regExe}" add "${this.regPath}" /v ProxyEnable /t REG_DWORD /d 0 /f`);
      await execAsync(
        `"${this.netshExe}" advfirewall firewall delete rule name="FlowZ_Block_QUIC"`
      ).catch(() => {});
    }

    await this.notifyProxyChange();
  }

  /**
   * 通知系统代理设置已更改
   * 使用 Windows API 通知系统刷新代理设置
   */
  private async notifyProxyChange(): Promise<void> {
    // 在 Windows 上，修改注册表后需要通知系统刷新设置
    // 这里使用 PowerShell 调用 WinAPI
    const script = `
      Add-Type -TypeDefinition @"
      using System;
      using System.Runtime.InteropServices;
      public class WinInet {
        [DllImport("wininet.dll")]
        public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
        public const int INTERNET_OPTION_SETTINGS_CHANGED = 39;
        public const int INTERNET_OPTION_REFRESH = 37;
      }
"@
      [WinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
      [WinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
    `;

    try {
      // 换行保留：here-string @"..."@ 要求 @" 行尾、"@ 行首，不可压成单行
      // windowsHide：与 ProcessEnumerator 的 powershell 调用对齐，避免闪 PowerShell 控制台窗
      await execFileAsync(this.psExe, ['-NoProfile', '-Command', script], { windowsHide: true });
    } catch (error) {
      // 通知失败不影响代理设置，只记录警告
      this.log('warn', `通知系统刷新代理设置失败: ${error}`);
    }
  }
}

/**
 * macOS 系统代理管理器
 * 使用 networksetup 命令配置网络服务代理
 */
export class MacOSSystemProxy extends SystemProxyBase {
  /**
   * 启用系统代理
   */
  async enableProxy(
    address: string,
    httpPort: number,
    socksPort: number,
    bypassList?: string[]
  ): Promise<void> {
    this.log('info', '正在设置 macOS 系统代理');

    // marker 提前写（intent）：enable 期间崩溃也留 marker，供下次启动恢复（disable 成功/失败回滚才会删）。
    this.writeMarker(`${address}:${httpPort}`);

    // 保存原始设置（防自指：已指向我们自己的代理 → 视为无原始，杜绝 disable restore 死端口致断网）。
    // 按"首个服务"读取，与 disable 时 restoreProxySettings 回写**全部**服务的单快照口径对称——勿用 iterate-all 的
    // getProxyStatus(那是给残留检测/清理用，会返回非首服务的代理)，否则多网卡上把以太网代理存为原始 → restore 误铺到
    // Wi-Fi 等全部服务(round-3 MED)。注：单快照 blanket 回写对"各服务代理不同"仍有损(既有设计限制，罕见配置，见设计文档)。
    try {
      const primary = (await this.getNetworkServices())[0];
      this.originalSettings = primary
        ? SystemProxyBase.stripSelf(await this.readServiceProxy(primary), address, httpPort)
        : null;
      this.log('info', '已保存原始代理设置');
    } catch (error) {
      this.log('warn', `无法获取原始代理设置: ${error}`);
      // 继续执行，即使无法获取原始设置
    }

    try {
      // 使用重试机制设置代理
      await retry(
        async () => {
          // 获取所有网络服务
          const services = await this.getNetworkServices();
          this.log('debug', `找到 ${services.length} 个网络服务`);

          // 为每个网络服务设置代理
          for (const service of services) {
            this.log('debug', `正在为网络服务 "${service}" 设置代理`);

            // 设置 HTTP 代理
            await execAsync(`networksetup -setwebproxy "${service}" ${address} ${httpPort}`);
            await execAsync(`networksetup -setwebproxystate "${service}" on`);

            // 设置 HTTPS 代理
            await execAsync(`networksetup -setsecurewebproxy "${service}" ${address} ${httpPort}`);
            await execAsync(`networksetup -setsecurewebproxystate "${service}" on`);

            // 设置 SOCKS 代理
            await execAsync(
              `networksetup -setsocksfirewallproxy "${service}" ${address} ${socksPort}`
            );
            await execAsync(`networksetup -setsocksfirewallproxystate "${service}" on`);

            // 代理绕过列表（忽略代理列表）= 用户配置的 bypass 清单（缺省业内聚合清单，对齐 Clash/Stash）。
            // networksetup 原样接受 CIDR(v4/v6) + 域名 + *.通配（空格分隔）。保存原列表→开启写入→关闭还原。
            const bypassDomains = formatBypassForMac(bypassList ?? []);
            // 攻击面 review H3：bypass 列表是用户可控输入（设置 UI 编辑 / 备份导入注入），原用 execAsync
            // shell 字符串拼接（${bypassDomains.join(' ')}）→ 含 ;/`/$() 的项可命令注入。改 execFileAsync
            // 数组参数：每个 bypass 项作为独立 argv 元素，不经 /bin/sh -c 解析，从根本上消除注入面。
            // service/address/httpPort 同为 argv（程序内常量/系统输出，虽非外部可控但一并参数化更稳）。
            await execFileAsync('networksetup', [
              '-setproxybypassdomains',
              service,
              ...bypassDomains,
            ]);

            this.log('debug', `网络服务 "${service}" 代理设置完成`);
          }
        },
        {
          maxRetries: 2,
          delay: 500,
          shouldRetry: (error) => {
            // 权限错误不重试
            const message = error.message.toLowerCase();
            if (message.includes('permission') || message.includes('not authorized')) {
              return false;
            }
            return true;
          },
          onRetry: (error, attempt) => {
            this.log('warn', `设置系统代理失败，正在进行第 ${attempt} 次重试: ${error.message}`);
          },
        }
      );

      // marker 已在 enable 前置写入（崩溃/强杀后下次启动据此恢复）
      this.log('info', 'macOS 系统代理设置成功');
    } catch (error) {
      this.log('error', `设置 macOS 系统代理失败: ${error}`);

      // 失败兜底（fail-closed）经 disableProxy 统一收口：有真实旧代理 → 恢复；originalSettings 为 null
      //（原本无代理，或旧代理就是我们自己被 stripSelf 置 null）→ 简单关掉全部服务。杜绝「部分 service 已
      // 半指向我们、又清掉了 marker」的自指残留——否则崩溃后所有 marker 门控失效 → 死端口断网（H3）。
      // disableProxy 内部成功后会 clearMarker；失败则补清一次。
      try {
        await this.disableProxy();
      } catch (rollbackError) {
        this.log('error', `失败兜底关闭/恢复系统代理失败: ${rollbackError}`);
        this.clearMarker();
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `设置 macOS 系统代理失败: ${errorMessage}\n\n可能的原因:\n1. 权限不足，请授予应用网络设置权限\n2. networksetup 命令不可用\n3. 网络服务配置异常`
      );
    }
  }

  /**
   * 禁用系统代理
   */
  async disableProxy(): Promise<void> {
    this.log('info', '正在禁用 macOS 系统代理');

    try {
      if (this.originalSettings) {
        // 恢复原始设置
        this.log('info', '正在恢复原始代理设置');
        await this.restoreProxySettings(this.originalSettings);
        this.originalSettings = null;
        this.log('info', '已恢复原始代理设置');
      } else {
        // 简单禁用代理
        const services = await this.getNetworkServices();
        for (const service of services) {
          this.log('debug', `正在禁用网络服务 "${service}" 的代理`);
          await execAsync(`networksetup -setwebproxystate "${service}" off`);
          await execAsync(`networksetup -setsecurewebproxystate "${service}" off`);
          await execAsync(`networksetup -setsocksfirewallproxystate "${service}" off`);
        }
        this.log('info', '已禁用系统代理');
      }
      // 拆除成功 → 删除持久化 marker
      this.clearMarker();
    } catch (error) {
      this.log('error', `禁用 macOS 系统代理失败: ${error}`);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`禁用 macOS 系统代理失败: ${errorMessage}\n\n建议手动检查系统代理设置`);
    }
  }

  /**
   * 同步禁用系统代理
   */
  disableProxySync(): void {
    const { execSync } = require('child_process');
    try {
      const activeInterfaces = execSync('networksetup -listallnetworkservices')
        .toString()
        .split('\n')
        .filter((s: string) => s && !s.includes('*') && !s.includes('Bluetooth'));

      let allOff = true;
      for (const service of activeInterfaces) {
        try {
          execSync(`networksetup -setwebproxystate "${service}" off`, { stdio: 'ignore' });
          execSync(`networksetup -setsecurewebproxystate "${service}" off`, { stdio: 'ignore' });
          execSync(`networksetup -setsocksfirewallproxystate "${service}" off`, {
            stdio: 'ignore',
          });
        } catch {
          allOff = false;
        }
      }
      // 全部服务成功关闭才删 marker；任一失败则保留，交下次启动恢复重试（避免漏关服务而 marker 已删失去兜底）
      if (allOff) this.clearMarker();
    } catch (error) {
      this.log('error', `同步禁用 macOS 系统代理失败: ${error}`);
    }
  }

  /**
   * 获取代理状态
   */
  async getProxyStatus(): Promise<SystemProxyStatus> {
    try {
      // 逐服务检查：代理可能设在非首个服务上（以太网优先 / VPN / 多网卡）。与 enable/disable 遍历全部服务同口径——
      // 任一服务有启用代理即返回它，避免只看 services[0] 漏检非首服务上的残留代理（修 round-2：macOS 误判"无残留"）。
      for (const service of await this.getNetworkServices()) {
        const status = await this.readServiceProxy(service);
        if (status.enabled) return status;
      }
      return { enabled: false };
    } catch {
      // 查询失败，返回禁用状态
      return { enabled: false };
    }
  }

  /** 读单个网络服务的 http/https/socks 代理（任一启用即 enabled）。DRY 化原三段重复块。 */
  private async readServiceProxy(service: string): Promise<SystemProxyStatus> {
    const read = async (sub: string): Promise<string | undefined> => {
      const { stdout } = await execAsync(`networksetup ${sub} "${service}"`);
      if (!stdout.includes('Enabled: Yes')) return undefined;
      const server = stdout.match(/Server: (.+)/);
      const port = stdout.match(/Port: (\d+)/);
      return server && port ? `${server[1].trim()}:${port[1].trim()}` : undefined;
    };
    const status: SystemProxyStatus = { enabled: false };
    status.httpProxy = await read('-getwebproxy');
    status.httpsProxy = await read('-getsecurewebproxy');
    status.socksProxy = await read('-getsocksfirewallproxy');
    status.enabled = !!(status.httpProxy || status.httpsProxy || status.socksProxy);
    return status;
  }

  /**
   * 获取所有网络服务
   */
  private async getNetworkServices(): Promise<string[]> {
    try {
      const { stdout } = await execAsync('networksetup -listallnetworkservices');
      const lines = stdout.split('\n');

      // 跳过首行提示 + 空行 + 以 * 开头的禁用服务 + Bluetooth PAN。
      // 排除 Bluetooth 与 disableProxySync 的退出兜底口径统一——否则 async enable 在 Bluetooth PAN 上设了代理，
      // 而 sync 退出兜底跳过它 → 残留无法被关（round-2 LOW：async/sync 服务集不一致）。
      return lines
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('*') && !line.includes('Bluetooth'));
    } catch (error) {
      throw new Error(
        `获取网络服务列表失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * 恢复代理设置
   */
  private async restoreProxySettings(settings: SystemProxyStatus): Promise<void> {
    const services = await this.getNetworkServices();

    for (const service of services) {
      if (settings.enabled) {
        // 恢复 HTTP 代理（攻击面 review M2：set*proxy 改 execFileAsync argv，server/port 来自系统原始设置
        // 经 shell 拼接有注入残面，与 enable 路径 H3 参数化口径统一）
        if (settings.httpProxy) {
          const [server, port] = settings.httpProxy.split(':');
          await execFileAsync('networksetup', ['-setwebproxy', service, server, port]);
          await execFileAsync('networksetup', ['-setwebproxystate', service, 'on']);
        } else {
          await execFileAsync('networksetup', ['-setwebproxystate', service, 'off']);
        }

        // 恢复 HTTPS 代理
        if (settings.httpsProxy) {
          const [server, port] = settings.httpsProxy.split(':');
          await execFileAsync('networksetup', ['-setsecurewebproxy', service, server, port]);
          await execFileAsync('networksetup', ['-setsecurewebproxystate', service, 'on']);
        } else {
          await execFileAsync('networksetup', ['-setsecurewebproxystate', service, 'off']);
        }

        // 恢复 SOCKS 代理
        if (settings.socksProxy) {
          const [server, port] = settings.socksProxy.split(':');
          await execFileAsync('networksetup', ['-setsocksfirewallproxy', service, server, port]);
          await execFileAsync('networksetup', ['-setsocksfirewallproxystate', service, 'on']);
        } else {
          await execFileAsync('networksetup', ['-setsocksfirewallproxystate', service, 'off']);
        }
      } else {
        // 禁用所有代理（M2：参数化对齐）
        await execFileAsync('networksetup', ['-setwebproxystate', service, 'off']);
        await execFileAsync('networksetup', ['-setsecurewebproxystate', service, 'off']);
        await execFileAsync('networksetup', ['-setsocksfirewallproxystate', service, 'off']);
      }
    }
  }
}

/**
 * Linux 系统代理管理器
 * 目前主要针对使用 GNOME 桌面环境的发行版（如 Debian/Ubuntu/Fedora）
 * 使用 gsettings 命令配置系统代理
 */
export class LinuxSystemProxy extends SystemProxyBase {
  /**
   * 启用系统代理
   */
  async enableProxy(
    address: string,
    httpPort: number,
    socksPort: number,
    bypassList?: string[]
  ): Promise<void> {
    this.log('info', '正在设置 Linux 系统代理');

    // 保存原始设置
    try {
      this.originalSettings = await this.getProxyStatus();
      this.log('info', '已保存原始代理设置');
    } catch (error) {
      this.log('warn', `无法获取原始代理设置: ${error}`);
    }

    try {
      await retry(
        async () => {
          // 设置 Mode 为 manual (gsettings)
          await execAsync('gsettings set org.gnome.system.proxy mode "manual"');

          // 设置 HTTP 代理
          await execAsync(`gsettings set org.gnome.system.proxy.http host "${address}"`);
          await execAsync(`gsettings set org.gnome.system.proxy.http port ${httpPort}`);
          await execAsync('gsettings set org.gnome.system.proxy.http enabled true');

          // 设置 HTTPS 代理
          await execAsync(`gsettings set org.gnome.system.proxy.https host "${address}"`);
          await execAsync(`gsettings set org.gnome.system.proxy.https port ${httpPort}`);

          // 设置 SOCKS 代理
          await execAsync(`gsettings set org.gnome.system.proxy.socks host "${address}"`);
          await execAsync(`gsettings set org.gnome.system.proxy.socks port ${socksPort}`);

          // 设置忽略列表（用户配置的 bypass 清单，缺省业内聚合清单）。gsettings ignore-hosts 为 GVariant 字符串数组，
          // 接受 CIDR + 域名；单引号包裹、逗号分隔。
          // 攻击面 review H1（与 mac H3 / win M1 同源）：原 execAsync shell 双引号拼接 ignoreList，bypass 项含
          // $()/反引号时在双引号内仍展开 → 命令注入（原注释"无注入风险"误判）。改 execFileAsync argv 参数化，
          // ignoreList 作为独立 argv 元素不经 /bin/sh -c 解析，从根本上消除注入面。
          const hosts = formatBypassForLinux(bypassList ?? []);
          const ignoreList = `[${hosts.map((h) => `'${h}'`).join(', ')}]`;
          await execFileAsync('gsettings', [
            'set',
            'org.gnome.system.proxy',
            'ignore-hosts',
            ignoreList,
          ]);
        },
        { maxRetries: 1, delay: 500 }
      );
      // 持久化 marker：标记系统代理由 FlowZ 设置（崩溃/强杀后下次启动据此恢复）
      this.writeMarker(`${address}:${httpPort}`);
      this.log('info', 'Linux 系统代理设置成功');
    } catch (error) {
      this.log('error', `设置 Linux 系统代理失败: ${error}`);
      throw error;
    }
  }

  /**
   * 禁用系统代理
   */
  async disableProxy(): Promise<void> {
    this.log('info', '正在禁用 Linux 系统代理');
    try {
      await execAsync('gsettings set org.gnome.system.proxy mode "none"');
      this.log('info', '已禁用系统代理');
      // 拆除成功 → 删除持久化 marker
      this.clearMarker();
    } catch (error) {
      this.log('error', `禁用 Linux 系统代理失败: ${error}`);
    }
  }

  /**
   * 获取代理状态
   */
  async getProxyStatus(): Promise<SystemProxyStatus> {
    try {
      const modeResult = await execAsync('gsettings get org.gnome.system.proxy mode');
      const isManual = modeResult.stdout.includes("'manual'");

      if (!isManual) {
        return { enabled: false };
      }

      const hostResult = await execAsync('gsettings get org.gnome.system.proxy.http host');
      const portResult = await execAsync('gsettings get org.gnome.system.proxy.http port');

      const host = hostResult.stdout.replace(/'/g, '').trim();
      const port = portResult.stdout.trim();
      // mode=manual 但 host 空 = 无实际代理（用户清了 host），不误报 enabled（否则 advisory 弹 ":port"）。
      if (!host) return { enabled: false };

      return {
        enabled: true,
        httpProxy: `${host}:${port}`,
      };
    } catch {
      return { enabled: false };
    }
  }

  /**
   * 同步禁用系统代理
   */
  disableProxySync(): void {
    const { execSync } = require('child_process');
    try {
      // GNOME
      execSync('gsettings set org.gnome.system.proxy mode "none"', { stdio: 'ignore' });
      // GNOME 禁用成功 → 删除持久化 marker（enableProxy 仅走 GNOME 路径）
      this.clearMarker();
    } catch {
      /* ignore */
    }
    try {
      // KDE
      execSync('kwriteconfig5 --file kioslaverc --group "Proxy Settings" --key "ProxyType" 0', {
        stdio: 'ignore',
      });
    } catch {
      /* ignore */
    }
  }
}

/**
 * 创建系统代理管理器
 * 根据当前平台返回对应的实现
 */
export function createSystemProxyManager(): ISystemProxyManager {
  const platform = process.platform;

  if (platform === 'win32') {
    return new WindowsSystemProxy();
  } else if (platform === 'darwin') {
    return new MacOSSystemProxy();
  } else if (platform === 'linux') {
    return new LinuxSystemProxy();
  }

  throw new Error(`不支持平台: ${platform}`);
}
