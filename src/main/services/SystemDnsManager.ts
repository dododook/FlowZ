/**
 * 系统 DNS 接管管理服务（TUN 模式治本）。
 * 根因：macOS/Win 的系统 DNS 多为 on-link 的 LAN/ISP 地址，不经 TUN 默认路由 → sing-box 的 hijack-dns 看不到
 * → 需走代理的域名被系统解析器解析为真实/错族 IP，代理连接被破坏（双栈站 ERR_CONNECTION_CLOSED / 真 v6 泄漏）。
 * 治本：TUN 启动时把系统 DNS 强制设为「受控、可路由、不在 bootstrap-direct」的 IP（8.8.8.8），使其经 TUN 被
 * hijack（真进 sing-box → FakeIP/远程解析）；停止/退出/崩溃恢复还原原始。
 * 完全沿用 SystemProxyManager 的 marker + single-writer + 防自指 + sync 退出 + 启动恢复五件套。
 * 设计见 docs/design/dns-ipv6-takeover.md。
 */

import { exec, execFile, execFileSync } from 'child_process';
import { networkInterfaces } from 'os';
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
  pickTunInterfaceByAddress,
  resolvectlDnsArgs,
  resolvectlDomainArgs,
  resolvectlRevertArgs,
  resolvectlLinkValues,
  parseResolvectlLinks,
} from '../../shared/system-dns';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// 单条系统 DNS 命令（networksetup/netsh）硬超时：防某条命令 hang 住无限阻断 TUN 启动（兑现 setDns
// 「best-effort 不阻断 TUN 启动」承诺）。命中即子进程被 kill、调用 reject → 经 retry/try-catch 降级为 best-effort。
const DNS_CMD_TIMEOUT_MS = 8000;

/** setDns 的可选入参（平台按需取用；不认识的字段一律忽略）。 */
export interface SetDnsOptions {
  /**
   * 本次 TUN 的 IPv4 地址（可带 CIDR）。Linux 用它**按地址**认出 FlowZ 自己的 TUN 链路——按名字认会误伤
   * OpenVPN/WireGuard 等同样叫 `tun0` 的链路。缺省 → Linux fail-closed 不接管。
   */
  tunInet4Address?: string | null;
}

export interface ISystemDnsManager {
  /** TUN 启动 → 保存原始 DNS、把系统 DNS 设为受控 IP（best-effort：失败仅告警，不阻断 TUN 启动）。 */
  setDns(opts?: SetDnsOptions): Promise<void>;
  /** 停止/切模式 → 还原原始 DNS（marker 在才动手由调用方门控）。 */
  restoreDns(): Promise<void>;
  /**
   * 热插重灌：接管激活中（marker 在）时，把「启动后新出现 / 仍未受控」的网络服务也接管为受控 IP。
   * 幂等（已受控跳过）+ best-effort（单服务失败不阻断其余、绝不抛）+ 防自指（不覆盖既有 marker 的真实原始、
   * 不把受控 IP 误存成原始）。Win/Linux 无 marker → 自然 no-op，无需 override。
   */
  reconcileDns(): Promise<void>;
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
  /** 子类可往 marker 里追加平台字段（Linux 记 TUN 地址，跨会话还原据此核验身份）。默认无。 */
  protected markerExtra(): Partial<SystemDnsMarker> {
    return {};
  }

  protected writeMarker(original: Record<string, string[]>): void {
    try {
      const marker: SystemDnsMarker = {
        controlledIp: this.controlledIp,
        original,
        at: Date.now(),
        ...this.markerExtra(),
      };
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
  async setDns(_opts?: SetDnsOptions): Promise<void> {
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
   * 热插重灌：接管激活中（marker 在）时，把「启动后新出现 / 仍未受控」的网络服务也接管为受控 IP。
   * 不变量：① 仅 marker 在才动手（接管未激活时绝不写系统）；② 先写 marker 再 apply（崩溃留 intent 据此还原）；
   * ③ 只 apply 未受控服务（已受控跳过 → 幂等）；④ best-effort 逐服务，单服务失败不阻断其余、绝不抛；
   * ⑤ 防自指 + 不覆盖已消失服务的 original（mergedOriginal 以既有 marker.original 为底，仅并入新捕获的真实原始）。
   */
  async reconcileDns(): Promise<void> {
    // 守卫：受控 IP 在 bootstrap-direct → fail-closed 不接管（与 setDns 同口径，纵深防御一次）。
    if (!isControlledDnsIpValid(this.controlledIp)) return;
    // marker 不在 = 接管未激活（或 Win/Linux 永不写 marker）→ 绝不擅自接管，直接返回。
    const marker = SystemDnsBase.readMarker();
    if (!marker) return;

    let targets: string[];
    try {
      targets = await this.listTargets();
    } catch {
      return;
    }
    if (targets.length === 0) return;

    // 读各服务当前 DNS（best-effort，读失败按 [] 处理）。
    const current: Record<string, string[]> = {};
    for (const t of targets) {
      current[t] = await this.readDns(t).catch(() => []);
    }

    // 以既有 marker.original 为底，并入当前各服务的「应保存原始」（防自指：已受控的回退既有真实原始）。
    // 展开顺序保证既有 original 里已消失服务的记录保留（computeOriginalToSave 只覆盖 current 里出现的服务）。
    const mergedOriginal = {
      ...marker.original,
      ...computeOriginalToSave(current, this.controlledIp, marker.original),
    };

    const isControlled = (ips: string[]) => ips.length === 1 && ips[0] === this.controlledIp;
    const toApply = targets.filter((t) => !isControlled(current[t]));
    if (toApply.length === 0) return; // 全部已受控 → 幂等 no-op（不写 marker、不动系统）。

    // 先写 marker（含合并后的真实原始）再 apply：apply 期间崩溃也留 intent，下次启动据此精确还原。
    this.originalDns = mergedOriginal;
    this.writeMarker(mergedOriginal);

    for (const t of toApply) {
      try {
        await this.applyDns(t, [this.controlledIp]);
      } catch (e) {
        this.log('warn', `重灌服务 "${t}" DNS 失败: ${e}`);
      }
    }
    this.log('info', `DNS 重灌：${toApply.length} 个未受控服务接管为 ${this.controlledIp}`);
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
    return (
      stdout
        .split('\n')
        .slice(1)
        .map((l) => l.trim())
        // 与 SystemProxyManager.getNetworkServices 口径统一，排除 Bluetooth PAN——
        // 否则 DNS 接管会把 DNS 写到蓝牙网络（PAN/个人热点），关闭后可能残留。
        .filter((l) => l && !l.startsWith('*') && !l.includes('Bluetooth'))
    );
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
    return (
      execSync('networksetup -listallnetworkservices', { timeout: DNS_CMD_TIMEOUT_MS })
        .toString()
        .split('\n')
        .slice(1)
        .map((l: string) => l.trim())
        // 与 async listTargets 口径统一，排除 Bluetooth PAN——否则关机还原
        //（restoreDnsSync 走此 sync 路径）仍会往蓝牙网络写 DNS，async/sync 服务集不一致。
        .filter((l: string) => l && !l.startsWith('*') && !l.includes('Bluetooth'))
    );
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
 * Linux：经 systemd-resolved 接管 **FlowZ 自己那条 TUN 链路** 的 DNS（P2）。
 *
 * 为什么需要（不是「auto_route 已经处理了」）：Linux 上的 DNS 劫持全靠 auto_route 装的一条 ip rule
 * `from 0.0.0.0 iif lo lookup 2022`，它的匹配条件是「源地址未确定」——**一旦发起方显式 bind 接口或源地址，
 * 查询完全绕过 TUN**（netns 实测）。宿主机 systemd-resolved 单 scope 形态下实测不绑定（`SO_BINDTODEVICE, NULL, 0`
 * 是清除绑定），但它代码里存在设置绑定的分支，多 scope 环境未验证。接管把正确性从「resolved 恰好不绑定」
 * 换成「resolved 被配置成把查询发给受控 IP」——后者不依赖未验证前提。
 *
 * 机制：`resolvectl dns <tun> <受控IP>` + `resolvectl domain <tun> '~.'`。`~.` 是关键：没有它，resolved 只把
 * 匹配搜索域的查询分派到本链路，其余仍走原链路的上游。还原用 `resolvectl revert <tun>`。
 *
 * 三条与 mac/Win 不同的性质：
 *  ① **配置挂在 TUN 链路上**，而 TUN 随内核进程消失 → 崩溃/强杀不留残留（mac/Win 改的是常驻网络服务，必须还原）。
 *  ② **提权已就位**：Linux TUN 提权脚本已安装限定用户的 `org.freedesktop.resolve1.*` polkit 规则
 *     （见 PlatformPrivilegeService），故 resolvectl 免密码框。规则不在（用户拒绝提权）→ 命令失败 → 自动降级不接管。
 *  ③ **按地址认接口**，不按名字：`tun0` 可能是 OpenVPN/WireGuard 的，认错等于改别人的 DNS。
 *
 * 无 resolvectl（非 systemd-resolved 发行版）→ 全程 no-op、不写 marker，与本实现引入前行为一致。
 */
export class LinuxSystemDns extends SystemDnsBase {
  /** 本次接管的目标链路名；null = 尚未认出/不接管。setDns 时解析，restore/reconcile 复用。 */
  private tunInterface: string | null = null;
  /** 本次 TUN 的 IPv4 地址（来自 setDns 入参）。 */
  private tunInet4Address: string | null = null;
  /** resolvectl 可用性探测结果（null=未探测）。整个会话只探一次并只告警一次。 */
  private resolvectlAvailable: boolean | null = null;
  /** 「服务不可用」这类瞬态原因只告警一次，避免每次启动刷同一条。 */
  private probeWarned = false;

  /** 注入点：单测替换掉真实 exec / 接口枚举 / 等待，无需真机、不碰宿主网络。 */
  constructor(
    private readonly deps: {
      run?: (args: string[]) => Promise<string>;
      runSync?: (args: string[]) => string;
      networkInterfaces?: () => NodeJS.Dict<
        Array<{ address: string; family: string; internal: boolean }>
      >;
      sleep?: (ms: number) => Promise<void>;
      /** 等 TUN 接口出现的最大轮次与间隔（默认 20 × 150ms = 3s 上界）。 */
      waitRounds?: number;
      waitIntervalMs?: number;
    } = {}
  ) {
    super();
  }

  private async run(args: string[]): Promise<string> {
    if (this.deps.run) return this.deps.run(args);
    const { stdout } = await execFileAsync('resolvectl', args, { timeout: DNS_CMD_TIMEOUT_MS });
    return stdout;
  }

  private runSync(args: string[]): string {
    if (this.deps.runSync) return this.deps.runSync(args);
    return execFileSync('resolvectl', args, {
      timeout: DNS_CMD_TIMEOUT_MS,
      encoding: 'utf-8',
    });
  }

  private ifaces(): NodeJS.Dict<Array<{ address: string; family: string; internal: boolean }>> {
    if (this.deps.networkInterfaces) return this.deps.networkInterfaces();
    return networkInterfaces();
  }

  /**
   * 等 TUN 接口出现（有上界）。setDns 在核就绪之后调用，但「核就绪」与「TUN 网卡已在 os 层可见」之间
   * 仍有窗口，且就绪判定的语义可能随启动流程演进而变——自己等一小会儿，就不把正确性押在别处的时序上。
   */
  private async resolveTunInterface(): Promise<string | null> {
    // 与秒停并发时可能等到一半核已死：此时接口消失 → 返回 null → 不接管，不会留下 marker。
    // 反过来若在 apply 之前接口才消失，apply 会失败并走基类回滚（restoreDns → 接口不在 → 清 marker）。
    const rounds = this.deps.waitRounds ?? 20;
    const interval = this.deps.waitIntervalMs ?? 150;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let i = 0; i < rounds; i++) {
      const name = pickTunInterfaceByAddress(
        this.ifaces() as Record<
          string,
          { address: string; family: string; internal: boolean }[] | undefined
        >,
        this.tunInet4Address
      );
      if (name) return name;
      if (i < rounds - 1) await sleep(interval);
    }
    return null;
  }

  /**
   * systemd-resolved 是否**真的可用**。
   *
   * 探的是 `resolvectl dns`（只读、但要过 D-Bus）而**不是** `--version`：后者只证明二进制在，
   * 而装了 resolvectl 却没跑 resolved 的发行版并不少见（Arch 默认、部分 Debian、NetworkManager 自管 DNS 的机器）。
   * 用 `--version` 探活会让这些机器一路走到「marker 已写、apply 失败」——正是 Windows 接管那次的 stuck marker。
   *
   * 只把 ENOENT（二进制不存在）缓存成永久不可用：其余失败可能是瞬态（D-Bus 忙、8s 超时），缓存会让
   * 整个会话连方案B 的 LAN 解析器一起失能。
   */
  private async ensureResolvectl(): Promise<boolean> {
    if (this.resolvectlAvailable === false) return false;
    if (this.resolvectlAvailable === true) return true;
    try {
      await this.run(['dns']);
      this.resolvectlAvailable = true;
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 判据必须收窄到「二进制不存在」：resolved 已装未跑时的 `Unit dbus-org.freedesktop.resolve1.service
      // not found` 也含 "not found"，用宽判据会把它永久缓存成「非 systemd-resolved 发行版」，
      // 会话中途把 resolved 启起来也不再接管、连方案B 一起失能——且与 applyDns 侧把同一形态按
      // service-unavailable 处理的判据自相矛盾。
      const missing = /spawn\s+\S*resolvectl.*enoent|command not found/i.test(msg);
      if (missing) {
        this.resolvectlAvailable = false;
        this.log(
          'info',
          '本机无 resolvectl（非 systemd-resolved 发行版），不接管系统 DNS（TUN DNS 仍由 sing-box auto_route 劫持）'
        );
      } else if (!this.probeWarned) {
        this.probeWarned = true;
        this.log('info', `systemd-resolved 不可用（${msg.split('\n')[0]}），本次不接管系统 DNS`);
      }
      return false;
    }
  }

  /**
   * 写权限探针：对**我们自己刚建的** TUN 链路跑一次 `resolvectl revert`。
   *
   * 为什么必须在写 marker 之前探一次：`org.freedesktop.resolve1.*` 的 polkit 规则要么全放行要么全拒，
   * 拒的时候 set-dns 与 revert **一起**拒 —— 于是「先写 marker → apply 失败 → 回滚 revert 也失败 → marker 卡死」，
   * 每次启动都刷一轮「检测到残留、还原失败」。这正是本仓 Windows 接管被移除的第二条根因。
   * revert 打在新建的自家 TUN 上语义无害（新接口本就没有人工配置），却能一次同时证明「服务在」与「有授权」。
   */
  private async probeWritable(iface: string): Promise<boolean> {
    try {
      await this.run(resolvectlRevertArgs(iface));
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(
        'info',
        `无权修改 systemd-resolved 链路配置（${msg.split('\n')[0]}），本次不接管系统 DNS`
      );
      return false;
    }
  }

  /** 按地址找当前的自家 TUN 链路（每次重解析，绝不用缓存名——缓存名会在接口消失后指向别人的 tun0）。 */
  private currentTunInterface(address: string | null = this.tunInet4Address): string | null {
    return pickTunInterfaceByAddress(
      this.ifaces() as Record<
        string,
        { address: string; family: string; internal: boolean }[] | undefined
      >,
      address
    );
  }

  protected async listTargets(): Promise<string[]> {
    // 不在这里等待：restore/reconcile 也走本方法，接口已消失时等待只会白白拖住终态清理。
    // **每次按地址重解析**：缓存的接口名在核死后可能被别的客户端占用（Linux 不设 interface_name，
    // 自家默认名就是 tun0 = OpenVPN 的默认名）。
    const name = this.currentTunInterface();
    return name ? [name] : [];
  }

  /**
   * 只读 dns 不读 domain：`original` 因此不含链路接管前的搜索/路由域。对自建 TUN 无损（新接口恒空），
   * 还原也不受影响（走 revert 全清）。只有「接管一条已有链路」才会丢信息，而本实现只接管自己的 TUN。
   */
  protected async readDns(target: string): Promise<string[]> {
    const out = await this.run(['dns', target]);
    return resolvectlLinkValues(out, target);
  }

  protected async applyDns(target: string, ips: string[]): Promise<void> {
    try {
      if (ips.length === 0) {
        // 还原：revert 清掉本链路的一切人工配置（含 `~.` 路由域），回到系统下发值。比逐项设回更faithful。
        await this.run(resolvectlRevertArgs(target));
        return;
      }
      if (ips.length === 1 && ips[0] === this.controlledIp) {
        await this.run(resolvectlDnsArgs(target, ips));
        await this.run(resolvectlDomainArgs(target));
        return;
      }
      // 非受控值（还原到记录过的真实原始）：先 revert 清掉我们设的路由域，再设回原值，避免 `~.` 残留。
      await this.run(resolvectlRevertArgs(target));
      await this.run(resolvectlDnsArgs(target, ips));
    } catch (e) {
      // 归一化 polkit 拒绝的措辞：基类 retry 的 shouldRetry 以 'permission' / 'not authorized' 判定不可重试，
      // 而 resolvectl 的原文是 "Interactive authentication required."，不归一化会白重试两轮。
      const msg = e instanceof Error ? e.message : String(e);
      if (/interactive authentication required|not authorized|access denied/i.test(msg)) {
        throw new Error(`permission denied: ${msg}`);
      }
      // 服务不可用（resolved 未跑 / D-Bus 连不上）同样重试无益 —— 归一化成同一类，免白重试两轮。
      if (/failed to connect to bus|unit .* not found|is masked|no such unit/i.test(msg)) {
        throw new Error(`permission denied (service unavailable): ${msg}`);
      }
      throw e;
    }
  }

  protected listTargetsSync(): string[] {
    const name = this.currentTunInterface();
    return name ? [name] : [];
  }

  protected applyDnsSync(target: string, ips: string[]): void {
    if (ips.length === 0) {
      this.runSync(resolvectlRevertArgs(target));
      return;
    }
    this.runSync(resolvectlRevertArgs(target));
    this.runSync(resolvectlDnsArgs(target, ips));
  }

  /**
   * 方案B：读「接管前的内网 LAN 解析器」。取 resolvectl 的**各链路** DNS 而非 resolv.conf——
   * 后者在 systemd-resolved 下恒为指向 stub 的 127.0.0.53，零判别力。排除 TUN 链路自身（那是我们设的受控 IP）。
   */
  protected async readEffectiveResolvers(): Promise<string[]> {
    if (!(await this.ensureResolvectl())) return [];
    try {
      const out = await this.run(['dns']);
      const tun = this.tunInterface;
      return parseResolvectlLinks(out)
        .filter((l) => l.name !== tun)
        .flatMap((l) => l.values);
    } catch {
      return [];
    }
  }

  async setDns(opts?: SetDnsOptions): Promise<void> {
    // 与基类同一守卫，但必须前置：probeWritable 是**写操作**，不能跑在「受控 IP 非法就不接管」的判定之前。
    // 日志与基类同文，否则前置之后基类那条 error 不再触发，配置漂移就静默了。
    if (!isControlledDnsIpValid(this.controlledIp)) {
      this.log(
        'error',
        `受控 DNS IP ${this.controlledIp} 在 bootstrap-direct 列表，拒绝接管（会逃逸 hijack）`
      );
      return;
    }
    this.tunInet4Address = opts?.tunInet4Address ?? null;
    if (!this.tunInet4Address) {
      // fail-closed：没有地址就无法确定哪条链路是自己的，宁可不接管也不碰别人的链路。
      this.log(
        'warn',
        '未取得 TUN 地址，跳过 Linux 系统 DNS 接管（不按接口名猜，避免误改他人链路）'
      );
      return;
    }
    if (!(await this.ensureResolvectl())) return;
    this.tunInterface = await this.resolveTunInterface();
    if (!this.tunInterface) {
      this.log('warn', `未找到地址为 ${this.tunInet4Address} 的 TUN 接口，跳过系统 DNS 接管`);
      return;
    }
    // 写 marker 之前先证明「能写」：失败即降级，不留任何 marker（见 probeWritable 的注释）。
    if (!(await this.probeWritable(this.tunInterface))) {
      this.tunInterface = null;
      return;
    }
    this.log('info', `Linux 系统 DNS 接管目标链路：${this.tunInterface}`);
    await super.setDns(opts);
  }

  /** marker 记下本次的 TUN 地址——跨会话还原靠它核验身份，没有它就只能按名字猜。 */
  protected markerExtra(): Partial<SystemDnsMarker> {
    return this.tunInet4Address ? { tunInet4Address: this.tunInet4Address } : {};
  }

  /**
   * Linux 还原**不走基类**：基类在 listTargets 为空时回退到 `Object.keys(marker.original)` 按**接口名**下发，
   * 而 Linux 的接口名不带身份（自家默认就是 `tun0`，也是 OpenVPN 的默认名）。跨会话还原时新实例没有地址，
   * 那条回退等于「崩溃后按名字 revert tun0」——此刻 tun0 可能已经是用户的 OpenVPN，改的就是别人的链路。
   *
   * 本实现只认地址：
   *  - marker 里没有地址（旧版本写的 / 跨平台拷贝进来的 Mac·Win marker）→ 无法核验身份 →
   *    **只清 marker，绝不动系统**（我们的配置挂在 TUN 链路上，随接口消失，系统层无残留）；
   *  - 按地址找不到接口 → 接口已消失 → 同上视作已还原并清 marker。不这么判就会
   *    「revert 报 No such device → allOk=false → marker 永久滞留 → 每次启动刷一轮还原失败」，
   *    正是本仓 Windows 接管被移除的第二条根因；
   *  - 找得到 → revert 该接口，成功才清 marker。
   */
  /**
   * 这条链路上确实是**我们**设的接管吗（revert 前的最后一道身份核验）。
   *
   * 地址在崩溃之后不再等价于属主：另一个 sing-box 系客户端用同一默认网段（172.19.0.1）起了 TUN 且配了
   * resolved，按地址就会单命中到它——同址双接口的 fail-closed 挡不住「现在只剩它一个」。故 revert 前再读一次：
   * 链路上没有受控 IP 就不是我们的活儿，只清 marker 不动系统。读失败同样按「不是我们的」处理——
   * 我们的配置挂在自家 TUN 链路上、随接口消失，漏还原的代价远小于误改别人链路。
   */
  private async isOurTakeover(iface: string): Promise<boolean> {
    try {
      return (await this.readDns(iface)).includes(this.controlledIp);
    } catch {
      return false;
    }
  }

  async restoreDns(): Promise<void> {
    const marker = SystemDnsBase.readMarker();
    // marker 写入失败（磁盘满，writeMarker 只警不抛）时内存里仍有地址 → 仍按地址尝试还原，
    // 否则自家链路会残留受控 DNS 直到核死。marker 与内存都没有 → 无从核验身份，只清 marker。
    const address = marker?.tunInet4Address ?? this.tunInet4Address;
    const iface = address ? this.currentTunInterface(address) : null;
    if (!iface || !(await this.isOurTakeover(iface))) {
      this.clearMarker();
      this.tunInterface = null;
      // 清掉地址：留着会让下一次 restoreDns 拿一个陈旧地址去匹配，万一同址外来链路上恰好也有受控 IP
      // 就会误 revert。当前各调用点都有 marker 门控挡着，但纵深防御不该指望调用方。
      this.tunInet4Address = null;
      return;
    }
    try {
      await this.run(resolvectlRevertArgs(iface));
      this.originalDns = null;
      this.clearMarker();
      this.tunInterface = null;
      this.tunInet4Address = null;
      this.log('info', '系统 DNS 已还原');
    } catch (e) {
      this.log('warn', `还原链路 "${iface}" 的 DNS 失败，保留 marker 交下次启动重试: ${e}`);
    }
  }

  /** 同步还原（退出/关机）：与异步版同一判据——只认地址，接口不在即视作已还原。 */
  restoreDnsSync(): void {
    const marker = SystemDnsBase.readMarker();
    const address = marker?.tunInet4Address ?? this.tunInet4Address;
    const iface = address ? this.currentTunInterface(address) : null;
    if (!iface) {
      this.clearMarker();
      return;
    }
    // 与异步版同一身份核验：链路上没有受控 IP 就不是我们的活儿。
    let ours = false;
    try {
      ours = resolvectlLinkValues(this.runSync(['dns', iface]), iface).includes(this.controlledIp);
    } catch {
      ours = false;
    }
    if (!ours) {
      this.clearMarker();
      return;
    }
    try {
      this.runSync(resolvectlRevertArgs(iface));
      this.clearMarker();
    } catch {
      /* 保留 marker 交下次启动重试 */
    }
  }

  /**
   * 方案B：Linux 恒走 readEffectiveResolvers，**不走基类的 marker 分支**。
   * 基类在 marker 在时改读 `marker.original`，而 Linux 的 original 是「TUN 链路接管前的值」= 恒空，
   * 于是切节点/切模式重启（stop 腿被 stopping 守卫跳过还原、marker 仍在）时 LAN 解析器恒为 null，
   * 内网域名重定向只在冷启动有效。物理链路的 DNS 在接管期间未被我们改动，直接读它始终有效。
   */
  async getLanResolverForDns(): Promise<string | null> {
    return pickLanResolverIp(await this.readEffectiveResolvers(), this.controlledIp);
  }
}

export function createSystemDnsManager(): ISystemDnsManager {
  const platform = process.platform;
  if (platform === 'darwin') return new MacOSSystemDns();
  if (platform === 'win32') return new WindowsSystemDns();
  return new LinuxSystemDns();
}
