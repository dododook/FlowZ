/**
 * 回归：root 提权下 userData 路径全局统一。
 *
 * 1) shadow 已修复——root 修正移入 initUserDataPath() 并 setPath 下沉，getUserDataPath() 不再被
 *    initUserDataPath 的早缓存屏蔽（原 bug：修正写在 getUserDataPath，但 init 先缓存默认路径致其从不执行）。
 * 2) #12 已修——真实家目录解析不硬编码 /home 或 /Users 前缀：HOME 自定义路径直接采信；
 *    /etc/passwd 反查由纯函数 parsePasswdHome 承担，单测直接钉死其解析（含 usermod -d 非标准家目录）。
 *
 * root 场景套件用 typeof process.getuid 守卫：getuid 仅 POSIX 存在，Windows 上 undefined，
 * 直接 spyOn 会抛（gate 绿 / Windows CI 红）——与仓库既有 POSIX-only 测试同规约。
 */

const mockApp = {
  getPath: jest.fn((k: string): string => (k === 'userData' ? '/root/.config/FlowZ' : '/root')),
  getName: jest.fn((): string => 'FlowZ'),
  setPath: jest.fn(),
  isPackaged: false,
};
jest.mock('electron', () => ({ app: mockApp }));

const describeRoot = typeof process.getuid === 'function' ? describe : describe.skip;

describeRoot('userData root 提权统一（initUserDataPath setPath 根治 shadow）', () => {
  let origPlatform: PropertyDescriptor | undefined;
  let getuidSpy: jest.SpyInstance | undefined;
  const ENV = ['SUDO_USER', 'HOME', 'PORTABLE_EXECUTABLE_DIR'];
  const saved: Record<string, string | undefined> = {};

  const setPlatform = (p: string): void => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  };
  const asRoot = (uid = 0): void => {
    getuidSpy = jest
      .spyOn(process as unknown as { getuid: () => number }, 'getuid')
      .mockReturnValue(uid);
  };
  const setUserDataDefault = (def: string): void => {
    mockApp.getPath.mockImplementation((k: string) => (k === 'userData' ? def : '/root'));
  };

  beforeEach(() => {
    origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    mockApp.setPath.mockClear();
    mockApp.getPath.mockClear();
  });

  afterEach(() => {
    if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
    if (getuidSpy) getuidSpy.mockRestore();
    getuidSpy = undefined;
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
    jest.restoreAllMocks();
  });

  // darwin 用例用哨兵用户名（宿主 /etc/passwd 必无）→ passwd 反查 miss → 走 /Users 兜底，避免依赖测试机用户。
  it('darwin+root：initUserDataPath 修正到真实用户家并 setPath；getUserDataPath 不再被 shadow', () => {
    setPlatform('darwin');
    asRoot(0);
    process.env.SUDO_USER = 'zzflowztestuser';
    process.env.HOME = '/var/root';
    setUserDataDefault('/var/root/Library/Application Support/FlowZ');
    jest.isolateModules(() => {
      const paths = require('../paths');
      paths.initUserDataPath();
      const expected = '/Users/zzflowztestuser/Library/Application Support/FlowZ';
      expect(mockApp.setPath).toHaveBeenCalledWith('userData', expected);
      expect(paths.getUserDataPath()).toBe(expected);
    });
  });

  it('linux+root：HOME 指向自定义家目录（非 /home）→ 直接采信，不硬编码（#12）', () => {
    setPlatform('linux');
    asRoot(0);
    process.env.HOME = '/data/custom-user';
    setUserDataDefault('/root/.config/FlowZ');
    jest.isolateModules(() => {
      const paths = require('../paths');
      paths.initUserDataPath();
      const expected = '/data/custom-user/.config/FlowZ';
      expect(mockApp.setPath).toHaveBeenCalledWith('userData', expected);
      expect(paths.getUserDataPath()).toBe(expected);
    });
  });

  it('普通用户（非 root）：不修正、不 setPath，用 Electron 默认', () => {
    setPlatform('linux');
    asRoot(1000);
    process.env.HOME = '/home/normal';
    setUserDataDefault('/home/normal/.config/FlowZ');
    jest.isolateModules(() => {
      const paths = require('../paths');
      paths.initUserDataPath();
      expect(mockApp.setPath).not.toHaveBeenCalled();
      expect(paths.getUserDataPath()).toBe('/home/normal/.config/FlowZ');
    });
  });

  it('getUserDataPath 独立调用（未先 init）：委托 init，root 下仍走修正', () => {
    setPlatform('darwin');
    asRoot(0);
    process.env.HOME = '/var/root';
    process.env.SUDO_USER = 'zzflowztestcarol';
    setUserDataDefault('/var/root/Library/Application Support/FlowZ');
    jest.isolateModules(() => {
      const paths = require('../paths');
      expect(paths.getUserDataPath()).toBe(
        '/Users/zzflowztestcarol/Library/Application Support/FlowZ'
      );
    });
  });
});

describe('parsePasswdHome（/etc/passwd 解析，#12 核心，纯函数）', () => {
  // lazy require：避免顶层 import 在 mockApp 初始化前触发 electron mock 工厂
  const { parsePasswdHome } = require('../paths');
  const PASSWD = [
    '# comment line',
    '',
    'root:x:0:0:root:/root:/bin/bash',
    'alice:x:1000:1000:Alice:/home/alice:/bin/bash',
    'bob:x:1001:1001::/data/bob:/bin/zsh', // usermod -d 非标准家目录
    'short:x:1002', // 字段不足
  ].join('\n');

  it('命中 → 取第 6 字段家目录', () => {
    expect(parsePasswdHome(PASSWD, 'alice')).toBe('/home/alice');
  });

  it('usermod -d 非标准家目录（不硬编码 /home）', () => {
    expect(parsePasswdHome(PASSWD, 'bob')).toBe('/data/bob');
  });

  it('查不到用户 → null', () => {
    expect(parsePasswdHome(PASSWD, 'nobody')).toBeNull();
  });

  it('注释行 / 空行 / 字段不足 / 空内容 均跳过', () => {
    expect(parsePasswdHome(PASSWD, '# comment line')).toBeNull();
    expect(parsePasswdHome(PASSWD, 'short')).toBeNull();
    expect(parsePasswdHome('', 'alice')).toBeNull();
  });
});
