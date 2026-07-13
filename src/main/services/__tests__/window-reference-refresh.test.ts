/**
 * 关窗默认销毁重建后，构造时只捕获一次的 mainWindow 引用会永久指向已销毁窗口——ProxyManager 的
 * sendEventToRenderer（代理启停/错误、Tailscale 认证、失效节点告警等）会因此静默失效。本测覆盖其
 * setMainWindow 刷新。
 *
 * 注：UpdateService 的「更新提醒」已从原生 dialog（依赖 mainWindow）改为独立 Conduit mini 更新窗
 * （UpdateService.createUpdatePopup，不依赖 mainWindow）——原先「mainWindow 销毁→showUpdateDialog 返回
 * later 不弹」的判断已随架构移除（弹窗独立即修了该缺陷），故此处不再测 showUpdateDialog 的窗口有效性；
 * 弹窗布局纯逻辑见 update-popup-layout.test.ts，弹窗创建/定位/焦点为真机项。
 */
import * as os from 'os';
import * as path from 'path';
import * as fsSync from 'fs';

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-winref-test-'));

jest.mock('electron', () => ({
  app: {
    getPath: () => TMP,
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => TMP,
  },
  shell: {},
  BrowserWindow: class {},
  dialog: { showMessageBox: jest.fn() },
  net: {},
  session: {},
  Notification: class {},
}));

import { ProxyManager } from '../ProxyManager';

function freshPm(): any {
  const pm: any = new ProxyManager(
    undefined,
    undefined,
    path.join(TMP, 'cfg.json'),
    '/fake/sing-box'
  );
  pm.logToManager = () => {};
  return pm;
}

describe('ProxyManager.setMainWindow', () => {
  it('旧窗口销毁后未刷新引用 → 事件静默丢弃（回归场景）；调用 setMainWindow 刷新后重新送达新窗口', () => {
    const pm = freshPm();
    const oldWindow = { isDestroyed: () => false, webContents: { send: jest.fn() } };
    pm.setMainWindow(oldWindow);

    // 模拟窗口关闭销毁：若 createWindow() 不再调 setMainWindow 刷新，pm 仍会永久持有这个已销毁引用。
    oldWindow.isDestroyed = () => true;
    pm.sendEventToRenderer('test:channel', { a: 1 });
    expect(oldWindow.webContents.send).not.toHaveBeenCalled();

    const newWindow = { isDestroyed: () => false, webContents: { send: jest.fn() } };
    pm.setMainWindow(newWindow);
    pm.sendEventToRenderer('test:channel', { a: 1 });
    expect(newWindow.webContents.send).toHaveBeenCalledWith('test:channel', { a: 1 });
  });

  it('setMainWindow(null) → 后续事件静默跳过，不抛', () => {
    const pm = freshPm();
    pm.setMainWindow(null);
    expect(() => pm.sendEventToRenderer('test:channel', {})).not.toThrow();
  });
});
