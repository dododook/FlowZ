/**
 * 自动换节点服务
 *
 * 职责边界（与崩溃恢复解耦）：
 * - 只负责「当前节点不可达」时换到更优节点。进程崩溃由主进程「原地重启同节点」兜底，
 *   不再触发换节点——崩溃多为瞬时/配置问题，换节点既不对症又会丢失用户选中节点。
 *
 * 工作机制：
 * 1. 心跳检测：每 30 秒做一次「应用层连通性检测」——经本地代理 HTTP 端口请求 generate_204，
 *    真实验证整条代理链是否通（优于裸 TCP Ping 节点地址：端口通不等于代理可用）。连续 3 次失败触发换节点。
 * 2. 换节点：对其他节点测延迟，选最优 → 优先经 clash_api 热切换（switchMode 内部 canHotSwitch，
 *    失败/不适用退回重启）→ 通知渲染进程。
 * 3. 熔断：连续切换达上限仍未恢复（多为整体网络问题，换节点无效）→ 暂停切换一段时间，避免在节点间空转。
 *
 * 注意：同一时刻只允许一个换节点操作在进行，防止并发切换。
 */

import * as net from 'net';
import * as http from 'http';
import { EventEmitter } from 'events';
import type { BrowserWindow } from 'electron';
import type { ConfigManager } from './ConfigManager';
import type { LogManager } from './LogManager';
import type { ProxyManager } from './ProxyManager';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { ProxyErrorCode } from '../../shared/types';
import { localProxyPort } from '../../shared/proxy-ports';

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 秒检测一次
const MAX_CONSECUTIVE_FAILURES = 3; // 连续 3 次失败触发换节点
const PING_TIMEOUT_MS = 4_000; // 单次 ping 超时 4 秒
const SWITCH_COOLDOWN_MS = 60_000; // 换节点冷却 60 秒，防止频繁切换
const CONNECTIVITY_TIMEOUT_MS = 5_000; // 应用层连通性检测超时
const MAX_AUTO_SWITCHES = 3; // 熔断阈值：连续切换 3 次仍未恢复则暂停
const BREAKER_COOLDOWN_MS = 10 * 60_000; // 熔断冷却 10 分钟后再放行一次重试
// 经代理请求的连通性探测端点（返回 204）：海外可达即证明代理链通；多个互为兜底
const CONNECTIVITY_URLS = [
  'http://cp.cloudflare.com/generate_204',
  'http://www.gstatic.com/generate_204',
];

export class AutoSwitchService extends EventEmitter {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private isSwitching = false;
  private lastSwitchTime = 0;
  private enabled = false;
  // 熔断状态：连续自动切换次数 + 熔断触发时刻
  private consecutiveSwitches = 0;
  private breakerTrippedAt = 0;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly proxyManager: ProxyManager,
    private readonly logManager: LogManager,
    private readonly getMainWindow: () => BrowserWindow | null
  ) {
    super();
  }

  // ─── 启用 / 禁用 ─────────────────────────────────────────────────────────

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.consecutiveFailures = 0;
    this.consecutiveSwitches = 0;
    this.breakerTrippedAt = 0;
    this.startHeartbeat();
    this.logManager.addLog('info', '自动换节点已启用（应用层连通性检测）', 'AutoSwitch');
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.stopHeartbeat();
    this.logManager.addLog('info', '自动换节点已禁用', 'AutoSwitch');
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ─── 心跳检测 ────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.runHeartbeat().catch((e) => {
        this.logManager.addLog('warn', `心跳检测异常: ${e}`, 'AutoSwitch');
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async runHeartbeat(): Promise<void> {
    if (!this.enabled || this.isSwitching) return;

    // 代理没在运行时不需要检测
    const status = this.proxyManager.getStatus();
    if (!status?.running) {
      this.consecutiveFailures = 0;
      return;
    }

    const config = await this.configManager.loadConfig().catch(() => null);
    if (!config?.selectedServerId) return;

    const server = config.servers.find((s) => s.id === config.selectedServerId);
    if (!server) return;

    // 应用层连通性检测：经本地 mixed 代理端口请求 generate_204，验证整条代理链而非裸 TCP 端口
    const httpPort = localProxyPort(config);
    const alive = await this.checkProxyConnectivity(httpPort);

    if (alive) {
      if (this.consecutiveFailures > 0) {
        this.logManager.addLog(
          'info',
          `连通性恢复正常（此前连续失败 ${this.consecutiveFailures} 次）`,
          'AutoSwitch'
        );
      }
      this.consecutiveFailures = 0;
      // 恢复联通即视为已稳定，复位熔断计数
      this.consecutiveSwitches = 0;
    } else {
      this.consecutiveFailures++;
      this.logManager.addLog(
        'warn',
        `连通性检测失败 [${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}]: 当前节点 ${server.name}`,
        'AutoSwitch'
      );

      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.consecutiveFailures = 0;
        await this.triggerSwitch('连通性检测');
      }
    }
  }

  // ─── 换节点逻辑 ──────────────────────────────────────────────────────────

  private async triggerSwitch(reason: string): Promise<void> {
    if (this.isSwitching) {
      this.logManager.addLog('info', '换节点操作已在进行中，跳过', 'AutoSwitch');
      return;
    }

    // 熔断检查：连续切换达上限仍未恢复 → 多为整体网络问题，换节点无效，暂停切换避免在节点间空转
    if (this.consecutiveSwitches >= MAX_AUTO_SWITCHES) {
      const sinceTrip = Date.now() - this.breakerTrippedAt;
      if (sinceTrip < BREAKER_COOLDOWN_MS) {
        this.logManager.addLog(
          'warn',
          `自动切换已熔断（连续 ${this.consecutiveSwitches} 次切换未恢复连通），` +
            `${Math.ceil((BREAKER_COOLDOWN_MS - sinceTrip) / 1000)}s 内暂停切换，请检查网络/订阅`,
          'AutoSwitch'
        );
        return;
      }
      // 冷却结束，复位熔断，放行一次重试
      this.consecutiveSwitches = 0;
    }

    // 冷却期检查
    const now = Date.now();
    if (now - this.lastSwitchTime < SWITCH_COOLDOWN_MS) {
      const remaining = Math.ceil((SWITCH_COOLDOWN_MS - (now - this.lastSwitchTime)) / 1000);
      this.logManager.addLog('info', `自动换节点冷却中，${remaining}s 后可再次触发`, 'AutoSwitch');
      return;
    }

    this.isSwitching = true;
    this.lastSwitchTime = now;

    try {
      const config = await this.configManager.loadConfig();
      const currentId = config.selectedServerId;

      // 过滤出其他可用节点（排除当前节点）
      const candidates = config.servers.filter((s) => s.id !== currentId);
      if (candidates.length === 0) {
        this.logManager.addLog('warn', '没有其他可用节点，无法自动切换', 'AutoSwitch');
        return;
      }

      this.logManager.addLog(
        'info',
        `[${reason}] 开始对 ${candidates.length} 个候选节点测速...`,
        'AutoSwitch'
      );

      // 并行对所有候选节点做 TCP Ping + 延迟测量
      const results = await Promise.all(
        candidates.map(async (server) => {
          const latency = await this.measureLatency(server.address, server.port);
          return { server, latency };
        })
      );

      // 过滤掉不可达的节点，按延迟排序
      const available = results
        .filter((r) => r.latency !== null)
        .sort((a, b) => (a.latency as number) - (b.latency as number));

      if (available.length === 0) {
        this.logManager.addLog('warn', '所有候选节点均不可达，无法自动切换', 'AutoSwitch');
        return;
      }

      const best = available[0];
      this.logManager.addLog(
        'info',
        `选中最优节点: ${best.server.name} (${best.latency}ms)`,
        'AutoSwitch'
      );

      // 切换配置（先落盘，保证 UI/重启都用新选中节点）
      const newConfig = { ...config, selectedServerId: best.server.id };
      await this.configManager.saveConfig(newConfig);

      // 优先经 clash_api 热切换（switchMode 内部 canHotSwitch，失败/不适用自动退回重启）
      await this.proxyManager.switchMode(newConfig);

      // 计入熔断窗口：连续切换达上限则触发熔断（由后续心跳恢复来复位）
      this.consecutiveSwitches++;
      if (this.consecutiveSwitches >= MAX_AUTO_SWITCHES) {
        this.breakerTrippedAt = Date.now();
      }

      this.logManager.addLog('info', `✅ 自动换节点成功: ${best.server.name}`, 'AutoSwitch');

      // 通知渲染进程
      const mainWindow = this.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.EVENT_AUTO_NODE_SWITCHED, {
          reason,
          newServerName: best.server.name,
          latency: best.latency,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 内核替换窗口期 switchMode 被 core-swap 门控瞬态拒绝（CORE_UPDATE_IN_PROGRESS），非真实失败，降级避免日志噪音
      if ((err as any)?.code === ProxyErrorCode.CORE_UPDATE_IN_PROGRESS) {
        this.logManager.addLog('debug', `自动换节点因内核更新中暂缓: ${msg}`, 'AutoSwitch');
      } else {
        this.logManager.addLog('error', `自动换节点失败: ${msg}`, 'AutoSwitch');
      }
    } finally {
      this.isSwitching = false;
    }
  }

  // ─── 工具方法 ────────────────────────────────────────────────────────────

  /**
   * 应用层连通性检测：经本地代理 HTTP 端口请求 generate_204 端点，任一端点返回 2xx/3xx 即判通。
   * 比裸 TCP Ping 节点地址更可靠——端口可达不代表代理握手/转发正常（鉴权失效、节点限流、TUN 回流等）。
   */
  private async checkProxyConnectivity(httpPort: number): Promise<boolean> {
    for (const url of CONNECTIVITY_URLS) {
      if (await this.probeThroughProxy(httpPort, url)) return true;
    }
    return false;
  }

  /**
   * 经 HTTP 代理（127.0.0.1:httpPort）以绝对 URI 形式请求目标，判断是否拿到响应。
   */
  private probeThroughProxy(httpPort: number, targetUrl: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: boolean) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      try {
        const u = new URL(targetUrl);
        const req = http.request(
          {
            host: '127.0.0.1',
            port: httpPort,
            method: 'GET',
            path: targetUrl, // 绝对 URI = HTTP 代理请求格式
            headers: { Host: u.host, 'Proxy-Connection': 'close' },
            timeout: CONNECTIVITY_TIMEOUT_MS,
          },
          (res) => {
            const code = res.statusCode ?? 0;
            res.resume(); // 丢弃响应体，释放 socket
            done(code >= 200 && code < 400);
          }
        );
        req.on('timeout', () => {
          req.destroy();
          done(false);
        });
        req.on('error', () => done(false));
        req.end();
      } catch {
        done(false);
      }
    });
  }

  /**
   * 测量延迟（毫秒）
   */
  private measureLatency(host: string, port: number): Promise<number | null> {
    return new Promise((resolve) => {
      const start = Date.now();
      const socket = new net.Socket();
      socket.setTimeout(PING_TIMEOUT_MS);
      socket.on('connect', () => {
        socket.destroy();
        resolve(Date.now() - start);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(null);
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve(null);
      });
      socket.connect(port, host);
    });
  }

  destroy(): void {
    this.disable();
  }
}
