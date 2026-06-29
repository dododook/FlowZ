/**
 * LogManager 背压单测（issue #210 根因 #1）。
 *
 * 验证 MAX_PENDING_WRITES 兜底两阶段：
 *  1) 积压：写盘跟不上时 pendingWrites 不超上限，内存缓冲 + UI 仍保留（背压丢弃落盘）。
 *  2) 恢复：积压清理后新日志恢复落盘（背压是瞬态，非永久卡死）—— 这是核心前提属性。
 * 另验丢弃计数（droppedDueToBackpressure）可观测性。
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// 可控的 appendFile mock：返回一个可按需 resolve 的 promise，模拟慢盘/恢复。
let appendFileCalls = 0;
let pendingResolvers: Array<() => void> = [];
let blockWrites = true; // true = 永不自动 resolve（积压）；false = 立即 resolve（恢复）

jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises') as typeof import('fs/promises');
  return {
    ...actual,
    appendFile: jest.fn(() => {
      appendFileCalls++;
      if (!blockWrites) return Promise.resolve();
      return new Promise<void>((resolve) => {
        pendingResolvers.push(resolve);
      });
    }),
  };
});

import { LogManager } from '../LogManager';

describe('LogManager 背压（issue #210 根因 #1）', () => {
  let tmpDir: string;
  let manager: LogManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-log-bp-'));
    manager = new LogManager(tmpDir);
    appendFileCalls = 0;
    pendingResolvers = [];
    blockWrites = true;
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /** resolve 所有挂起的 appendFile promise（模拟积压清理）。 */
  function flushPending(): void {
    const resolvers = pendingResolvers;
    pendingResolvers = [];
    for (const r of resolvers) r();
  }

  it('积压：pendingWrites 超 MAX_PENDING_WRITES 后丢弃落盘，但内存缓冲仍保留', async () => {
    const MAX = (LogManager as unknown as { MAX_PENDING_WRITES: number }).MAX_PENDING_WRITES;
    expect(MAX).toBeGreaterThan(0);

    await (manager as unknown as { initPromise: Promise<void> }).initPromise;
    const total = MAX + 50;
    for (let i = 0; i < total; i++) {
      manager.addLog('info', `msg-${i}`, 'test');
    }

    // pendingWrites 不超上限（背压丢弃了超额条目的落盘）
    const pending = (manager as unknown as { pendingWrites: Set<unknown> }).pendingWrites;
    expect(pending.size).toBeLessThanOrEqual(MAX);
    // 内存缓冲仍保留所有日志（背压只丢落盘，不丢 UI 可见性）
    const logs = manager.getLogs();
    expect(logs.length).toBeGreaterThan(MAX);
    expect(logs[logs.length - 1].message).toBe(`msg-${total - 1}`);
    // 丢弃计数 > 0（可观测性：至少 50 条被背压丢弃）
    expect(manager.getDroppedDueToBackpressure()).toBeGreaterThan(0);
  });

  it('恢复：积压清理后新日志恢复落盘（背压是瞬态，非永久卡死）', async () => {
    const MAX = (LogManager as unknown as { MAX_PENDING_WRITES: number }).MAX_PENDING_WRITES;
    await (manager as unknown as { initPromise: Promise<void> }).initPromise;

    // 阶段 1：堆积到背压（blockWrites=true，appendFile 永不自动 resolve）
    for (let i = 0; i < MAX + 30; i++) {
      manager.addLog('info', `block-${i}`, 'test');
    }
    const pending = (manager as unknown as { pendingWrites: Set<unknown> }).pendingWrites;
    expect(pending.size).toBeLessThanOrEqual(MAX);
    const droppedInBacklog = manager.getDroppedDueToBackpressure();
    expect(droppedInBacklog).toBeGreaterThan(0);

    // 阶段 2：清理积压（resolve 所有挂起的 appendFile）+ 切换为立即 resolve
    flushPending();
    blockWrites = false;
    // 等积压的 writeToFile 链（appendFile→finally delete）走完：轮询 pending.size 归零
    await new Promise<void>((resolve) => {
      const tick = () => (pending.size === 0 ? resolve() : setImmediate(tick));
      setImmediate(tick);
    });

    // 阶段 3：恢复 —— blockWrites=false，新 appendFile 立即 resolve，不触发背压
    const beforeDropped = manager.getDroppedDueToBackpressure();
    for (let i = 0; i < 10; i++) {
      manager.addLog('info', `recover-${i}`, 'test');
    }
    // 等新 writeToFile 落定
    await new Promise<void>((resolve) => {
      const tick = () => (pending.size === 0 ? resolve() : setImmediate(tick));
      setImmediate(tick);
    });
    // 恢复后丢弃计数不再增长（新日志都成功落盘，未触发背压）
    expect(manager.getDroppedDueToBackpressure()).toBe(beforeDropped);
  });

  it('FATAL/error 关键级别绕过背压上限直写（崩溃复盘不丢关键行）', async () => {
    const MAX = (LogManager as unknown as { MAX_PENDING_WRITES: number }).MAX_PENDING_WRITES;
    await (manager as unknown as { initPromise: Promise<void> }).initPromise;

    // 撑满积压：MAX 条 info（blockWrites=true，writeToFile 的 appendFile 永不 resolve）→ pending 封顶 MAX
    for (let i = 0; i < MAX; i++) manager.addLog('info', `sat-${i}`, 'test');
    const pending = (manager as unknown as { pendingWrites: Set<unknown> }).pendingWrites;
    expect(pending.size).toBe(MAX);

    // 满载下：普通 info 被丢（不入 pendingWrites，dropped++）
    const droppedBefore = manager.getDroppedDueToBackpressure();
    manager.addLog('info', 'should-drop', 'test');
    expect(pending.size).toBe(MAX); // 未新增落盘
    expect(manager.getDroppedDueToBackpressure()).toBe(droppedBefore + 1);

    // 满载下：fatal / error 绕过上限直写（同步入 pendingWrites，pending 超过 MAX），且不计入丢弃
    manager.addLog('fatal', 'critical-fatal', 'test');
    expect(pending.size).toBe(MAX + 1);
    manager.addLog('error', 'critical-error', 'test');
    expect(pending.size).toBe(MAX + 2);
    expect(manager.getDroppedDueToBackpressure()).toBe(droppedBefore + 1);
  });
});
