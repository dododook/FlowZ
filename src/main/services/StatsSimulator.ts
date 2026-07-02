/**
 * StatsSimulator —— 合成 churn 注入器（issue #242 §5 泄漏定证 harness）。
 *
 * 背景：#242 renderer RSS 数天涨到 2GB，但泄漏机制在应用层之下、本机不一定能稳定复现。本模块**制造**复现：
 * 构造一个假连接池，用**真实的** aggregateConnections 聚合后，经与 StatsWorkerHost 相同的 isUiActive 门控把
 * aggregate/stats 灌给渲染端——绕过内核/流量/TUN，以可调速率把 reporter 数天暴露压缩到小时级，供 CDP heap
 * 三连拍定位滞留层。**dev-only 工具、零业务行为变更**：仅 FLOWZ_STATS_SIM 存在时替换真实 stats worker。
 *
 * 语义刻意与代理生命周期解耦（dev 工具）：构造即启动 ticker；stop()/resubscribe() 只记日志、不停 ticker
 * （代理起停不该打断定证跑批）；仅 dispose()（app 退出）才停并 clearInterval。对外面实现 StatsHost，与
 * StatsWorkerHost 可在 index.ts 处直接替换。
 */
import type {
  TrafficStats,
  ConnectionsSnapshot,
  ConnectionsAggregate,
  ConnectionEntry,
} from '../../shared/types';
import { aggregateConnections } from './connections-aggregate';
import type { StatsHost, StatsWorkerHostOptions } from './StatsWorkerHost';

/** 合成器参数（FLOWZ_STATS_SIM=intervalMs,connCount,churnPerFrame 解析而来）。 */
export interface StatsSimConfig {
  /** tick 间隔（ms）：每 tick 一次聚合 + 一次 stats。 */
  intervalMs: number;
  /** 假连接池恒定大小（= aggregate.total / activeConnections）。 */
  connCount: number;
  /** 每 tick 关掉最老、开同数量新连接的条数（驱动 aggregate 签名变化）。 */
  churnPerFrame: number;
}

/** 缺省参数：1s、200 连接、每帧换 20 条（与设计示例一致）。 */
export const DEFAULT_STATS_SIM_CONFIG: StatsSimConfig = {
  intervalMs: 1000,
  connCount: 200,
  churnPerFrame: 20,
};

/** 假域名池（~30）：新连接从中取 host，制造多样 host 节点。 */
const FAKE_HOSTS: readonly string[] = [
  'example.com',
  'api.example.com',
  'cdn.example.net',
  'img.example.org',
  'video.stream.tv',
  'chat.im',
  'mail.provider.com',
  'docs.office.io',
  'push.notify.dev',
  'auth.login.net',
  'analytics.track.co',
  'ads.serve.io',
  'update.pkg.org',
  'git.code.dev',
  'registry.npm.js',
  'pypi.python.org',
  'search.engine.com',
  'map.tiles.net',
  'weather.now.io',
  'news.feed.rss',
  'social.graph.co',
  'photo.album.me',
  'music.play.fm',
  'game.match.gg',
  'shop.cart.store',
  'pay.checkout.io',
  'bank.secure.com',
  'crm.sales.app',
  'metrics.grafana.io',
  'log.ingest.dev',
];

/** 假出口池（5）：新连接从中取 outbound（chains[0]）。 */
const FAKE_OUTBOUNDS: readonly string[] = ['proxy-a', 'proxy-b', 'proxy-c', 'direct', 'block'];

/**
 * 解析 FLOWZ_STATS_SIM=intervalMs,connCount,churnPerFrame。防御式：任一字段非法（非正整数/缺失）→ 该字段
 * 回退缺省并 warn（不因一个字段拖垮整体）。纯函数，供单测。
 */
export function parseStatsSimConfig(
  raw: string | undefined,
  warn?: (message: string) => void
): StatsSimConfig {
  const d = DEFAULT_STATS_SIM_CONFIG;
  const parts = (raw ?? '').split(',');
  const bad: string[] = [];

  const pick = (idx: number, fallback: number, label: string): number => {
    const n = Number.parseInt((parts[idx] ?? '').trim(), 10);
    if (!Number.isFinite(n) || n <= 0) {
      bad.push(label);
      return fallback;
    }
    return n;
  };

  const intervalMs = pick(0, d.intervalMs, 'intervalMs');
  const connCount = pick(1, d.connCount, 'connCount');
  const churnPerFrame = pick(2, d.churnPerFrame, 'churnPerFrame');

  if (bad.length > 0) {
    warn?.(
      `FLOWZ_STATS_SIM 解析非法字段 [${bad.join(', ')}]（原值 "${raw ?? ''}"），已回退缺省 ` +
        `${d.intervalMs},${d.connCount},${d.churnPerFrame}`
    );
  }
  return { intervalMs, connCount, churnPerFrame };
}

export class StatsSimulator implements StatsHost {
  private readonly config: StatsSimConfig;
  private readonly onStats: (s: TrafficStats) => void;
  private readonly onAggregate: (agg: ConnectionsAggregate) => void;
  private readonly isUiActive: () => boolean;
  private readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;

  private readonly pool: ConnectionEntry[] = [];
  private readonly churnPerFrame: number;
  private nextId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;

  private snapshot: TrafficStats;
  private aggregate: ConnectionsAggregate;

  /**
   * @param opts 与 StatsWorkerHost 同形（复用 index.ts 装配的 onStats/onAggregate/isUiActive/log）；workerPath/
   *   getEndpoint 对合成器无意义，刻意忽略。
   * @param rawConfig FLOWZ_STATS_SIM 原始串（构造内解析 + 打激活/防御 banner）。
   */
  constructor(opts: StatsWorkerHostOptions, rawConfig: string | undefined) {
    this.onStats = opts.onStats;
    this.onAggregate = opts.onAggregate;
    this.isUiActive = opts.isUiActive;
    this.log = opts.log;
    this.config = parseStatsSimConfig(rawConfig, (m) => this.log?.('warn', m));
    // churn 不超过池大小（否则整池每 tick 全换、老连接切片越界语义无意义）。
    this.churnPerFrame = Math.min(this.config.churnPerFrame, this.config.connCount);

    this.log?.(
      'warn',
      `stats 模拟器激活（FLOWZ_STATS_SIM=${rawConfig ?? ''} → intervalMs=${this.config.intervalMs}, ` +
        `connCount=${this.config.connCount}, churnPerFrame=${this.churnPerFrame}），仅用于泄漏定证`
    );

    // 初始填满连接池，使首个 tick 起 aggregate.total 即等于 connCount。
    for (let i = 0; i < this.config.connCount; i++) this.pool.push(this.makeConnection());
    this.snapshot = {
      uploadSpeed: 0,
      downloadSpeed: 0,
      totalUpload: 0,
      totalDownload: 0,
      activeConnections: this.pool.length,
    };
    this.aggregate = aggregateConnections(this.pool, Date.now());

    // 构造即启动 ticker（dev 工具语义，不跟随代理生命周期）。
    this.timer = setInterval(() => this.tick(), this.config.intervalMs);
  }

  /** 造一条假连接：id 递增、host/outbound 随机取自假池、字节从 0 起。 */
  private makeConnection(): ConnectionEntry {
    const id = `sim-${this.nextId++}`;
    const host = FAKE_HOSTS[Math.floor(Math.random() * FAKE_HOSTS.length)];
    const outbound = FAKE_OUTBOUNDS[Math.floor(Math.random() * FAKE_OUTBOUNDS.length)];
    return {
      id,
      chains: [outbound],
      rule: 'sim',
      rulePayload: '',
      metadata: { host, network: 'tcp' },
      upload: 0,
      download: 0,
      start: new Date().toISOString(),
    };
  }

  /**
   * 单 tick：churn 连接池（关最老 churn 条 + 开同数量新）→ 真实聚合 → 门控 onAggregate；随机游走速率 + 累加
   * totals → 门控 onStats。快照恒更新（getters 读缓存），门控只挡广播（与 StatsWorkerHost 一致）。
   */
  private tick(): void {
    // 1) churn：关最老 churnPerFrame 条，开同数量新连接（池大小恒定）。
    this.pool.splice(0, this.churnPerFrame);
    for (let i = 0; i < this.churnPerFrame; i++) this.pool.push(this.makeConnection());
    // 存量连接字节随 tick 推进（模拟持续传输，使明细每帧微变）。**替换新对象**而非原地变异——与
    // StatsWorkerHost 每帧 post 全新对象的语义一致，使已发出的快照条目不被后续 tick 改动（引用隔离）。
    // 否则消费端两次 pull 差分算速率时「上一次快照」被原地改新 → Δ 恒 0 → 明细页速率恒显 0。
    for (let i = 0; i < this.pool.length; i++) {
      const c = this.pool[i];
      this.pool[i] = {
        ...c,
        upload: (c.upload ?? 0) + Math.floor(Math.random() * 4096),
        download: (c.download ?? 0) + Math.floor(Math.random() * 16384),
      };
    }

    const now = Date.now();
    this.aggregate = aggregateConnections(this.pool, now);
    if (this.isUiActive()) this.onAggregate(this.aggregate);

    // 2) 速率随机游走，clamp 到 [50KB/s, 500KB/s]；totals 累加；activeConnections = 池大小。
    const walk = (v: number): number => {
      const next = v + (Math.random() - 0.5) * 100 * 1024;
      return Math.max(50 * 1024, Math.min(500 * 1024, next));
    };
    const uploadSpeed = walk(this.snapshot.uploadSpeed || 200 * 1024);
    const downloadSpeed = walk(this.snapshot.downloadSpeed || 200 * 1024);
    this.snapshot = {
      uploadSpeed: Math.round(uploadSpeed),
      downloadSpeed: Math.round(downloadSpeed),
      totalUpload: this.snapshot.totalUpload + Math.round(uploadSpeed),
      totalDownload: this.snapshot.totalDownload + Math.round(downloadSpeed),
      activeConnections: this.pool.length,
    };
    if (this.isUiActive()) this.onStats(this.snapshot);
  }

  // ── StatsHost 对外面 ────────────────────────────────────────────────────────

  /** dev 工具：不跟随代理生命周期，仅记日志、不重启 ticker。 */
  resubscribe(): void {
    this.log?.('info', 'stats 模拟器 resubscribe()（dev 工具，ticker 不受代理生命周期影响，忽略）');
  }

  /** dev 工具：不跟随代理生命周期，仅记日志、不停 ticker。 */
  stop(): void {
    this.log?.('info', 'stats 模拟器 stop()（dev 工具，ticker 持续，忽略）');
  }

  /** batch3：合成器无 worker demand（ticker 自跑），registry 订阅变化对其无意义 → no-op。 */
  syncDemand(): void {
    /* 无 worker demand：合成 aggregate/stats 经 opts.onStats/onAggregate → registry.broadcast 已按订阅落地 */
  }

  /** 拖动结束补推缓存最新（活跃才推），与 StatsWorkerHost.resume 语义一致。 */
  resume(): void {
    if (!this.isUiActive()) return;
    this.onStats(this.snapshot);
    this.onAggregate(this.aggregate);
  }

  getSnapshot(): TrafficStats {
    return { ...this.snapshot };
  }

  getConnectionsSnapshot(): ConnectionsSnapshot {
    // 浅拷贝数组：条目已由 tick 不可变替换（引用隔离），故 slice 即足以让快照在消费前不随后续 tick 漂移。
    return { connections: this.pool.slice(), at: Date.now() };
  }

  getAggregateSnapshot(): ConnectionsAggregate {
    return this.aggregate;
  }

  /** app 退出：停 ticker。唯一停止入口。 */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log?.('info', 'stats 模拟器 dispose()，ticker 已停');
  }
}
