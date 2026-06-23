/**
 * ensureWritableCore 原子换核单测（issue #150：内核替换 ETXTBSY 根因修复）。
 *
 * 验 ResourceManager.ensureWritableCore(force=true) 走原子替换（写 targetPath.tmp → chmod → rename）而非
 * 原地 copyFile 覆盖：原地 O_TRUNC 打开正被执行的旧核会 ETXTBSY（text file busy）→ 替换失败、旧核残留；
 * rename 只 unlink 旧 inode（在用进程不受影响）、文件名指向全新核 → 规避 ETXTBSY。
 *
 * 关键不变量（实现无关，直击回归）：换核后 target 的 **inode 改变**（rename 换 inode；原地 copyFile 保持 inode），
 * 即证明走的是 rename 而非原地覆盖。设计：真实临时目录承载内置 bundle + 可写核目录，仅 mock electron.app + 平台。
 */

import * as os from 'os';
import * as fsSync from 'fs';
import * as path from 'path';

const ROOT = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-reseed-test-'));
const RESOURCES = path.join(ROOT, 'resources');
Object.defineProperty(process, 'resourcesPath', { value: RESOURCES, configurable: true });

jest.mock('electron', () => ({
  app: {
    getPath: () => ROOT, // userData → ROOT（core_update 落于 ROOT/core_update）
    getVersion: () => '9.9.9',
    isPackaged: true, // 生产模式：baseDir=process.resourcesPath
    getAppPath: () => ROOT,
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ResourceManager } from '../ResourceManager';

const ORIG_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

const LINUX_BUNDLE = path.join(RESOURCES, 'linux');
const CORE_UPDATE = path.join(ROOT, 'core_update');
const SOURCE = path.join(LINUX_BUNDLE, 'sing-box');
const TARGET = path.join(CORE_UPDATE, 'sing-box');

function seedBundleCore(content: string): void {
  fsSync.mkdirSync(LINUX_BUNDLE, { recursive: true });
  fsSync.writeFileSync(SOURCE, content);
  fsSync.chmodSync(SOURCE, 0o755);
}

beforeEach(() => {
  fsSync.rmSync(RESOURCES, { recursive: true, force: true });
  fsSync.rmSync(CORE_UPDATE, { recursive: true, force: true });
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
  rm.setLogManager({ addLog: () => {} } as any); // 静默日志，避免 console 噪音
  return rm;
}

describe('ensureWritableCore(force=true) — 原子替换换核（issue #150）', () => {
  it('旧核已在位 → 用随包核覆盖：内容更新为新核，且 inode 改变（证明 rename 非原地 copyFile）', async () => {
    seedBundleCore('NEW-CORE-1.14.0-alpha.33');
    // 预置一个旧核（模拟用户装的官方 1.13.13 残留可写核）
    fsSync.mkdirSync(CORE_UPDATE, { recursive: true });
    fsSync.writeFileSync(TARGET, 'OLD-CORE-1.13.13');
    fsSync.chmodSync(TARGET, 0o755);
    const inodeBefore = fsSync.statSync(TARGET).ino;

    const rm = mkRm();
    const ret = await rm.ensureWritableCore(true);

    expect(ret).toBe(TARGET);
    // 内容已替换为新核
    expect(fsSync.readFileSync(TARGET, 'utf-8')).toBe('NEW-CORE-1.14.0-alpha.33');
    // inode 改变 = 走 rename（原子换 inode）而非原地 O_TRUNC 覆盖 → 根除 ETXTBSY
    expect(fsSync.statSync(TARGET).ino).not.toBe(inodeBefore);
    // 可执行位保留（POSIX 语义；Windows 宿主无 0o111 执行位、chmod 只动只读属性，跳过——该断言仅类 Unix 宿主有意义）
    if (ORIG_PLATFORM !== 'win32') expect(fsSync.statSync(TARGET).mode & 0o111).not.toBe(0);
    // 不留半残 .tmp
    expect(fsSync.existsSync(`${TARGET}.tmp`)).toBe(false);
  });

  it('目标不存在 → 首次播种：经 tmp+rename 落位，内容正确、可执行、无残留 .tmp', async () => {
    seedBundleCore('NEW-CORE-1.14.0-alpha.33');
    expect(fsSync.existsSync(TARGET)).toBe(false);

    const rm = mkRm();
    const ret = await rm.ensureWritableCore(true);

    expect(ret).toBe(TARGET);
    expect(fsSync.readFileSync(TARGET, 'utf-8')).toBe('NEW-CORE-1.14.0-alpha.33');
    // 可执行位保留（POSIX-only，Windows 宿主跳过——见上）
    if (ORIG_PLATFORM !== 'win32') expect(fsSync.statSync(TARGET).mode & 0o111).not.toBe(0);
    expect(fsSync.existsSync(`${TARGET}.tmp`)).toBe(false);
  });

  it('残留 .tmp 不阻断换核（copyFile 覆盖 tmp 后 rename）', async () => {
    seedBundleCore('NEW-CORE-1.14.0-alpha.33');
    fsSync.mkdirSync(CORE_UPDATE, { recursive: true });
    fsSync.writeFileSync(`${TARGET}.tmp`, 'STALE-LEFTOVER'); // 上次崩溃残留

    const rm = mkRm();
    await rm.ensureWritableCore(true);

    expect(fsSync.readFileSync(TARGET, 'utf-8')).toBe('NEW-CORE-1.14.0-alpha.33');
    expect(fsSync.existsSync(`${TARGET}.tmp`)).toBe(false);
  });
});
