/**
 * 日志广播批处理 + UI 门控单测（T1，issue #225）。覆盖 registerLogHandlers 的 coalescer 行为：
 *  1) 多条 'log' 在 ~150ms 窗口内合并为单次 EVENT_LOG_RECEIVED_BATCH（数组、顺序保持），非逐条广播。
 *  2) isUiActive 门控：不活跃（拖动/隐藏）时只暂存不广播；活跃后下一 tick 一次性 flush 全部暂存。
 *  3) 暂存上限 MAX_PENDING_LOG_BATCH=500：超限丢最旧、保最新（live tail 语义）。
 * 经 mock registerIpcHandler（LOGS_GET/CLEAR 桩）+ broadcastEvent（捕获广播）+ fake timers 驱动 flush。
 */
import { EventEmitter } from 'events';
import { IPC_CHANNELS } from '../../../../shared/ipc-channels';
import type { LogEntry } from '../../../../shared/types';

// LOGS_GET/LOGS_CLEAR 处理器注册桩（本测不关心，避免触达真实 IPC）。
jest.mock('../../ipc-handler', () => ({
  registerIpcHandler: jest.fn(),
}));
// 捕获广播：断言批次内容/次数。
jest.mock('../../ipc-events', () => ({
  broadcastEvent: jest.fn(),
}));

import { registerLogHandlers } from '../log-handlers';
import { broadcastEvent } from '../../ipc-events';

const mockBroadcast = broadcastEvent as jest.MockedFunction<typeof broadcastEvent>;

function entry(message: string): LogEntry {
  return { timestamp: '2026-06-30T00:00:00.000Z', level: 'info', message, source: 'test' };
}

/** 最小 LogManager 桩：仅需 on('log')（EventEmitter）。getLogs/clearLogs 不触达（registerIpcHandler 已 mock）。 */
function makeLogManager() {
  return new EventEmitter() as unknown as Parameters<typeof registerLogHandlers>[0];
}

describe('registerLogHandlers 日志批处理 (T1)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockBroadcast.mockClear();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('多条日志在一个 flush 窗口内合并为单次 BATCH 广播（顺序保持）', () => {
    const lm = makeLogManager();
    registerLogHandlers(lm, undefined, () => true);

    (lm as unknown as EventEmitter).emit('log', entry('a'));
    (lm as unknown as EventEmitter).emit('log', entry('b'));
    (lm as unknown as EventEmitter).emit('log', entry('c'));
    expect(mockBroadcast).not.toHaveBeenCalled(); // flush 前不广播

    jest.advanceTimersByTime(150);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    const [channel, batch] = mockBroadcast.mock.calls[0];
    expect(channel).toBe(IPC_CHANNELS.EVENT_LOG_RECEIVED_BATCH);
    expect((batch as LogEntry[]).map((e) => e.message)).toEqual(['a', 'b', 'c']);
  });

  it('空 pending 不广播', () => {
    const lm = makeLogManager();
    registerLogHandlers(lm, undefined, () => true);
    jest.advanceTimersByTime(600);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('isUiActive=false（拖动/隐藏）时只暂存不广播；恢复后一次性 flush 全部', () => {
    let active = false;
    const lm = makeLogManager();
    registerLogHandlers(lm, undefined, () => active);

    (lm as unknown as EventEmitter).emit('log', entry('x'));
    (lm as unknown as EventEmitter).emit('log', entry('y'));
    jest.advanceTimersByTime(450); // 多个 tick 都不活跃
    expect(mockBroadcast).not.toHaveBeenCalled();

    active = true;
    jest.advanceTimersByTime(150);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect((mockBroadcast.mock.calls[0][1] as LogEntry[]).map((e) => e.message)).toEqual([
      'x',
      'y',
    ]);
  });

  it('暂存超上限丢最旧保最新（live tail），上限 500', () => {
    let active = false;
    const lm = makeLogManager();
    registerLogHandlers(lm, undefined, () => active);
    // 不活跃期间灌 600 条 → 暂存超 500 上限，丢最旧 100 条（m0..m99），保最新 500（m100..m599）。
    for (let i = 0; i < 600; i++) {
      (lm as unknown as EventEmitter).emit('log', entry(`m${i}`));
    }
    active = true;
    jest.advanceTimersByTime(150);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    const batch = mockBroadcast.mock.calls[0][1] as LogEntry[];
    expect(batch).toHaveLength(500);
    expect(batch[0].message).toBe('m100'); // 最旧保留项 = 第 101 条
    expect(batch[batch.length - 1].message).toBe('m599'); // 最新
  });
});
