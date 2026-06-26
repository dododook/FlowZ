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
 *  - **Windows：降权 flowz-ts 接口 metric（根治，非装路由）**。Windows 上 sing-box 的 tsnet **自己**给 flowz-ts 装
 *    exit 0/0，且 **metric=0** → 抢过物理网卡，把直连/bootstrap DNS（节点域名解析的 1.12.12.12/223.5.5.5）灌进 TS
 *    出口、源 IP 变 tailnet → SERVFAIL → 解析不出代理节点 → **全网瘫（真机实证 2026-06-26，Find-NetRoute 实锤
 *    `1.12.12.12 → ifIndex(flowz-ts) src=100.x`）**。FlowZ 删不掉 tsnet 这条 0/0；Windows 又无 macOS 的 ifscope
 *    作用域。等价根治手段＝**经 helper 把 flowz-ts 接口 metric 设高**（WIN_TS_DEMOTED_METRIC）→ 其 0/0 effective
 *    metric 输给以太网、直连/DNS 回物理；tailnet /32 仍按最长前缀命中；**出口经 sing-box selector 内部转发给 TS
 *    outbound，不依赖这条 OS 0/0**（gVisor 无任何 OS 路由也能出口即证）。降权不破坏出口（真机验：降权后切节点访问全正常）。
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { UserConfig } from '../../shared/types';
import type { IPrivilegedHelper } from './IPrivilegedHelper';
import { planMeshExitRoute, type MeshExitRoutePlan } from '../../shared/mesh-exit-route';
import { TS_SYSTEM_INTERFACE_NAME } from '../../shared/endpoint-routes';

const execFileAsync = promisify(execFile);

// Windows 根治 System TS 出口劫持：flowz-ts 接口 metric 设到此高值，使 tsnet 装的 exit 0/0 的 effective metric
// （RouteMetric 0 + 接口 metric）输给物理网卡（以太网约 15、flowz-wg 约 5）→ 直连/bootstrap DNS 回物理网卡。
// 真机实证此值有效（`Set-NetIPInterface flowz-ts -InterfaceMetric 9000` 后 DNS 恢复、切节点访问全正常）。
const WIN_TS_DEMOTED_METRIC = 9000;

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
  private windowsMetricTimer: ReturnType<typeof setInterval> | null = null; // Windows：flowz-ts metric 周期巡检定时器。
  private windowsMetricFailureLogged = false; // Windows：持久降权失败是否已报过一次(防每 15s 刷屏,成功复位)。

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
    try {
      const plan = planMeshExitRoute(config, enableIPv6);
      // Windows：不装 OS 路由（tsnet 自装 exit 0/0），改为周期巡检降权 flowz-ts 接口 metric 根治其 0/0 抢直连/DNS
      //（根因/机理见类注释「平台」§ Windows）。plan 存在（选/规则指向 TS System+exit）→ 启动巡检；否则停巡检。
      // 「为何用周期巡检而非一次性」见 startWindowsMetricWatch。
      if (process.platform === 'win32') {
        if (plan) this.startWindowsMetricWatch();
        else this.stopWindowsMetricWatch();
        return;
      }
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

  /** 停核 / teardown：清理已装的出口路由。 */
  async clear(): Promise<void> {
    // Windows：未装 OS 路由（只周期降 flowz-ts metric）。停核 → 停巡检（flowz-ts 随之销毁，无需还原；下次起核
    // reconcile 重启巡检）。
    if (process.platform === 'win32') {
      this.stopWindowsMetricWatch();
      return;
    }
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
   * Windows 根治：周期巡检确保 flowz-ts 接口 metric 降权（根因/机理见类注释「平台」§ Windows）。
   * 用周期巡检而非一次性：① flowz-ts 在连上 tailnet 后数秒才出现，一次性窗口易错过（真机实证「未能设」即此）；
   * ② TS 自身重连会重建接口、metric 复位，巡检检出后补设；③ 切节点/重启由 reconcile 重启巡检。
   */
  private startWindowsMetricWatch(): void {
    if (this.windowsMetricTimer) return; // 已在巡检
    void this.ensureWindowsTsMetric(); // 立即一次
    this.windowsMetricTimer = setInterval(() => void this.ensureWindowsTsMetric(), 15000);
  }

  private stopWindowsMetricWatch(): void {
    if (this.windowsMetricTimer) {
      clearInterval(this.windowsMetricTimer);
      this.windowsMetricTimer = null;
    }
  }

  /**
   * 崩溃 / giveUp 等非正常拆除（走 ProxyManager.cleanup() 而非 stopInner→clear()）的同步内存态复位。内核接口随进程
   * 销毁、其路由已自动消失，故无需发删命令；但**必须清掉残留态**，否则：① macOS/Linux 残留的 `installed` 会让下次
   * reconcile 的 cidr 去重误判「已装」而跳过 apply → 出口路由不再装（自愈后静默黑洞）；② Windows 的 15s 巡检定时器泄漏、
   * 持续 spawn powershell。clear()（正常停核）已含同款 stop；本方法是崩溃腿的补漏，同步、不发命令、绝不抛。
   */
  resetState(): void {
    this.installed = null;
    this.stopWindowsMetricWatch();
  }

  /**
   * 一轮巡检：读 flowz-ts 两族接口 metric（只读、非提权直跑 Get-NetIPInterface），任一不是 WIN_TS_DEMOTED_METRIC
   * （初次/AutomaticMetric/被 TS 重连重建复位）→ 经 helper（SYSTEM）补设两族。
   * **关键（真机踩坑）**：AutomaticMetric 时 InterfaceMetric **读出为空**（join 得 `,` 或 `''`）——这**正是**需要降权
   * 的状态，绝不能当「未就绪」跳过。故用 `$i.Count` 区分「接口不存在(NONE→跳过)」vs「存在但 metric 空/非9000(补设)」。
   * 达标即跳、不刷屏；proto 过旧 helper 回 `ERR unknown` → 停巡检 + 提示重装。
   */
  private async ensureWindowsTsMetric(): Promise<void> {
    let out: string;
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$i=@(Get-NetIPInterface -InterfaceAlias '${TS_SYSTEM_INTERFACE_NAME}' -ErrorAction SilentlyContinue); if($i.Count -eq 0){'NONE'}else{$i.InterfaceMetric -join ','}`,
      ]);
      out = stdout.trim();
    } catch {
      return; // 读失败 → 下轮再试
    }
    if (out === 'NONE') return; // flowz-ts 接口不存在（未就绪）→ 下轮再试
    const metrics = out.split(',').map((s) => s.trim()); // 空表示 AutomaticMetric（需降权,非「未就绪」）
    if (metrics.every((m) => m === String(WIN_TS_DEMOTED_METRIC))) {
      this.windowsMetricFailureLogged = false; // 已达标(含外部手动设)→ 复位失败标记
      return;
    }
    const helper = this.getHelper();
    if (!helper) return;
    const res = await helper.setInterfaceMetric(TS_SYSTEM_INTERFACE_NAME, WIN_TS_DEMOTED_METRIC);
    if (res.ok) {
      this.windowsMetricFailureLogged = false; // 成功 → 复位失败标记（下次再失败重新报一次）
      this.log(
        'info',
        `Windows TS 出口:flowz-ts 接口 metric 降权为 ${WIN_TS_DEMOTED_METRIC}(两族;原 ${metrics.join('/')})—— 其 exit 0/0 让位物理网卡,直连/DNS 回物理`
      );
    } else if (res.error && /unknown/i.test(res.error)) {
      this.stopWindowsMetricWatch(); // 旧 helper 不识别 iface-metric → 停巡检免空转
      this.log(
        'warn',
        'Windows TS 出口:当前 helper 不支持 iface-metric(需重装 helper);否则 flowz-ts 0/0 会抢直连/bootstrap DNS 致解析失败'
      );
    } else if (!this.windowsMetricFailureLogged) {
      // 其它持久失败（PowerShell 未找到 / Set-NetIPInterface 拒绝 / 权限）：仍每 15s 重试（可能自愈），但**报一次**
      // 诊断（首次失败即报、成功后复位），避免静默——否则 flowz-ts 0/0 持续抢 bootstrap DNS 而无任何信号。
      this.windowsMetricFailureLogged = true;
      this.log(
        'warn',
        `Windows TS 出口:flowz-ts metric 降权失败(每 15s 重试中,flowz-ts 0/0 可能仍抢直连/bootstrap DNS): ${res.error || '未知'}`
      );
    }
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
