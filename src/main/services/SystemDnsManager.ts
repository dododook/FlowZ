/**
 * 系统 DNS 接管管理服务（TUN 模式治本）。
 * 根因：macOS/Win 的系统 DNS 多为 on-link 的 LAN/ISP 地址，不经 TUN 默认路由 → sing-box 的 hijack-dns 看不到
 * → 需走代理的域名被系统解析器解析为真实/错族 IP，代理连接被破坏（双栈站 ERR_CONNECTION_CLOSED / 真 v6 泄漏）。
 * 治本：TUN 启动时把系统 DNS 强制设为「受控、可路由、不在 bootstrap-direct」的 IP（8.8.8.8），使其经 TUN 被
 * hijack（真进 sing-box → FakeIP/远程解析）；停止/退出/崩溃恢复还原原始。
 * 完全沿用 SystemProxyManager 的 marker + single-writer + 防自指 + sync 退出 + 启动恢复五件套。
 * 设计见 docs/design/dns-ipv6-takeover.md。
 */

import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { retry } from '../utils/retry';
import { getUserDataPath } from '../utils/paths';
import { system32 } from '../utils/win-system32';
import type { LogManager } from './LogManager';
import type { LogLevel } from '../../shared/types';
import { CONTROLLED_TUN_DNS_IP } from '../../shared/dns';
import {
  type SystemDnsMarker,
  isControlledDnsIpValid,
  parseMacGetDnsServers,
  macSetDnsArgs,
  winSetDnsCommands,
  parseWinShowDnsServers,
  parseWinInterfaces,
  parseScutilNameservers,
  extractIpv4s,
  pickLanResolverIp,
  computeOriginalToSave,
} from '../../shared/system-dns';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// 单条系统 DNS 命令（networksetup/netsh）硬超时：防某条命令 hang 住无限阻断 TUN 启动（兑现 setDns
// 「best-effort 不阻断 TUN 启动」承诺）。命中即子进程被 kill、调用 reject → 经 retry/try-catch 降级为 best-effort。
const DNS_CMD_TIMEOUT_MS = 8000;

/**
 * 系统 DNS 管理器接口
 */
export interface ISystemDnsManager {
  /** TUN 启动 → 保存原始 DNS、把系统 DNS 设为受控 IP（best-effort：失败仅告警，不阻断 TUN 启动）。 */
  setDns(): Promise<void>;
  /** 停止/切模式 → 还原原始 DNS（marker 在才动手由调用方门控）。 */
  restoreDns(): Promise<void>;
  /** 同步还原（关机/退出等紧急场景，读 marker 跨会话还原）。 */
  restoreDnsSync(): void;
  /** 是否存在「DNS 由 FlowZ 接管」marker（终态清理门控用）。 */
  hasMarker(): boolean;
  /**
   * 方案B：读「接管前的内网 LAN 解析器 IP」（私网 IPv4），供 generateDnsConfig 把内网/captive 域名重定向到它
   * （takeover 后 dns-local=公网 8.8.8.8 解不了内网）。无可用（DHCP 读不到/仅公网/Linux）→ null，调用方退回 dns-local。
   * 必须在 setDns 改写系统 DNS 之前读（此刻生效解析器仍是 LAN）。只读、无副作用。
   */
  getLanResolverForDns(): Promise<string | null>;
  /** 注入日志 sink。 */
  setLogManager(lm: LogManager): void;
}

/**
 * 系统 DNS 管理器基类：marker IO + orchestration（setDns/restoreDns/sync）。
 * 平台命令（list/read/apply）由子类实现，orchestration 写一次。
 */
export abstract class SystemDnsBase implements ISystemDnsManager {
  protected originalDns: Record<string, string[]> | null = null;
  protected readonly controlledIp = CONTROLLED_TUN_DNS_IP;

  private logManager?: LogManager;
  setLogManager(lm: LogManager): void {
    this.logManager = lm;
  }

  /** 统一日志出口；LogManager 未注入时 fallback console（可能早于 LogManager 初始化，不 brick）。 */
  protected log(level: LogLevel, message: string): void {
    if (this.logManager) {
      this.logManager.addLog(level, message, 'SystemDns');
      return;
    }
    if (level === 'error' || level === 'fatal') console.error(message);
    else if (level === 'warn') console.warn(message);
    else console.log(message);
  }

  /** 持久化 marker 路径（userData/system-dns.marker.json）。 */
  private static getMarkerPath(): string {
    return path.join(getUserDataPath(), 'system-dns.marker.json');
  }

  /** 写 marker（setDns 前置写入 intent；同步 fs，失败仅告警绝不抛）。 */
  protected writeMarker(original: Record<string, string[]>): void {
    try {
      const marker: SystemDnsMarker = { controlledIp: this.controlledIp, original, at: Date.now() };
      fs.writeFileSync(SystemDnsBase.getMarkerPath(), JSON.stringify(marker));
    } catch (error) {
      this.log('warn', `写入系统 DNS marker 失败: ${error}`);
    }
  }

  protected clearMarker(): void {
    SystemDnsBase.clearMarkerFile();
  }

  /** 删除 marker（静态入口，供启动恢复清理）；失败仅告警绝不抛。 */
  static clearMarkerFile(): void {
    try {
      fs.rmSync(SystemDnsBase.getMarkerPath(), { force: true });
    } catch (error) {
      console.warn('删除系统 DNS marker 失败:', error);
    }
  }

  /** 读 marker；不存在 / 损坏 / 结构非法 → null。 */
  static readMarker(): SystemDnsMarker | null {
    try {
      const raw = fs.readFileSync(SystemDnsBase.getMarkerPath(), 'utf-8');
      const data = JSON.parse(raw);
      if (
        data &&
        typeof data.controlledIp === 'string' &&
        data.original &&
        typeof data.original === 'object'
      ) {
        return data as SystemDnsMarker;
      }
      return null;
    } catch {
      return null;
    }
  }

  hasMarker(): boolean {
    return SystemDnsBase.readMarker() !== null;
  }

  // ── 平台抽象（命令集中在子类；orchestration 在基类）──
  /** 列出应接管的网络服务/接口名。 */
  protected abstract listTargets(): Promise<string[]>;
  /** 读某服务/接口的当前 DNS（[] = DHCP/自动）。 */
  protected abstract readDns(target: string): Promise<string[]>;
  /** 设某服务/接口 DNS（[] → DHCP/Empty 还原）。 */
  protected abstract applyDns(target: string, ips: string[]): Promise<void>;
  /** 同步列接口（退出兜底）。 */
  protected abstract listTargetsSync(): string[];
  /** 同步设 DNS（退出兜底）。 */
  protected abstract applyDnsSync(target: string, ips: string[]): void;
  /** 读「生效」DNS 解析器候选 IP（含 DHCP 下发的；方案B 用）。无法读 → []。 */
  protected abstract readEffectiveResolvers(): Promise<string[]>;

  /**
   * 方案B：挑接管前的内网 LAN 解析器（私网 IPv4，排除受控 IP）。读失败/无私网解析器 → null。
   * marker 在（接管已激活，如 switchMode 重启的 start 腿——stop 腿因 stopping 守卫未还原）→ 生效解析器已是受控 IP，
   * 改用 marker.original（接管前真实 LAN）；否则（干净启动）读 scutil/netsh 生效解析器（含 DHCP 下发的）。
   */
  async getLanResolverForDns(): Promise<string | null> {
    try {
      const marker = SystemDnsBase.readMarker();
      const candidates = marker
        ? Object.values(marker.original).flat()
        : await this.readEffectiveResolvers();
      return pickLanResolverIp(candidates, this.controlledIp);
    } catch {
      return null;
    }
  }

  /**
   * TUN 启动接管系统 DNS。best-effort：失败仅告警 + 回滚还原，绝不抛（DNS 治理降级不应阻断 TUN 启动）。
   */
  async setDns(): Promise<void> {
    // 守卫：受控 IP 绝不能在 bootstrap-direct 列表（否则 :53 被直连规则放行、逃逸 hijack → 接管失效）。
    // 命中=配置漂移，fail-closed 不接管（单测护栏断言 CONTROLLED_TUN_DNS_IP 不命中，运行期再纵深防御一次）。
    if (!isControlledDnsIpValid(this.controlledIp)) {
      this.log(
        'error',
        `受控 DNS IP ${this.controlledIp} 在 bootstrap-direct 列表，拒绝接管（会逃逸 hijack）`
      );
      return;
    }

    this.log('info', '正在接管系统 DNS（TUN 模式）');

    let targets: string[];
    try {
      targets = await this.listTargets();
    } catch (error) {
      this.log('warn', `获取网络服务列表失败，跳过 DNS 接管: ${error}`);
      return;
    }
    if (targets.length === 0) {
      this.log('warn', '无可接管的网络服务，跳过 DNS 接管');
      return;
    }

    // 读当前 DNS + 防自指计算原始值（再次接管时若当前已是受控 IP，回退既有 marker 的真实原始）
    const current: Record<string, string[]> = {};
    for (const t of targets) {
      current[t] = await this.readDns(t).catch(() => []);
    }
    const existing = SystemDnsBase.readMarker();
    const original = computeOriginalToSave(current, this.controlledIp, existing?.original);

    // marker 前置写入（intent）：set 期间崩溃也留 marker，下次启动据此还原。
    this.originalDns = original;
    this.writeMarker(original);

    try {
      await retry(
        async () => {
          for (const t of targets) {
            await this.applyDns(t, [this.controlledIp]);
          }
        },
        {
          maxRetries: 2,
          delay: 500,
          shouldRetry: (error) => {
            const m = error.message.toLowerCase();
            return !(m.includes('permission') || m.includes('not authorized'));
          },
          onRetry: (error, attempt) => {
            this.log('warn', `设置系统 DNS 失败，正在进行第 ${attempt} 次重试: ${error.message}`);
          },
        }
      );
      this.log('info', `系统 DNS 已接管为 ${this.controlledIp}`);
    } catch (error) {
      this.log('error', `接管系统 DNS 失败: ${error}`);
      // 失败兜底：还原（best-effort）以免半接管残留；还原失败则补清 marker。不抛——不阻断 TUN 启动。
      try {
        await this.restoreDns();
      } catch (rollbackError) {
        this.log('error', `失败兜底还原系统 DNS 失败: ${rollbackError}`);
        this.clearMarker();
      }
    }
  }

  /**
   * 还原系统 DNS 为接管前原始值。无 marker/原始 → 仅清 marker。还原成功 → 清 marker + 清内存。
   */
  async restoreDns(): Promise<void> {
    const marker = SystemDnsBase.readMarker();
    const original = this.originalDns ?? marker?.original ?? null;
    if (!original) {
      this.clearMarker();
      return;
    }

    this.log('info', '正在还原系统 DNS');
    let targets: string[];
    try {
      targets = await this.listTargets();
    } catch {
      targets = Object.keys(original);
    }
    // 接管前不存在、本次新增的服务不动；只还原 original 里记录过的（= 我们改过的）。
    // 接管时存在、还原时已消失的服务不在 listTargets → 自然跳过（其 DNS 设置随服务消失，无需还原）。
    const restoreTargets = targets.length ? targets : Object.keys(original);
    // 逐服务 best-effort：单服务失败不阻断其余还原（防『首个失败 → 后续已改服务漏还原』泄漏），与 restoreDnsSync
    // 同口径。全部成功才清 marker + 内存；任一失败保留 marker 交下次启动 recovery 重试。
    let allOk = true;
    for (const t of restoreTargets) {
      if (!(t in original)) continue;
      try {
        await this.applyDns(t, original[t]);
      } catch (error) {
        allOk = false;
        this.log('warn', `还原网络服务 "${t}" 的 DNS 失败: ${error}`);
      }
    }
    if (allOk) {
      this.originalDns = null;
      this.clearMarker();
      this.log('info', '系统 DNS 已还原');
    } else {
      this.log('warn', '部分网络服务 DNS 还原失败，保留 marker 交下次启动重试');
    }
  }

  /**
   * 同步还原（退出/关机紧急场景）：读 marker（跨会话，新实例内存无 originalDns），全部还原成功才清 marker。
   */
  restoreDnsSync(): void {
    const marker = SystemDnsBase.readMarker();
    const original = marker?.original ?? this.originalDns ?? null;
    if (!original) return;
    try {
      const targets = this.listTargetsSync();
      const restoreTargets = targets.length ? targets : Object.keys(original);
      let allOk = true;
      for (const t of restoreTargets) {
        if (!(t in original)) continue;
        try {
          this.applyDnsSync(t, original[t]);
        } catch {
          allOk = false;
        }
      }
      // 全部还原成功才删 marker；任一失败保留，交下次启动恢复重试（避免漏还原而 marker 已删失去兜底）。
      if (allOk) this.clearMarker();
    } catch (error) {
      this.log('error', `同步还原系统 DNS 失败: ${error}`);
    }
  }
}

/**
 * macOS：networksetup -getdnsservers / -setdnsservers（per network service）。
 */
export class MacOSSystemDns extends SystemDnsBase {
  protected async listTargets(): Promise<string[]> {
    const { stdout } = await execAsync('networksetup -listallnetworkservices', {
      timeout: DNS_CMD_TIMEOUT_MS,
    });
    return stdout
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('*'));
  }

  protected async readDns(service: string): Promise<string[]> {
    const { stdout } = await execFileAsync('networksetup', ['-getdnsservers', service], {
      timeout: DNS_CMD_TIMEOUT_MS,
    });
    return parseMacGetDnsServers(stdout);
  }

  protected async applyDns(service: string, ips: string[]): Promise<void> {
    // execFile 传 argv：服务名含空格（如 "USB 10/100/1000 LAN"）也安全，无引号歧义。
    await execFileAsync('networksetup', macSetDnsArgs(service, ips), {
      timeout: DNS_CMD_TIMEOUT_MS,
    });
  }

  protected listTargetsSync(): string[] {
    const { execSync } = require('child_process');
    return execSync('networksetup -listallnetworkservices', { timeout: DNS_CMD_TIMEOUT_MS })
      .toString()
      .split('\n')
      .slice(1)
      .map((l: string) => l.trim())
      .filter((l: string) => l && !l.startsWith('*'));
  }

  protected applyDnsSync(service: string, ips: string[]): void {
    const { execFileSync } = require('child_process');
    execFileSync('networksetup', macSetDnsArgs(service, ips), {
      stdio: 'ignore',
      timeout: DNS_CMD_TIMEOUT_MS,
    });
  }

  protected async readEffectiveResolvers(): Promise<string[]> {
    // scutil --dns 反映生效解析器（含 DHCP 下发的，networksetup -getdnsservers 对 DHCP 返空拿不到）。
    const { stdout } = await execAsync('scutil --dns', { timeout: DNS_CMD_TIMEOUT_MS });
    return parseScutilNameservers(stdout);
  }
}

/**
 * Windows：netsh interface ipv4 set/show dnsservers（per connected interface）。真机待验（netsh 输出本地化）。
 */
export class WindowsSystemDns extends SystemDnsBase {
  private readonly netshExe = system32('netsh.exe');

  protected async listTargets(): Promise<string[]> {
    const { stdout } = await execAsync(`"${this.netshExe}" interface ipv4 show interfaces`, {
      timeout: DNS_CMD_TIMEOUT_MS,
    });
    return parseWinInterfaces(stdout);
  }

  protected async readDns(iface: string): Promise<string[]> {
    const { stdout } = await execAsync(
      `"${this.netshExe}" interface ipv4 show dnsservers name="${iface}"`,
      { timeout: DNS_CMD_TIMEOUT_MS }
    );
    return parseWinShowDnsServers(stdout);
  }

  protected async applyDns(iface: string, ips: string[]): Promise<void> {
    for (const cmd of winSetDnsCommands(this.netshExe, iface, ips)) {
      await execAsync(cmd, { timeout: DNS_CMD_TIMEOUT_MS });
    }
  }

  protected listTargetsSync(): string[] {
    const { execSync } = require('child_process');
    try {
      const out = execSync(`"${this.netshExe}" interface ipv4 show interfaces`, {
        timeout: DNS_CMD_TIMEOUT_MS,
      }).toString();
      return parseWinInterfaces(out);
    } catch {
      return [];
    }
  }

  protected applyDnsSync(iface: string, ips: string[]): void {
    const { execSync } = require('child_process');
    for (const cmd of winSetDnsCommands(this.netshExe, iface, ips)) {
      execSync(cmd, { stdio: 'ignore', timeout: DNS_CMD_TIMEOUT_MS });
    }
  }

  protected async readEffectiveResolvers(): Promise<string[]> {
    // 逐**已连接**接口读 DNS（与 listTargets 同口径，避免 VMware/Hyper-V/VPN 虚拟网卡的私网 DNS 抢先被选）。
    // 单接口 show dnsservers 同时含 static 与 dhcp 行 → extractIpv4s 两者都取；输出本地化不影响 IPv4 提取。
    // 仅 READ（show，非提权可跑），供 getLanResolverForDns(方案B) 用——SET(setDns) 已收敛为 no-op，见下。
    const ifaces = await this.listTargets();
    const all: string[] = [];
    for (const iface of ifaces) {
      try {
        const { stdout } = await execAsync(
          `"${this.netshExe}" interface ipv4 show dnsservers name="${iface}"`,
          { timeout: DNS_CMD_TIMEOUT_MS }
        );
        for (const ip of extractIpv4s(stdout)) {
          if (!all.includes(ip)) all.push(ip);
        }
      } catch {
        /* 单接口读失败跳过 */
      }
    }
    return all;
  }

  // ── 收口（2026-06-17，真机实证）：Windows 不接管系统 DNS（与 Linux 同口径） ──
  // 根因：① sing-box TUN `strict_route`(WFP) 已在路由层把所有 :53(含 DHCP/系统分配 DNS)强制逼进 TUN → 被 hijack，
  //   不需要也不应再改系统 DNS 设置项；② `netsh set dnsservers` 需管理员，FlowZ GUI 非提权 → 真机每次 ACCESS DENIED
  //   失败，且 set 前已写 marker → 失败后 marker 卡死 → 每次启动反复「还原 netsh 失败、保留 marker」刷错误日志。
  // 故 setDns/restoreDns/sync 收敛为 no-op（READ 机制保留供方案B）。详见 docs/design/dns-ipv6-takeover.md §A。
  async setDns(): Promise<void> {
    this.log(
      'info',
      'Windows 不接管系统 DNS（sing-box TUN strict_route/WFP 已在路由层劫持 :53；netsh set 需管理员、GUI 非提权必失败）'
    );
  }
  async restoreDns(): Promise<void> {
    // 清历史（旧版 netsh 失败）残留的 stuck marker，否则 hasMarker 恒 true 致每个终态点/启动 recovery 反复空跑还原。
    this.clearMarker();
  }
  restoreDnsSync(): void {
    this.clearMarker();
  }
}

/**
 * Linux：暂不接管系统 DNS。发行版差异大（systemd-resolved/resolv.conf/NetworkManager），写入风险高，
 * 且 FlowZ Linux TUN 由 sing-box auto_route 自身处理 DNS。best-effort no-op（不写 marker、不动系统）。
 */
export class LinuxSystemDns extends SystemDnsBase {
  protected async listTargets(): Promise<string[]> {
    return [];
  }
  protected async readDns(): Promise<string[]> {
    return [];
  }
  protected async applyDns(): Promise<void> {
    /* no-op */
  }
  protected listTargetsSync(): string[] {
    return [];
  }
  protected applyDnsSync(): void {
    /* no-op */
  }
  protected async readEffectiveResolvers(): Promise<string[]> {
    return [];
  }

  async setDns(): Promise<void> {
    this.log(
      'info',
      'Linux 暂不接管系统 DNS（best-effort no-op；TUN DNS 由 sing-box auto_route 处理）'
    );
  }
  async restoreDns(): Promise<void> {
    // Linux 从不接管、不写 marker。若存在 marker（如跨平台拷贝 userData 带入的 Mac/Win 残留）→ 清掉，
    // 否则 hasMarker() 恒 true 致每个终态点反复进还原 no-op + 启动 recovery 误报。
    this.clearMarker();
  }
  restoreDnsSync(): void {
    this.clearMarker();
  }
}

/**
 * 创建系统 DNS 管理器（按平台）。
 */
export function createSystemDnsManager(): ISystemDnsManager {
  const platform = process.platform;
  if (platform === 'darwin') return new MacOSSystemDns();
  if (platform === 'win32') return new WindowsSystemDns();
  return new LinuxSystemDns();
}
