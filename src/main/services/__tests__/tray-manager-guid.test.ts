/**
 * #312：托盘 guid 的平台分派。
 *
 * darwin 必须传固定 guid —— Electron 在 darwin 上把它赋给 NSStatusItem.autosaveName，系统据此把用户拖放的
 * 菜单栏位置存进本 app 的 preferences domain；不传则位置不跨启动保留（electron#47838），每次更新后图标回到默认位。
 *
 * win32 必须**不**传 —— Electron 文档明示未签名 exe 的 GUID 与 exe 路径永久绑定，路径变则托盘创建失败；
 * FlowZ 无 Authenticode 签名且 portable 形态每版换文件名 → 传了会弄坏 portable 更新后的托盘。这条是本次改动
 * 最危险的逃逸面（传错了在 Linux/mac 上一切正常、只在 Windows portable 真机炸），故单独钉死。
 */
const trayCtorArgs: unknown[][] = [];

jest.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN', getPreferredSystemLanguages: () => ['zh-Hans-CN'] },
  BrowserWindow: class {},
  Tray: class {
    constructor(...args: unknown[]) {
      trayCtorArgs.push(args);
    }
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

// loadTrayIcon 经 ResourceManager 取图标路径（真实实现依赖打包态的 app 路径，测试态拿不到）。
// 给一个不存在的路径 → 走 createDefaultTrayIcon 分支，与本测关注的 guid 分派无关。
jest.mock('../ResourceManager', () => ({
  resourceManager: { getTrayIconPath: () => '/nonexistent/flowz-tray-icon.png' },
}));

import { TrayManager } from '../TrayManager';

const makeLogger = () => ({ addLog: jest.fn(), clearLogs: jest.fn() }) as any;

/** UUID v4 形态；Electron 对非 UUID 的 guid 抛 "Invalid GUID format"。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function createTrayOn(platform: NodeJS.Platform): unknown[] {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    trayCtorArgs.length = 0;
    new TrayManager(null, makeLogger()).createTray();
    expect(trayCtorArgs).toHaveLength(1);
    return trayCtorArgs[0];
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

describe('TrayManager 托盘 guid 平台分派（#312）', () => {
  it('darwin：传 guid，且为合法 UUID（= NSStatusItem.autosaveName，保住菜单栏位置）', () => {
    const args = createTrayOn('darwin');
    expect(args).toHaveLength(2);
    expect(typeof args[1]).toBe('string');
    expect(args[1]).toMatch(UUID_RE);
  });

  it('win32：绝不传 guid（未签名 exe 的 GUID 绑死 exe 路径，portable 换名后托盘创建即失败）', () => {
    expect(createTrayOn('win32')).toHaveLength(1);
  });

  it('linux：不传 guid（该参数在 Linux 无意义）', () => {
    expect(createTrayOn('linux')).toHaveLength(1);
  });

  // 钉死字面量而非「跨调用自比」——后者是同进程内常量自比、恒真，守不住任何常量替换：
  // 换成另一个合法 UUID（或 crypto.randomUUID()，模块级 const 进程内同样稳定）时全绿，
  // 而用户菜单栏位置已全丢。这是本次改动唯一真实的长期逃逸面（重构手滑即触发）。
  // 钉死后「改 guid」必须同时改本测试 → 强制过一次有意识决策。
  it('guid 恒为该字面量（跨版本不得变更；改动=换 autosaveName=用户已拖好的位置全丢）', () => {
    expect(createTrayOn('darwin')[1]).toBe('ba2b1484-56c4-430d-a3a9-18e6cc3f45dd');
  });
});
