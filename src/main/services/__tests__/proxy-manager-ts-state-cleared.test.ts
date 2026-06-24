/**
 * ProxyManager.reconcileRuntimeOwnershipBeforeStart：删某节点 root 残留 tailscale state 后，发
 * EVENT_TAILSCALE_STATE_CLEARED({serverId}) 通知渲染端清登录缓存（#173 review MED-4：陈旧 loggedIn=true 与
 * 已清空 state 撕裂）。state_directory 键即 serverId（<userData>/tailscale/<serverId>），故从删除路径首段还原 serverId。
 *
 * 全 mock：reconcileTreeOwnership 返回受控 deleted 列表；getUserDataPath 固定根；mainWindow.webContents.send 捕获事件。
 */
jest.mock('electron', () => ({
  app: { getPath: () => '/fake/userdata', getVersion: () => '9.9.9', isPackaged: false },
  BrowserWindow: class {},
  Notification: class {
    static isSupported() {
      return false;
    }
  },
  shell: { openExternal: jest.fn() },
  net: {},
  session: {},
}));

const USER_DATA = '/fake/userdata';
jest.mock('../../utils/paths', () => ({
  ...jest.requireActual('../../utils/paths'),
  getUserDataPath: () => USER_DATA,
}));

// reconcileTreeOwnership 受控返回：每个 case 用 mockReturnValueOnce 设定 deleted/chowned。
const mockReconcile = jest.fn();
jest.mock('../runtime-ownership', () => ({
  reconcileTreeOwnership: (...args: any[]) => mockReconcile(...args),
}));

import * as path from 'path';
import { ProxyManager } from '../ProxyManager';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';

const TS_ROOT = path.join(USER_DATA, 'tailscale');

function makeSvc() {
  const sent: { channel: string; data: any }[] = [];
  const mainWindow: any = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, data: any) => sent.push({ channel, data }) },
  };
  const svc: any = new ProxyManager(
    { addLog: jest.fn() } as any,
    mainWindow,
    '/fake/cfg.json',
    '/fake/sing-box'
  );
  // 走非提权 POSIX 分支：强制 needsOsascript/needsWindowsUAC 返 false（否则方法早返回不归一）。
  svc.needsOsascript = () => false;
  svc.needsWindowsUAC = () => false;
  return { svc, sent };
}

function clearedEvents(sent: { channel: string; data: any }[]) {
  return sent
    .filter((e) => e.channel === IPC_CHANNELS.EVENT_TAILSCALE_STATE_CLEARED)
    .map((e) => e.data);
}

const isPosix = typeof process.getuid === 'function';
const d = isPosix ? describe : describe.skip; // Windows 分支直接 return，无属主归一

d('reconcileRuntimeOwnershipBeforeStart：删 state → 发 EVENT_TAILSCALE_STATE_CLEARED', () => {
  afterEach(() => mockReconcile.mockReset());

  it('删某节点 state 文件 → 发该 serverId 的 STATE_CLEARED（路径首段还原 serverId）', () => {
    mockReconcile.mockReturnValueOnce({
      chowned: [],
      deleted: [path.join(TS_ROOT, 'srv-1', 'tailscaled.state')],
      failed: [],
    });
    const { svc, sent } = makeSvc();
    svc.reconcileRuntimeOwnershipBeforeStart();
    expect(clearedEvents(sent)).toEqual([{ serverId: 'srv-1' }]);
  });

  it('同节点删多文件 → 去重，只发一次该 serverId', () => {
    mockReconcile.mockReturnValueOnce({
      chowned: [],
      deleted: [
        path.join(TS_ROOT, 'srv-1', 'tailscaled.state'),
        path.join(TS_ROOT, 'srv-1', 'derpmap.cache'),
        path.join(TS_ROOT, 'srv-1'),
      ],
      failed: [],
    });
    const { svc, sent } = makeSvc();
    svc.reconcileRuntimeOwnershipBeforeStart();
    expect(clearedEvents(sent)).toEqual([{ serverId: 'srv-1' }]);
  });

  it('删两个节点 → 各发一次（按 serverId 去重聚合）', () => {
    mockReconcile.mockReturnValueOnce({
      chowned: [],
      deleted: [
        path.join(TS_ROOT, 'a', 'tailscaled.state'),
        path.join(TS_ROOT, 'b', 'tailscaled.state'),
      ],
      failed: [],
    });
    const { svc, sent } = makeSvc();
    svc.reconcileRuntimeOwnershipBeforeStart();
    const ids = clearedEvents(sent)
      .map((e) => e.serverId)
      .sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('仅 chown 无删除 → 不发 STATE_CLEARED（登录态未失效）', () => {
    mockReconcile.mockReturnValueOnce({
      chowned: [path.join(TS_ROOT, 'srv-1', 'tailscaled.state')],
      deleted: [],
      failed: [],
    });
    const { svc, sent } = makeSvc();
    svc.reconcileRuntimeOwnershipBeforeStart();
    expect(clearedEvents(sent)).toHaveLength(0);
  });
});
