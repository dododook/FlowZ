/**
 * 换核覆盖跨平台统一 — Windows 单测（设计见 docs/design/core-override-cross-platform-unify）。
 *
 * 修复前：Windows 上 ensureWritableCore 是 no-op（reseed 不执行），升级带来更新随包核时旧可写核永不被替换、
 * 需手动「重置出厂」；且 getSingBoxPath/UpdateTargetPath 只在 portable 才用 userData，安装版现役核耦合安装目录。
 * 本测固化统一后行为：Windows（portable+安装版）现役核恒为 userData 可写核、随包核只是种子，reseed 真正执行。
 *
 * 真实临时目录 + mock electron.app（isPackaged=true → baseDir=process.resourcesPath）+ process.platform='win32'。
 * 注：跑在 Linux 宿主，'sing-box.exe' 仅为文件名、atomicCopy 走宿主 fs，验的是路径/换核【逻辑】（同 cronet 测 win32）。
 */
import * as os from 'os';
import * as fsSync from 'fs';
import * as path from 'path';

const ROOT = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-reseed-win-'));
const RESOURCES = path.join(ROOT, 'resources');
Object.defineProperty(process, 'resourcesPath', { value: RESOURCES, configurable: true });

jest.mock('electron', () => ({
  app: { getPath: () => ROOT, getVersion: () => '9.9.9', isPackaged: true, getAppPath: () => ROOT },
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

const WIN_BUNDLE = path.join(RESOURCES, 'win'); // 生产 baseDir=process.resourcesPath → resources/win
const CORE_UPDATE = path.join(ROOT, 'core_update'); // userData/core_update
const SOURCE = path.join(WIN_BUNDLE, 'sing-box.exe');
const TARGET = path.join(CORE_UPDATE, 'sing-box.exe');

function seedBundleCore(content: string): void {
  fsSync.mkdirSync(WIN_BUNDLE, { recursive: true });
  fsSync.writeFileSync(SOURCE, content);
}

beforeEach(() => {
  fsSync.rmSync(RESOURCES, { recursive: true, force: true });
  fsSync.rmSync(CORE_UPDATE, { recursive: true, force: true });
  delete process.env.PORTABLE_EXECUTABLE_DIR; // 验「安装版(非 portable)也走 userData」=统一关键
  setPlatform('win32');
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
  return rm;
}

describe('ensureWritableCore(win32) — 换核执行不再 no-op', () => {
  it('force：旧可写核 ← 随包核 原子替换（inode 改变=rename，内容更新，无 .tmp）', async () => {
    seedBundleCore('NEW-CORE-1.14.0-alpha.34');
    fsSync.mkdirSync(CORE_UPDATE, { recursive: true });
    fsSync.writeFileSync(TARGET, 'OLD-CORE-1.14.0-alpha.33'); // 旧可写核（升级前残留）
    const inodeBefore = fsSync.statSync(TARGET).ino;

    const rm = mkRm();
    const ret = await rm.ensureWritableCore(true);

    expect(ret).toBe(TARGET); // 返回 userData 可写核（非 no-op 回 bundle）
    expect(fsSync.readFileSync(TARGET, 'utf-8')).toBe('NEW-CORE-1.14.0-alpha.34'); // 真换了
    expect(fsSync.statSync(TARGET).ino).not.toBe(inodeBefore); // rename 非原地覆盖
    expect(fsSync.existsSync(`${TARGET}.tmp`)).toBe(false);
  });

  it('non-force 且无可写核 → 从随包核播种（首启）', async () => {
    seedBundleCore('NEW-CORE-1.14.0-alpha.34');
    expect(fsSync.existsSync(TARGET)).toBe(false);

    const rm = mkRm();
    const ret = await rm.ensureWritableCore(false);

    expect(ret).toBe(TARGET);
    expect(fsSync.readFileSync(TARGET, 'utf-8')).toBe('NEW-CORE-1.14.0-alpha.34');
  });

  it('non-force 且已有可写核 → 复用，不覆盖（不降级用户已装核）', async () => {
    seedBundleCore('BUNDLED-alpha.34');
    fsSync.mkdirSync(CORE_UPDATE, { recursive: true });
    fsSync.writeFileSync(TARGET, 'USER-UPDATED-alpha.35'); // 用户更新到更新核

    const rm = mkRm();
    const ret = await rm.ensureWritableCore(false);

    expect(ret).toBe(TARGET);
    expect(fsSync.readFileSync(TARGET, 'utf-8')).toBe('USER-UPDATED-alpha.35'); // 未被随包覆盖
  });
});

describe('getSingBoxPath / getSingBoxUpdateTargetPath(win32) — 安装版也走 userData（不再仅 portable）', () => {
  it('getSingBoxPath：userData 可写核存在 → 用它（无 PORTABLE_EXECUTABLE_DIR 也生效）', () => {
    seedBundleCore('BUNDLED');
    fsSync.mkdirSync(CORE_UPDATE, { recursive: true });
    fsSync.writeFileSync(TARGET, 'WRITABLE');
    const rm = mkRm();
    expect(rm.getSingBoxPath()).toBe(TARGET);
  });

  it('getSingBoxPath：userData 无可写核 → 回落随包种子（首启/迁移不 brick）', () => {
    seedBundleCore('BUNDLED');
    const rm = mkRm();
    expect(rm.getSingBoxPath()).toBe(SOURCE);
  });

  it('getSingBoxUpdateTargetPath：恒指向 userData 可写核（与现役核解耦安装目录种子）', () => {
    const rm = mkRm();
    expect(rm.getSingBoxUpdateTargetPath()).toBe(TARGET);
  });
});
