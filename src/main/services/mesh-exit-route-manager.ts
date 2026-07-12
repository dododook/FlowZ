/**
 * 出口路由托管（System 模式 TS exit_node 的出网路由）。
 *
 * 背景（真机实证）：sing-box 的 tailscale system_interface 只往内核接口装 tailnet/accept 子网路由，**不为
 * exit_node 装出口 0/0 路由** → 绑接口 dialer 拨公网 `network unreachable`。手动补一条 **ifscope `default`（0/0）**
 * 即通 → tsnet 在内核接口模式会把 0/0 转发给 exit peer。ifscope 作用域不进全局表竞争 → 与全局 default/主 TUN 共存，
 * 无需折半（折半只为压全局表里的 default，ifscope 用不上）；FlowZ 经 helper `route add -ifscope` 只加不删，不删全局 default。
 *
 * 本管理器在「选中的全局出口 = TS System + 承载全隧道」时，于其内核接口装单条 ifscope default；停核/切节点/切模式时清理。
 * 决策见 shared/mesh-exit-route.planMeshExitRoute（纯函数）。
 *
 * 平台：
 *  - macOS：内核 utun 名动态（用户实证），按 tailnet IP 反查接口名 → helper(root) `route -ifscope`。
 *  - Linux：固定名 flowz-ts → app 自身 `ip route`（已有 CAP_NET_ADMIN），独立表 + oif 规则、不碰 main 表。
 *  - **Windows：禁 System，本管理器 no-op**。Windows 上 tsnet 会给 flowz-ts 自装 exit 0/0 metric=0、抢直连/
 *    bootstrap DNS 致全网瘫，且无 ifscope 作用域；曾用周期降权 metric 兜底，但脆弱、有 0–15s 滞后窗口。故 Windows
 *    直接禁 System（ProxyManager.systemInterfaceAvailable 在 win32 恒 false → mesh 节点强制 gVisor），从源头消除：
 *    gVisor userspace 栈不建内核接口、不装 0/0、出口经 tsnet 内部转发不依赖 OS 路由。
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { UserConfig } from '../../shared/types';
import type { IPrivilegedHelper } from './IPrivilegedHelper';
import { planMeshExitRoute, type MeshExitRoutePlan } from '../../shared/mesh-exit-route';
import { meshSystemSupportedOnPlatform } from '../../shared/endpoint-routes';

const execFileAsync = promisify(execFile);

type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

interface InstalledRoute {
  iface: string; // 实际装路由的接口名（macOS=反查到的 utunN；Win/Linux=flowz-ts）
  cidrs: string[];
}

export class MeshExitRouteManager {
  private installed: InstalledRoute | null = null;
  private reconciling = false; // 串行化:起核+切节点的 fire-and-forget 调用不并发抢路由。
  private pending: { config: UserConfig; enableIPv6: boolean } | null = null; // 最新待对齐目标(latest-wins)。
  private baselineUtuns: Set<string> | null = null; // macOS 起核前的 utun 基线(时序 diff 锚点)。

  constructor(
    private readonly getHelper: () => IPrivilegedHelper | null,
    private readonly log: LogFn
  ) {}

  /**
   * macOS：起核前快照 utun 列表（时序 diff 锚点）。utun 随 sing-box 的 control-socket fd 出现/消失，
   * 故「起核后新增的 utun」即 sing-box 创建的（含主 TUN + TS/WG system 接口）——比纯按 100.x 地址反推更稳，
   * 不会误命中另跑的 Tailscale.app utun，也不依赖 utunN 数值（用户实证建议）。ProxyManager 在起核前调用。
   */
  async snapshotBaseline(): Promise<void> {
    if (process.platform !== 'darwin') return;
    this.baselineUtuns = await this.listUtuns();
  }

  private async listUtuns(): Promise<Set<string>> {
    try {
      const { stdout } = await execFileAsync('ifconfig', ['-l']);
      return new Set(
        stdout
          .trim()
          .split(/\s+/)
          .filter((n) => /^utun\d+$/.test(n))
      );
    } catch {
      return new Set();
    }
  }

  /**
   * 对齐到目标态：起核就绪 / 切节点 / 切模式后调用（fire-and-forget，内部轮询等接口、绝不抛）。
   * latest-wins：调用期间(macOS apply 轮询接口可达 18s)若被再次调用(如热切换),记最新目标,当前轮结束后续跑——
   * 避免「轮询中切节点 → 第二次调用被丢 → 路由停在旧选中」。
   */
  async reconcile(config: UserConfig, enableIPv6: boolean): Promise<void> {
    this.pending = { config, enableIPv6 };
    if (this.reconciling) return; // 在飞 → 已记 pending,在飞那轮会续跑到最新
    this.reconciling = true;
    try {
      while (this.pending) {
        const { config: c, enableIPv6: v6 } = this.pending;
        this.pending = null;
        await this.reconcileOnce(c, v6);
      }
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileOnce(config: UserConfig, enableIPv6: boolean): Promise<void> {
    // 禁 System 的平台（Windows，meshSystemSupportedOnPlatform）：mesh 节点强制 gVisor、无 flowz-ts 内核接口 →
    // 无出口路由可托管，no-op。
    if (!meshSystemSupportedOnPlatform(process.platform)) return;
    try {
      const plan = planMeshExitRoute(config, enableIPv6);
      const desiredKey = plan ? plan.cidrs.join(',') : '';
      const currentKey = this.installed ? this.installed.cidrs.join(',') : '';
      // 注:macOS 接口名动态,desired.iface 是逻辑名(flowz-ts);实际接口在 apply 内反查。仅以 cidrs 判变更。
      if (desiredKey === currentKey && !!plan === !!this.installed) return;
      await this.clear();
      if (plan) await this.apply(plan);
    } catch (e) {
      this.log(
        'warn',
        `出口路由托管 reconcile 失败(不影响代理): ${e instanceof Error ? e.message : e}`
      );
    }
  }

  /**
   * 出口路由重申（TS 出口 re-advertise 恢复腿调用，R3）。修两个真缺口而**不 churn 已存路由**：
   *  ① `installed` 为空——`resolveIface` 18s 轮询超时过（登录慢/TS 接口晚出现）→ 路由从未装成、此后无重试挂钩
   *     → 重新 reconcile 补装；
   *  ② macOS `installed.iface` 已消失（接口换名/停了 → 其 ifscope 路由随接口自动失效，内存 installed 却残留）
   *     → 复位 installed 后 reconcile 重装。
   * 其余情形（路由应仍在）不动——避免对已存 ifscope 路由重发 `route add` 的 EEXIST 噪音；纯读判定、绝不抛。
   */
  async reassert(config: UserConfig, enableIPv6: boolean): Promise<void> {
    if (!meshSystemSupportedOnPlatform(process.platform)) return;
    try {
      const plan = planMeshExitRoute(config, enableIPv6);
      if (!plan) return; // 无 System exit 出口 → 无路由可保
      if (!this.installed) {
        await this.reconcile(config, enableIPv6);
        return;
      }
      if (process.platform === 'darwin' && !(await this.listUtuns()).has(this.installed.iface)) {
        this.log('info', `出口路由重申:接口 ${this.installed.iface} 已不在 → 复位重装`);
        this.installed = null;
        await this.reconcile(config, enableIPv6);
      }
    } catch (e) {
      this.log('warn', `出口路由重申失败(不影响代理): ${e instanceof Error ? e.message : e}`);
    }
  }

  /** 停核 / teardown：清理已装的出口路由。 */
  async clear(): Promise<void> {
    // 禁 System 的平台（Windows）：本管理器 no-op（无装过的 OS 路由可清）。
    if (!meshSystemSupportedOnPlatform(process.platform)) return;
    const cur = this.installed;
    if (!cur) return;
    this.installed = null;
    // BUG2 防误删（macOS，真机实证）：停核时 sing-box 拆除 TS utun，其 ifscope 路由随接口自动消失。此时若再对
    // 「已不存在的 iface」发 `route delete -ifscope <goneIface> -net 0/1`，macOS 因该 ifscope 已无效会落到 main 表、
    // 误删主 TUN 的拆半默认（netstat 显示全部 utun 路由消失、代理失效）。故接口已消失 → 路由已随之清理 → 跳过 delete。
    if (process.platform === 'darwin' && !(await this.listUtuns()).has(cur.iface)) {
      this.log(
        'info',
        `出口路由:接口 ${cur.iface} 已随停核移除,ifscope 路由自动清理,跳过 route delete(防误删主表)`
      );
      return;
    }
    try {
      await this.runRoute('del', cur.iface, cur.cidrs);
      this.log('info', `出口路由已清理: ${cur.iface} ${cur.cidrs.join(',')}`);
    } catch (e) {
      this.log('warn', `出口路由清理失败(best-effort): ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * 崩溃 / giveUp 等非正常拆除（走 ProxyManager.cleanup() 而非 stopInner→clear()）的同步内存态复位。内核接口随进程
   * 销毁、其路由已自动消失，故无需发删命令；但**必须清掉残留 `installed`**——否则 macOS/Linux 残留态会让下次
   * reconcile 的 cidr 去重误判「已装」而跳过 apply → 出口路由不再装（自愈后静默黑洞）。同步、不发命令、绝不抛。
   */
  resetState(): void {
    this.installed = null;
  }

  private async apply(plan: MeshExitRoutePlan): Promise<void> {
    const iface = await this.resolveIface(plan.iface);
    if (!iface) {
      this.log('warn', '出口路由托管:未找到 TS 内核接口(tailnet 100.x),跳过装路由');
      return;
    }
    await this.runRoute('add', iface, plan.cidrs);
    this.installed = { iface, cidrs: plan.cidrs };
    this.log('info', `出口路由已装: ${iface} ${plan.cidrs.join(',')}(System TS exit 出网)`);
  }

  /**
   * macOS：内核 utun 名动态 → 按 tailnet IP(100.64/10)反查;其它平台用固定逻辑名。
   * TS 内核接口在核连上 tailnet 后才出现(起核后数秒),故 macOS 轮询等待(每 1.5s,≤12 次≈18s)。
   */
  private async resolveIface(logicalName: string): Promise<string | null> {
    if (process.platform !== 'darwin') return logicalName;
    for (let i = 0; i < 12; i++) {
      const found = await this.probeMacosTailnetIface();
      if (found) return found;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return null;
  }

  /**
   * 找 sing-box 的 TS system 内核接口：先用时序 diff（current − baseline = 起核新增的 sing-box utun）缩小到
   * sing-box 自己的接口集，再在其中取带 tailnet(100.64/10)地址的那张 = TS。无 baseline 时退化为纯地址反推。
   */
  private async probeMacosTailnetIface(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('ifconfig', []);
      // 解析每张 utun 的 inet 地址。
      const ifaceIps = new Map<string, string[]>();
      let cur = '';
      for (const line of stdout.split('\n')) {
        const m = line.match(/^(utun\d+):/);
        if (m) {
          cur = m[1];
          ifaceIps.set(cur, []);
          continue;
        }
        const ip = line.match(/^\s+inet (\d+\.\d+\.\d+\.\d+)/);
        if (ip && cur) ifaceIps.get(cur)!.push(ip[1]);
      }
      const isTailnet = (ips: string[]) =>
        ips.some((ip) => {
          const m = ip.match(/^100\.(\d+)\./);
          return !!m && +m[1] >= 64 && +m[1] <= 127;
        });
      // 候选：起核后新增的 utun（sing-box 创建的）；无 baseline 则全部 utun。
      const candidates = [...ifaceIps.keys()].filter(
        (n) => !this.baselineUtuns || !this.baselineUtuns.has(n)
      );
      const pick = candidates.find((n) => isTailnet(ifaceIps.get(n) || []));
      if (pick) return pick;
      // 兜底：新增集里没找到带 tailnet 地址的（baseline 偏差/边缘）→ 全量 utun 里找带 tailnet 的。
      return [...ifaceIps.keys()].find((n) => isTailnet(ifaceIps.get(n) || [])) || null;
    } catch (e) {
      this.log('warn', `反查 TS 接口失败: ${e instanceof Error ? e.message : e}`);
    }
    return null;
  }

  /**
   * 跨平台装/删路由。**核心约束：绝不抢占 sing-box 自己的路由**（否则 sing-box 流量失效，用户实证要求）：
   *  - macOS：`route -ifscope <iface>` 作用域限定该接口、不进 main 表；且 0/1+128/1 比 sing-box 的 tailnet/子网
   *    路由更不具体 → 那些更具体路由仍命中、不被抢。
   *  - Linux：装进**独立表 + `oif` 规则**（仅绑该接口出站的 dialer 走此表），**绝不动 main 表** → 不抢 sing-box。
   *  - Windows：**不到达此函数**（reconcile 入口已 no-op，见类注释「平台」§ Windows：无 ifscope，0/0 抢全局表致路由异常）。
   * macOS 经 helper(提权);Linux app 自身(CAP_NET_ADMIN)。
   */
  private async runRoute(op: 'add' | 'del', iface: string, cidrs: string[]): Promise<void> {
    if (process.platform === 'linux') {
      // 独立表 + oif 规则：绑该接口的 dialer 出站走 LINUX_EXIT_TABLE，不碰 main 表 → 不抢占 sing-box 主 TUN/子网路由。
      const T = '7732';
      const P = '7732';
      if (op === 'add') {
        await execFileAsync('ip', ['rule', 'add', 'oif', iface, 'table', T, 'priority', P]).catch(
          () => {
            /* 规则已存在则忽略（幂等） */
          }
        );
        for (const c of cidrs) {
          await execFileAsync('ip', ['route', 'replace', c, 'dev', iface, 'table', T]).catch(
            () => {}
          );
        }
      } else {
        for (const c of cidrs) {
          await execFileAsync('ip', ['route', 'del', c, 'dev', iface, 'table', T]).catch(() => {});
        }
        await execFileAsync('ip', ['rule', 'del', 'oif', iface, 'table', T, 'priority', P]).catch(
          () => {}
        );
      }
      return;
    }
    const helper = this.getHelper();
    if (!helper) {
      this.log('warn', '出口路由托管:helper 不可用,无法装路由(System+exit 出网将不通)');
      return;
    }
    const res =
      op === 'add' ? await helper.routeAdd(iface, cidrs) : await helper.routeDel(iface, cidrs);
    if (!res.ok) {
      this.log(
        'warn',
        `helper 路由${op === 'add' ? '装' : '清'}失败(可能 helper 版本过旧需重装 v7): ${res.error || ''}`
      );
    }
  }
}
