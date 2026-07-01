/**
 * 关窗默认销毁重建后，构造时只捕获一次的 mainWindow 引用会永久指向已销毁窗口——ProxyManager 的
 * sendEventToRenderer（代理启停/错误、Tailscale 认证、失效节点告警等）与 UpdateService 的更新对话框
 * 会因此静默失效。本测覆盖两者新增的 setMainWindow 刷新 + UpdateService 补的 isDestroyed 判断。
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
import { UpdateService } from '../UpdateService';

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

describe('UpdateService.showUpdateDialog 窗口有效性判断', () => {
  const log = { addLog: () => {} } as any;
  const updateInfo = { version: '1.0.0', releaseNotes: '' } as any;

  it('mainWindow 已销毁（非 null）→ 返回 later，不弹窗（原先只判 !mainWindow，销毁但非 null 时漏判）', async () => {
    const svc = new UpdateService(log);
    svc.setMainWindow({ isDestroyed: () => true } as any);
    await expect(svc.showUpdateDialog(updateInfo)).resolves.toBe('later');
  });

  it('mainWindow 为 null → 返回 later', async () => {
    const svc = new UpdateService(log);
    svc.setMainWindow(null);
    await expect(svc.showUpdateDialog(updateInfo)).resolves.toBe('later');
  });
});
