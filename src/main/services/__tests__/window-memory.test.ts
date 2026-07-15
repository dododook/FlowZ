/**
 * releaseWindowMemory 单测：销毁窗口释放渲染进程 + 可选延迟清日志/触发 GC。
 * 供「关窗释放内存」（index.ts，默认不清日志）与「托盘/空闲轻量模式」（TrayManager 经
 * tray-actions.ts，clearLogsAndGc:true）共用，两处不再各自维护一份。
 */
import { releaseWindowMemory, detectRenderCrashLoop } from '../window-memory';

const makeLogger = () => ({ addLog: jest.fn(), clearLogs: jest.fn() }) as any;

function makeWindow(destroyed = false) {
  let isDestroyed = destroyed;
  return {
    isDestroyed: () => isDestroyed,
    destroy: jest.fn(() => {
      isDestroyed = true;
    }),
  } as any;
}

describe('releaseWindowMemory', () => {
  afterEach(() => {
    delete (global as any).gc;
    jest.useRealTimers();
  });

  it('默认（clearLogsAndGc 缺省）：只销毁窗口，不清日志、不排定任何延迟任务', () => {
    jest.useFakeTimers();
    const window = makeWindow();
    const logManager = makeLogger();

    releaseWindowMemory({ window, logManager });

    expect(window.destroy).toHaveBeenCalledTimes(1);
    expect(logManager.addLog).toHaveBeenCalledWith(
      'info',
      'Window destroyed to release memory',
      'Main'
    );
    jest.runAllTimers();
    expect(logManager.clearLogs).not.toHaveBeenCalled();
  });

  it('clearLogsAndGc:true → 延迟清空日志缓冲 + 触发 GC', () => {
    jest.useFakeTimers();
    const window = makeWindow();
    const logManager = makeLogger();
    const gcSpy = jest.fn();
    (global as any).gc = gcSpy;

    releaseWindowMemory({ window, logManager, clearLogsAndGc: true });

    expect(logManager.clearLogs).not.toHaveBeenCalled(); // 延迟前未执行
    jest.runAllTimers();
    expect(logManager.clearLogs).toHaveBeenCalledTimes(1);
    expect(gcSpy).toHaveBeenCalledTimes(1);
  });

  it('clearLogsAndGc:true 但手动 GC 不可用 → 静默跳过，不抛', () => {
    jest.useFakeTimers();
    const window = makeWindow();
    const logManager = makeLogger();

    releaseWindowMemory({ window, logManager, clearLogsAndGc: true });
    expect(() => jest.runAllTimers()).not.toThrow();
    expect(logManager.clearLogs).toHaveBeenCalledTimes(1);
  });

  it('窗口已销毁 → 直接跳过，不重复 destroy、不记日志、不排定任何任务', () => {
    jest.useFakeTimers();
    const window = makeWindow(true);
    const logManager = makeLogger();

    releaseWindowMemory({ window, logManager, clearLogsAndGc: true });

    expect(window.destroy).not.toHaveBeenCalled();
    expect(logManager.addLog).not.toHaveBeenCalled();
    jest.runAllTimers();
    expect(logManager.clearLogs).not.toHaveBeenCalled();
  });

  it('传 reason → 日志带上来源，便于事后从 app.log 区分是关窗还是轻量模式触发的销毁', () => {
    const window = makeWindow();
    const logManager = makeLogger();

    releaseWindowMemory({ window, logManager, reason: 'lightweight-mode' });

    expect(logManager.addLog).toHaveBeenCalledWith(
      'info',
      'Window destroyed to release memory (lightweight-mode)',
      'Main'
    );
  });

  it('不传 reason → 日志维持无来源后缀的原始文案', () => {
    const window = makeWindow();
    const logManager = makeLogger();

    releaseWindowMemory({ window, logManager });

    expect(logManager.addLog).toHaveBeenCalledWith(
      'info',
      'Window destroyed to release memory',
      'Main'
    );
  });
});

describe('detectRenderCrashLoop（主窗崩溃自愈的崩溃循环闸门）', () => {
  it('窗口内首次崩溃 → 非循环，允许重建', () => {
    const { recent, isLoop } = detectRenderCrashLoop([], 1000);
    expect(recent).toEqual([1000]);
    expect(isLoop).toBe(false);
  });

  it('60s 内累计 3 次 → 非循环（阈值边界：第 3 次仍允许重建）', () => {
    const { recent, isLoop } = detectRenderCrashLoop([20_000, 40_000], 55_000);
    expect(recent).toEqual([20_000, 40_000, 55_000]); // 两条都在 60s 窗口内 + 本次 = 3
    expect(isLoop).toBe(false);
  });

  it('60s 内累计 >3 次 → 判崩溃循环，停止自动重建', () => {
    const { recent, isLoop } = detectRenderCrashLoop([10_000, 20_000, 30_000], 40_000);
    expect(recent).toHaveLength(4);
    expect(isLoop).toBe(true);
  });

  it('陈旧时间戳滑出窗口后被剪枝 → 不累计成假循环', () => {
    // 三次都在很久以前（>60s），本次是窗口内第一次 → 非循环
    const { recent, isLoop } = detectRenderCrashLoop([1000, 2000, 3000], 200_000);
    expect(recent).toEqual([200_000]);
    expect(isLoop).toBe(false);
  });
});
