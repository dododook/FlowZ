/**
 * tray-actions 导航单测：托盘「打开主窗口」回首页(/home)、「打开设置」切设置(/settings)、「管理服务器」切 /server。
 * mock electron（仅 app/BrowserWindow 占位）；验 showWindow + webContents.send(EVENT_NAVIGATE) 行为。
 */
jest.mock('electron', () => ({ app: { quit: jest.fn() }, BrowserWindow: class {} }));

import { buildTrayCallbacks } from '../tray-actions';
import { IPC_CHANNELS } from '../../shared/ipc-channels';

function makeDeps() {
  const send = jest.fn();
  const showWindow = jest.fn();
  const mainWindow = { isDestroyed: () => false, webContents: { send } };
  const deps = {
    getMainWindow: () => mainWindow,
    getTrayManager: () => null,
    getProxyManager: () => null,
    logManager: { addLog: jest.fn() },
    configManager: {} as never,
    updateService: {} as never,
    speedTestService: {} as never,
    showWindow,
    updateTrayMenuState: jest.fn(),
    setPrivacyMode: jest.fn(),
  };
  return { deps, send, showWindow };
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

  it('窗口已销毁 → 不发送导航（不抛）', () => {
    const send = jest.fn();
    const showWindow = jest.fn();
    const mainWindow = { isDestroyed: () => true, webContents: { send } };
    const deps = {
      getMainWindow: () => mainWindow,
      getTrayManager: () => null,
      getProxyManager: () => null,
      logManager: { addLog: jest.fn() },
      configManager: {} as never,
      updateService: {} as never,
      speedTestService: {} as never,
      showWindow,
      updateTrayMenuState: jest.fn(),
      setPrivacyMode: jest.fn(),
    };
    buildTrayCallbacks(deps as never).onShowWindow();
    expect(showWindow).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
