/**
 * StatsWorkerHost —— main 侧 stats utilityProcess 宿主（T4，issue #225）。
 *
 * 背景：原 StatsService 在 main 进程订阅 sing-box 1.14 管理 API 的 Status/Connections gRPC 长流，每帧解析连接事件、
 * 物化连接列表（trimConnection × N）。这部分 per-frame 工作与 Windows 拖动的 move modal loop（跑主线程）抢事件循环，
 * 是「拖动卡顿 + 启动后迟缓」的结构性来源（perf doc P2-1 实测 main 事件循环 >100ms 高频）。
 *
 * 方案：把 StatsService **原样**搬进 utilityProcess（见 workers/stats-worker.ts，类逻辑不改，保 #210/#167/审计#3 全部
 * 不变量），main 侧仅留本宿主：fork/看护 worker、转发控制、缓存最新快照、按 uiActive(可见 && !拖动) 门控后 sendToAll。
 * 本宿主**镜像 StatsService 的对外公共接口**（resubscribe/stop/getSnapshot/getConnectionsSnapshot）做近 drop-in，
 * index.ts 接线与 proxy-handlers 几乎不变。
 *
 * 进程拓扑：worker 持自己的 SingBoxApiClient（仅 stats，不订 Tailscale）；main 保留 tailscaleApiClient 管 Tailscale。
 * 两 client 各连同一 127.0.0.1:apiPort 的不同 RPC 流，互不冲突。
 */
import { utilityProcess, type UtilityProcess } from 'electron';
import type { TrafficStats, ConnectionsSnapshot, ConnectionsAggregate } from '../../shared/types';
import { aggregateConnections } from './connections-aggregate';

/** worker 重建 SingBoxApiClient 所需的运行期管理 API 端点（本地恒无 tls）。 */
export interface StatsApiEndpoint {
  host: string;
  port: number;
  secret: string;
  tls?: { ca?: string; skipVerify?: boolean };
}

/** proxy-handlers 只需「读快照」这一最小面；StatsWorkerHost 与（测试用的）StatsService 均满足。 */
export interface StatsProvider {
  getSnapshot(): TrafficStats;
  getConnectionsSnapshot(): ConnectionsSnapshot;
  getAggregateSnapshot(): ConnectionsAggregate;
}

/**
 * index.ts 装配点 + 生命周期钩子对 stats 宿主的完整对外面（读快照 + 订阅生命周期）。StatsWorkerHost（生产）
 * 与 StatsSimulator（issue #242 §5 泄漏定证 harness）两者均实现，使 index.ts 的 statsService 可在两者间替换、
 * 装配 diff 最小。成员集与 index.ts/proxy-handlers 实际调用点一一对应（resubscribe/stop/resume/dispose +
 * StatsProvider 三读），无 getStatus——刻意不含未被调用的成员，避免虚假接口面。
 */
export interface StatsHost extends StatsProvider {
  resubscribe(): void;
  stop(): void;
  resume(): void;
  dispose(): void;
}

/** main → worker 控制消息。 */
export type HostToWorkerMessage =
  | { type: 'connect'; endpoint: StatsApiEndpoint }
  | { type: 'stop' }
  // C（issue #225 review）：门控 worker 的 connections 跨进程 post——不活跃（隐藏/拖动）时 worker 跳过把连接表
  // 克隆推给 main（隐藏挂托盘 + 上千连接时的主要浪费）。status 帧不门控、始终流动，故本标志靠 host 在每个 status
  // 帧上惰性同步（见 syncConnActive），无需窗口事件接线、无 worker 卡死风险。
  | { type: 'setConnActive'; active: boolean }
  | { type: 'dispose' };

/** worker → main 数据/握手消息。 */
export type WorkerToHostMessage =
  | { type: 'ready' }
  | { type: 'stats'; payload: TrafficStats }
  | { type: 'connections'; payload: ConnectionsSnapshot };

const ZERO_STATS: TrafficStats = {
  uploadSpeed: 0,
  downloadSpeed: 0,
  totalUpload: 0,
  totalDownload: 0,
  activeConnections: 0,
};

/** 空聚合（stop/初始化用）。 */
function emptyAggregate(at: number): ConnectionsAggregate {
  return { total: 0, hosts: [], outbounds: [], at };
}

export interface StatsWorkerHostOptions {
  /** 已编译 worker 入口绝对路径（dist 下 .js）。 */
  workerPath: string;
  /** 流量快照广播到渲染端（main 侧门控后调用）。 */
  onStats: (s: TrafficStats) => void;
  /** 连接聚合广播到渲染端（首页拓扑，main 侧门控后调用，issue #227）。 */
  onAggregate: (agg: ConnectionsAggregate) => void;
  /** UI 广播活跃谓词：false（不可见/拖动中）时只缓存不广播。 */
  isUiActive: () => boolean;
  /** 取运行期管理 API 端点（核未起返回 null → worker 不开流）。 */
  getEndpoint: () => StatsApiEndpoint | null;
  /** 可选日志钩子（接 logManager）。 */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class StatsWorkerHost implements StatsHost {
  private worker: UtilityProcess | null = null;
  private snapshot: TrafficStats = { ...ZERO_STATS };
  // worker post 来的最近连接明细快照：仅供连接信息页 CONNECTIONS_GET 按需 pull，不再 relay 给渲染端（旧放大器）。
  private connections: ConnectionsSnapshot = { connections: [], at: 0 };
  // 由 connections 每帧 host 侧 O(N) 聚合而来（首页拓扑供数）：relay EVENT_CONNECTIONS_AGGREGATE + CONNECTIONS_AGGREGATE_GET 回填。
  private aggregate: ConnectionsAggregate = emptyAggregate(0);
  /** 是否应处于订阅态（代理运行）。崩溃 respawn 后据此自动重连，不丢流。 */
  private started = false;
  private disposed = false;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private respawnDelayMs = 500;
  /** 上次下发给 worker 的 connActive（C）。null=未发过（reconnect/respawn 后重置，强制下个 status 帧重新同步）。 */
  private lastConnActiveSent: boolean | null = null;

  constructor(private readonly opts: StatsWorkerHostOptions) {
    this.spawn();
  }

  private spawn(): void {
    if (this.disposed) return;
    try {
      const w = utilityProcess.fork(this.opts.workerPath, [], { serviceName: 'flowz-stats' });
      this.worker = w;
      w.on('message', (msg: WorkerToHostMessage) => this.onWorkerMessage(msg));
      w.on('exit', (code: number) => this.onWorkerExit(code));
      // 退避不在此重置：fork 成功 ≠ worker 健康。boot 即崩的 worker 收不到 'ready'，退避须持续增长（见 'ready' case）。
    } catch (e) {
      this.opts.log?.('error', `stats worker spawn 失败: ${(e as Error)?.message ?? e}`);
      this.scheduleRespawn();
    }
  }

  private onWorkerExit(code: number): void {
    this.worker = null;
    if (this.disposed) return;
    // 非 dispose 的退出 = 崩溃 → 退避 respawn；spawn 后收到 'ready' 时若 started 自动重连（见 onWorkerMessage）。
    this.opts.log?.('warn', `stats worker 退出(code=${code})，${this.respawnDelayMs}ms 后重启`);
    this.scheduleRespawn();
  }

  private scheduleRespawn(): void {
    if (this.respawnTimer || this.disposed) return;
    const delay = this.respawnDelayMs;
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      this.spawn();
    }, delay);
    this.respawnDelayMs = Math.min(this.respawnDelayMs * 2, 10_000); // 指数退避，上限 10s
  }

  private post(msg: HostToWorkerMessage): void {
    // worker 重启窗口内 worker=null → 丢弃；respawn 后据 started 由 'ready' 握手重连，不需在此重试。
    try {
      this.worker?.postMessage(msg);
    } catch {
      /* ignore */
    }
  }

  private postConnect(): void {
    // reconnect/respawn 后强制下个 status 帧重新同步 connActive（worker 可能是新进程、默认 connActive=true）。
    this.lastConnActiveSent = null;
    const endpoint = this.opts.getEndpoint();
    if (!endpoint) {
      this.post({ type: 'stop' });
      return;
    }
    this.post({ type: 'connect', endpoint });
  }

  /**
   * 惰性同步 worker 的 connActive（C）：仅在 isUiActive 变化时下发，借「始终流动」的 status 帧驱动——故无需
   * 监听窗口 show/hide/minimize 事件，且 status 不门控 → worker 不会卡死在 inactive。
   * 自愈延迟分两档：**stats/连接计数 ≤1 个 status 间隔（~1s）**（status 恒流、转活跃下一帧即经 relay 广播）；
   * **连接明细列表最坏 ~2 个流间隔**（先一个 status 帧触发本同步 setConnActive(true)，worker 收到后再等下一个
   * connections 帧才 post）。功能正确、仅列表多 ~1s 滞后，隐藏期本无列表消费者，可接受。
   */
  private syncConnActive(): void {
    const active = this.opts.isUiActive();
    if (active !== this.lastConnActiveSent) {
      this.lastConnActiveSent = active;
      this.post({ type: 'setConnActive', active });
    }
  }

  private onWorkerMessage(msg: WorkerToHostMessage): void {
    switch (msg?.type) {
      case 'ready':
        // worker 监听器就绪握手：避免 fork 后立即 post 被「监听器未挂」竞态吞掉。worker 证明健康 → 重置退避
        //（修 boot-即崩 worker 把退避永远卡在 500ms 的紧循环：退避只该被「健康过」的 worker 重置）。
        this.respawnDelayMs = 500;
        if (this.started) this.postConnect();
        break;
      case 'stats':
        // started 门控：stop() 后 worker 在途旧帧（stop 消息送达前 worker 可能刚 post 一帧非零）必须丢弃，
        // 否则缓存被旧值覆盖 + 广播残留非零速率/总量，直到下次 connect → 违反 stop「停止即清零」不变量。
        if (!this.started) return;
        this.syncConnActive(); // 借常流的 status 帧惰性同步 worker 的 connActive（C）
        this.snapshot = msg.payload;
        if (this.opts.isUiActive()) this.opts.onStats(this.snapshot);
        break;
      case 'connections':
        if (!this.started) return; // 同上：停后在途连接帧丢弃，避免残留旧连接列表。
        // issue #227：worker 仍 post 全量明细（供连接页 pull 缓存），但 host 不再把它 relay 给渲染端（旧每秒全量
        // EVENT_CONNECTIONS_UPDATED 放大器）。host 侧 O(N) 聚合一次 → 只 relay 小载荷聚合（拓扑），渲染端零 O(N)
        // 重算。隐藏/拖动期 worker 经 connActive 门控本就不 post connections，故此聚合也随之停。
        this.connections = msg.payload;
        this.aggregate = aggregateConnections(msg.payload.connections, msg.payload.at);
        if (this.opts.isUiActive()) this.opts.onAggregate(this.aggregate);
        break;
    }
  }

  // ── 镜像 StatsService 对外公共接口（近 drop-in） ──────────────────────────────

  /** 代理就绪（api-client-ready）/ 切端口：让 worker 连最新端点并重订阅。worker 未 ready 时由 'ready' 握手补连。 */
  resubscribe(): void {
    this.started = true;
    this.postConnect();
  }

  /** 停止订阅 + 清零广播（对齐 StatsService.stop：不门控、直接清 UI，避免停后残留旧值）。 */
  stop(): void {
    this.started = false;
    this.post({ type: 'stop' });
    this.snapshot = { ...ZERO_STATS };
    this.connections = { connections: [], at: Date.now() };
    this.aggregate = emptyAggregate(Date.now());
    this.opts.onStats({ ...this.snapshot });
    this.opts.onAggregate(this.aggregate);
  }

  /** 拖动结束：立即补推一帧缓存最新（免等 worker 下一帧滞后）。窗口由隐藏转可见时不另补推——stats/计数走恒流的
   *  status 帧 ≤1s 自然广播；连接列表经 connActive 重新激活后 ~2 个流间隔恢复（见 syncConnActive），与原行为大致一致。 */
  resume(): void {
    if (!this.opts.isUiActive()) return;
    this.opts.onStats({ ...this.snapshot });
    this.opts.onAggregate(this.aggregate);
  }

  getSnapshot(): TrafficStats {
    return { ...this.snapshot };
  }

  getConnectionsSnapshot(): ConnectionsSnapshot {
    // at 用 worker 真实采样时刻（this.connections.at），非拉取时刻：连接页速率差分以采样间隔为分母，避免 pull
    // 节奏与 worker 帧节奏漂移时同一缓存被拉两次 → Δbytes=0 报速率 0、下次翻倍的抖动（review Low-2）。
    return { connections: this.connections.connections, at: this.connections.at };
  }

  /** 首页拓扑挂载回填（CONNECTIONS_AGGREGATE_GET）：缓存的最近聚合（后续增量走 EVENT_CONNECTIONS_AGGREGATE）。 */
  getAggregateSnapshot(): ConnectionsAggregate {
    return this.aggregate;
  }

  /** app 退出：终止 worker，停止 respawn。 */
  dispose(): void {
    this.disposed = true;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    this.post({ type: 'dispose' });
    try {
      this.worker?.kill();
    } catch {
      /* ignore */
    }
    this.worker = null;
  }
}
