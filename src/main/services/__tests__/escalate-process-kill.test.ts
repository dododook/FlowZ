/**
 * escalateProcessKill 纯逻辑单测（#86-122 复审硬化 #2：瞬态登录核 SIGTERM→宽限→SIGKILL 升级）。
 *
 * 注入 sendSignal/schedule，零进程验证：
 *  1. 立即发 SIGTERM（优雅退出窗口）；
 *  2. graceMs 后仍未被 finalize 取消 → schedule 回调触发 SIGKILL 强杀；
 *  3. 返回 schedule 句柄（供调用方在 proc exit/error 时 clearTimeout 取消升级，防 timer 泄漏）。
 *
 * ProxyManager.ts 顶层依赖 electron（app 等）→ 同 proxy-manager-norm-hotswitch 测 mock electron 后再 import。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-escalate-test-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { escalateProcessKill } from '../ProxyManager';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('escalateProcessKill（SIGTERM → 宽限 → SIGKILL 升级）', () => {
  it('立即发 SIGTERM；宽限期到点回调发 SIGKILL；返回 schedule 句柄', () => {
    const signals: NodeJS.Signals[] = [];
    let scheduled: { fn: () => void; ms: number } | null = null;
    const fakeTimer = { id: 'timer-1' } as unknown as NodeJS.Timeout;

    const timer = escalateProcessKill({
      sendSignal: (sig) => signals.push(sig),
      schedule: (fn, ms) => {
        scheduled = { fn, ms };
        return fakeTimer;
      },
      graceMs: 3000,
    });

    // 第一段：立即 SIGTERM，此刻还没 SIGKILL（回调未触发）。
    expect(signals).toEqual(['SIGTERM']);
    // 返回的句柄正是 schedule 产出的 timer（供调用方 clearTimeout 取消升级）。
    expect(timer).toBe(fakeTimer);
    // schedule 以 graceMs 排程。
    expect(scheduled).not.toBeNull();
    expect(scheduled!.ms).toBe(3000);

    // 第二段：触发宽限期回调 → 升级到 SIGKILL。
    scheduled!.fn();
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('回调未触发（进程优雅退出，finalize 已 clearTimeout）→ 只发过 SIGTERM', () => {
    const signals: NodeJS.Signals[] = [];
    escalateProcessKill({
      sendSignal: (sig) => signals.push(sig),
      // schedule 不执行 fn（模拟 timer 被 finalize clearTimeout 取消）。
      schedule: () => ({}) as unknown as NodeJS.Timeout,
      graceMs: 3000,
    });
    expect(signals).toEqual(['SIGTERM']);
  });

  it('用真实 setTimeout + fake timers：宽限期前无 SIGKILL，到点后 SIGKILL', () => {
    jest.useFakeTimers();
    try {
      const signals: NodeJS.Signals[] = [];
      escalateProcessKill({
        sendSignal: (sig) => signals.push(sig),
        schedule: (fn, ms) => setTimeout(fn, ms),
        graceMs: 3000,
      });
      expect(signals).toEqual(['SIGTERM']);
      jest.advanceTimersByTime(2999);
      expect(signals).toEqual(['SIGTERM']); // 宽限期未满
      jest.advanceTimersByTime(1);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']); // 到点升级
    } finally {
      jest.useRealTimers();
    }
  });
});
