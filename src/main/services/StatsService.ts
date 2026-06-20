/**
 * 流量统计服务：代理运行时经 sing-box 1.14 管理 API（gRPC）订阅 Status / Connections 流，算累计/速率/连接数，
 * 经 EVENT_STATS_UPDATED / EVENT_CONNECTIONS_UPDATED 推给渲染端展示。仅读取、不影响代理；流断开静默（客户端内部 2s 重连）。
 *
 * §3-B：取代旧 clash_api `/connections` 每秒轮询。速率（uplink/downlink）由 server 直接给出（无需本地 delta/dt 自算）；
 * 连接以事件流（NEW/UPDATE/CLOSED 增量 + reset 全量重置）维护一份 map，避免每秒拉全量连接列表。
 */
import type { TrafficStats, ConnectionEntry, ConnectionsSnapshot } from '../../shared/types';
import type {
  SingBoxApiClient,
  SingBoxStatus,
  SingBoxConnection,
  SingBoxConnectionEvents,
} from './singbox-api-client';

// 流推送间隔：1s（纳秒，int64）。对齐旧轮询 1s 节奏（首页速率/连接数体感）。
const STATUS_INTERVAL_NS = 1_000_000_000;
const CONNECTIONS_INTERVAL_NS = 1_000_000_000;

/** 数值规整：string/number → number，非有限值 → undefined（避免 NaN 进 UI 差分）。 */
function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 拆 "ip:port"（含 IPv6 "[::1]:443"）为 { ip, port }。缺省 undefined。 */
function splitHostPort(v: unknown): { ip?: string; port?: string } {
  if (typeof v !== 'string' || v === '') return {};
  const s = v.trim();
  // IPv6 字面量带方括号："[2001:db8::1]:443"
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close > 0) {
      const ip = s.slice(1, close);
      const rest = s.slice(close + 1);
      const port = rest.startsWith(':') ? rest.slice(1) : undefined;
      return { ip: ip || undefined, port: port || undefined };
    }
    return { ip: s, port: undefined };
  }
  // IPv4 / 域名："1.2.3.4:443"——按最后一个冒号拆（裸 IPv6 无方括号时无法可靠拆，退化为整体当 ip）。
  const idx = s.lastIndexOf(':');
  if (idx < 0) return { ip: s, port: undefined };
  // 多冒号且无方括号 = 裸 IPv6（无端口），整体当 ip。
  if (s.indexOf(':') !== idx) return { ip: s, port: undefined };
  return { ip: s.slice(0, idx) || undefined, port: s.slice(idx + 1) || undefined };
}

/**
 * gRPC Connection.createdAt（int64 unix 时间戳，longs=String）→ RFC3339 字符串（渲染端 formatTimeAgo 用 Date.parse）。
 * sing-box 以 unix 纳秒（time.Time.UnixNano）序列化 createdAt；启发式按数量级判 ns/us/ms/s 兼容核版本差异：
 *   ns ~1e18 / us ~1e15 / ms ~1e12 / s ~1e9（2020 后）。非法/0 → undefined（连接信息页时长列留空）。
 */
function createdAtToRfc3339(v: unknown): string | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  let ms: number;
  if (n >= 1e17)
    ms = n / 1e6; // 纳秒（sing-box 默认）
  else if (n >= 1e14)
    ms = n / 1e3; // 微秒
  else if (n >= 1e11)
    ms = n; // 毫秒
  else ms = n * 1e3; // 秒
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * 裁剪 gRPC SingBoxConnection → ConnectionEntry。
 * topology 用 id/chains/rule/metadata{host,destinationIP}；连接信息页额外用
 * network/type/sourceIP/sourcePort/destinationPort/processPath + upload/download/start（速率/源/进程/时长）。
 * ⚠️ metadata 含 sourceIP/processPath 隐私字段——出 IPC 供连接信息页用，由渲染端在隐私模式下屏蔽明细（决策）。
 * 字段映射（gRPC → ConnectionEntry）：id→id, chainList→chains, rule→rule；metadata{ host←domain,
 * network←network, destinationIP/destinationPort←拆 destination, sourceIP/sourcePort←拆 source,
 * processPath←processInfo.processPath, type←inboundType }; upload←uplinkTotal, download←downlinkTotal,
 * start←createdAt(转 RFC3339)。导出供单测断言扩字段带出。
 */
export function trimConnection(c: SingBoxConnection): ConnectionEntry {
  const src = splitHostPort(c?.source);
  const dst = splitHostPort(c?.destination);
  return {
    id: String(c?.id ?? ''),
    chains: Array.isArray(c?.chainList) ? c.chainList : [],
    rule: String(c?.rule ?? ''),
    // gRPC 无 rulePayload 字段（clash 专有）；恒空串维持 ConnectionEntry 形状。
    rulePayload: '',
    metadata: {
      host: c?.domain || undefined,
      destinationIP: dst.ip,
      network: c?.network || undefined,
      type: c?.inboundType || undefined,
      sourceIP: src.ip,
      sourcePort: src.port,
      destinationPort: dst.port,
      processPath: c?.processInfo?.processPath || undefined,
    },
    upload: num(c?.uplinkTotal),
    download: num(c?.downlinkTotal),
    start: createdAtToRfc3339(c?.createdAt),
  };
}

export class StatsService {
  // Status 流 stop 句柄（常开，仅核运行期）。null=未订阅。
  private statusStop: (() => void) | null = null;
  // Connections 流 stop 句柄（仅 connectionsWatchers>0 时订阅）。null=未订阅。
  private connectionsStop: (() => void) | null = null;
  private snapshot: TrafficStats = {
    uploadSpeed: 0,
    downloadSpeed: 0,
    totalUpload: 0,
    totalDownload: 0,
    activeConnections: 0,
  };
  // 连接事件流维护的连接 map（key=id）。reset=true 清空重建；NEW 加 / UPDATE 改 / CLOSED 删。
  private connMap = new Map<string, SingBoxConnection>();
  private connections: ConnectionEntry[] = [];
  private started = false;
  // P1：连接页 watcher 引用计数（连接页 mount→+1 / unmount→-1，经 CONNECTIONS_WATCH/UNWATCH IPC）。
  // 仅 >0 时才订阅 Connections 流（0→1 订阅、→0 退订）——「代理连着但没盯连接页」最常见稳态下不开连接事件流。
  // 计数泄漏（渲染端硬崩漏 unwatch）fail-safe：流继续开着 = 仅多一条订阅，不破功能。
  private connectionsWatchers = 0;

  /**
   * @param onUpdate 每次拿到新 Status 时回调（广播给渲染端）
   * @param getApiClient 取运行期管理 API 客户端（ProxyManager.getApiClient；核未起返回 null）。每次开流时取最新。
   * @param onConnections 连接快照回调（topology 统一供数；连接事件流每帧推送）
   * @param isWindowVisible 窗口可见性谓词。无可见窗口（hide/minimizeToTray/轻量销毁/普通最小化）= 无 UI 消费者
   *   → 跳过 broadcast（含首页 stats）。缺省（未注入，如单测）= 不门控、始终广播。
   */
  constructor(
    private readonly onUpdate: (stats: TrafficStats) => void,
    private readonly getApiClient: () => SingBoxApiClient | null,
    private readonly onConnections?: (snap: ConnectionsSnapshot) => void,
    private readonly isWindowVisible?: () => boolean
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.subscribeStatusStream();
    // 停核→重启时连接页可能仍 mount 着（connectionsWatchers>0，无 0→1 跃迁不经 addConnectionsWatcher）：
    // 与 mount 对齐逻辑一致，重启后若仍有 watcher 立即重订阅连接流。
    if (this.connectionsWatchers > 0) this.subscribeConnectionsStream();
  }

  /**
   * 重订阅到「当前」api client（E-1）。崩溃自动重启路径（ProxyManager.handleProcessExit 直接 return，不经
   * emit('stopped') → 不调本服务 stop()）下 `started` 仍为 true → start() 幂等闸门直接 return → 旧 statusStop
   * 句柄仍绑死旧 client / 旧 api 端口（端口每次启动可能重解析变化），旧流即便自愈也连不回新核 → Status 流
   * （首页速率/总量/连接数）显示停滞。本方法无视幂等闸门：先停现有流句柄（旧句柄 cancel 旧 client 的流），
   * 再按新 getApiClient() 重订阅 Status（始终）+ Connections（仅 watcher>0 时），即时切到新 client。
   * connectionsWatchers 引用计数语义不变（仅据其值决定是否重订阅 Connections，不增减计数）。
   * 同时满足首次启动（started=false）：置位 started 后等效于 start()，故 'started' 监听器统一调用本方法即可。
   */
  resubscribe(): void {
    this.started = true;
    // 停旧句柄（指向旧 client）。两条 unsubscribe 把 statusStop/connectionsStop 清 null（吞异常 cancel 旧 client 的流），
    // 否则 subscribe* 会被「已订阅」守卫（if (this.statusStop) return）短路、订阅不到新 client。
    // unsubscribeConnectionsStream 同时清 connMap/connections。
    this.unsubscribeStatusStream();
    this.unsubscribeConnectionsStream();
    // F2：snapshot 归零并广播（对齐 stop() 语义）。新核重启后 totals/speed/activeConnections 本就从 0 起；
    // 不归零则崩溃 auto-restart（不走 stop()）后，新核首帧到达前 ~1s 窗口里首页 activeConnections 显旧值、
    // 而连接列表已被 unsubscribeConnectionsStream 清空，计数/列表不一致。归零 + 广播使重连窗口状态一致。
    this.snapshot = {
      uploadSpeed: 0,
      downloadSpeed: 0,
      totalUpload: 0,
      totalDownload: 0,
      activeConnections: 0,
    };
    this.onUpdate({ ...this.snapshot });
    this.onConnections?.({ connections: [], at: Date.now() });
    this.subscribeStatusStream();
    if (this.connectionsWatchers > 0) this.subscribeConnectionsStream();
  }

  stop(): void {
    this.started = false;
    this.unsubscribeStatusStream();
    this.unsubscribeConnectionsStream();
    this.snapshot = {
      uploadSpeed: 0,
      downloadSpeed: 0,
      totalUpload: 0,
      totalDownload: 0,
      activeConnections: 0,
    };
    this.onUpdate({ ...this.snapshot }); // 停止即清零广播
    this.connMap.clear();
    this.connections = [];
    this.onConnections?.({ connections: [], at: Date.now() }); // 停止即广播空连接快照
  }

  getSnapshot(): TrafficStats {
    return { ...this.snapshot };
  }

  getConnectionsSnapshot(): ConnectionsSnapshot {
    return { connections: this.connections, at: Date.now() };
  }

  /** 连接页订阅：引用计数 +1。0→1 时（且服务已 start）开 Connections 流，连接页 mount 后即推数据。 */
  addConnectionsWatcher(): void {
    this.connectionsWatchers++;
    if (this.connectionsWatchers === 1 && this.started) {
      this.subscribeConnectionsStream();
    }
  }

  /** 连接页退订：引用计数 -1（钳制 ≥0，防 over-unwatch）。归 0 后退订 Connections 流（停流、清缓存）。 */
  removeConnectionsWatcher(): void {
    if (this.connectionsWatchers > 0) this.connectionsWatchers--;
    if (this.connectionsWatchers === 0) {
      this.unsubscribeConnectionsStream();
    }
  }

  /**
   * 渲染端重载/重建时归零引用计数（N-2）：watcher 计数依赖连接页 mount/unmount 配对发 WATCH/UNWATCH，
   * 渲染进程硬崩 / 整页 reload 会漏发 UNWATCH → 计数只增不减泄漏 → 连接流永久开着（fail-safe，仅多一订阅）。
   * 挂渲染端 did-start-loading 调用：页面将重建，旧 watcher 全作废，清零 + 退订；重建后连接页会重新 WATCH。
   */
  resetConnectionsWatchers(): void {
    this.connectionsWatchers = 0;
    this.unsubscribeConnectionsStream();
  }

  /** 流 stop 句柄安全调用（吞异常）并清空：两条流退订同构，单一真值复用。返回 null 供调用方回写句柄字段。 */
  private clearStop(handle: (() => void) | null): null {
    try {
      handle?.();
    } catch {
      /* ignore */
    }
    return null;
  }

  // ── Status 流 ────────────────────────────────────────────────────────────────
  private subscribeStatusStream(): void {
    if (this.statusStop) return;
    const client = this.getApiClient();
    if (!client) return; // 核未起/无管理 API → 不开流（start 时核必已起；防御性兜底）
    this.statusStop = client.subscribeStatus(STATUS_INTERVAL_NS, (status) => this.onStatus(status));
  }

  private unsubscribeStatusStream(): void {
    this.statusStop = this.clearStop(this.statusStop);
  }

  /**
   * Status 帧处理：speed/total/连接数直接取 server 给的值（speed 已是速率，无需本地 delta/dt）。
   * 窗口不可见 → 跳过 broadcast（无 UI 消费者；快照仍更新，可见后下一帧即广播最新）。
   */
  private onStatus(status: SingBoxStatus): void {
    this.snapshot.uploadSpeed = num(status?.uplink) ?? 0;
    this.snapshot.downloadSpeed = num(status?.downlink) ?? 0;
    this.snapshot.totalUpload = num(status?.uplinkTotal) ?? 0;
    this.snapshot.totalDownload = num(status?.downlinkTotal) ?? 0;
    this.snapshot.activeConnections =
      (num(status?.connectionsIn) ?? 0) + (num(status?.connectionsOut) ?? 0);
    if (this.isWindowVisible && !this.isWindowVisible()) return; // 无 UI 消费者 → 跳过广播
    this.onUpdate({ ...this.snapshot });
  }

  // ── Connections 流 ───────────────────────────────────────────────────────────
  private subscribeConnectionsStream(): void {
    if (this.connectionsStop) return;
    const client = this.getApiClient();
    if (!client) return;
    this.connMap.clear();
    this.connections = [];
    this.connectionsStop = client.subscribeConnections(CONNECTIONS_INTERVAL_NS, (events) =>
      this.onConnectionEvents(events)
    );
  }

  private unsubscribeConnectionsStream(): void {
    this.connectionsStop = this.clearStop(this.connectionsStop);
    this.connMap.clear();
    this.connections = [];
  }

  /**
   * Connections 事件帧处理：reset=true → 清空 map 按 events 全量重建；否则增量（NEW 加/UPDATE 改/CLOSED 删）。
   * 维护后映射成 ConnectionEntry 列表广播。窗口不可见跳过 broadcast（map 仍维护，可见后下帧即推）。
   */
  private onConnectionEvents(events: SingBoxConnectionEvents): void {
    if (events?.reset) this.connMap.clear();
    for (const ev of events?.events ?? []) {
      const id = ev?.id ?? ev?.connection?.id;
      if (!id) continue;
      switch (ev?.type) {
        case 'CLOSED':
          this.connMap.delete(id);
          break;
        case 'UPDATE': {
          // 实测：UPDATE 帧只带 uplinkDelta/downlinkDelta（connection 为 null）→ 把增量累加到既有条目 totals，
          // 维持连接页 per-connection 实时流量（否则恒显 NEW 时的 0，到 CLOSED 又被删，全程流量为 0=regression）。
          // 漏收 NEW（UPDATE 先到）时 ev.connection 兜底补建。
          // 缺失/keepalive 帧的 delta 缺省按 0 累积，故用 `|| 0` 而非 num()——num() 会把缺失字段算成 NaN，
          // 一次 NaN 会污染 totals 此后恒 NaN（累积语义被毁），`|| 0`（同 falsy→0）才是累积所需的正确兜底。
          const existing = this.connMap.get(id);
          if (existing) {
            existing.uplinkTotal = String(
              (Number(existing.uplinkTotal) || 0) + (Number(ev.uplinkDelta) || 0)
            );
            existing.downlinkTotal = String(
              (Number(existing.downlinkTotal) || 0) + (Number(ev.downlinkDelta) || 0)
            );
          } else if (ev?.connection) {
            this.connMap.set(id, ev.connection);
          }
          break;
        }
        case 'NEW':
        default:
          if (ev?.connection) this.connMap.set(id, ev.connection);
          break;
      }
    }
    this.connections = Array.from(this.connMap.values()).map(trimConnection);
    if (this.isWindowVisible && !this.isWindowVisible()) return; // 无 UI 消费者 → 跳过广播
    this.onConnections?.({ connections: this.connections, at: Date.now() });
  }
}
