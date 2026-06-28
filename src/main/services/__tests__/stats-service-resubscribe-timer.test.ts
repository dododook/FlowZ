/**
 * StatsService 长流周期重建单测（issue #210 根因 #3）。
 *
 * 验证 STREAM_RESUBSCRIBE_INTERVAL_MS 周期触发 resubscribe（停旧流句柄 + 重订阅），
 * 以及 start/stop 对 resubscribeTimer 的生命周期管理——避免长会话 gRPC 流对象长期驻留，
 * 且 stop 后无残留定时器泄漏（jest worker force-exited 警告的根因排查点）。
 */
import { StatsService } from '../StatsService';
import type { TrafficStats } from '../../../shared/types';
import type { SingBoxApiClient, SingBoxStatus } from '../singbox-api-client';

function makeMockClient() {
  let statusCb: ((s: SingBoxStatus) => void) | null = null;
  const calls = { subscribeStatus: 0 };
  const client = {
    subscribeStatus: jest.fn((_ns: number, cb: (s: SingBoxStatus) => void) => {
      calls.subscribeStatus++;
      statusCb = cb;
      return () => {
        statusCb = null;
      };
    }),
    subscribeConnections: jest.fn(() => () => {}),
  };
  return {
    client: client as unknown as SingBoxApiClient,
    calls,
    pushStatus: (s: SingBoxStatus) => statusCb?.(s),
  };
}

describe('StatsService 长流周期重建（issue #210 根因 #3）', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('start 启动周期重建定时器；到点触发 resubscribe（重订阅）', () => {
    const mock = makeMockClient();
    const onUpdate = jest.fn<void, [TrafficStats]>();
    const service = new StatsService(onUpdate, () => mock.client);

    service.start();
    // start 初次订阅
    expect(mock.calls.subscribeStatus).toBe(1);

    // 推进一个周期（STREAM_RESUBSCRIBE_INTERVAL_MS = 30min）→ resubscribe 再订阅一次
    const INTERVAL = 30 * 60 * 1000;
    jest.advanceTimersByTime(INTERVAL);
    expect(mock.calls.subscribeStatus).toBe(2);

    service.stop();
  });

  it('R2 假绿修复：生产入口 resubscribe() 也启动周期定时器（start() 在生产从不被调）', () => {
    // 生产代码（index.ts）仅 proxyManager.on('api-client-ready', () => resubscribe())，
    // 从不调 start()。若定时器只在 start() 启动 → 生产环境永不触发（issue #210 根因#3 失效）。
    const mock = makeMockClient();
    const onUpdate = jest.fn<void, [TrafficStats]>();
    const service = new StatsService(onUpdate, () => mock.client);

    // 模拟生产路径：只调 resubscribe()（不调 start）
    service.resubscribe();
    expect(mock.calls.subscribeStatus).toBe(1);

    // 推进一个周期 → 定时器应触发 resubscribeStreamsOnly（再订阅）
    jest.advanceTimersByTime(30 * 60 * 1000);
    expect(mock.calls.subscribeStatus).toBeGreaterThanOrEqual(2);

    service.stop();
  });

  it('R3 Nit-3：多次 resubscribe() 只持有一个定时器（幂等，推进一周期只多订阅一次）', () => {
    // startResubscribeTimer 首句 if(this.resubscribeTimer) return 保证幂等。连调多次 resubscribe 不应累积多个定时器，
    // 否则推进一周期会触发 N 次 resubscribeStreamsOnly。锁死该守卫防回归。
    const mock = makeMockClient();
    const onUpdate = jest.fn<void, [TrafficStats]>();
    const service = new StatsService(onUpdate, () => mock.client);

    service.resubscribe(); // subscribeStatus=1
    service.resubscribe(); // subscribeStatus=2（每次 resubscribe 重订阅）
    service.resubscribe(); // subscribeStatus=3
    expect(mock.calls.subscribeStatus).toBe(3);

    // 推进一个周期 → 若只有一个定时器，只再订阅 1 次（3→4）；若有多个定时器泄漏，会订阅多次
    jest.advanceTimersByTime(30 * 60 * 1000);
    expect(mock.calls.subscribeStatus).toBe(4);

    service.stop();
  });

  it('stop 清理周期重建定时器（无残留定时器泄漏）', () => {
    const mock = makeMockClient();
    const onUpdate = jest.fn<void, [TrafficStats]>();
    const service = new StatsService(onUpdate, () => mock.client);

    service.start();
    service.stop();

    // stop 后推进长时间，不应再触发 resubscribe（subscribeStatus 次数不再增加）
    const before = mock.calls.subscribeStatus;
    jest.advanceTimersByTime(2 * 30 * 60 * 1000);
    expect(mock.calls.subscribeStatus).toBe(before);
  });

  it('周期重建不归零 totals/快照（M4：避免首页每 30min 闪烁 0）', () => {
    const mock = makeMockClient();
    const onUpdate = jest.fn<void, [TrafficStats]>();
    const service = new StatsService(onUpdate, () => mock.client);

    service.start();
    // 推一帧真实流量，建立非零 totals 基线
    mock.pushStatus({
      uplink: '100',
      downlink: '200',
      uplinkTotal: '1000',
      downlinkTotal: '2000',
    });
    onUpdate.mockClear();

    // 触发周期重建（resubscribeStreamsOnly）：重订阅流但不归零 snapshot。
    jest.advanceTimersByTime(30 * 60 * 1000);

    // 周期重建本身不广播 snapshot（resubscribeStreamsOnly 不调 onUpdate）→ 此刻 onUpdate 未被周期重建调用。
    // 锁死契约：周期重建不得主动广播全 0（否则首页每 30min 闪烁）。R3 review Medium-1：原 for 循环遍历空数组
    // 是空壳断言（假绿），改为直接断言「周期重建未触发广播」——可触达、对任何实现都会真检验。
    expect(onUpdate).not.toHaveBeenCalled();

    // 周期重建后首帧到达：snapshot 仍是周期前的连续值（未被归零），首帧覆盖后广播非零 totals。
    // 这验证了「不归零」的最终效果：用户在重建窗口看到的是旧值，而非闪 0。
    mock.pushStatus({
      uplink: '100',
      downlink: '200',
      uplinkTotal: '1000',
      downlinkTotal: '2000',
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const lastSnap = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(lastSnap.totalUpload).toBe(1000);
    expect(lastSnap.totalDownload).toBe(2000);
    service.stop();
  });
});
