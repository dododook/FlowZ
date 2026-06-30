/**
 * stats-worker —— Electron utilityProcess 入口（T4，issue #225）。
 *
 * 把 StatsService 的 Status/Connections gRPC 长流订阅 + 连接事件解析 + per-frame 物化从 main 进程移出，消除主线程
 * 事件循环争用（Windows 拖动 move modal loop 跑主线程，与 stats 处理抢线程 → 拖动卡顿 / 启动后迟缓）。
 *
 * 设计要点：
 * - StatsService 类**原样复用**（import 现有实现，逻辑不改 → 保 #210 长流重建 / #167 LRU eviction / 审计#3 OOM 上限
 *   / resubscribe 切端口 等全部不变量；存量单测继续护）。
 * - worker 持自己的 SingBoxApiClient（仅 stats，不传 onUpdate → 不订 Tailscale）；端点参数由 main 经 'connect' 下发。
 * - isWindowVisible **恒缺省**（undefined）→ worker 永远物化 + post；可见性/拖动门控统一在 main 侧 relay 完成
 *   （StatsWorkerHost.onWorkerMessage 按 uiActive 门控），worker 不感知窗口态。
 */
import { StatsService } from '../services/StatsService';
import { SingBoxApiClient } from '../services/singbox-api-client';
import type { HostToWorkerMessage, WorkerToHostMessage } from '../services/StatsWorkerHost';

// utilityProcess 子进程的父端口（Electron 在子进程 process 上注入）。
const parentPort = process.parentPort;

let apiClient: SingBoxApiClient | null = null;
// connActive（C，issue #225 review）：main 经 'setConnActive' 下发。false（UI 隐藏/拖动）时跳过把连接表克隆推给
// main（隐藏挂托盘 + 上千连接的主要浪费）。status 帧不门控、始终流动 → main 借其惰性同步本标志，无卡死风险。
// 默认 true：连上即推，待 main 首个 status 帧校正（最坏多推 ~1s 连接帧，无害）。
let connActive = true;

function post(msg: WorkerToHostMessage): void {
  parentPort.postMessage(msg);
}

// StatsService 实例常驻：'connect' 切 client + resubscribe，'stop' 停流。getApiClient 返回 worker 当前 client。
const stats = new StatsService(
  (s) => post({ type: 'stats', payload: s }), // status 不门控：始终流动，驱动 main 惰性同步 connActive
  () => apiClient,
  (snap) => {
    if (connActive) post({ type: 'connections', payload: snap }); // C：不活跃跳过连接表跨进程克隆
  }
  // 第 4 参 isWindowVisible 故意不传 → status 始终广播；connections 由 connActive 门控（上方）。
);

parentPort.on('message', (e: Electron.MessageEvent) => {
  const msg = e.data as HostToWorkerMessage;
  switch (msg?.type) {
    case 'connect':
      // 切到最新端点（apiPort 每次启动可能重解析变化）：重建 client 后 resubscribe（停旧流句柄 → 按新 client 重订阅）。
      // connActive 复位 true：新订阅默认活跃推连接，避免持久 worker 重连时残留的 stale-false 抑制连接帧；
      // host 的 postConnect 已重置同步态，会在首个 status 帧（≤1s）按真实可见性校正。
      connActive = true;
      apiClient = new SingBoxApiClient(
        { host: msg.endpoint.host, port: msg.endpoint.port, tls: msg.endpoint.tls },
        msg.endpoint.secret
      );
      stats.resubscribe();
      break;
    case 'setConnActive':
      connActive = msg.active; // C：门控 connections 跨进程 post（status 不受影响）
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
