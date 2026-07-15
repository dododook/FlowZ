/**
 * macOS DNS 接管「热插重灌」watcher（设计 §四 4.2）。
 *
 * 背景：setDns() 只在 TUN 启动那一刻把当时存在的网络服务接管为受控 DNS（8.8.8.8）。启动后插坞站/换 Wi-Fi/VPN 起落
 * 会带来「新出现 / 换网后未受控」的网络服务 → 这些服务的系统 DNS 仍是 on-link LAN/ISP 地址、不进 TUN、逃逸 hijack。
 * 本 watcher 长驻 `route -n monitor` 监听链路变化，命中后去抖调 reconcileDns() 把它们补接管为受控 DNS。
 *
 * 设计要点：
 * - 机制：spawn 长驻 `route -n monitor`，stdout 按行喂 isDnsReconcileTriggerLine；命中 → 去抖（合并 burst，
 *   插坞站连发多条 RTM_）→ 调 onTrigger（= ProxyManager 注入的「门控 + reconcileDns」入口）。
 * - 叠加 powerMonitor 'resume'（系统唤醒，链路常已变但未必发 route 事件）→ 走同一去抖入口。
 * - best-effort：spawn/起停/回调失败仅经注入的 onWarn 告警，绝不抛 —— watcher 故障不得阻断 TUN 生命周期/stop。
 * - 可测性：spawn 工厂 / powerMonitor / onTrigger / schedule(setTimeout) / clearSchedule(clearTimeout) / onWarn
 *   全部构造注入 → 单测以 jest fake timers + mock spawn/powerMonitor 完全离线覆盖去抖/门控/生命周期。
 *
 * 门控不在本类内（本类只管「探到变化 → 去抖 → 调 onTrigger」）；是否真 reconcile 由 ProxyManager 注入的 onTrigger
 * 内部按 shouldReconcileDns() 判定。平台门控（仅 darwin 起）由 ProxyManager 薄接线层判定，本类不内嵌 platform 检查
 * （保持可测、可在任意平台单测）。设计见 docs/design/dns-takeover-dynamic-interface.md §四 4.2。
 */

import type { LogLevel, UserConfig } from '../../shared/types';
import { isDnsReconcileTriggerLine } from './dns-route-events';

/** spawn 出的子进程在本类内只需 stdout 可读流 + kill + 错误事件 —— 收窄接口便于 mock，不绑死 ChildProcess 全形。 */
export interface WatchableChildProcess {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  on(event: 'error', listener: (err: Error) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** powerMonitor 子集：只用到 resume 的注册/反注册（electron 的 on/removeListener 同形）。 */
export interface ResumeMonitor {
  on(event: 'resume', listener: () => void): void;
  removeListener(event: 'resume', listener: () => void): void;
}

export interface DnsInterfaceWatcherDeps {
  /** spawn `route -n monitor` 工厂（注入便于 mock；真实实现 = () => child_process.spawn('route', ['-n','monitor'])）。 */
  spawnRouteMonitor: () => WatchableChildProcess;
  /** 唤醒事件源（真实 = electron powerMonitor）；null = 不订阅 resume（如平台不支持）。 */
  powerMonitor: ResumeMonitor | null;
  /** 命中（去抖后）调用：ProxyManager 注入的「门控 + reconcileDns」入口。可异步；其 reject 由本类 catch 成 warn。 */
  onTrigger: () => void | Promise<void>;
  /** 去抖窗口（ms）。设计建议 1–2s 合并 burst。 */
  debounceMs: number;
  /** schedule = setTimeout（注入便于 fake timers）；返回句柄交 clearSchedule。 */
  schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearSchedule: (handle: ReturnType<typeof setTimeout>) => void;
  /** 告警 sink（best-effort 失败仅 warn）。 */
  onWarn: (level: LogLevel, message: string) => void;
}

/**
 * 纯门控判定：是否应执行 DNS reconcile（镜像 setDns 的接管条件）。
 * 仅 TUN 模式 + 未关闭接管开关 + 当前确有 marker（接管已激活）才放行 —— 系统代理/手动模式或未接管时，watcher
 * 绝不擅自改系统 DNS。抽成纯函数便于单测，也供 ProxyManager 接线层与本判定共用同一真值。
 *
 * @param config 当前生效配置（ProxyManager.currentConfig）；null/非 TUN/关掉开关 → false。
 * @param hasMarker SystemDnsManager.hasMarker() 结果（接管 marker 是否在）。
 */
export function shouldReconcileDns(
  config: UserConfig | null | undefined,
  hasMarker: boolean
): boolean {
  if (!config) return false;
  if (config.proxyModeType !== 'tun') return false;
  if (config.dnsConfig?.takeoverSystemDns === false) return false;
  return hasMarker;
}

/**
 * 可注入的 watcher 单元：start() spawn route monitor + 订阅 resume；命中去抖调 onTrigger；stop() 杀子进程 +
 * 反注册 resume + 取消在飞去抖。幂等（重复 start/stop 安全）。全部 best-effort（异常仅 warn 不抛）。
 */
export class DnsInterfaceWatcher {
  private child: WatchableChildProcess | null = null;
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;
  private lineBuffer = ''; // stdout chunk 跨界拼接缓存（一条 RTM_ 行可能分片到达）。
  private started = false;
  private readonly resumeListener: () => void;

  constructor(private readonly deps: DnsInterfaceWatcherDeps) {
    // 绑定单一 resume 监听实例，stop() 才能精确 removeListener（匿名函数无法反注册）。
    this.resumeListener = () => this.scheduleReconcile('系统唤醒(resume)');
  }

  /** 启动：spawn route monitor + 订阅 resume。幂等：已启动则 no-op。best-effort：spawn 抛仅 warn 不抛。 */
  start(): void {
    if (this.started) return;
    this.started = true;

    try {
      const child = this.deps.spawnRouteMonitor();
      this.child = child;
      child.stdout?.on('data', (chunk) => this.onStdoutData(chunk));
      // 子进程自身错误（route 不存在/被杀）best-effort：仅 warn，不抛、不影响 TUN（watcher 失效 ≠ 接管失效，
      // setDns 已接管的服务仍受控，只是热插补接管暂失能 —— 远好于阻断生命周期）。
      child.on('error', (err) => {
        this.deps.onWarn('warn', `DNS 接口 watcher 子进程错误: ${err.message}`);
      });
    } catch (e) {
      // spawn 同步抛（route 二进制缺失等）→ 回退未启动态，仅 warn。
      this.started = false;
      this.child = null;
      this.deps.onWarn(
        'warn',
        `启动 DNS 接口 watcher 失败: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    // resume 订阅独立 try：spawn 失败也仍订阅唤醒（唤醒后链路常变，是另一条补接管路径）。
    if (this.deps.powerMonitor) {
      try {
        this.deps.powerMonitor.on('resume', this.resumeListener);
      } catch (e) {
        this.deps.onWarn(
          'warn',
          `订阅系统唤醒事件失败: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  }

  /** 停止：杀子进程 + 反注册 resume + 取消在飞去抖。幂等、best-effort（每步独立 try，单步失败不阻断其余）。 */
  stop(): void {
    if (this.debounceHandle !== null) {
      this.deps.clearSchedule(this.debounceHandle);
      this.debounceHandle = null;
    }
    if (this.child) {
      try {
        this.child.kill();
      } catch (e) {
        this.deps.onWarn(
          'warn',
          `停止 DNS 接口 watcher 子进程失败: ${e instanceof Error ? e.message : String(e)}`
        );
      }
      this.child = null;
    }
    if (this.deps.powerMonitor) {
      try {
        this.deps.powerMonitor.removeListener('resume', this.resumeListener);
      } catch (e) {
        this.deps.onWarn(
          'warn',
          `反注册系统唤醒事件失败: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    this.lineBuffer = '';
    this.started = false;
  }

  /** stdout chunk → 按行切分 → 命中触发行即排去抖。chunk 可能含半行，跨 chunk 用 lineBuffer 拼接。 */
  private onStdoutData(chunk: Buffer | string): void {
    this.lineBuffer += chunk.toString();
    const parts = this.lineBuffer.split('\n');
    this.lineBuffer = parts.pop() ?? ''; // 末段可能是半行，留回缓存等下个 chunk 补全。
    for (const line of parts) {
      if (isDnsReconcileTriggerLine(line)) {
        this.scheduleReconcile('链路变化(route monitor)');
        // 一个 burst 内多条触发行只需排一次去抖（schedule 会被 scheduleReconcile 合并），继续扫完本批即可。
      }
    }
  }

  /** 去抖排程：合并 burst（已有在飞句柄先清再重排）→ 窗口结束调一次 onTrigger。onTrigger 异常仅 warn。 */
  private scheduleReconcile(reason: string): void {
    if (this.debounceHandle !== null) {
      this.deps.clearSchedule(this.debounceHandle);
    }
    this.debounceHandle = this.deps.schedule(() => {
      this.debounceHandle = null;
      try {
        const r = this.deps.onTrigger();
        if (r && typeof (r as Promise<void>).catch === 'function') {
          (r as Promise<void>).catch((e) =>
            this.deps.onWarn(
              'warn',
              `DNS 重灌(${reason})失败: ${e instanceof Error ? e.message : String(e)}`
            )
          );
        }
      } catch (e) {
        this.deps.onWarn(
          'warn',
          `DNS 重灌(${reason})失败: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }, this.deps.debounceMs);
  }
}
