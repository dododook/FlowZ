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
import type { StatsTopic } from '../../shared/ipc-channels';

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
  /**
   * 重算并（变化时）下发 worker demand（batch3 §3.7）：订阅表变化后由 registry 立即调用，让 worker 尽快开/停
   * 对应上游流，免等下一个 status 帧的惰性同步。StatsSimulator 无 worker demand → no-op。
   */
  syncDemand(): void;
  dispose(): void;
}

/** main → worker 控制消息。 */
export type HostToWorkerMessage =
  | { type: 'connect'; endpoint: StatsApiEndpoint }
  | { type: 'stop' }
  // batch3 §3.7（源从「窗口可见」换成「渲染端订阅」）：需求驱动。connectionsStream=是否订阅上游 SubscribeConnections
  // （aggregate 或 detail 有订阅者→需拓扑/明细；均无→连上游流一起停，削核 CPU）；detail=明细页有订阅者（true 时
  // worker 每帧跨进程传全量明细）。由 registry 订阅变化即时触发 + status 帧惰性重发（reconnect 自愈），见 syncDemand。
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
  /** 流量帧 relay（batch3：经 registry 只发给 'stats' 订阅者；main 侧 isUiActive 门控后调用）。 */
  onStats: (s: TrafficStats) => void;
  /** 连接聚合 relay（首页拓扑；batch3：经 registry 只发给 'aggregate' 订阅者；门控后调用，issue #227）。 */
  onAggregate: (agg: ConnectionsAggregate) => void;
  /** 连接明细 relay（batch3 §3.7：detail 由 pull 改 push topic；经 registry 只发给 'detail' 订阅者；门控后调用）。 */
  onDetail: (conns: ConnectionsSnapshot) => void;
  /**
   * relay 安全门（belt-and-suspenders）：false（窗口不可见 / Windows 拖动中）时只缓存不 relay。batch3 里订阅本身
   * 已由渲染端 visibility 暂停，此为兜底（订阅在但窗口不可见——如拖动期——仍不发）。**非** demand 源（见 hasSubscribers）。
   */
  isUiActive: () => boolean;
  /**
   * demand 源（batch3 §3.7，取代 isUiActive）：某 topic 是否有渲染端订阅者。syncDemand 据此派生 worker 上游流开关
   * （connectionsStream = aggregate||detail 有订阅；detail = detail 有订阅）。无订阅者 → 逐级停机。
   */
  hasSubscribers: (topic: StatsTopic) => boolean;
  /** 取运行期管理 API 端点（核未起返回 null → worker 不开流）。 */
  getEndpoint: () => StatsApiEndpoint | null;
  /** 可选日志钩子（接 logManager）。 */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class StatsWorkerHost implements StatsHost {
  private worker: UtilityProcess | null = null;
  private snapshot: TrafficStats = { ...ZERO_STATS };
  // worker 'detail' 消息缓存的最近连接明细（batch3：detail 变 push topic）：relay 给 'detail' 订阅者 + 作订阅初始帧。
  private connections: ConnectionsSnapshot = { connections: [], at: 0 };
  // worker 'aggregate' 消息缓存的最近拓扑聚合（batch2：聚合已下沉 worker，host 不再自算）：relay 给 'aggregate'
  // 订阅者 + 作订阅初始帧（合并原 CONNECTIONS_AGGREGATE_GET 回填）。
  private aggregate: ConnectionsAggregate = emptyAggregate(0);
  /** 是否应处于订阅态（代理运行）。崩溃 respawn 后据此自动重连，不丢流。 */
  private started = false;
  private disposed = false;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private respawnDelayMs = 500;
  /** 上次下发给 worker 的需求（batch2，取代 lastConnActiveSent）。null=未发过（reconnect/respawn 后重置，
   *  强制下个 status 帧重新下发 setDemand）。仅任一字段变化才重发。 */
  private lastDemandSent: { connectionsStream: boolean; detail: boolean } | null = null;

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
   * 重算并（变化时）下发 worker demand（batch3 §3.7，取代 batch2 的 isUiActive / lastPullAt 源）。两条驱动路径：
   *  ① registry 订阅/退订后立即调（低延迟：连接页一打开 detail 即开流、一关即停，不等下个 status 帧）；
   *  ② case 'stats' 每个 status 帧惰性调（reconnect/respawn 后 lastDemandSent 被 postConnect 复位 null → 借常流
   *     status 帧把当前 demand 重发给新 worker，自愈）；无订阅变化时靠 lastDemandSent 去重、绝不重复 post。
   * demand 源 = 订阅集（**非**窗口可见）：connectionsStream = 拓扑或明细有订阅（订上游 Connections 流；均无 →
   * 连 aggregate 一起停，削核 CPU）；detail = 明细页有订阅（true 时 worker 才跨进程传全量明细）。
   */
  syncDemand(): void {
    const connectionsStream =
      this.opts.hasSubscribers('aggregate') || this.opts.hasSubscribers('detail');
    const detail = this.opts.hasSubscribers('detail');
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
        this.syncDemand(); // 借常流 status 帧惰性重发 demand（reconnect 自愈路径；订阅变化的即时路径在 registry）
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
        // batch3 §3.7：detail 由 pull 改 push topic——缓存 + 按可见性门控 relay 给 'detail' 订阅者（连接页）。worker
        // 仅 detail 有订阅（detailDemand）时才 post，故此缓存只在连接页订阅期新鲜；也作后来订阅者的初始帧。
        this.connections = msg.payload;
        if (this.opts.isUiActive()) this.opts.onDetail(this.connections);
        break;
    }
  }

  // ── 镜像 StatsService 对外公共接口（近 drop-in） ──────────────────────────────

  /** 代理就绪（api-client-ready）/ 切端口：让 worker 连最新端点并重订阅。worker 未 ready 时由 'ready' 握手补连。 */
  resubscribe(): void {
    this.started = true;
    this.postConnect();
  }

  /** 停止订阅 + 清零直推（不门控、直接清 UI，避免停后残留旧值）。batch3：detail 亦为 push topic，须同样清空
   *  推给订阅者（连接页），否则停止后旧连接列表滞留（旧 pull 模型靠下次 pull 拿空缓存自然清，push 模型须显式推）。 */
  stop(): void {
    this.started = false;
    this.post({ type: 'stop' });
    this.snapshot = { ...ZERO_STATS };
    this.connections = { connections: [], at: Date.now() };
    this.aggregate = emptyAggregate(Date.now());
    this.opts.onStats({ ...this.snapshot });
    this.opts.onAggregate(this.aggregate);
    this.opts.onDetail(this.connections);
  }

  /** 拖动结束（Windows）：立即把缓存最新帧补推给各 topic 订阅者（免等 worker 下一帧 ~1s 滞后）。窗口由隐藏转可见
   *  由渲染端重订自然拿初始帧（见 registry），无需在此另补。relay 均经 registry 落到对应 topic 订阅者（无订阅者即 no-op）。 */
  resume(): void {
    if (!this.opts.isUiActive()) return;
    this.opts.onStats({ ...this.snapshot });
    this.opts.onAggregate(this.aggregate);
    this.opts.onDetail(this.connections);
  }

  getSnapshot(): TrafficStats {
    return { ...this.snapshot };
  }

  getConnectionsSnapshot(): ConnectionsSnapshot {
    // batch3：detail 订阅的初始帧来源（registry.getInitialFrame('detail')）。at 用 worker 真实采样时刻
    // （this.connections.at），非读取时刻：连接页速率差分以采样间隔为分母，避免同一缓存被读两次 → Δbytes=0 报
    // 速率 0、下次翻倍的抖动。detail 需求已改由订阅驱动（hasSubscribers），不再记 lastPullAt。
    return { connections: this.connections.connections, at: this.connections.at };
  }

  /** aggregate 订阅的初始帧来源（registry.getInitialFrame('aggregate')）：缓存的最近聚合（增量走同一通道 push）。 */
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
