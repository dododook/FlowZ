/**
 * 订阅自动更新调度器
 *
 * 职责：在不打断当前连接的前提下，按需自动刷新订阅节点。
 * - 启动补更：启动后延迟一段时间，对启用自动更新的订阅补一次更新（忽略陈旧阈值，仅守 10min 地板——
 *   开了「启动时更新」就应更新，而非"距上次≥间隔阈值才更"）。
 * - 周期巡检：每 30 分钟扫一遍，更新到期（陈旧）的订阅。
 * - 退避：单个订阅失败后指数退避（5min→…→上限 6h），避免对故障源高频重试。
 * - 不打断连接：只「落盘 + 通知 UI」，绝不重启代理——运行中的 sing-box 保持其内存配置，
 *   节点增删仅在下次（重）启动或热切换时生效。配合 reconcile 保留 id/选中节点，连接零中断。
 * - 经代理开关：viaProxy 时若代理未运行则本轮跳过（冷启动鸡生蛋），挂起待代理就绪（onProxyStarted）补更。
 */

import type { ConfigManager } from './ConfigManager';
import type { LogManager } from './LogManager';
import { SubscriptionService } from './SubscriptionService';
import type { UserConfig } from '../../shared/types';
import { localProxyPort } from '../../shared/proxy-ports';

export class SubscriptionScheduler {
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private isRunning = false; // 防重入（巡检与启动补更不并发）
  // 每订阅退避状态：累计失败次数 + 下次可尝试时刻
  private backoff = new Map<string, { failures: number; nextEligibleAt: number }>();
  private pendingProxyCatchup = false; // viaProxy 但代理未起时跳过的「启动补更」挂起标记，待代理就绪补跑
  private startupTimer: ReturnType<typeof setTimeout> | null = null; // 启动补更句柄（stop 时清，防 8s 内 stop→start 武装双补更）

  private static readonly TICK_MS = 30 * 60_000; // 30 分钟巡检一次
  private static readonly STARTUP_DELAY_MS = 8_000; // 启动延迟，避开启动高峰
  private static readonly BACKOFF_BASE_MS = 5 * 60_000; // 退避基数 5 分钟
  private static readonly BACKOFF_MAX_MS = 6 * 60 * 60_000; // 退避上限 6 小时
  private static readonly DEFAULT_INTERVAL_HOURS = 12;
  // 启动 / 代理就绪补更免陈旧门时的最小间隔地板：防频繁重启把订阅源打爆
  private static readonly STARTUP_MIN_GAP_MS = 10 * 60_000;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly subscriptionService: SubscriptionService,
    private readonly logManager: LogManager,
    private readonly getProxyRunning: () => boolean,
    private readonly notifyConfigChanged: (config: UserConfig) => void
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      // 启动补更忽略陈旧阈值：开了「启动时更新」就应更新，而非"距上次≥12h才更"（仅守 10min 地板）
      this.runDueUpdates('启动补更', { ignoreStaleness: true }).catch((e) => {
        this.logManager.addLog('warn', `订阅启动补更异常: ${e}`, 'SubScheduler');
      });
    }, SubscriptionScheduler.STARTUP_DELAY_MS);

    this.tickTimer = setInterval(() => {
      this.runDueUpdates('周期更新').catch((e) => {
        this.logManager.addLog('warn', `订阅周期更新异常: ${e}`, 'SubScheduler');
      });
    }, SubscriptionScheduler.TICK_MS);
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.started = false;
  }

  /** 代理就绪：补跑因 viaProxy + 代理未起而跳过的「启动补更」（忽略陈旧门，仅守 10min 地板）。 */
  onProxyStarted(): void {
    // isRunning 时不清 flag：已有更新在途，保留挂起标记待后续触发，避免补更被静默吞掉
    if (!this.pendingProxyCatchup || this.isRunning) return;
    this.pendingProxyCatchup = false;
    this.runDueUpdates('代理就绪补更', { ignoreStaleness: true }).catch((e) => {
      this.logManager.addLog('warn', `代理就绪补更异常: ${e}`, 'SubScheduler');
    });
  }

  private intervalMs(config: UserConfig): number {
    const h = config.subscriptionUpdateIntervalHours;
    const hours = typeof h === 'number' && h > 0 ? h : SubscriptionScheduler.DEFAULT_INTERVAL_HOURS;
    return hours * 3_600_000;
  }

  private async runDueUpdates(reason: string, opts?: { ignoreStaleness?: boolean }): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const config = await this.configManager.loadConfig();
      if (!config.autoUpdateSubscriptionOnStart) return; // 总开关未开
      const subs = config.subscriptions || [];
      // 清理已删除订阅的退避条目（仅内存，防无界增长）
      const subIds = new Set(subs.map((s) => s.id));
      for (const id of this.backoff.keys()) if (!subIds.has(id)) this.backoff.delete(id);
      if (subs.length === 0) return;

      const viaProxy = config.subscriptionUpdateViaProxy === true;
      // viaProxy 但代理未运行：冷启动鸡生蛋，本轮跳过，挂起待代理就绪后补跑（onProxyStarted）
      if (viaProxy && !this.getProxyRunning()) {
        this.pendingProxyCatchup = true;
        this.logManager.addLog(
          'info',
          '订阅更新经代理但代理未运行，本轮跳过（待代理就绪后自动补更）',
          'SubScheduler'
        );
        return;
      }
      // 走到这里本轮会真正巡检更新 → 任何挂起的代理就绪补更已被本轮覆盖，清除挂起标记（周期 tick 亦消费之）
      this.pendingProxyCatchup = false;

      const now = Date.now();
      const intervalMs = this.intervalMs(config);
      let failed = 0;

      // 阶段 1：仅做网络拉取（不触碰 config），收集到期订阅的抓取结果
      const fetched: Array<{
        subId: string;
        name: string;
        servers: typeof config.servers;
        userInfo: (typeof subs)[number]['userInfo'];
        partial?: boolean;
        failedProviders?: string[];
      }> = [];
      for (const sub of subs) {
        if (!sub.autoUpdate) continue;

        // 陈旧判断：从未更新或已超过间隔阈值；启动/代理就绪补更（ignoreStaleness）改为仅守 10min 地板
        const last = sub.lastUpdated ? Date.parse(sub.lastUpdated) : 0;
        const stale = opts?.ignoreStaleness
          ? !last || now - last >= SubscriptionScheduler.STARTUP_MIN_GAP_MS
          : !last || now - last >= intervalMs;
        if (!stale) continue;

        // 退避判断：失败源未到下次可尝试时刻则跳过
        const bo = this.backoff.get(sub.id);
        if (bo && now < bo.nextEligibleAt) continue;

        try {
          const result = await this.subscriptionService.fetchSubscription(
            sub.url,
            sub.id,
            viaProxy,
            localProxyPort(config),
            sub.userAgent ?? config.subscriptionUserAgent
          );
          fetched.push({
            subId: sub.id,
            name: sub.name,
            servers: result.servers,
            userInfo: result.userInfo,
            partial: result.partial,
            failedProviders: result.failedProviders,
          });
          this.backoff.delete(sub.id);
        } catch (e: any) {
          failed++;
          const failures = (this.backoff.get(sub.id)?.failures ?? 0) + 1;
          const delay = Math.min(
            SubscriptionScheduler.BACKOFF_BASE_MS * 2 ** (failures - 1),
            SubscriptionScheduler.BACKOFF_MAX_MS
          );
          this.backoff.set(sub.id, { failures, nextEligibleAt: now + delay });
          this.logManager.addLog(
            'warn',
            `[${reason}] 订阅 [${sub.name}] 更新失败(第 ${failures} 次)，${Math.round(delay / 60_000)} 分钟后重试: ${e?.message ?? e}`,
            'SubScheduler'
          );
        }
      }

      if (fetched.length === 0) return;

      // 阶段 2：重载最新 config，逐订阅对账并合并，单次落盘。
      // 关键：reconcile 针对「重载后的最新 servers」做，且只替换该订阅自己的节点 —— 期间渲染端对
      // 自建节点/其它订阅/其它设置的写入不会被本次后台更新覆盖（缩小读改写丢更新窗口）。
      const fresh = await this.configManager.loadConfig();
      const nowIso = new Date().toISOString();
      let updated = 0;
      for (const f of fetched) {
        const sub = fresh.subscriptions?.find((x) => x.id === f.subId);
        if (!sub) continue; // 订阅在此期间被删除 → 跳过
        const oldServers = fresh.servers.filter((s) => s.subscriptionId === f.subId);
        const { servers: kept, deletedIds } = SubscriptionService.reconcileServers(
          oldServers,
          f.servers,
          nowIso
        );
        // partial（Clash provider 部分失败）→ merge-only：M1 provider 级精确——只保留失败 provider 名下的
        // 下架节点，成功 provider 的真下架正常删除。
        let finalKept = kept;
        if (f.partial && deletedIds.size > 0) {
          const leftover = SubscriptionService.leftoverToKeep(
            oldServers,
            deletedIds,
            f.failedProviders
          );
          finalKept = [...kept, ...leftover];
        }
        // selectedServerId 被删且未被 leftover 保留 → 清空
        if (
          fresh.selectedServerId &&
          deletedIds.has(fresh.selectedServerId) &&
          !finalKept.some((s) => s.id === fresh.selectedServerId)
        ) {
          fresh.selectedServerId = null;
        }
        const others = fresh.servers.filter((s) => s.subscriptionId !== f.subId);
        fresh.servers = [...others, ...finalKept];
        sub.lastUpdated = nowIso;
        if (f.userInfo) sub.userInfo = f.userInfo;
        updated++;
      }

      if (updated > 0) {
        // 仅落盘 + 通知 UI，绝不重启代理 → 不打断当前连接
        await this.configManager.saveConfig(fresh);
        this.notifyConfigChanged(fresh);
        this.logManager.addLog(
          'info',
          `[${reason}] 订阅自动更新完成：成功 ${updated}，失败 ${failed}`,
          'SubScheduler'
        );
      }
    } finally {
      this.isRunning = false;
    }
  }
}
