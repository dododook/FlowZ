/**
 * 指数退避状态机（按 id 维度）。收口 RuleResourceScheduler / SubscriptionScheduler 中逐字相同的
 * `Map<id, { failures, nextEligibleAt }>` + `BASE * 2^(n-1)` capped MAX 退避逻辑。
 *
 * 纯逻辑、可单测；`now` 由调用方传入（不内部取时钟，便于测试与确定性）。
 */
export class BackoffTracker {
  private state = new Map<string, { failures: number; nextEligibleAt: number }>();

  constructor(
    private readonly baseMs: number,
    private readonly maxMs: number
  ) {}

  /** 是否到了可再次尝试的时刻（无记录=可以）。 */
  isEligible(id: string, now: number): boolean {
    const bo = this.state.get(id);
    return !bo || now >= bo.nextEligibleAt;
  }

  recordSuccess(id: string): void {
    this.state.delete(id);
  }

  recordFailure(id: string, now: number): { failures: number; delayMs: number } {
    const failures = (this.state.get(id)?.failures ?? 0) + 1;
    const delayMs = Math.min(this.baseMs * 2 ** (failures - 1), this.maxMs);
    this.state.set(id, { failures, nextEligibleAt: now + delayMs });
    return { failures, delayMs };
  }

  /** 剪除不在活跃集合内的陈旧键（订阅/资源被删后清理，防内存无界增长）。 */
  prune(activeIds: Set<string>): void {
    for (const id of this.state.keys()) if (!activeIds.has(id)) this.state.delete(id);
  }
}
