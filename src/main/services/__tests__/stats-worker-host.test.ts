/**
 * StatsWorkerHost 单测（T4，issue #225；batch3 §3.7 订阅驱动数据面，issue #242）。覆盖 main 侧宿主逻辑（worker 由
 * mock electron.utilityProcess 替身）：
 *  1) 构造即 fork worker；resubscribe 下发最新端点 connect / 端点为 null 下发 stop。
 *  2) worker 数据消息（聚合下沉 worker）：'aggregate'/'detail'/'stats' 缓存 + 按 isUiActive 门控 relay（detail
 *     batch3 由 pull 改 push topic，缓存 + relay）。host 不再自算聚合。
 *  3) demand 由**订阅集**派生（batch3 取代 batch2 的 isUiActive/lastPullAt）：connectionsStream=aggregate||detail、
 *     detail=detail，变化才 post；registry 订阅变化经 host.syncDemand() 即时触发 + status 帧惰性重发（reconnect 自愈）。
 *  4) resume 补推缓存最新（stats+aggregate+detail，活跃才推）；stop 不门控清零直推（含 detail）；停后在途旧帧经 started 丢弃。
 *  5) getSnapshot/getConnectionsSnapshot/getAggregateSnapshot 读缓存；'ready' 握手 / 崩溃 respawn / dispose 生命周期。
 */
import type {
  TrafficStats,
  ConnectionsSnapshot,
  ConnectionsAggregate,
} from '../../../shared/types';

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
import type { StatsTopic } from '../../../shared/ipc-channels';

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
  connections: [
    { id: 'c1', chains: ['proxy'], rule: '', rulePayload: '', metadata: { host: 'a.com' } },
  ],
  at: 123,
};
// worker 直接 post 聚合（聚合下沉 worker），host 只缓存/relay。此固定值等于 aggregateConnections(SAMPLE_CONNS)。
const SAMPLE_AGG: ConnectionsAggregate = {
  total: 1,
  hosts: [{ name: 'a.com', count: 1, flows: [{ outbound: 'proxy', count: 1 }] }],
  outbounds: [{ name: 'proxy', count: 1 }],
  at: 123,
};

function makeHost() {
  const onStats = jest.fn();
  const onAggregate = jest.fn();
  const onDetail = jest.fn();
  const state = { active: true, endpoint: ENDPOINT as StatsApiEndpoint | null };
  // 订阅集（batch3 demand 源）：测试直接拨动，模拟 registry 订阅态；host.hasSubscribers 读它。
  const subs: Record<StatsTopic, boolean> = { stats: false, aggregate: false, detail: false };
  const host = new StatsWorkerHost({
    workerPath: '/fake/stats-worker.js',
    onStats,
    onAggregate,
    onDetail,
    isUiActive: () => state.active,
    hasSubscribers: (topic) => subs[topic],
    getEndpoint: () => state.endpoint,
  });
  return { host, onStats, onAggregate, onDetail, state, subs };
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

  it('aggregate 消息门控（聚合下沉 worker）：不活跃只缓存不广播，活跃广播', () => {
    const { onAggregate, host, state } = makeHost();
    host.resubscribe(); // started=true
    state.active = false;
    lastWorker().emit('message', { type: 'aggregate', payload: SAMPLE_AGG });
    expect(onAggregate).not.toHaveBeenCalled(); // 不活跃不广播
    expect(host.getAggregateSnapshot()).toEqual(SAMPLE_AGG); // host 只缓存 worker 聚合，不再自算

    state.active = true;
    lastWorker().emit('message', { type: 'aggregate', payload: SAMPLE_AGG });
    expect(onAggregate).toHaveBeenCalledWith(SAMPLE_AGG); // 活跃 → relay 拓扑
  });

  it('detail 消息缓存 + 按可见性门控 relay 给 detail 订阅者（batch3：pull 改 push topic）', () => {
    const { onDetail, host, state } = makeHost();
    host.resubscribe(); // started=true
    state.active = false;
    lastWorker().emit('message', { type: 'detail', payload: SAMPLE_CONNS });
    expect(onDetail).not.toHaveBeenCalled(); // 不可见 → 只缓存不 relay（安全门）
    expect(host.getConnectionsSnapshot().connections).toEqual(SAMPLE_CONNS.connections); // 缓存供初始帧

    state.active = true;
    lastWorker().emit('message', { type: 'detail', payload: SAMPLE_CONNS });
    expect(onDetail).toHaveBeenCalledWith(SAMPLE_CONNS); // 可见 → relay 给连接页
  });

  it('resume 活跃时补推缓存最新（stats+aggregate+detail）；不活跃不推', () => {
    const { onStats, onAggregate, onDetail, host, state } = makeHost();
    host.resubscribe(); // started=true
    state.active = false;
    lastWorker().emit('message', { type: 'stats', payload: SAMPLE_STATS });
    lastWorker().emit('message', { type: 'aggregate', payload: SAMPLE_AGG });
    lastWorker().emit('message', { type: 'detail', payload: SAMPLE_CONNS });
    onStats.mockClear();
    onAggregate.mockClear();
    onDetail.mockClear();

    host.resume(); // 仍不活跃 → 不推
    expect(onStats).not.toHaveBeenCalled();

    state.active = true;
    host.resume(); // 活跃 → 补推缓存（stats + 聚合 + 明细）
    expect(onStats).toHaveBeenCalledWith(SAMPLE_STATS);
    expect(onAggregate).toHaveBeenCalledWith(SAMPLE_AGG);
    expect(onDetail).toHaveBeenCalledWith(SAMPLE_CONNS);
  });

  it('stop 不门控、清零直推（含 detail）', () => {
    const { onStats, onAggregate, onDetail, host, state } = makeHost();
    host.resubscribe(); // started=true，下面的帧进缓存
    lastWorker().emit('message', { type: 'stats', payload: SAMPLE_STATS });
    lastWorker().emit('message', { type: 'detail', payload: SAMPLE_CONNS });
    expect(host.getSnapshot().activeConnections).toBe(3); // 缓存确为非零
    onStats.mockClear();
    onAggregate.mockClear();
    onDetail.mockClear();
    state.active = false; // 即便不活跃，stop 仍直推清零

    host.stop();
    expect(onStats).toHaveBeenCalledWith(
      expect.objectContaining({ uploadSpeed: 0, downloadSpeed: 0, activeConnections: 0 })
    );
    expect(onAggregate).toHaveBeenCalledWith(expect.objectContaining({ total: 0, hosts: [] }));
    expect(onDetail).toHaveBeenCalledWith(expect.objectContaining({ connections: [] })); // 连接页清空
    expect(host.getSnapshot().activeConnections).toBe(0);
    expect(host.getConnectionsSnapshot().connections).toEqual([]);
  });

  // Medium-A 回归：stop 后 worker 在途旧帧（stop 消息送达前 post 的非零帧）必须被 started 门控丢弃，
  // 否则缓存被旧值覆盖 + 广播残留非零，违反 stop「停止即清零」。
  it('stop 后 worker 在途旧帧被丢弃（!started 门控，不广播不覆盖缓存）', () => {
    const { onStats, onDetail, host } = makeHost();
    host.resubscribe(); // started=true
    lastWorker().emit('message', { type: 'stats', payload: SAMPLE_STATS });
    expect(host.getSnapshot()).toEqual(SAMPLE_STATS);

    host.stop(); // started=false + 清零直推
    onStats.mockClear();
    onDetail.mockClear();
    lastWorker().emit('message', { type: 'stats', payload: SAMPLE_STATS }); // 在途旧帧
    lastWorker().emit('message', { type: 'aggregate', payload: SAMPLE_AGG });
    lastWorker().emit('message', { type: 'detail', payload: SAMPLE_CONNS });
    expect(onStats).not.toHaveBeenCalled();
    expect(onDetail).not.toHaveBeenCalled(); // 在途 detail 亦被丢弃
    expect(host.getSnapshot().activeConnections).toBe(0); // 缓存仍为 stop 的零值
    expect(host.getConnectionsSnapshot().connections).toEqual([]);
    expect(host.getAggregateSnapshot().total).toBe(0); // 聚合缓存亦为 stop 的零值（在途 aggregate 被丢弃）
  });
});

describe('StatsWorkerHost demand 由订阅集派生 (batch3 §3.7)', () => {
  it('connectionsStream=aggregate||detail、detail=detail，变化才 post；syncDemand 即时触发', () => {
    const { host, subs } = makeHost();
    host.resubscribe();
    const w = lastWorker();
    w.postMessage.mockClear();

    // 无订阅 → 首个 status 帧下发 {stream:false, detail:false}（lastDemandSent=null 强制首发）
    w.emit('message', { type: 'stats', payload: SAMPLE_STATS });
    expect(w.postMessage).toHaveBeenCalledWith({
      type: 'setDemand',
      connectionsStream: false,
      detail: false,
    });
    w.postMessage.mockClear();

    // aggregate 订阅出现 → registry 经 host.syncDemand() 即时触发 → {stream:true, detail:false}
    subs.aggregate = true;
    host.syncDemand();
    expect(w.postMessage).toHaveBeenCalledWith({
      type: 'setDemand',
      connectionsStream: true,
      detail: false,
    });
    w.postMessage.mockClear();

    // detail 订阅出现 → {stream:true, detail:true}
    subs.detail = true;
    host.syncDemand();
    expect(w.postMessage).toHaveBeenCalledWith({
      type: 'setDemand',
      connectionsStream: true,
      detail: true,
    });
    w.postMessage.mockClear();

    // 需求未变 → status 帧不重复下发
    w.emit('message', { type: 'stats', payload: SAMPLE_STATS });
    expect(w.postMessage).not.toHaveBeenCalled();

    // aggregate 退订但 detail 仍在 → stream 由 detail 撑着，{true,true} 未变 → 不 post
    subs.aggregate = false;
    host.syncDemand();
    expect(w.postMessage).not.toHaveBeenCalled();

    // detail 也退订 → {stream:false, detail:false}
    subs.detail = false;
    host.syncDemand();
    expect(w.postMessage).toHaveBeenCalledWith({
      type: 'setDemand',
      connectionsStream: false,
      detail: false,
    });
  });

  it('reconnect 后重置需求态，借下个 status 帧按当前订阅重发 setDemand（自愈）', () => {
    const { host, subs } = makeHost();
    subs.aggregate = true;
    host.resubscribe();
    const w = lastWorker();
    w.emit('message', { type: 'stats', payload: SAMPLE_STATS }); // 已下发 {true,false}
    w.postMessage.mockClear();

    host.resubscribe(); // reconnect → postConnect 重置 lastDemandSent=null
    w.emit('message', { type: 'stats', payload: SAMPLE_STATS });
    expect(w.postMessage).toHaveBeenCalledWith({
      type: 'setDemand',
      connectionsStream: true,
      detail: false,
    }); // 按当前订阅（aggregate=true）重发
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
