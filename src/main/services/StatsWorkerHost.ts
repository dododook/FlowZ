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

// batch2 §3.6：detail 需求存活窗口。连接页每次 pull（getConnectionsSnapshot）刷新 lastPullAt，此窗口内维持 detail
// 上游明细传输；超时（页面关闭/停拉）则下发 detail=false，worker 停止跨进程克隆明细。
const PULL_DEMAND_TTL = 5000;

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
  // batch2 §3.6（取代 setConnActive）：需求驱动。connectionsStream=是否订阅上游 SubscribeConnections（窗口可见→拓扑需
  // aggregate；隐藏→连上游流一起停，削核 CPU）；detail=连接页近 PULL_DEMAND_TTL 内有 pull（true 时 worker 每帧跨进程
  // 传全量明细）。status 帧不门控、始终流动，故 host 借其惰性下发本需求（见 syncDemand），无需窗口事件接线。
  | { type: 'setDemand'; connectionsStream: boolean; detail: boolean }
  | { type: 'dispose' };

/** worker → main 数据/握手消息。 */
export type WorkerToHostMessage =
  | { type: 'ready' }
  | { type: 'stats'; payload: TrafficStats }
  // batch2 §3.6（取代 connections）：聚合下沉 worker——worker 每帧本地聚合 + 签名比对，仅内容真变才 post 小载荷
  // aggregate（拓扑供数，杀「每秒全量克隆」B2 + 「零信息增量每秒重渲染」放大器）。
  | { type: 'aggregate'; payload: ConnectionsAggregate }
  // detail=全量明细，仅 detailDemand（连接页 pull 期）才 post，host 缓存供 CONNECTIONS_GET pull（不 relay）。
  | { type: 'detail'; payload: ConnectionsSnapshot };

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
  // worker 'detail' 消息缓存的最近连接明细：仅供连接信息页 CONNECTIONS_GET 按需 pull，不 relay 给渲染端（旧放大器）。
  private connections: ConnectionsSnapshot = { connections: [], at: 0 };
  // worker 'aggregate' 消息缓存的最近拓扑聚合（batch2：聚合已下沉 worker，host 不再自算）：relay
  // EVENT_CONNECTIONS_AGGREGATE + CONNECTIONS_AGGREGATE_GET 回填。
  private aggregate: ConnectionsAggregate = emptyAggregate(0);
  /** 是否应处于订阅态（代理运行）。崩溃 respawn 后据此自动重连，不丢流。 */
  private started = false;
  private disposed = false;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private respawnDelayMs = 500;
  /** 上次下发给 worker 的需求（batch2，取代 lastConnActiveSent）。null=未发过（reconnect/respawn 后重置，
   *  强制下个 status 帧重新下发 setDemand）。仅任一字段变化才重发。 */
  private lastDemandSent: { connectionsStream: boolean; detail: boolean } | null = null;
  /** 连接页最近一次 pull（getConnectionsSnapshot 调用）时刻 epoch ms；驱动 detail 需求（近 PULL_DEMAND_TTL 内=需 detail）。 */
  private lastPullAt = 0;

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
    // reconnect/respawn 后强制下个 status 帧重新下发 setDemand（worker 可能是新进程、connect 已把需求态复位默认）。
    this.lastDemandSent = null;
    const endpoint = this.opts.getEndpoint();
    if (!endpoint) {
      this.post({ type: 'stop' });
      return;
    }
    this.post({ type: 'connect', endpoint });
  }

  /**
   * 惰性下发需求（batch2 §3.6，取代 syncConnActive）：借「始终流动」的 status 帧驱动，仅需求变化才 post setDemand——
   * 无需监听窗口 show/hide/minimize 事件，且 status 不门控 → worker 不会卡死在停用态。
   * - connectionsStream = isUiActive()：窗口可见→拓扑需 aggregate（订阅上游 Connections 流）；隐藏→连上游流一起停
   *   （worker cancel SubscribeConnections，削核 CPU 面）。自愈延迟 ≤1 个 status 间隔（~1s）。
   * - detail = 连接页近 PULL_DEMAND_TTL 内有 pull（lastPullAt）：仅页面真正拉取时 worker 才跨进程传全量明细。
   *   转 true 后明细恢复最坏 ~2 个流间隔（先 status 帧下发 detail=true，worker 再等下一 connections 帧才 post），
   *   与旧 connActive 语义一致；隐藏期本无明细消费者，可接受。
   */
  private syncDemand(): void {
    const connectionsStream = this.opts.isUiActive();
    const detail = Date.now() - this.lastPullAt < PULL_DEMAND_TTL;
    const prev = this.lastDemandSent;
    if (!prev || prev.connectionsStream !== connectionsStream || prev.detail !== detail) {
      this.lastDemandSent = { connectionsStream, detail };
      this.post({ type: 'setDemand', connectionsStream, detail });
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
        this.syncDemand(); // 借常流的 status 帧惰性下发 worker 的 setDemand（batch2）
        this.snapshot = msg.payload;
        if (this.opts.isUiActive()) this.opts.onStats(this.snapshot);
        break;
      case 'aggregate':
        if (!this.started) return; // 停后在途旧帧丢弃，避免残留旧拓扑。
        // 聚合已下沉 worker（change-driven + rate-cap，杀 B2 每秒全量克隆 + 零信息增量重渲染）：host 只缓存 + 按
        // 可见性门控 relay，不再自算 O(N)。隐藏期 worker 经 connectionsStream 需求本就不 post aggregate。
        this.aggregate = msg.payload;
        if (this.opts.isUiActive()) this.opts.onAggregate(this.aggregate);
        break;
      case 'detail':
        if (!this.started) return; // 停后在途旧帧丢弃，避免残留旧连接列表。
        // 仅缓存供连接页 CONNECTIONS_GET pull，不 relay（每秒全量明细 relay 放大器已删，issue #227）。detail 仅
        // detailDemand（连接页 pull 期）才由 worker post，故此缓存只在页面活跃期新鲜。
        this.connections = msg.payload;
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
   *  status 帧 ≤1s 自然广播；拓扑 aggregate 经 connectionsStream 需求重新激活后 ≤2 个流间隔恢复（见 syncDemand），
   *  与原行为大致一致。 */
  resume(): void {
    if (!this.opts.isUiActive()) return;
    this.opts.onStats({ ...this.snapshot });
    this.opts.onAggregate(this.aggregate);
  }

  getSnapshot(): TrafficStats {
    return { ...this.snapshot };
  }

  getConnectionsSnapshot(): ConnectionsSnapshot {
    // batch2：记录本次 pull 时刻，驱动 detail 需求（syncDemand 据 lastPullAt 判「连接页近 PULL_DEMAND_TTL 内活跃」→
    // 下发 detail=true，worker 才跨进程传全量明细）。CONNECTIONS_GET 是唯一调用点（proxy-handlers），语义精确。
    this.lastPullAt = Date.now();
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
