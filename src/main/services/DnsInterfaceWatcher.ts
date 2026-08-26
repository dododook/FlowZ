/**
 * 链路变化 watcher（原 macOS DNS 接管「热插重灌」watcher，设计 §四 4.2；issue #368 扩到三平台）。
 *
 * 背景（macOS）：setDns() 只在 TUN 启动那一刻把当时存在的网络服务接管为受控 DNS（8.8.8.8）。启动后插坞站/换 Wi-Fi/VPN 起落
 * 会带来「新出现 / 换网后未受控」的网络服务 → 这些服务的系统 DNS 仍是 on-link LAN/ISP 地址、不进 TUN、逃逸 hijack。
 * 本 watcher 长驻 `route -n monitor` 监听链路变化，命中后去抖调 reconcileDns() 把它们补接管为受控 DNS。
 *
 * 背景（issue #368，Linux/Windows）：这两个平台不接管系统 DNS，但**链路变化后仍需补刷 OS DNS 缓存**——
 * 换网/唤醒瞬间落到旧解析器的查询会在系统缓存里留下陈旧或否定记录，其存活时长由上游 SOA 决定、不受 FlowZ 控制，
 * 而刷新此前只在核 start/stop 两点发生，两次启停之间的污染要等下次启停才清（issue #363 的持续失败即此形态）。
 * 故本类的平台门控与「触发后做什么」解耦：**监听与去抖三平台共用**，是否 reconcile 由注入的 onTrigger 决定。
 *
 * 设计要点：
 * - 机制：spawn 长驻链路监听命令，stdout 按行喂注入的 isTriggerLine；命中 → 去抖（合并 burst，
 *   插坞站连发多条 RTM_）→ 调 onTrigger（= ProxyManager 注入的「门控 + reconcileDns」入口）。
 * - 叠加 powerMonitor 'resume'（系统唤醒，链路常已变但未必发 route 事件）→ 走同一去抖入口。
 * - best-effort：spawn/起停/回调失败仅经注入的 onWarn 告警，绝不抛 —— watcher 故障不得阻断 TUN 生命周期/stop。
 * - 可测性：spawn 工厂 / powerMonitor / onTrigger / schedule(setTimeout) / clearSchedule(clearTimeout) / onWarn
 *   全部构造注入 → 单测以 jest fake timers + mock spawn/powerMonitor 完全离线覆盖去抖/门控/生命周期。
 *
 * 门控不在本类内（本类只管「探到变化 → 去抖 → 调 onTrigger」）；是否真 reconcile 由 ProxyManager 注入的 onTrigger
 * 内部按 shouldReconcileDns() 判定。平台差异（监听命令、行判定、触发后做什么）全部经注入下沉到 ProxyManager 薄接线层，
 * 本类不内嵌 platform 检查（保持可测、可在任意平台单测）。设计见 docs/design/dns-takeover-dynamic-interface.md §四 4.2。
 */

import type { LogLevel, UserConfig } from '../../shared/types';

/** spawn 出的子进程在本类内只需 stdout 可读流 + kill + 错误事件 —— 收窄接口便于 mock，不绑死 ChildProcess 全形。 */
export interface WatchableChildProcess {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  on(event: 'error', listener: (err: Error) => void): this;
  /**
   * 进程终结（含被杀、含 spawn 失败）。用于「事件源死了」的自曝 + 降级轮询，见 start()。
   * 取 `close` 而非 `exit`：spawn 失败（二进制不存在 / PATH 残缺）只发 `error` + `close`，**不发 `exit`**
   * （本机 node 实测）——挂 `exit` 会让「Linux 上没有 ip 命令」这一路既无事件源也无降级轮询。
   */
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** powerMonitor 子集：只用到 resume 的注册/反注册（electron 的 on/removeListener 同形）。 */
export interface ResumeMonitor {
  on(event: 'resume', listener: () => void): void;
  removeListener(event: 'resume', listener: () => void): void;
}

export interface DnsInterfaceWatcherDeps {
  /** spawn 链路监听子进程的工厂（注入便于 mock）。darwin = `route -n monitor`；linux = `ip -o monitor link addr route`。
   *  **null = 该平台无可用的链路监听命令**（Windows），此时只订阅 powerMonitor resume，不 spawn。 */
  spawnRouteMonitor: (() => WatchableChildProcess) | null;
  /** 单行输出 → 是否算一次链路变化。darwin 传 isDnsReconcileTriggerLine（挑 RTM_ 类型）；
   *  linux 传 isLinuxLinkChangeLine（非空即命中，理由见 dns-route-events）。注入而非内嵌，使本类平台无关。 */
  isTriggerLine: (line: string) => boolean;
  /** 唤醒事件源（真实 = electron powerMonitor）；null = 不订阅 resume（如平台不支持）。 */
  powerMonitor: ResumeMonitor | null;
  /** 命中（去抖后）调用：ProxyManager 注入的「门控 + reconcileDns」入口。可异步；其 reject 由本类 catch 成 warn。 */
  onTrigger: () => void | Promise<void>;
  /** 去抖窗口（ms）。设计建议 1–2s 合并 burst。 */
  debounceMs: number;
  /**
   * 指纹轮询间隔（ms）。>0 时周期性走同一个去抖入口（issue #368）。
   * 用于**没有链路事件源的平台**（Windows）：那里 spawnRouteMonitor 为 null，powerMonitor 的 resume 只覆盖
   * 睡眠唤醒、覆盖不到换网/插拔，不轮询等于该平台没修。0/缺省 = 不轮询。
   */
  pollIntervalMs?: number;
  /**
   * 事件源子进程**死亡后**降级启用的轮询间隔（ms）。0/缺省 = 不降级。
   * 没有它，`ip monitor` / `route -n monitor` 被杀之后该平台的修复静默失效到下次核重启，且无任何迹象。
   */
  fallbackPollIntervalMs?: number;
  /**
   * 系统唤醒（resume）时**同步**回调一次，在去抖之前。
   * 供上层豁免自己的限频：睡眠期间 `CLOCK_MONOTONIC` 是否推进属平台语义（Linux/macOS 通常不推进），
   * 若上层以单调钟做限频，「睡前刚刷过 → 醒来落到新网络的那次被拦掉」就成立。让唤醒显式豁免一次，
   * 正确性便不再依赖各平台的睡眠时钟语义这个未实测前提。
   */
  onResume?: () => void;
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
  private pollHandle: ReturnType<typeof setTimeout> | null = null;
  private lineBuffer = ''; // stdout chunk 跨界拼接缓存（一条 RTM_ 行可能分片到达）。
  private started = false;
  /** 当前生效的轮询间隔：初值取 pollIntervalMs，事件源死亡后可被 fallbackPollIntervalMs 顶上。 */
  private pollIntervalMs: number;
  private readonly resumeListener: () => void;

  constructor(private readonly deps: DnsInterfaceWatcherDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 0;
    // 绑定单一 resume 监听实例，stop() 才能精确 removeListener（匿名函数无法反注册）。
    this.resumeListener = (): void => {
      // 先同步通知上层「这是唤醒」，再走去抖：去抖回调里已分不出触发来源。
      try {
        this.deps.onResume?.();
      } catch (e) {
        this.deps.onWarn(
          'warn',
          `处理系统唤醒事件失败: ${e instanceof Error ? e.message : String(e)}`
        );
      }
      this.scheduleReconcile('系统唤醒');
    };
  }

  /** 启动：spawn route monitor + 订阅 resume。幂等：已启动则 no-op。best-effort：spawn 抛仅 warn 不抛。 */
  start(): void {
    if (this.started) return;
    this.started = true;

    try {
      // spawnRouteMonitor 为 null（Windows 无等价的链路监听命令）→ 跳过 spawn，仅靠下方 resume 订阅。
      // 仍置 started=true：resume 这条腿有效，stop() 也须能正常反注册。
      const spawnFn = this.deps.spawnRouteMonitor;
      const child = spawnFn ? spawnFn() : null;
      this.child = child;
      child?.stdout?.on('data', (chunk) => this.onStdoutData(chunk));
      // 子进程自身错误（route 不存在/被杀）best-effort：仅 warn，不抛、不影响 TUN（watcher 失效 ≠ 接管失效，
      // setDns 已接管的服务仍受控，只是热插补接管暂失能 —— 远好于阻断生命周期）。
      child?.on('error', (err) => {
        this.deps.onWarn('warn', `DNS 接口 watcher 子进程错误: ${err.message}`);
      });
      // 事件源终结（OOM / 被杀 / 自身崩溃 / spawn 失败）：此前会静默失效到下次核重启——该平台的修复形同
      // 关闭且不自曝。故 warn 留痕 + 降级到指纹轮询（覆盖面窄于事件流但有界，好过完全失明）。
      // stop() 杀子进程也会走到这里，靠 started 守卫区分：stop() 结束时 started 已置 false。
      child?.on('close', (code, signal) => {
        if (!this.started) return; // 我们自己 kill 的，非异常死亡
        if (this.child !== child) return; // 上一代子进程的迟到事件，不得空掉当前代
        this.child = null;
        this.deps.onWarn(
          'warn',
          `链路事件源已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}），降级为指纹轮询`
        );
        this.degradeToPolling();
      });
    } catch (e) {
      // spawn 同步抛（监听二进制缺失等）→ 仅 warn，**不回退 started**：resume/轮询两条腿仍然有效，
      // 且回退成未启动态会让再次 start() 二次订阅 resume 而 stop() 只反注册一次（泄漏的监听会在已停止的
      // watcher 上继续触发 onTrigger）。与 spawnRouteMonitor=null 的路径保持同一语义。
      this.child = null;
      this.deps.onWarn(
        'warn',
        `启动 DNS 接口 watcher 失败: ${e instanceof Error ? e.message : String(e)}`
      );
    }

    // 指纹轮询腿（无事件源的平台）：自重排定时器，命中同一去抖入口。
    if (this.pollIntervalMs > 0) {
      this.schedulePoll();
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
    if (this.pollHandle !== null) {
      this.deps.clearSchedule(this.pollHandle);
      this.pollHandle = null;
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
    // 复位降级态：同实例再次 start() 应重新尝试事件源，而不是继承上一代的降级轮询。
    this.pollIntervalMs = this.deps.pollIntervalMs ?? 0;
  }

  /** 事件源死亡后降级：启用（或维持）指纹轮询。已在轮询则只更新间隔，不重复排程。 */
  private degradeToPolling(): void {
    const fallback = this.deps.fallbackPollIntervalMs ?? 0;
    if (fallback <= 0) return;
    const alreadyPolling = this.pollHandle !== null;
    this.pollIntervalMs = fallback;
    if (!alreadyPolling) this.schedulePoll();
  }

  /** stdout chunk → 按行切分 → 命中触发行即排去抖。chunk 可能含半行，跨 chunk 用 lineBuffer 拼接。 */
  private onStdoutData(chunk: Buffer | string): void {
    this.lineBuffer += chunk.toString();
    const parts = this.lineBuffer.split('\n');
    this.lineBuffer = parts.pop() ?? ''; // 末段可能是半行，留回缓存等下个 chunk 补全。
    for (const line of parts) {
      if (this.deps.isTriggerLine(line)) {
        this.scheduleReconcile('链路事件');
        // 一个 burst 内多条触发行只需排一次去抖（schedule 会被 scheduleReconcile 合并），继续扫完本批即可。
      }
    }
  }

  /** 轮询自重排：每 pollIntervalMs 走一次去抖入口。stop() 清句柄后不再重排。 */
  private schedulePoll(): void {
    const interval = this.pollIntervalMs;
    if (interval <= 0) return;
    this.pollHandle = this.deps.schedule(() => {
      this.pollHandle = null;
      this.scheduleReconcile('定时轮询');
      if (this.started) this.schedulePoll();
    }, interval);
  }

  /**
   * 去抖排程：合并 burst（已有在飞句柄先清再重排）→ 窗口结束调一次 onTrigger。onTrigger 异常仅 warn。
   *
   * **语义是 reset 型尾沿去抖**：事件间隔持续小于窗口时会一直推迟，直到平息才触发一次。对「换网后重新配置好
   * 才刷缓存」是想要的行为（中途的半配置态刷了也白刷）；代价是理论上的抖动风暴可无限推迟触发，此时轮询腿
   * （若开启）与 resume 腿仍是兜底。
   */
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
              `链路变化处理失败（${reason}）: ${e instanceof Error ? e.message : String(e)}`
            )
          );
        }
      } catch (e) {
        this.deps.onWarn(
          'warn',
          `链路变化处理失败（${reason}）: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }, this.deps.debounceMs);
  }
}

/** createLinkChangeHandler 的注入面。全部为函数，便于在无 ProxyManager 实例的前提下单测组合逻辑。 */
export interface LinkChangeHandlerDeps {
  /**
   * macOS 接管重灌。生产接线恒传非 null（门控与 SystemDnsManager 都在闭包内每次求值），
   * null 支只保留给单测——用来钉住「没有 reconcile 时 flush 腿照常工作」这条组合语义。
   */
  reconcile: (() => Promise<void>) | null;
  /** 读取当前网络指纹。 */
  readFingerprint: () => string;
  /** 上次**成功刷新**时的指纹；null = 尚未成功刷过。 */
  getLastFingerprint: () => string | null;
  /** 发起刷新（fire-and-forget；指纹由调用方在成功后落库）。 */
  flush: (fingerprint: string) => void;
  onWarn: (message: string) => void;
}

/**
 * 组装链路变化的处理逻辑（issue #368）。抽成工厂而非内联在 ProxyManager 里，是为了让下面三条**组合语义**
 * 可被单测钉住——它们各自的零件都有测，但接线错了（顺序反接、异常吞掉后半段、把指纹判据接反）现有测试全绿：
 *
 *  1. **reconcile 失败不得吃掉 flush**：reconcile 单独 try/catch。链路变化瞬间正是 networksetup 最易失败的时点，
 *     也正是最需要刷缓存的那一次；若让异常冒泡，watcher 只会转成一句 warn，本轮 flush 静默丢失。
 *  2. **顺序是先 reconcile 后取指纹**：接管会改动系统 DNS 配置，先改完再取指纹才对得上「刷新后的世界」。
 *  3. **指纹相同就不刷**：事件流不是判据（周期性 RA / DHCP renew 是噪音，自身路由操作是自触发）。
 */
export function createLinkChangeHandler(deps: LinkChangeHandlerDeps): () => Promise<void> {
  return async () => {
    if (deps.reconcile) {
      try {
        await deps.reconcile();
      } catch (e) {
        deps.onWarn(`链路变化重灌 DNS 接管失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const fingerprint = deps.readFingerprint();
    if (fingerprint === deps.getLastFingerprint()) return;
    deps.flush(fingerprint);
  };
}
