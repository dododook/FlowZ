/**
 * TrayManager.handleLightweightMode 兜底分支：onLightweightMode 回调未注入时，仍应自行销毁窗口
 * 释放内存（与 handleQuit/handleShowWindow 等同类回调保留自带兜底的既有约定一致）。
 * 生产环境经 tray-actions.ts 恒注入该回调，这条分支只在未来某次构造遗漏注入时才会被走到——
 * 但兜底本身零额外复杂度（复用已导入的 releaseWindowMemory，无循环依赖），故仍保留并覆盖。
 */
jest.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN', getPreferredSystemLanguages: () => ['zh-Hans-CN'] },
  BrowserWindow: class {},
  Tray: class {
    setToolTip = jest.fn();
    setImage = jest.fn();
    setContextMenu = jest.fn();
    destroy = jest.fn();
    on = jest.fn();
  },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: {
    createFromPath: () => ({ resize: () => ({}), isEmpty: () => false }),
    createFromDataURL: () => ({}),
  },
}));

import { TrayManager } from '../TrayManager';

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

describe('TrayManager.handleLightweightMode 兜底', () => {
  it('未注入 onLightweightMode 回调 → 自行销毁 mainWindow 释放内存', () => {
    // 兜底走 releaseWindowMemory({clearLogsAndGc:true})，真实 setTimeout 排定延迟清理：
    // 假计时器跑完，避免真实定时器晚于测试结束才触发、对着不完整 mock 调用抛出未捕获异常
    // （曾经的真实事故：mock 漏了 clearLogs，定时器在别的测试跑到一半时才触发，把 worker 进程冲垮）。
    jest.useFakeTimers();
    try {
      const mainWindow = makeWindow();
      const tm: any = new TrayManager(mainWindow, makeLogger(), {});

      tm.handleLightweightMode();
      jest.runAllTimers();

      expect(mainWindow.destroy).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('注入了 onLightweightMode 回调 → 走回调，不自行销毁', () => {
    const mainWindow = makeWindow();
    const onLightweightMode = jest.fn();
    const tm: any = new TrayManager(mainWindow, makeLogger(), { onLightweightMode });

    tm.handleLightweightMode();

    expect(onLightweightMode).toHaveBeenCalledTimes(1);
    expect(mainWindow.destroy).not.toHaveBeenCalled();
  });

  it('未注入回调且 mainWindow 为 null → 不抛', () => {
    const tm: any = new TrayManager(null, makeLogger(), {});
    expect(() => tm.handleLightweightMode()).not.toThrow();
  });
});
