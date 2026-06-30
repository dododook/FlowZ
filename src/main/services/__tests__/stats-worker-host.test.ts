/**
 * StatsWorkerHost 单测（T4，issue #225）。覆盖 main 侧宿主逻辑（worker 由 mock electron.utilityProcess 替身）：
 *  1) 构造即 fork worker；resubscribe 下发最新端点 connect / 端点为 null 下发 stop。
 *  2) worker 数据消息：缓存 + 按 isUiActive 门控广播（不活跃只缓存不 onStats/onAggregate；connections 经 host
 *     侧聚合后 relay 聚合给拓扑，明细只缓存供 pull，issue #227）。
 *  3) resume 补推缓存最新（活跃才推）；stop 不门控清零广播。
 *  4) getSnapshot/getConnectionsSnapshot/getAggregateSnapshot 读缓存。
 *  5) 'ready' 握手 / 崩溃 exit → 退避 respawn + 自动重连；dispose 终止不再 respawn。
 */
import type { TrafficStats, ConnectionsSnapshot } from '../../../shared/types';

// mock electron：utilityProcess.fork 返回 EventEmitter 替身（postMessage/kill 为 jest.fn）。
jest.mock('electron', () => {
  const { EventEmitter } = require('events');
  // 工厂内用 any 规避「值当类型」（EventEmitter 是 require 来的运行期值）；外部用 FakeWorker 类型断言。
  const forkedWorkers: any[] = [];
  const fork = jest.fn(() => {
    const w: any = new EventEmitter();
    w.postMessage = jest.fn();
    w.kill = jest.fn();
    forkedWorkers.push(w);
    return w;
  });
  return {
    utilityProcess: { fork },
    __getForkedWorkers: () => forkedWorkers,
    __reset: () => {
      forkedWorkers.length = 0;
      fork.mockClear();
    },
  };
});

import { StatsWorkerHost, type StatsApiEndpoint } from '../StatsWorkerHost';

const electron = require('electron');
type FakeWorker = import('events').EventEmitter & { postMessage: jest.Mock; kill: jest.Mock };
const workers = (): FakeWorker[] => electron.__getForkedWorkers();
const lastWorker = (): FakeWorker => workers()[workers().length - 1];

const ENDPOINT: StatsApiEndpoint = { host: '127.0.0.1', port: 9090, secret: 'sec' };
const SAMPLE_STATS: TrafficStats = {
  uploadSpeed: 10,
  downloadSpeed: 20,
  totalUpload: 100,
  totalDownload: 200,
  activeConnections: 3,
};
const SAMPLE_CONNS: ConnectionsSnapshot = {
  // 带 host + chain：使 host 侧聚合产出非空 hosts（覆盖 getAggregateSnapshot 实路径，issue #227 review Nit）。
  connections: [
    { id: 'c1', chains: ['proxy'], rule: '', rulePayload: '', metadata: { host: 'a.com' } },
  ],
  at: 123,
};

function makeHost() {
  const onStats = jest.fn();
  const onAggregate = jest.fn();
  const state = { active: true, endpoint: ENDPOINT as StatsApiEndpoint | null };
  const host = new StatsWorkerHost({
    workerPath: '/fake/stats-worker.js',
    onStats,
    onAggregate,
    isUiActive: () => state.active,
    getEndpoint: () => state.endpoint,
  });
  return { host, onStats, onAggregate, state };
}

beforeEach(() => electron.__reset());

describe('StatsWorkerHost 控制面 (T4)', () => {
  it('构造即 fork worker', () => {
    makeHost();
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(1);
    expect(workers()).toHaveLength(1);
  });

  it('resubscribe 下发最新端点 connect', () => {
    const { host } = makeHost();
    host.resubscribe();
    expect(lastWorker().postMessage).toHaveBeenCalledWith({ type: 'connect', endpoint: ENDPOINT });
  });

  it('resubscribe 端点为 null（核未起）→ 下发 stop', () => {
    const { host, state } = makeHost();
    state.endpoint = null;
    host.resubscribe();
    expect(lastWorker().postMessage).toHaveBeenCalledWith({ type: 'stop' });
  });
});

describe('StatsWorkerHost 数据面门控 (T4)', () => {
  it('活跃时 stats 消息缓存 + 广播', () => {
    const { onStats, host } = makeHost();
    host.resubscribe(); // started=true（生产中帧只在 connect 后才来）
    lastWorker().emit('message', { type: 'stats', payload: SAMPLE_STATS });
    expect(onStats).toHaveBeenCalledWith(SAMPLE_STATS);
    expect(host.getSnapshot()).toEqual(SAMPLE_STATS);
  });

  it('不活跃时 stats 消息只缓存不广播', () => {
    const { onStats, host, state } = makeHost();
    host.resubscribe(); // started=true
    state.active = false;
    lastWorker().emit('message', { type: 'stats', payload: SAMPLE_STATS });
    expect(onStats).not.toHaveBeenCalled();
    expect(host.getSnapshot()).toEqual(SAMPLE_STATS); // 缓存仍更新
  });

  it('connections 消息门控 + host 聚合（明细缓存供 pull、聚合供拓扑，issue #227）', () => {
    const { onAggregate, host, state } = makeHost();
    host.resubscribe(); // started=true
    state.active = false;
    lastWorker().emit('message', { type: 'connections', payload: SAMPLE_CONNS });
    expect(onAggregate).not.toHaveBeenCalled(); // 不活跃不广播
    // 明细缓存（连接页 CONNECTIONS_GET pull）+ host 已 O(N) 聚合（拓扑 CONNECTIONS_AGGREGATE_GET 回填）
    expect(host.getConnectionsSnapshot().connections).toEqual(SAMPLE_CONNS.connections);
    expect(host.getAggregateSnapshot().total).toBe(1);
    expect(host.getAggregateSnapshot().hosts.map((h) => h.name)).toEqual(['a.com']); // 聚合产出 host 节点
  });

  it('resume 活跃时补推缓存最新；不活跃不推', () => {
    const { onStats, onAggregate, host, state } = makeHost();
    host.resubscribe(); // started=true
    state.active = false;
    lastWorker().emit('message', { type: 'stats', payload: SAMPLE_STATS });
    lastWorker().emit('message', { type: 'connections', payload: SAMPLE_CONNS });
    onStats.mockClear();
    onAggregate.mockClear();

    host.resume(); // 仍不活跃 → 不推
    expect(onStats).not.toHaveBeenCalled();

    state.active = true;
    host.resume(); // 活跃 → 补推缓存（stats + 聚合）
    expect(onStats).toHaveBeenCalledWith(SAMPLE_STATS);
    expect(onAggregate).toHaveBeenCalledWith(expect.objectContaining({ total: 1 }));
  });

  it('stop 不门控、清零广播', () => {
    const { onStats, onAggregate, host, state } = makeHost();
    host.resubscribe(); // started=true，下面的帧进缓存
    lastWorker().emit('message', { type: 'stats', payload: SAMPLE_STATS });
    expect(host.getSnapshot().activeConnections).toBe(3); // 缓存确为非零
    onStats.mockClear();
    onAggregate.mockClear();
    state.active = false; // 即便不活跃，stop 仍广播清零

    host.stop();
    expect(onStats).toHaveBeenCalledWith(
      expect.objectContaining({ uploadSpeed: 0, downloadSpeed: 0, activeConnections: 0 })
    );
    expect(onAggregate).toHaveBeenCalledWith(expect.objectContaining({ total: 0, hosts: [] }));
    expect(host.getSnapshot().activeConnections).toBe(0);
  });

  // Medium-A 回归：stop 后 worker 在途旧帧（stop 消息送达前 post 的非零帧）必须被 started 门控丢弃，
  // 否则缓存被旧值覆盖 + 广播残留非零，违反 stop「停止即清零」。
  it('stop 后 worker 在途旧帧被丢弃（!started 门控，不广播不覆盖缓存）', () => {
    const { onStats, host } = makeHost();
    host.resubscribe(); // started=true
    lastWorker().emit('message', { type: 'stats', payload: SAMPLE_STATS });
    expect(host.getSnapshot()).toEqual(SAMPLE_STATS);

    host.stop(); // started=false + 清零
    onStats.mockClear();
    lastWorker().emit('message', { type: 'stats', payload: SAMPLE_STATS }); // 在途旧帧
    lastWorker().emit('message', { type: 'connections', payload: SAMPLE_CONNS });
    expect(onStats).not.toHaveBeenCalled();
    expect(host.getSnapshot().activeConnections).toBe(0); // 缓存仍为 stop 的零值
    expect(host.getConnectionsSnapshot().connections).toEqual([]);
  });
});

describe('StatsWorkerHost connActive 惰性同步 (C)', () => {
  it('isUiActive 变化时经 status 帧下发 setConnActive，未变化不重复下发', () => {
    const { host, state } = makeHost();
    host.resubscribe();
    const w = lastWorker();
    w.postMessage.mockClear();

    // 首个 status 帧（active=true，lastSent=null）→ 下发 setConnActive(true)
    w.emit('message', { type: 'stats', payload: SAMPLE_STATS });
    expect(w.postMessage).toHaveBeenCalledWith({ type: 'setConnActive', active: true });
    w.postMessage.mockClear();

    // 再来 status 帧、active 未变 → 不重复下发
    w.emit('message', { type: 'stats', payload: SAMPLE_STATS });
    expect(w.postMessage).not.toHaveBeenCalledWith({ type: 'setConnActive', active: true });

    // 转不活跃（隐藏/拖动）→ 下个 status 帧下发 setConnActive(false)
    state.active = false;
    w.emit('message', { type: 'stats', payload: SAMPLE_STATS });
    expect(w.postMessage).toHaveBeenCalledWith({ type: 'setConnActive', active: false });
  });

  it('reconnect 后重置同步态，强制下个 status 帧重新下发 setConnActive', () => {
    const { host } = makeHost();
    host.resubscribe();
    const w = lastWorker();
    w.emit('message', { type: 'stats', payload: SAMPLE_STATS }); // 已下发 setConnActive(true)
    w.postMessage.mockClear();

    host.resubscribe(); // reconnect → postConnect 重置 lastConnActiveSent=null
    w.emit('message', { type: 'stats', payload: SAMPLE_STATS });
    expect(w.postMessage).toHaveBeenCalledWith({ type: 'setConnActive', active: true }); // 重新下发
  });
});

describe('StatsWorkerHost 生命周期 (T4)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("'ready' 握手在 started 后补连 connect", () => {
    const { host } = makeHost();
    host.resubscribe(); // started=true，已发一次 connect
    lastWorker().postMessage.mockClear();
    lastWorker().emit('message', { type: 'ready' });
    expect(lastWorker().postMessage).toHaveBeenCalledWith({ type: 'connect', endpoint: ENDPOINT });
  });

  it('worker 崩溃 exit → 退避 respawn，新 worker ready 后自动重连', () => {
    const { host } = makeHost();
    host.resubscribe(); // started=true
    expect(workers()).toHaveLength(1);

    lastWorker().emit('exit', 1); // 崩溃
    jest.advanceTimersByTime(500); // 首次退避 500ms
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(2); // 已 respawn
    expect(workers()).toHaveLength(2);

    lastWorker().emit('message', { type: 'ready' }); // 新 worker 就绪
    expect(lastWorker().postMessage).toHaveBeenCalledWith({ type: 'connect', endpoint: ENDPOINT });
  });

  // Medium-B 回归：退避只该被「证明健康（发过 ready）」的 worker 重置；boot-即崩 worker 退避须持续增长。
  it('boot-即崩 worker（从不 ready）退避指数增长，不卡在 500ms', () => {
    makeHost();
    lastWorker().emit('exit', 1); // 第 1 次崩（从未 ready）
    jest.advanceTimersByTime(500);
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(2); // 首次退避 500ms

    lastWorker().emit('exit', 1); // 第 2 次崩
    jest.advanceTimersByTime(500); // 退避已升到 1000ms，500ms 不够
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(2); // 未 respawn
    jest.advanceTimersByTime(500); // 累计 1000ms
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(3); // 现在才 respawn
  });

  // 强化版：先连续 boot-crash 把退避涨到 2000ms，再 ready 验回落 500ms——这样删掉 'ready' 里的重置即会 fail，
  // 真正护住 B（旧版只崩一次、初始退避本就 500ms，删重置也通过、抓不到回归）。
  it('worker 发过 ready（证明健康）后再崩，退避从涨高值重置回 500ms', () => {
    const { host } = makeHost();
    host.resubscribe();
    // 连续 boot-crash：退避 500→1000→2000
    lastWorker().emit('exit', 1);
    jest.advanceTimersByTime(500); // fork #2，退避→1000
    lastWorker().emit('exit', 1);
    jest.advanceTimersByTime(1000); // fork #3，退避→2000
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(3);

    // 健康握手 → 退避应重置 500；随后崩，500ms 即应 respawn（若未重置则退避=2000，500ms 不够 → fail）
    lastWorker().emit('message', { type: 'ready' });
    lastWorker().emit('exit', 1);
    jest.advanceTimersByTime(500);
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(4);
  });

  it('dispose 终止 worker 且不再 respawn', () => {
    const { host } = makeHost();
    host.dispose();
    expect(lastWorker().postMessage).toHaveBeenCalledWith({ type: 'dispose' });
    expect(lastWorker().kill).toHaveBeenCalled();

    // dispose 后再 exit 不应 respawn。
    const forkCountBefore = electron.utilityProcess.fork.mock.calls.length;
    lastWorker().emit('exit', 0);
    jest.advanceTimersByTime(10000);
    expect(electron.utilityProcess.fork.mock.calls.length).toBe(forkCountBefore);
  });
});
