/**
 * 流量统计服务：代理运行时每秒轮询 clash_api /connections，算出累计/速率/连接数，
 * 经 EVENT_STATS_UPDATED 推给渲染端展示。仅读取、不影响代理；轮询失败静默。
 */
import type { TrafficStats, ConnectionEntry, ConnectionsSnapshot } from '../../shared/types';
import { ClashApiClient } from './ClashApiClient';

const POLL_INTERVAL_MS = 1000;
const CLASH_API_PATH = '/connections';
const CONNECTIONS_PUSH_DIVIDER = 2; // 1s 轮询，每 2 tick 推一次连接快照 = 维持原 topology 2s 节奏

/**
 * 裁剪 clash 原始 connection → ConnectionEntry。
 * topology 用 id/chains/rule/rulePayload/metadata{host,destinationIP}；连接信息页额外用
 * network/type/sourceIP/sourcePort/destinationPort/processPath + upload/download/start（速率/源/进程/时长）。
 * ⚠️ metadata 含 sourceIP/processPath 隐私字段——出 IPC 供连接信息页用，由渲染端在隐私模式下屏蔽明细（决策）。
 * 数值字段经 Number()+isFinite 兜底为 undefined（避免 NaN 进 UI 差分）。导出供单测断言扩字段带出。
 */
export function trimConnection(c: any): ConnectionEntry {
  const m = c?.metadata;
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    id: String(c?.id ?? ''),
    chains: Array.isArray(c?.chains) ? c.chains : [],
    rule: String(c?.rule ?? ''),
    rulePayload: String(c?.rulePayload ?? ''),
    metadata: m
      ? {
          host: m.host,
          destinationIP: m.destinationIP,
          network: m.network,
          type: m.type,
          sourceIP: m.sourceIP,
          sourcePort: m.sourcePort,
          destinationPort: m.destinationPort,
          processPath: m.processPath,
        }
      : undefined,
    upload: num(c?.upload),
    download: num(c?.download),
    start: typeof c?.start === 'string' ? c.start : undefined,
  };
}

export class StatsService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: { up: number; down: number; at: number } | null = null;
  private snapshot: TrafficStats = {
    uploadSpeed: 0,
    downloadSpeed: 0,
    totalUpload: 0,
    totalDownload: 0,
    activeConnections: 0,
  };
  private connections: ConnectionEntry[] = [];
  private tick = 0;
  // P1：连接页 watcher 引用计数（连接页 mount→+1 / unmount→-1，经 CONNECTIONS_WATCH/UNWATCH IPC）。
  // 仅 >0 时才 trimConnection + 推送连接快照——「代理连着但没盯连接页」最常见稳态下省掉全量裁剪与大包广播。
  // 计数泄漏（渲染端硬崩漏 unwatch）fail-safe：退化为始终推送 = 原行为，不破功能。
  private connectionsWatchers = 0;
  /**
   * @param onUpdate 每次拿到新快照时回调（广播给渲染端）
   * @param clashApi clash_api 客户端（端口默认 9090，可经 config.controlPort 改；T15：与 ProxyManager 共用单一 agent）
   * @param onConnections 连接快照回调（topology 统一供数；按 divider 节奏推送）
   */
  constructor(
    private readonly onUpdate: (stats: TrafficStats) => void,
    private readonly clashApi: ClashApiClient,
    private readonly onConnections?: (snap: ConnectionsSnapshot) => void,
    // P2：窗口可见性谓词。无可见窗口（macOS hide / minimizeToTray / 轻量销毁 / 普通最小化）= 无任何 UI 消费者
    // → 整轮跳过 fetch/parse/trim/广播（含首页 stats，非仅连接列表；与只门控连接列表的 P1 watcher 不同）。
    // 缺省（未注入，如单测）= 不门控、保持原行为，与 onConnections 缺省语义对称。
    private readonly isWindowVisible?: () => boolean
  ) {}

  start(): void {
    if (this.timer) return;
    this.last = null;
    // 停核→重启时连接页可能仍 mount 着（connectionsWatchers>0，无 0→1 跃迁不经 addConnectionsWatcher 对齐）：
    // 与 mount 对齐逻辑一致，让重启后首轮 poll 即推连接快照（否则 stop() 置 tick=0 致首帧慢一拍 ~1s）。
    if (this.connectionsWatchers > 0) this.tick = CONNECTIONS_PUSH_DIVIDER - 1;
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.last = null;
    this.snapshot = {
      uploadSpeed: 0,
      downloadSpeed: 0,
      totalUpload: 0,
      totalDownload: 0,
      activeConnections: 0,
    };
    this.onUpdate({ ...this.snapshot }); // 停止即清零广播
    this.connections = [];
    this.tick = 0;
    this.onConnections?.({ connections: [], at: Date.now() }); // 停止即广播空连接快照
  }

  getSnapshot(): TrafficStats {
    return { ...this.snapshot };
  }

  getConnectionsSnapshot(): ConnectionsSnapshot {
    return { connections: this.connections, at: Date.now() };
  }

  /** 连接页订阅：引用计数 +1。0→1 时把 tick 对齐到下一轮即推，连接页 mount 后 ≤1s 见数据（不等满 divider）。 */
  addConnectionsWatcher(): void {
    this.connectionsWatchers++;
    if (this.connectionsWatchers === 1) {
      this.tick = CONNECTIONS_PUSH_DIVIDER - 1;
    }
  }

  /** 连接页退订：引用计数 -1（钳制 ≥0，防 over-unwatch）。归 0 后下轮 poll 不再 trim/推送。 */
  removeConnectionsWatcher(): void {
    if (this.connectionsWatchers > 0) this.connectionsWatchers--;
  }

  /**
   * 渲染端重载/重建时归零引用计数（N-2）：watcher 计数依赖连接页 mount/unmount 配对发 WATCH/UNWATCH，
   * 渲染进程硬崩 / 整页 reload 会漏发 UNWATCH → 计数只增不减泄漏 → 稳态省裁剪的优化永久失效（fail-safe 退化为
   * 始终推送，不破功能但白费优化）。挂渲染端 did-start-loading 调用：页面将重建，旧 watcher 全作废，清零；
   * 重建后连接页会重新 WATCH 自然恢复计数。
   */
  resetConnectionsWatchers(): void {
    this.connectionsWatchers = 0;
  }

  private async poll(): Promise<void> {
    // P2：无可见窗口（hide / 最小化 / 轻量销毁）→ 无任何 UI 消费者，整轮跳过 fetch+parse+trim+广播（含首页 stats）。
    // 重置 last 让窗口恢复后首轮干净再基线（避免跨隐藏窗口的大 dt 算出失真速率）。
    if (this.isWindowVisible && !this.isWindowVisible()) {
      this.last = null;
      return;
    }
    try {
      const data = await this.clashApi.getJson<{
        uploadTotal?: number;
        downloadTotal?: number;
        connections?: unknown[];
      }>(CLASH_API_PATH);
      if (!data) return; // 轮询失败静默（核心刚停/鉴权未就绪）

      const up = data.uploadTotal ?? 0;
      const down = data.downloadTotal ?? 0;
      const now = Date.now();
      if (this.last) {
        const dt = Math.max((now - this.last.at) / 1000, 0.001);
        // 核心重启会令累计回绕 → clamp 0，避免出现负速率
        this.snapshot.uploadSpeed = Math.max(0, (up - this.last.up) / dt);
        this.snapshot.downloadSpeed = Math.max(0, (down - this.last.down) / dt);
      }
      this.last = { up, down, at: now };
      this.snapshot.totalUpload = up;
      this.snapshot.totalDownload = down;
      // activeConnections 只取 length（廉价、无需 trim）→ 首页连接数恒可用，与连接列表门控解耦
      this.snapshot.activeConnections = Array.isArray(data.connections)
        ? data.connections.length
        : 0;
      this.onUpdate({ ...this.snapshot });

      // 连接列表：仅连接页有 watcher 时才 trim + 按 divider 推送（P1 主门控）。trim 移进 divider 分支
      // （P4：消除「每 1s 裁剪但每 2s 才推」的半浪费）；无 watcher 时零裁剪、清陈旧缓存。
      if (this.connectionsWatchers > 0) {
        if (++this.tick % CONNECTIONS_PUSH_DIVIDER === 0) {
          this.connections = Array.isArray(data.connections)
            ? data.connections.map(trimConnection)
            : [];
          this.onConnections?.({ connections: this.connections, at: now });
        }
      } else if (this.connections.length > 0) {
        this.connections = []; // 无 watcher：清缓存（CONNECTIONS_GET 回填得空，watch 后下轮即 fill）
      }
    } catch {
      /* 静默：核心未运行 / 连接被拒 */
    }
  }
}
