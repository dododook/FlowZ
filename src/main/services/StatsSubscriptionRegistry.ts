/**
 * StatsSubscriptionRegistry —— stats 数据面订阅表（batch3 §3.7，推翻-1/-3 收口）。
 *
 * 背景：batch2 把 worker demand 收敛成 setDemand，但 demand 的**源**仍是「窗口可见」（isUiActive）——非首页可见视图
 * （设置页）下拓扑流仍在跑（Mac 真机 0.47Hz）。batch3 把源换成 renderer 按 topic 精确声明的订阅：无订阅者 → 逐级停机。
 *
 * 职责（收口三处各自订阅 + GET/event 双路径）：
 *  - 维护 topic → 订阅 wc 集；订阅即回初始帧（合并原 CONNECTIONS_AGGREGATE_GET/CONNECTIONS_GET 初值 pull）。
 *  - 订阅集变化驱动 host.syncDemand（订阅瞬间即让 worker 开流，免等下个 status 帧）。
 *  - relay 只发给对应 topic 的订阅者（broadcast）——StatsWorkerHost 的 onStats/onAggregate/onDetail 经此落地。
 *  - wc destroyed（renderer 崩溃/重载）自动清其全部 topic，防订阅泄漏。
 *
 * 纯逻辑、无运行期 electron 依赖（仅 type-only import WebContents）：wc 用最小 mock（{id,send,once,isDestroyed}）单测。
 */
import type { WebContents } from 'electron';
import { STATS_TOPIC_EVENT, type StatsTopic } from '../../shared/ipc-channels';

/** 全部 topic（集合初始化 + 遍历清理用）。 */
const TOPICS: readonly StatsTopic[] = ['stats', 'aggregate', 'detail'];

export interface StatsSubscriptionRegistryOptions {
  /**
   * 取某 topic 当前缓存帧（订阅即回初始帧）：来源 = StatsWorkerHost 的
   * getSnapshot/getAggregateSnapshot/getConnectionsSnapshot。
   */
  getInitialFrame: (topic: StatsTopic) => unknown;
  /**
   * 订阅集变化后驱动 host 重算 demand（可选：simulator 无 worker demand 时传 no-op / 省略）。订阅/退订/destroyed
   * 清理后调用，让 worker 尽快开/停对应上游流，不必等下一个 status 帧的惰性 syncDemand。
   */
  onDemandChange?: () => void;
}

export class StatsSubscriptionRegistry {
  /** topic → 订阅 wc.id 集（成员真值；§3.7 状态模型 Map<Topic, Set<number>>）。 */
  private readonly topics: Map<StatsTopic, Set<number>> = new Map(
    TOPICS.map((t) => [t, new Set<number>()])
  );
  /** id → wc：subscribersOf / 初始帧 / broadcast 发送用（Set<number> 之外的解析表）。 */
  private readonly wcs: Map<number, WebContents> = new Map();
  /** 已挂 destroyed 清理监听的 wc id：防同 wc 多 topic 订阅重复挂监听。 */
  private readonly destroyHooked: Set<number> = new Set();

  constructor(private readonly opts: StatsSubscriptionRegistryOptions) {}

  /**
   * 订阅某 topic：加入订阅集 + 挂一次性 destroyed 清理 + **即回初始帧**（合并原 GET 初值路径）+ 驱动 demand 重算。
   * 已 destroyed 的 wc / 未知 topic 一律忽略（IPC 边界防御）。
   */
  subscribe(wc: WebContents, topic: StatsTopic): void {
    const set = this.topics.get(topic);
    if (!set || wc.isDestroyed()) return;
    this.wcs.set(wc.id, wc);
    set.add(wc.id);
    // 一次性 destroyed 清理：renderer 崩溃/重载 → 清其全部 topic（防订阅泄漏累积）。已挂过不重复挂。
    if (!this.destroyHooked.has(wc.id)) {
      this.destroyHooked.add(wc.id);
      wc.once('destroyed', () => this.removeAll(wc.id));
    }
    // 订阅即回初始帧（第一个事件即当前缓存帧，取代 CONNECTIONS_AGGREGATE_GET/CONNECTIONS_GET 的初值 pull）。
    this.sendFrame(wc, topic, this.opts.getInitialFrame(topic));
    this.opts.onDemandChange?.();
  }

  /** 退订某 topic（unmount / 窗口隐藏 / 连接页暂停）。真发生退订才驱动 demand 重算。 */
  unsubscribe(wc: WebContents, topic: StatsTopic): void {
    const set = this.topics.get(topic);
    if (!set) return;
    if (set.delete(wc.id)) {
      this.pruneWc(wc.id);
      this.opts.onDemandChange?.();
    }
  }

  /** 该 topic 是否有存活订阅者（供 host.syncDemand 派生 worker demand）。过滤已 destroyed（监听未及触发的兜底）。 */
  hasSubscribers(topic: StatsTopic): boolean {
    return this.subscribersOf(topic).length > 0;
  }

  /** 某 topic 的存活订阅 wc（relay 用；过滤 destroyed，不改集合——destroyed 监听负责清）。 */
  subscribersOf(topic: StatsTopic): WebContents[] {
    const set = this.topics.get(topic);
    if (!set) return [];
    const out: WebContents[] = [];
    for (const id of set) {
      const wc = this.wcs.get(id);
      if (wc && !wc.isDestroyed()) out.push(wc);
    }
    return out;
  }

  /** relay：把某 topic 的帧发给其全部存活订阅者（初始帧 + 增量共用同一通道）。 */
  broadcast(topic: StatsTopic, data: unknown): void {
    for (const wc of this.subscribersOf(topic)) {
      this.sendFrame(wc, topic, data);
    }
  }

  /** 单 wc 单 topic 发送（初始帧 / broadcast 共用）；send 竞态（发送瞬间被销毁）吞掉。 */
  private sendFrame(wc: WebContents, topic: StatsTopic, data: unknown): void {
    if (wc.isDestroyed()) return;
    try {
      wc.send(STATS_TOPIC_EVENT[topic], data);
    } catch {
      /* wc 在 isDestroyed 检查与 send 之间被销毁：忽略（destroyed 监听会清订阅） */
    }
  }

  /** wc destroyed：清其全部 topic 订阅 + 引用；有实际清除才驱动 demand 重算。 */
  private removeAll(id: number): void {
    let changed = false;
    for (const set of this.topics.values()) changed = set.delete(id) || changed;
    this.wcs.delete(id);
    this.destroyHooked.delete(id);
    if (changed) this.opts.onDemandChange?.();
  }

  /** 退订后：该 wc 若已无任何 topic 订阅 → 清 wc 引用（destroyed 监听保留到真 destroyed，无害幂等）。 */
  private pruneWc(id: number): void {
    for (const set of this.topics.values()) if (set.has(id)) return;
    this.wcs.delete(id);
  }
}
