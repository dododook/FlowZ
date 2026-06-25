/**
 * TrayManager 菜单映射回归（#75）。
 *
 * 守护「托盘状态头 / 启停开关 / 图标」三者恒与 isProxyRunning 一致」——即同一次渲染内不可能出现
 * 「状态头=已连接 而 开关=启用代理」这种自相矛盾（截图里的现象其实是托盘整体停在断开态、未随
 * 代理 started 刷新；根因修复在 index.ts on('started') 补刷，本测守住菜单映射这一半）。
 *
 * 仅依赖 electron / ResourceManager mock；不拉主进程 bootstrap。
 */

// ── electron mock：捕获 Menu.buildFromTemplate 传入的模板以做断言 ──────────────
let lastTemplate: any[] = [];
const buildFromTemplate = jest.fn((tpl: any[]) => {
  lastTemplate = tpl;
  return { __menu: true };
});
const imgStub: any = { resize: () => imgStub, isEmpty: () => false };

jest.mock('electron', () => ({
  // currentLanguage 初值改用 getPreferredSystemLanguages（getLocale 恒返 app bundle locale=en 不可用）→ mock 返中文偏好。
  app: {
    getLocale: () => 'zh-CN',
    getPreferredSystemLanguages: () => ['zh-Hans-CN'],
    isPackaged: false,
  },
  BrowserWindow: class {},
  Tray: class {
    setToolTip = jest.fn();
    setImage = jest.fn();
    setContextMenu = jest.fn();
    destroy = jest.fn();
    on = jest.fn();
  },
  Menu: { buildFromTemplate: (tpl: any[]) => buildFromTemplate(tpl) },
  nativeImage: {
    createFromPath: () => imgStub,
    createFromDataURL: () => imgStub,
    createFromBuffer: () => imgStub,
    createEmpty: () => imgStub,
  },
}));

// loadTrayIcon 内 require('./ResourceManager')，给个返回固定路径的桩（真实 fs.existsSync 对该路径返回 false
// → 走 createDefaultTrayIcon → nativeImage.createFromDataURL，全部命中上面的桩）。
const getTrayIconPath = jest.fn((_connected?: boolean) => '/nonexistent/tray-icon.png');
jest.mock('../ResourceManager', () => ({
  resourceManager: { getTrayIconPath: (connected?: boolean) => getTrayIconPath(connected) },
}));

import { TrayManager, type TrayMenuData } from '../TrayManager';
import { setMainLanguage } from '../../i18n';

const makeLogger = () => ({ addLog: jest.fn() }) as any;

const baseData = (isProxyRunning: boolean): TrayMenuData => ({
  isProxyRunning,
  servers: [],
  subscriptions: [],
  selectedServerId: null,
  proxyMode: 'smart',
  proxyModeType: 'tun',
});

/** 从最近一次模板里取「状态头」label 与「启停开关」label。 */
function readMenu(): { status: string; toggle: string } {
  const status = String(lastTemplate[0]?.label ?? '');
  const toggleItem = lastTemplate.find((i) => i?.label === '启用代理' || i?.label === '禁用代理');
  return { status, toggle: String(toggleItem?.label ?? '') };
}

function makeTray(): TrayManager {
  const tm = new TrayManager(null, makeLogger(), {});
  tm.createTray();
  return tm;
}

beforeEach(() => {
  lastTemplate = [];
  buildFromTemplate.mockClear();
  getTrayIconPath.mockClear();
  // 托盘文案改走主进程 i18n（mt 读中央语言持有点）。真机由 index.ts 启动按系统偏好初始化；
  // 测试显式设中文（对应本套 mock 的 zh-Hans-CN 系统偏好），以断言中文标签。
  setMainLanguage('zh-CN');
});

describe('TrayManager 菜单状态映射 (#75)', () => {
  it('代理运行中 → 状态头「已连接」且开关「禁用代理」', () => {
    const tm = makeTray();
    tm.updateFullTrayMenu(baseData(true));

    const { status, toggle } = readMenu();
    expect(status).toBe('已连接');
    expect(toggle).toBe('禁用代理');
    // 状态头带圆点图标（connected）
    expect(lastTemplate[0]?.icon).toBe(imgStub);
  });

  it('代理已停止 → 状态头「已断开」且开关「启用代理」', () => {
    const tm = makeTray();
    tm.updateFullTrayMenu(baseData(false));

    const { status, toggle } = readMenu();
    expect(status).toBe('已断开');
    expect(toggle).toBe('启用代理');
  });

  it('hasError → 状态头「连接异常」（开关仍按运行态）', () => {
    const tm = makeTray();
    tm.updateFullTrayMenu({ ...baseData(false), hasError: true });
    expect(readMenu().status).toBe('连接异常');
  });

  it('不变量：状态头与开关恒一致，绝不出现「已连接 + 启用代理」', () => {
    const tm = makeTray();
    for (const running of [true, false, true, false]) {
      tm.updateFullTrayMenu(baseData(running));
      const { status, toggle } = readMenu();
      if (status === '已连接') expect(toggle).toBe('禁用代理');
      if (status === '已断开') expect(toggle).toBe('启用代理');
    }
  });

  it('updateTrayMenu(true) 简化入口也渲染连接态', () => {
    const tm = makeTray();
    tm.updateTrayMenu(true);
    expect(readMenu()).toEqual({ status: '已连接', toggle: '禁用代理' });
  });

  it('updateTrayIcon(connected) 取彩色图标并 setImage', () => {
    const tm = makeTray();
    tm.updateTrayIcon('connected');
    // getTrayIconPath(connected=true)
    expect(getTrayIconPath).toHaveBeenCalledWith(true);
  });
});
