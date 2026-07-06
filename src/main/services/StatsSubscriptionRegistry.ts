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
  /**
   * topic → (wc.id → 引用计数)。为什么用计数而非 Set：同一窗口内两个组件（如首页两个订同一 topic 的视图）会各自
   * subscribe/unsubscribe 同一 (wc, topic)。Set 去重只存一份成员，任一组件 unsubscribe 即 delete 整个 wc → 另一个
   * 仍挂载的组件被误断流。改为按 (wc, topic) 计数：subscribe 时 count++，unsubscribe 时 count--，仅计数归 0 才真正
   * 移除 wc.id 并驱动 demand 重算。对外语义（hasSubscribers/subscribersOf 按 wc 去重）不变。
   */
  private readonly topics: Map<StatsTopic, Map<number, number>> = new Map(
    TOPICS.map((t) => [t, new Map<number, number>()])
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
    const counts = this.topics.get(topic);
    if (!counts || wc.isDestroyed()) return;
    this.wcs.set(wc.id, wc);
    // 引用计数++（同 wc 对同一 topic 的每次订阅各计一份，供两组件独立退订）。
    counts.set(wc.id, (counts.get(wc.id) ?? 0) + 1);
    // 一次性 destroyed 清理：renderer 崩溃/重载 → 清其全部 topic（防订阅泄漏累积）。已挂过不重复挂。
    if (!this.destroyHooked.has(wc.id)) {
      this.destroyHooked.add(wc.id);
      wc.once('destroyed', () => this.removeAll(wc.id));
    }
    // 订阅即回初始帧（第一个事件即当前缓存帧，取代 CONNECTIONS_AGGREGATE_GET/CONNECTIONS_GET 的初值 pull）。
    this.sendFrame(wc, topic, this.opts.getInitialFrame(topic));
    this.opts.onDemandChange?.();
  }

  /** 退订某 topic（unmount / 窗口隐藏 / 连接页暂停）。计数-- 后仅归 0（最后一个组件退订）才真断流 + 驱动 demand 重算。 */
  unsubscribe(wc: WebContents, topic: StatsTopic): void {
    const counts = this.topics.get(topic);
    if (!counts) return;
    const cur = counts.get(wc.id);
    if (cur === undefined) return; // 未订阅：幂等，不驱动 demand
    if (cur > 1) {
      // 仍有其他组件订阅该 (wc, topic)：仅递减计数，不断流、不驱动 demand（防同窗口双组件任一退订即整窗断流）。
      counts.set(wc.id, cur - 1);
      return;
    }
    // 最后一个订阅退订 → 真正移除 wc.id 并驱动 demand 重算。
    counts.delete(wc.id);
    this.pruneWc(wc.id);
    this.opts.onDemandChange?.();
  }

  /** 该 topic 是否有存活订阅者（供 host.syncDemand 派生 worker demand）。过滤已 destroyed（监听未及触发的兜底）。 */
  hasSubscribers(topic: StatsTopic): boolean {
    return this.subscribersOf(topic).length > 0;
  }

  /** 某 topic 的存活订阅 wc（relay 用；过滤 destroyed，不改集合——destroyed 监听负责清）。按 wc 去重（引用计数不放大 relay 目标）。 */
  subscribersOf(topic: StatsTopic): WebContents[] {
    const counts = this.topics.get(topic);
    if (!counts) return [];
    const out: WebContents[] = [];
    for (const id of counts.keys()) {
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

  /** wc destroyed：无视引用计数清其全部 topic 订阅 + 引用（renderer 已亡，残留计数无意义）；有实际清除才驱动 demand 重算。 */
  private removeAll(id: number): void {
    let changed = false;
    for (const counts of this.topics.values()) changed = counts.delete(id) || changed;
    this.wcs.delete(id);
    this.destroyHooked.delete(id);
    if (changed) this.opts.onDemandChange?.();
  }

  /** 退订后：该 wc 若已无任何 topic 订阅 → 清 wc 引用（destroyed 监听保留到真 destroyed，无害幂等）。 */
  private pruneWc(id: number): void {
    for (const counts of this.topics.values()) if (counts.has(id)) return;
    this.wcs.delete(id);
  }
}
