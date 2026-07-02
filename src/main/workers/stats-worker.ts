/**
 * stats-worker —— Electron utilityProcess 入口（T4，issue #225；batch2 数据面核心，issue #242）。
 *
 * 把 StatsService 的 Status/Connections gRPC 长流订阅 + 连接事件解析 + per-frame 物化从 main 进程移出，消除主线程
 * 事件循环争用（Windows 拖动 move modal loop 跑主线程，与 stats 处理抢线程 → 拖动卡顿 / 启动后迟缓）。
 *
 * 设计要点：
 * - StatsService 类**原样复用**（import 现有实现，逻辑不改 → 保 #210 长流重建 / #167 LRU eviction / 审计#3 OOM 上限
 *   / resubscribe 切端口 等全部不变量；存量单测继续护）。connections 流的按需开关经 StatsService.setConnectionsStreamEnabled
 *   （复用其既有 subscribe/unsubscribe，不新增流原语）。
 * - worker 持自己的 SingBoxApiClient（仅 stats，不传 onUpdate → 不订 Tailscale）；端点参数由 main 经 'connect' 下发。
 * - **batch2 治本（issue #242）**：聚合下沉本 worker。每收到内核 connections 帧本地 aggregateConnections + 签名比对：
 *   ① change-driven + rate-cap → 仅内容真变且距上次 ≥AGG_MIN_INTERVAL_MS 才 post 小载荷 aggregate（杀「每秒全量克隆」
 *   B2 + 「零信息增量每秒重渲染」放大器）；② detail（全量明细）仅 host 下发 detailDemand（连接页 pull 期）才 post；
 *   ③ connectionsStream 需求为 false（窗口隐藏/无消费者）时取消上游 SubscribeConnections（顺带削核 CPU 面）。
 * - 可见性/需求门控在 main（StatsWorkerHost）+ 本 worker 两侧完成；StatsService 第 4 参 isWindowVisible 恒不传 →
 *   其 connections 帧恒物化喂本 worker 回调。
 */
import { StatsService } from '../services/StatsService';
import { SingBoxApiClient } from '../services/singbox-api-client';
import { aggregateConnections, aggregateSignature } from '../services/connections-aggregate';
import type { HostToWorkerMessage, WorkerToHostMessage } from '../services/StatsWorkerHost';

// utilityProcess 子进程的父端口（Electron 在子进程 process 上注入）。
const parentPort = process.parentPort;

// change-driven aggregate 的最小 post 间隔（batch2 §3.6）：内核帧 ~1s 到，签名变化且距上次 post ≥2s 才推——高 churn
// 最坏 0.5 Hz；拓扑是计数图、落后 ≤2s 可接受，故无需额外 timer（帧本身即驱动）。
const AGG_MIN_INTERVAL_MS = 2000;

let apiClient: SingBoxApiClient | null = null;

// batch2 需求驱动状态（取代 issue #225 的 connActive）：
// detailDemand——host 据连接页 pull 活跃度下发（setDemand.detail）。true 时每帧 post 全量明细（跨进程克隆，仅连接页
//   开着时才付费）。默认 false，待 host 首个 status 帧惰性下发真实值。
let detailDemand = false;
// connectionsStreamOn——映射「是否订阅上游 SubscribeConnections」。host 据窗口可见性下发（setDemand.connectionsStream）。
//   false 时经 StatsService 取消 Connections 流（连 aggregate 都停，sing-box 少序列化一条每秒长流削核 CPU）；Status
//   流不受影响（流量条恒需）。connect 默认 true（可见时即有 aggregate，host 首帧 setDemand 再收敛真实值）。
let connectionsStreamOn = true;
// change-driven：上次 post 的 aggregate 内容签名与时刻。签名未变或未过 rate-cap 不 post。null=强制下帧必发（connect 复位）。
let lastSentSig: string | null = null;
let lastSentAt = 0;

function post(msg: WorkerToHostMessage): void {
  parentPort.postMessage(msg);
}

// StatsService 实例常驻：'connect' 切 client + resubscribe，'stop' 停流。getApiClient 返回 worker 当前 client。
const stats = new StatsService(
  (s) => post({ type: 'stats', payload: s }), // status 不门控：始终流动，驱动 host 惰性下发 setDemand
  () => apiClient,
  (snap) => {
    // 每收到内核 connections 帧：本地聚合（下沉 worker，杀 host 侧每秒全量跨进程克隆 B2）。
    const agg = aggregateConnections(snap.connections, snap.at);
    const sig = aggregateSignature(agg);
    const now = Date.now();
    // change-driven + rate-cap：签名变（内容真变）且距上次 post ≥AGG_MIN_INTERVAL_MS 才推 aggregate（拓扑小载荷）。
    if (sig !== lastSentSig && now - lastSentAt >= AGG_MIN_INTERVAL_MS) {
      post({ type: 'aggregate', payload: agg });
      lastSentSig = sig;
      lastSentAt = now;
    }
    // detail 需求驱动：仅 detailDemand（连接页 pull 期）才把全量明细跨进程传（不门控签名/cap——明细每帧微变、
    // 消费端要实时 per-connection 流量）。
    if (detailDemand)
      post({ type: 'detail', payload: { connections: snap.connections, at: snap.at } });
  }
  // 第 4 参 isWindowVisible 故意不传 → StatsService 恒物化 connections 帧喂上方回调；可见性/需求门控在 host+worker 侧。
);

parentPort.on('message', (e: Electron.MessageEvent) => {
  const msg = e.data as HostToWorkerMessage;
  switch (msg?.type) {
    case 'connect':
      // 切到最新端点（apiPort 每次启动可能重解析变化）：重建 client 后 resubscribe（停旧流句柄 → 按新 client 重订阅）。
      // 复位需求驱动态：connectionsStreamOn=true（新订阅默认活跃、可见时即有 aggregate，host 首个 status 帧按真实
      // 可见性校正）、detailDemand=false（待 host 下发）、lastSentSig=null + lastSentAt=0（强制首帧 aggregate 必发）。
      // 同时把 StatsService 的连接流开关复位 true（可能被上一需求周期关过），使 resubscribe 真的订阅 Connections。
      connectionsStreamOn = true;
      detailDemand = false;
      lastSentSig = null;
      lastSentAt = 0;
      apiClient = new SingBoxApiClient(
        { host: msg.endpoint.host, port: msg.endpoint.port, tls: msg.endpoint.tls },
        msg.endpoint.secret
      );
      stats.setConnectionsStreamEnabled(true);
      stats.resubscribe();
      break;
    case 'setDemand':
      // host 惰性下发的需求：detail 存标志（下帧起门控明细 post）；connectionsStream 变化时真正订阅/取消上游
      // SubscribeConnections（复用 StatsService.setConnectionsStreamEnabled，Status/stats 不受影响）。
      detailDemand = msg.detail;
      if (msg.connectionsStream !== connectionsStreamOn) {
        connectionsStreamOn = msg.connectionsStream;
        stats.setConnectionsStreamEnabled(connectionsStreamOn);
      }
      break;
    case 'stop':
      stats.stop();
      apiClient = null;
      break;
    case 'dispose':
      stats.stop();
      apiClient = null;
      process.exit(0);
      break;
  }
});

// 监听器已挂 → 握手通知 main 可安全下发 'connect'（避免 fork 后立即 post 被竞态吞掉）。
post({ type: 'ready' });
