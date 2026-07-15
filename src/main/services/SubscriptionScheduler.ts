/**
 * 订阅自动更新调度器
 *
 * 职责：在不打断当前连接的前提下，按需自动刷新订阅节点。
 * - 启动补更：启动后延迟一段时间，对启用自动更新的订阅补一次更新（忽略陈旧阈值，仅守 10min 地板——
 *   开了「启动时更新」就应更新，而非"距上次≥间隔阈值才更"）。
 * - 周期巡检：每 30 分钟扫一遍，更新到期（陈旧）的订阅。
 * - 退避：单个订阅失败后指数退避（5min→…→上限 6h），避免对故障源高频重试。
 * - 不打断连接（默认）：restartOnNodeChange OFF 且选中节点未被下架时，只「落盘 + 通知 UI」、不重启代理——
 *   运行中的 sing-box 保持其内存配置，新节点进「待应用」差集、下次（重）启动/被选中/一键应用时生效。
 * - §2 例外两路（会重启）：①restartOnNodeChange ON=auto-apply 立即整核入新节点；②选中节点被自动刷新下架=
 *   正确性必须重选出口 + 重启逃离运行核死节点（恒重启不受开关影响）。配合 reconcile 保留 id/选中节点，连接零中断。
 * - 经代理开关：全局三态策略 subscriptionProxyPolicy（follow=按 per-sub updateViaProxy / proxy=全强制经代理 /
 *   direct=全强制直连）作用于各订阅；经代理订阅若代理未运行则只跳过该订阅（冷启动鸡生蛋），挂起待代理就绪
 *   （onProxyStarted）补更，直连订阅照常更新。
 */

import type { ConfigManager } from './ConfigManager';
import type { LogManager } from './LogManager';
import { SubscriptionService } from './SubscriptionService';
import type { UserConfig } from '../../shared/types';
import { resolveSubscriptionViaProxy } from '../../shared/subscription-proxy';
import { DIRECT_SERVER_ID, isDirectSelection } from '../../shared/direct-selection';
import { pickViableFallbackExit } from '../../shared/fallback-exit';
import { referencedServerIds } from '../../shared/endpoint-routes';
import { BackoffTracker } from './backoff-tracker';

export class SubscriptionScheduler {
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private isRunning = false; // 防重入（巡检与启动补更不并发）
  // 每订阅退避状态：累计失败次数 + 下次可尝试时刻
  private backoff = new BackoffTracker(
    SubscriptionScheduler.BACKOFF_BASE_MS,
    SubscriptionScheduler.BACKOFF_MAX_MS
  );
  private pendingProxyCatchup = false; // 经代理订阅因代理未起被跳过的挂起标记（启动补更与周期巡检轮均可置位），待代理就绪 onProxyStarted 补跑
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
    private readonly notifyConfigChanged: (config: UserConfig) => void,
    // §2 待应用差集：自动刷新的 auto-apply / F14 强制重启入口（= proxyManager.applyConfigForcingRestart）。
    // 默认路径（restartOnNodeChange OFF 且选中节点未下架）仍只 saveConfig+通知、不重启（守「不打断连接」）。
    private readonly applyConfigForcingRestart: (config: UserConfig) => void
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
      this.backoff.prune(subIds);
      if (subs.length === 0) return;

      // per-sub 经代理：求值移进下方循环（每订阅 = 全局策略 subscriptionProxyPolicy 作用于该订阅 updateViaProxy）。
      // 先乐观清挂起，循环内遇「经代理但代理未起」的订阅再置 true——只跳过这些，直连订阅照常更新（鸡生蛋仅卡经代理项）。
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
        // §16.3.4：条件 GET 结果——notModified 时跳过 reconcile（仅刷元数据）；validators 回写供下次条件 GET。
        etag?: string;
        lastModified?: string;
        hasProviders?: boolean;
        notModified?: boolean;
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
        if (!this.backoff.isEligible(sub.id, now)) continue;

        // per-sub 经代理且代理未起：跳过该订阅，挂起待代理就绪后补更（直连订阅不受影响）。
        // getProxyRunning 现取（非循环前快照）：代理在本轮拉取直连订阅期间就绪时，后续经代理订阅同轮即拉、不必等下个周期 tick。
        const subViaProxy = resolveSubscriptionViaProxy(
          config.subscriptionProxyPolicy,
          sub.updateViaProxy
        );
        if (subViaProxy && !this.getProxyRunning()) {
          this.pendingProxyCatchup = true;
          this.logManager.addLog(
            'info',
            `订阅「${sub.name}」经代理更新但代理未运行，本轮跳过（待代理就绪后自动补更）`,
            'SubScheduler'
          );
          continue;
        }

        try {
          // §16.3.4：条件 GET——provider 型订阅豁免；否则带上次 validator（304 → notModified 短路）。
          const conditional = sub.hasProviders
            ? undefined
            : { etag: sub.etag, lastModified: sub.lastModified };
          const result = await this.subscriptionService.fetchSubscription(
            sub.url,
            sub.id,
            subViaProxy,
            sub.userAgent ?? config.subscriptionUserAgent,
            conditional
          );
          fetched.push({
            subId: sub.id,
            name: sub.name,
            servers: result.servers,
            userInfo: result.userInfo,
            partial: result.partial,
            failedProviders: result.failedProviders,
            etag: result.etag,
            lastModified: result.lastModified,
            hasProviders: result.hasProviders,
            notModified: result.notModified,
          });
          this.backoff.recordSuccess(sub.id);
        } catch (e: any) {
          failed++;
          const { failures, delayMs } = this.backoff.recordFailure(sub.id, now);
          this.logManager.addLog(
            'warn',
            `[${reason}] 订阅 [${sub.name}] 更新失败(第 ${failures} 次)，${Math.round(delayMs / 60_000)} 分钟后重试: ${e?.message ?? e}`,
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
      // F-A：仅「真实节点增/删/改」置位——304 / 内容等价的 200 不置。ON 开关据此只在真变更时 auto-apply，
      //   不在无变化的周期刷新空转重启（否则 ON 用户每个订阅更新间隔无谓断流一次）。
      let nodesChanged = false;
      // §2 矩阵 line 88「改/删被引用节点恒立即重启」（扩 F14）：被引用节点=选中/规则目标/detour链/
      //   endpoint（referencedServerIds 单一真值，与 canSkip 同口径）。循环前后各取一次引用集（refOld/refNext），
      //   任一被引用节点被本轮刷新增/删/改 → 运行核路由陈旧 → 恒重启对齐（不受开关，同手动路径 canSkip）。判据：
      //   删=不在最终 servers；增=新 id（不在 oldIds）；改=updatedAt===nowIso（reconcile 对内容变节点写本轮时间戳）。
      const refOld = referencedServerIds(fresh); // 循环前 fresh=旧 config
      const oldIds = new Set(fresh.servers.map((s) => s.id));
      // F14 逃死节点：仅当被下架的是「选中」节点才 reselect 存活出口（规则目标等被引用节点下架无需 reselect，
      //   重启后 generate 阶段处理悬空目标）。
      const selId =
        fresh.selectedServerId && !isDirectSelection(fresh.selectedServerId)
          ? fresh.selectedServerId
          : null;
      for (const f of fetched) {
        const sub = fresh.subscriptions?.find((x) => x.id === f.subId);
        if (!sub) continue; // 订阅在此期间被删除 → 跳过
        // §16.3.4：304 无变化 → 仅刷元数据（lastUpdated + validators），不 reconcile（零节点扰动、绝不误删）。
        if (f.notModified) {
          sub.lastUpdated = nowIso;
          if (f.etag) sub.etag = f.etag;
          if (f.lastModified) sub.lastModified = f.lastModified;
          updated++;
          continue;
        }
        const oldServers = fresh.servers.filter((s) => s.subscriptionId === f.subId);
        const {
          servers: kept,
          deletedIds,
          contentChanged,
        } = SubscriptionService.reconcileServers(oldServers, f.servers, nowIso);
        // L-5：200 但内容等价（contentChanged=false，非 partial）→ 仅刷元数据 + validators，不替换 servers（避免顺序 churn）。
        if (!contentChanged && !f.partial) {
          sub.lastUpdated = nowIso;
          if (f.userInfo) sub.userInfo = f.userInfo;
          sub.etag = f.etag;
          sub.lastModified = f.lastModified;
          sub.hasProviders = f.hasProviders;
          updated++;
          continue;
        }
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
        const others = fresh.servers.filter((s) => s.subscriptionId !== f.subId);
        fresh.servers = [...others, ...finalKept];
        sub.lastUpdated = nowIso;
        if (f.userInfo) sub.userInfo = f.userInfo;
        // §16.3.4：回写验证器 + hasProviders（下次条件 GET / provider 豁免）。自动路径**不 force-restart**（§16.3.4b③ 不变量）。
        // L-3：200 路径无条件写 etag/lastModified（含清除），服务端撤 validator 后不残留旧值致伪 304。
        sub.etag = f.etag;
        sub.lastModified = f.lastModified;
        sub.hasProviders = f.hasProviders;
        nodesChanged = true; // 走到 merge 路径 = contentChanged 或 partial → 真实节点变更
        updated++;
      }

      if (updated > 0) {
        const liveIds = new Set(fresh.servers.map((s) => s.id));
        // §2 矩阵 line 88：任一被引用节点（refOld∪refNext，覆盖被删节点的旧引用 + 新增/改后的新引用）被本轮刷新
        //   增/删/改 → 运行核路由陈旧 → 恒重启对齐（同手动路径 canSkip 口径，不受开关）。
        const refNext = referencedServerIds(fresh); // 循环后 fresh=新 config（selectedServerId 仍=原 selId，reselect 在下方）
        let referencedAffected = false;
        for (const id of new Set([...refOld, ...refNext])) {
          const node = fresh.servers.find((s) => s.id === id);
          if (!node || !oldIds.has(id) || node.updatedAt === nowIso) {
            referencedAffected = true; // 删（!node）/ 增（新 id）/ 改（本轮时间戳）
            break;
          }
        }
        // F14：被下架的若是「选中」节点 → reselect 存活出口逃死节点（pickFallbackExit：无 latency 取首个候选，空则 direct）。
        const selectedDelisted = !!selId && !liveIds.has(selId);
        if (selectedDelisted) {
          // 候选须过可用性谓词（排 subnet-only 组网节点，防静默直连，#291）；空则 DIRECT 哨兵。
          fresh.selectedServerId =
            pickViableFallbackExit(fresh.servers.filter((s) => liveIds.has(s.id))) ??
            DIRECT_SERVER_ID;
        }
        // 落盘 + 通知 UI（渲染端/托盘刷新 + 差集重算）。
        await this.configManager.saveConfig(fresh);
        this.notifyConfigChanged(fresh);
        // 变更源分流（§2 矩阵）：①被引用节点被增/删/改 = 正确性恒重启（不受开关）；②restartOnNodeChange ON 且**真有
        //   节点变更**（nodesChanged，非 304/内容等价空转）= auto-apply 全量入核。默认（OFF 且被引用节点未受影响）只落盘、
        //   新增未引用节点进「待应用」差集守「不打断连接」。applyConfigForcingRestart 内部 guard 代理未运行/换核窗口 + 单飞去抖。
        if (referencedAffected || (fresh.restartOnNodeChange === true && nodesChanged)) {
          this.applyConfigForcingRestart(fresh);
        }
        this.logManager.addLog(
          'info',
          `[${reason}] 订阅自动更新完成：成功 ${updated}，失败 ${failed}` +
            (selectedDelisted
              ? '（选中节点已下架，重选出口并重启）'
              : referencedAffected
                ? '（被引用节点变更，重启对齐）'
                : ''),
          'SubScheduler'
        );
      }
    } finally {
      this.isRunning = false;
    }
  }
}
