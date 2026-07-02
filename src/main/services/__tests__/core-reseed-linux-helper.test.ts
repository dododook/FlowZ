/**
 * ensureWritableCore — Linux helper 模式 root 受管核刷新（应用更新后受管核不自愈 gap 的修复）。
 *
 * 验：helper 就绪（受管核在位）+ force（§5 决策）→ 经注入的 install-core 用随包核刷新 root 受管核，返回受管核路径
 * （探测/校验/实跑同源）；无 helper（受管核不在位）→ 不碰 install-core，退化为刷 userData 兜底核（setcap 路径零回归）；
 * install-core 失败 → 不抛，诚实返回受管核路径（版本闸门兜底）；no-force → 恒不触碰 install-core；win32 → install-core 不参与。
 * 设计：真实临时目录承载 bundle + userData 核，mock electron.app + 平台 + getLinuxManagedCoreDir（绕开硬编码 /usr/local）。
 */

import * as os from 'os';
import * as fsSync from 'fs';
import * as path from 'path';

const ROOT = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-reseed-linux-'));
const RESOURCES = path.join(ROOT, 'resources');
Object.defineProperty(process, 'resourcesPath', { value: RESOURCES, configurable: true });

jest.mock('electron', () => ({
  app: {
    getPath: () => ROOT, // userData → ROOT（core_update 落于 ROOT/core_update）
    getVersion: () => '9.9.9',
    isPackaged: true,
    getAppPath: () => ROOT,
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ResourceManager } from '../ResourceManager';

const ORIG_PLATFORM = process.platform;
const setPlatform = (p: NodeJS.Platform) =>
  Object.defineProperty(process, 'platform', { value: p, configurable: true });

const LINUX_BUNDLE = path.join(RESOURCES, 'linux');
const WIN_BUNDLE = path.join(RESOURCES, 'win');
const CORE_UPDATE = path.join(ROOT, 'core_update');
const MANAGED_DIR = path.join(ROOT, 'managed', 'core'); // mock 的 root 受管核目录
const MANAGED_BIN = path.join(MANAGED_DIR, 'sing-box');

function seedBundle(dir: string, name: string, content: string): void {
  fsSync.mkdirSync(dir, { recursive: true });
  fsSync.writeFileSync(path.join(dir, name), content);
  fsSync.chmodSync(path.join(dir, name), 0o755);
}

function seedManagedCore(content: string): void {
  fsSync.mkdirSync(MANAGED_DIR, { recursive: true });
  fsSync.writeFileSync(MANAGED_BIN, content);
  fsSync.chmodSync(MANAGED_BIN, 0o755);
}

beforeEach(() => {
  fsSync.rmSync(RESOURCES, { recursive: true, force: true });
  fsSync.rmSync(CORE_UPDATE, { recursive: true, force: true });
  fsSync.rmSync(path.join(ROOT, 'managed'), { recursive: true, force: true });
  setPlatform('linux');
});

afterAll(() => {
  setPlatform(ORIG_PLATFORM);
  try {
    fsSync.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function mkRm(): ResourceManager {
  const rm = new ResourceManager();
  rm.setLogManager({ addLog: () => {} } as any);
  jest.spyOn(rm, 'getLinuxManagedCoreDir').mockReturnValue(MANAGED_DIR); // 绕开硬编码 /usr/local
  return rm;
}

/** 捕获 install-core 调用时 seedDir 的内容（finally 会清 seedDir，故必须在调用瞬间读）。 */
function mkInstallCore(ok = true) {
  const captured: { seedDir: string; singbox: string | null } = { seedDir: '', singbox: null };
  const fn = jest.fn(async (seedDir: string) => {
    captured.seedDir = seedDir;
    const sb = path.join(seedDir, 'sing-box');
    captured.singbox = fsSync.existsSync(sb) ? fsSync.readFileSync(sb, 'utf-8') : null;
    return ok ? { ok: true } : { ok: false, error: 'mock-fail' };
  });
  return { fn, captured };
}

describe('ensureWritableCore — Linux helper 模式受管核刷新', () => {
  it('helper 就绪 + force → install-core 用随包核刷新受管核；seedDir 含随包核且刷后被清；返回受管核路径', async () => {
    seedBundle(LINUX_BUNDLE, 'sing-box', 'BUNDLED-1.14.0-final');
    seedManagedCore('OLD-MANAGED-1.14.0-alpha.36'); // 应用更新后受管核停旧版
    const rm = mkRm();
    const { fn, captured } = mkInstallCore(true);

    const ret = await rm.ensureWritableCore(true, { installCore: fn });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(captured.singbox).toBe('BUNDLED-1.14.0-final'); // seedDir 里是随包核
    expect(fsSync.existsSync(captured.seedDir)).toBe(false); // finally 已清临时 seedDir
    expect(ret).toBe(MANAGED_BIN); // 返回受管核（探测/校验/实跑同源），非 userData
    // userData 兜底核也被维护（helper 卸载后不陈旧）
    expect(fsSync.existsSync(path.join(CORE_UPDATE, 'sing-box'))).toBe(true);
  });

  it('无 helper（受管核不在位）+ force → install-core 零调用，退化刷 userData 核，返回 userData 路径（零回归）', async () => {
    seedBundle(LINUX_BUNDLE, 'sing-box', 'BUNDLED-1.14.0-final');
    // 不 seedManagedCore → 受管核不在位
    const rm = mkRm();
    const { fn } = mkInstallCore(true);

    const ret = await rm.ensureWritableCore(true, { installCore: fn });

    expect(fn).not.toHaveBeenCalled();
    expect(ret).toBe(path.join(CORE_UPDATE, 'sing-box'));
    expect(fsSync.readFileSync(ret, 'utf-8')).toBe('BUNDLED-1.14.0-final');
  });

  it('install-core 失败 → 不抛，诚实返回受管核路径（版本闸门兜底），userData 仍刷', async () => {
    seedBundle(LINUX_BUNDLE, 'sing-box', 'BUNDLED-1.14.0-final');
    seedManagedCore('OLD-MANAGED');
    const rm = mkRm();
    const { fn } = mkInstallCore(false); // {ok:false}

    const ret = await rm.ensureWritableCore(true, { installCore: fn });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(ret).toBe(MANAGED_BIN); // 不回退 userData（helper 路径锁只跑受管核）
    expect(fsSync.readFileSync(MANAGED_BIN, 'utf-8')).toBe('OLD-MANAGED'); // 受管核未变（mock 不写）→ 探测将读旧版
    expect(fsSync.existsSync(path.join(CORE_UPDATE, 'sing-box'))).toBe(true);
  });

  it('no-force（每次启动路径）+ 受管核在位 → install-core 恒不触碰；返回受管核路径', async () => {
    seedBundle(LINUX_BUNDLE, 'sing-box', 'BUNDLED');
    seedManagedCore('MANAGED-CURRENT');
    fsSync.mkdirSync(CORE_UPDATE, { recursive: true });
    fsSync.writeFileSync(path.join(CORE_UPDATE, 'sing-box'), 'USERDATA'); // 令 !force 早退分支命中
    const rm = mkRm();
    const { fn } = mkInstallCore(true);

    const ret = await rm.ensureWritableCore(false, { installCore: fn });

    expect(fn).not.toHaveBeenCalled(); // 无 socket 开销
    expect(ret).toBe(MANAGED_BIN); // helper 模式现役核=受管核
  });

  it('win32 + force + deps → install-core 不参与（Linux 专属腿），返回 win userData 核', async () => {
    setPlatform('win32');
    seedBundle(WIN_BUNDLE, 'sing-box.exe', 'WIN-BUNDLED');
    const rm = mkRm();
    const { fn } = mkInstallCore(true);

    const ret = await rm.ensureWritableCore(true, { installCore: fn });

    expect(fn).not.toHaveBeenCalled();
    expect(ret).toBe(path.join(CORE_UPDATE, 'sing-box.exe'));
  });
});
