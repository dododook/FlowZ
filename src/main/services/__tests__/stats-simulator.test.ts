/**
 * StatsSimulator 单测（issue #242 §5 泄漏定证 harness）：
 *  1) parseStatsSimConfig：合法/非法/缺省/部分 → 防御式回退 + warn。
 *  2) churn 逻辑：池大小恒定、每 tick 换 K 条（最老出、新入）。
 *  3) 聚合：aggregate.total = 池大小。
 *  4) 门控：isUiActive=false → onStats/onAggregate 零调用（但快照缓存仍更新）。
 *  5) 生命周期：构造即启动 ticker；stop/resubscribe 不停 ticker；dispose 停 ticker。
 * 纯逻辑（aggregateConnections 是纯函数、无 electron 依赖），用 jest fake timers 驱动 ticker。
 */
import { StatsSimulator, parseStatsSimConfig, DEFAULT_STATS_SIM_CONFIG } from '../StatsSimulator';
import type { StatsWorkerHostOptions } from '../StatsWorkerHost';

function makeSim(rawConfig: string, active = true) {
  const onStats = jest.fn();
  const onAggregate = jest.fn();
  const logs: Array<{ level: string; message: string }> = [];
  const state = { active };
  const opts: StatsWorkerHostOptions = {
    workerPath: '/fake/stats-worker.js',
    onStats,
    onAggregate,
    // batch3 新增字段：合成器不产 detail、无 worker demand（onDetail/hasSubscribers 仅为满足 options 形状）。
    onDetail: jest.fn(),
    isUiActive: () => state.active,
    hasSubscribers: () => false,
    getEndpoint: () => null,
    log: (level, message) => logs.push({ level, message }),
  };
  const sim = new StatsSimulator(opts, rawConfig);
  return { sim, onStats, onAggregate, logs, state };
}

describe('parseStatsSimConfig', () => {
  it('合法 "1000,200,20" → 精确解析，不 warn', () => {
    const warn = jest.fn();
    expect(parseStatsSimConfig('1000,200,20', warn)).toEqual({
      intervalMs: 1000,
      connCount: 200,
      churnPerFrame: 20,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('合法非默认 "2000,50,5" → 精确解析', () => {
    expect(parseStatsSimConfig('2000,50,5')).toEqual({
      intervalMs: 2000,
      connCount: 50,
      churnPerFrame: 5,
    });
  });

  it('全非法 "abc" → 全回退缺省 + warn', () => {
    const warn = jest.fn();
    expect(parseStatsSimConfig('abc', warn)).toEqual(DEFAULT_STATS_SIM_CONFIG);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('部分非法 "1000,-5,20"（connCount ≤0）→ 仅该字段回退 + warn', () => {
    const warn = jest.fn();
    expect(parseStatsSimConfig('1000,-5,20', warn)).toEqual({
      intervalMs: 1000,
      connCount: DEFAULT_STATS_SIM_CONFIG.connCount,
      churnPerFrame: 20,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('connCount');
  });

  it('字段缺失 "500"（只有 intervalMs）→ 其余回退缺省 + warn', () => {
    const warn = jest.fn();
    expect(parseStatsSimConfig('500', warn)).toEqual({
      intervalMs: 500,
      connCount: DEFAULT_STATS_SIM_CONFIG.connCount,
      churnPerFrame: DEFAULT_STATS_SIM_CONFIG.churnPerFrame,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('空串 / undefined → 全缺省 + warn', () => {
    const warn = jest.fn();
    expect(parseStatsSimConfig('', warn)).toEqual(DEFAULT_STATS_SIM_CONFIG);
    expect(parseStatsSimConfig(undefined, warn)).toEqual(DEFAULT_STATS_SIM_CONFIG);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('非整数 "1000.5,200,20"（parseInt 截断为 1000）→ 合法', () => {
    // Number.parseInt('1000.5') = 1000（>0 合法），刻意接受（不追求严格整数校验，能跑即可）。
    expect(parseStatsSimConfig('1000.5,200,20').intervalMs).toBe(1000);
  });
});

describe('StatsSimulator 生命周期与激活 banner', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('构造即打「模拟器激活」warn banner', () => {
    const { logs } = makeSim('1000,200,20');
    const banner = logs.find((l) => l.level === 'warn' && l.message.includes('模拟器激活'));
    expect(banner).toBeDefined();
    expect(banner!.message).toContain('仅用于泄漏定证');
  });

  it('构造即启动 ticker：advance 一个 interval → onAggregate/onStats 各触发', () => {
    const { onStats, onAggregate } = makeSim('1000,200,20');
    expect(onStats).not.toHaveBeenCalled(); // 构造时不立即 tick
    jest.advanceTimersByTime(1000);
    expect(onAggregate).toHaveBeenCalledTimes(1);
    expect(onStats).toHaveBeenCalledTimes(1);
  });

  it('stop()/resubscribe() 只记日志、不停 ticker', () => {
    const { sim, onStats, logs } = makeSim('1000,200,20');
    sim.stop();
    sim.resubscribe();
    expect(logs.some((l) => l.message.includes('stop()'))).toBe(true);
    expect(logs.some((l) => l.message.includes('resubscribe()'))).toBe(true);
    jest.advanceTimersByTime(1000);
    expect(onStats).toHaveBeenCalledTimes(1); // ticker 仍在跑
  });

  it('dispose() 停 ticker：之后 advance 不再触发', () => {
    const { sim, onStats } = makeSim('1000,200,20');
    jest.advanceTimersByTime(1000);
    expect(onStats).toHaveBeenCalledTimes(1);
    sim.dispose();
    jest.advanceTimersByTime(5000);
    expect(onStats).toHaveBeenCalledTimes(1); // dispose 后不再 tick
  });
});

describe('StatsSimulator churn 与聚合', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('池大小恒定 = connCount；aggregate.total = 池大小', () => {
    const { sim } = makeSim('1000,50,10');
    expect(sim.getConnectionsSnapshot().connections).toHaveLength(50);
    expect(sim.getAggregateSnapshot().total).toBe(50);
    jest.advanceTimersByTime(3000); // 3 tick
    expect(sim.getConnectionsSnapshot().connections).toHaveLength(50);
    expect(sim.getAggregateSnapshot().total).toBe(50);
  });

  it('每 tick 换 churnPerFrame 条：最老 K 条出、K 条新入', () => {
    const { sim } = makeSim('1000,50,10');
    const before = sim.getConnectionsSnapshot().connections.map((c) => c.id);
    jest.advanceTimersByTime(1000); // 1 tick
    const after = sim.getConnectionsSnapshot().connections.map((c) => c.id);

    expect(after).toHaveLength(50);
    const removed = before.filter((id) => !after.includes(id));
    const added = after.filter((id) => !before.includes(id));
    expect(removed).toHaveLength(10);
    expect(added).toHaveLength(10);
    // 移除的正是最老的 10 条（数组头部）。
    expect(removed).toEqual(before.slice(0, 10));
  });

  it('churnPerFrame 被 clamp 到不超过 connCount', () => {
    const { sim } = makeSim('1000,5,100'); // churn 100 > connCount 5
    const before = sim.getConnectionsSnapshot().connections.map((c) => c.id);
    jest.advanceTimersByTime(1000);
    const after = sim.getConnectionsSnapshot().connections.map((c) => c.id);
    expect(after).toHaveLength(5);
    // clamp 到 5：整池换新，无重叠。
    expect(after.filter((id) => before.includes(id))).toHaveLength(0);
  });

  it('快照引用隔离：tick 替换新对象，旧快照条目字节不被改动，新快照差分为正', () => {
    // 固定 Math.random，使字节推进确定（upload +2048、download +8192），差分严格为正、可断言。
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const { sim } = makeSim('1000,50,10'); // churn 掐掉最老 10 条（索引 0..9），索引 10 起跨 tick 存活
      const snap1 = sim.getConnectionsSnapshot().connections;
      const survivor = snap1[10];
      const beforeUp = survivor.upload;
      const beforeDown = survivor.download;

      jest.advanceTimersByTime(1000); // 1 tick

      const snap2 = sim.getConnectionsSnapshot().connections;
      const after = snap2.find((c) => c.id === survivor.id);
      expect(after).toBeDefined(); // 确系跨 tick 存活条目

      // 引用隔离：snap1 持有的旧对象未被 tick 原地改动（in-place 变异会让此断言失败）。
      expect(survivor.upload).toBe(beforeUp);
      expect(survivor.download).toBe(beforeDown);
      // tick 替换而非原地变异：新旧快照的存活条目不是同一对象引用。
      expect(after).not.toBe(survivor);
      // 差分为正：新快照字节严格大于旧快照（消费端两次 pull 才能算出非零速率）。
      expect(after!.upload! + after!.download!).toBeGreaterThan(beforeUp! + beforeDown!);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('stats 速率随机游走恒在 [50KB, 500KB]；activeConnections = 池大小', () => {
    const { sim } = makeSim('1000,200,20');
    jest.advanceTimersByTime(5000); // 5 tick
    const s = sim.getSnapshot();
    expect(s.uploadSpeed).toBeGreaterThanOrEqual(50 * 1024);
    expect(s.uploadSpeed).toBeLessThanOrEqual(500 * 1024);
    expect(s.downloadSpeed).toBeGreaterThanOrEqual(50 * 1024);
    expect(s.downloadSpeed).toBeLessThanOrEqual(500 * 1024);
    expect(s.activeConnections).toBe(200);
    expect(s.totalUpload).toBeGreaterThan(0); // totals 累加
  });
});

describe('StatsSimulator UI 门控', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('isUiActive=false → onStats/onAggregate 零调用，但快照缓存仍更新', () => {
    const { sim, onStats, onAggregate } = makeSim('1000,50,10', false);
    jest.advanceTimersByTime(3000); // 3 tick
    expect(onStats).not.toHaveBeenCalled();
    expect(onAggregate).not.toHaveBeenCalled();
    // 门控只挡广播、不挡缓存：getters 反映最新池/速率。
    expect(sim.getAggregateSnapshot().total).toBe(50);
    expect(sim.getSnapshot().activeConnections).toBe(50);
  });

  it('转活跃后下一 tick 恢复广播', () => {
    const { onStats, state } = makeSim('1000,50,10', false);
    jest.advanceTimersByTime(2000);
    expect(onStats).not.toHaveBeenCalled();
    state.active = true;
    jest.advanceTimersByTime(1000);
    expect(onStats).toHaveBeenCalledTimes(1);
  });

  it('resume() 活跃时补推缓存最新；不活跃不推', () => {
    const { sim, onStats, onAggregate, state } = makeSim('1000,50,10', false);
    jest.advanceTimersByTime(1000);
    onStats.mockClear();
    onAggregate.mockClear();

    sim.resume(); // 不活跃 → 不推
    expect(onStats).not.toHaveBeenCalled();

    state.active = true;
    sim.resume(); // 活跃 → 补推缓存
    expect(onStats).toHaveBeenCalledTimes(1);
    expect(onAggregate).toHaveBeenCalledTimes(1);
  });
});
