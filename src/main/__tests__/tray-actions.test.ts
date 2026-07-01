/**
 * tray-actions 导航单测：托盘「打开主窗口」回首页(/home)、「打开设置」切设置(/settings)、「管理服务器」切 /server。
 * mock electron（仅 app/BrowserWindow 占位）；验 showWindow + webContents.send(EVENT_NAVIGATE) 行为。
 */
jest.mock('electron', () => ({ app: { quit: jest.fn() }, BrowserWindow: class {} }));

import { buildTrayCallbacks } from '../tray-actions';
import { IPC_CHANNELS } from '../../shared/ipc-channels';

function makeDeps(opts: { noWindow?: boolean; windowDestroyed?: boolean } = {}) {
  const send = jest.fn();
  const showWindow = jest.fn();
  let destroyed = opts.windowDestroyed ?? false;
  const mainWindow = {
    isDestroyed: () => destroyed,
    destroy: jest.fn(() => {
      destroyed = true;
    }),
    webContents: { send },
  };
  const logManager = { addLog: jest.fn(), clearLogs: jest.fn() };
  const markLightweightModeTransition = jest.fn();
  const deps = {
    getMainWindow: () => (opts.noWindow ? null : mainWindow),
    getTrayManager: () => null,
    getProxyManager: () => null,
    logManager,
    configManager: {} as never,
    updateService: {} as never,
    speedTestService: {} as never,
    showWindow,
    updateTrayMenuState: jest.fn(),
    setPrivacyMode: jest.fn(),
    markLightweightModeTransition,
  };
  return { deps, send, showWindow, mainWindow, logManager, markLightweightModeTransition };
}

describe('tray-actions 导航', () => {
  it('onShowWindow → showWindow + 导航首页 /home（与「打开设置」对称，不再停留上次页）', () => {
    const { deps, send, showWindow } = makeDeps();
    buildTrayCallbacks(deps as never).onShowWindow();
    expect(showWindow).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.EVENT_NAVIGATE, '/home');
  });

  it('onOpenSettings → showWindow + 导航 /settings', () => {
    const { deps, send } = makeDeps();
    buildTrayCallbacks(deps as never).onOpenSettings();
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.EVENT_NAVIGATE, '/settings');
  });

  it('onManageServers → 导航 /server', () => {
    const { deps, send } = makeDeps();
    buildTrayCallbacks(deps as never).onManageServers();
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.EVENT_NAVIGATE, '/server');
  });

  it('onLightweightMode → 先标记 markLightweightModeTransition（供 window-all-closed 跳过退出判定）再销毁主窗口，带 clearLogsAndGc', () => {
    jest.useFakeTimers();
    try {
      const { deps, mainWindow, logManager, markLightweightModeTransition } = makeDeps();
      buildTrayCallbacks(deps as never).onLightweightMode();
      expect(markLightweightModeTransition).toHaveBeenCalledTimes(1);
      expect(mainWindow.destroy).toHaveBeenCalledTimes(1);
      // 顺序是这个机制正确性的关键：destroy() 可能同步触发 window-all-closed，必须先标记完
      // pendingQuitOnAllClosed 再销毁，标记晚了 window-all-closed 读到的就是上一次的陈旧值。
      expect(markLightweightModeTransition.mock.invocationCallOrder[0]).toBeLessThan(
        mainWindow.destroy.mock.invocationCallOrder[0]
      );
      expect(logManager.clearLogs).not.toHaveBeenCalled(); // 延迟前未执行
      jest.runAllTimers();
      expect(logManager.clearLogs).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('onLightweightMode：窗口不存在 → 不标记 markLightweightModeTransition（没有窗口要销毁，不该产生这个信号）', () => {
    const { deps, markLightweightModeTransition } = makeDeps({ noWindow: true });
    buildTrayCallbacks(deps as never).onLightweightMode();
    expect(markLightweightModeTransition).not.toHaveBeenCalled();
  });

  it('onLightweightMode：窗口不存在 → 不抛', () => {
    const { deps } = makeDeps({ noWindow: true });
    expect(() => buildTrayCallbacks(deps as never).onLightweightMode()).not.toThrow();
  });

  it('窗口已销毁 → 不发送导航（不抛）', () => {
    const { deps, send, showWindow } = makeDeps({ windowDestroyed: true });
    buildTrayCallbacks(deps as never).onShowWindow();
    expect(showWindow).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
