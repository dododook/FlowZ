/**
 * createStatsTopicSubscription 单测（batch3 §3.7）：useStatsTopic 的纯订阅内核（无 React/DOM/ipcClient，node 可测）。
 * 覆盖 attach 先挂监听再订阅（保初始帧不丢的顺序约束）、帧路由、幂等、detach 退监听+退订、detach 后重 attach 重订。
 */
import { createStatsTopicSubscription, type StatsTopicIpc } from '../use-stats-topic-core';
import { IPC_CHANNELS, STATS_TOPIC_EVENT } from '../../../shared/ipc-channels';

function makeIpc() {
  const unlisten = jest.fn();
  const listeners: Array<(d: unknown) => void> = [];
  const on = jest.fn((_channel: string, listener: (d: unknown) => void) => {
    listeners.push(listener);
    return unlisten;
  });
  const invoke = jest.fn().mockResolvedValue(undefined);
  const ipc: StatsTopicIpc = { invoke, on };
  return { ipc, on, invoke, unlisten, listeners };
}

describe('createStatsTopicSubscription', () => {
  it('attach：先挂 EVENT 监听再 invoke STATS_SUBSCRIBE（顺序保初始帧不丢）', () => {
    const { ipc, on, invoke } = makeIpc();
    const sub = createStatsTopicSubscription('aggregate', jest.fn(), ipc);
    sub.attach();
    expect(on).toHaveBeenCalledWith(STATS_TOPIC_EVENT.aggregate, expect.any(Function));
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.STATS_SUBSCRIBE, { topic: 'aggregate' });
    // on 先于 invoke（监听须先就位，否则 main.subscribe 同步 send 的初始帧丢失）
    expect(on.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0]);
    expect(sub.isAttached()).toBe(true);
  });

  it('帧经监听路由到 onFrame', () => {
    const { ipc, listeners } = makeIpc();
    const onFrame = jest.fn();
    const sub = createStatsTopicSubscription<{ total: number }>('aggregate', onFrame, ipc);
    sub.attach();
    listeners[0]({ total: 7 });
    expect(onFrame).toHaveBeenCalledWith({ total: 7 });
  });

  it('attach 幂等：已订阅重复 attach 不重复挂监听/订阅', () => {
    const { ipc, on, invoke } = makeIpc();
    const sub = createStatsTopicSubscription('detail', jest.fn(), ipc);
    sub.attach();
    sub.attach();
    expect(on).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('detach：退监听 + invoke STATS_UNSUBSCRIBE；幂等', () => {
    const { ipc, unlisten, invoke } = makeIpc();
    const sub = createStatsTopicSubscription('detail', jest.fn(), ipc);
    sub.attach();
    invoke.mockClear();
    sub.detach();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.STATS_UNSUBSCRIBE, { topic: 'detail' });
    expect(sub.isAttached()).toBe(false);

    invoke.mockClear();
    sub.detach(); // 幂等：未订阅再 detach 不 invoke
    expect(invoke).not.toHaveBeenCalled();
  });

  it('detach 后重 attach：重新挂监听 + 重新订阅（重订拿新初始帧路径）', () => {
    const { ipc, on, invoke } = makeIpc();
    const sub = createStatsTopicSubscription('aggregate', jest.fn(), ipc);
    sub.attach();
    sub.detach();
    sub.attach();
    expect(on).toHaveBeenCalledTimes(2); // 两次挂监听
    const subscribeCalls = invoke.mock.calls.filter((c) => c[0] === IPC_CHANNELS.STATS_SUBSCRIBE);
    expect(subscribeCalls).toHaveLength(2); // 两次订阅
  });
});
