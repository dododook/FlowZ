/**
 * libcronet 缺失/损坏自愈单测（T1，docs/design/cronet-lib-self-healing.md §6 全用例，三平台 mock）。
 *
 * 验 ResourceManager.ensureCronetHealthy / cronetNeedsRestore / atomicCopy / getCronetLibStatus 的
 * 完整性感知判据（size 快筛热路径 + sha256 冷路径），及 mac-x64（内置无库）不误触发自愈=死代码的反向约束。
 *
 * 设计：用真实临时目录承载「内置 bundle 目录」与「核心加载目录」，仅 mock electron.app（resourcesPath/userData
 * 指向 temp，isPackaged=true 走生产路径 baseDir=process.resourcesPath）+ process.platform。零网络、纯本地 fs。
 */

import * as os from 'os';
import * as fsSync from 'fs';
import * as path from 'path';

const ROOT = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-cronet-test-'));
// 生产模式（isPackaged=true）→ getResourcesBaseDir() 返回 process.resourcesPath；指向 temp 下的 resources。
const RESOURCES = path.join(ROOT, 'resources');
Object.defineProperty(process, 'resourcesPath', { value: RESOURCES, configurable: true });

jest.mock('electron', () => ({
  app: {
    getPath: () => ROOT,
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
import { setPlatform, REAL_PLATFORM } from './platform-test-utils';

function setArch(a: string): void {
  Object.defineProperty(process, 'arch', { value: a, configurable: true });
}

/** 平台 → (bundle 目录, cronet 文件名)。生产 baseDir=process.resourcesPath。 */
function dirsFor(platform: NodeJS.Platform): { bundleDir: string; libName: string } {
  if (platform === 'win32')
    return { bundleDir: path.join(RESOURCES, 'win'), libName: 'libcronet.dll' };
  if (platform === 'darwin')
    return { bundleDir: path.join(RESOURCES, 'mac'), libName: 'libcronet.dylib' };
  return { bundleDir: path.join(RESOURCES, 'linux'), libName: 'libcronet.so' };
}

/** 核心加载目录：linux/win 生产经 userData/core_update（getSingBoxPath 优先它，存在 sing-box 时）。 */
function coreUpdateDir(): string {
  return path.join(ROOT, 'core_update');
}

let rm: ResourceManager;

beforeEach(() => {
  // 每用例清空 temp 子目录，避免互相污染。rm **不**在此构造：ResourceManager 在构造函数缓存
  // process.platform/arch，故必须在各用例 setPlatform 之后再 new（见 mkRm）。
  fsSync.rmSync(RESOURCES, { recursive: true, force: true });
  fsSync.rmSync(coreUpdateDir(), { recursive: true, force: true });
});

/** 在当前（已 setPlatform 后的）平台下构造 ResourceManager（构造函数读 process.platform 快照）。 */
function mkRm(): ResourceManager {
  return new ResourceManager();
}

afterAll(() => {
  setPlatform(REAL_PLATFORM);
  try {
    fsSync.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 在 bundleDir 写一个内置 libcronet（指定内容），并返回 dst 加载目录路径。 */
function seedBundle(
  platform: NodeJS.Platform,
  content: string
): { bundleDir: string; libName: string; coreDir: string } {
  const { bundleDir, libName } = dirsFor(platform);
  fsSync.mkdirSync(bundleDir, { recursive: true });
  fsSync.writeFileSync(path.join(bundleDir, libName), content);
  const coreDir = coreUpdateDir();
  fsSync.mkdirSync(coreDir, { recursive: true });
  return { bundleDir, libName, coreDir };
}

describe('ensureCronetHealthy — 缺失/损坏自愈（linux/win 对称）', () => {
  for (const platform of ['linux', 'win32'] as NodeJS.Platform[]) {
    describe(`platform=${platform}`, () => {
      beforeEach(() => {
        setPlatform(platform);
        rm = mkRm();
      });

      it('dst 缺失 → restored', async () => {
        const { coreDir, libName } = seedBundle(platform, 'BUNDLED-CRONET-12345');
        const res = await rm.ensureCronetHealthy(coreDir);
        expect(res.action).toBe('restored');
        expect(fsSync.existsSync(path.join(coreDir, libName))).toBe(true);
        expect(fsSync.readFileSync(path.join(coreDir, libName), 'utf-8')).toBe(
          'BUNDLED-CRONET-12345'
        );
      });

      it('size(dst)≠size(src) → restored（损坏检测核心）', async () => {
        const { coreDir, libName } = seedBundle(platform, 'BUNDLED-CRONET-12345');
        // dst 截断/0 字节：与 bundle 不同 size
        fsSync.writeFileSync(path.join(coreDir, libName), '');
        const res = await rm.ensureCronetHealthy(coreDir);
        expect(res.action).toBe('restored');
        expect(fsSync.readFileSync(path.join(coreDir, libName), 'utf-8')).toBe(
          'BUNDLED-CRONET-12345'
        );
      });

      it('size 相等 → ok 且未调用 sha256（热路径零 hash）', async () => {
        const { coreDir, libName } = seedBundle(platform, 'BUNDLED-CRONET-12345');
        // dst 与 bundle 同 size（均 20 字节）但内容不同 → 热路径只比 size，不该恢复也不该 hash
        fsSync.writeFileSync(path.join(coreDir, libName), 'SAMESIZE-DIFFER-1234');
        const fileHash = require('../../../shared/file-hash');
        const spy = jest.spyOn(fileHash, 'sha256File');
        const res = await rm.ensureCronetHealthy(coreDir);
        expect(res.action).toBe('ok');
        expect(spy).not.toHaveBeenCalled();
        // 内容未被覆盖（确未重拷）
        expect(fsSync.readFileSync(path.join(coreDir, libName), 'utf-8')).toBe(
          'SAMESIZE-DIFFER-1234'
        );
        spy.mockRestore();
      });

      it('strong + size 相等 + hash 不同 → restored（冷路径强校验）', async () => {
        const { coreDir, libName } = seedBundle(platform, 'BUNDLED-CRONET-12345');
        fsSync.writeFileSync(path.join(coreDir, libName), 'SAMESIZE-DIFFER-1234'); // 同 size 不同内容
        const res = await rm.ensureCronetHealthy(coreDir, { strong: true });
        expect(res.action).toBe('restored');
        expect(fsSync.readFileSync(path.join(coreDir, libName), 'utf-8')).toBe(
          'BUNDLED-CRONET-12345'
        );
      });

      it('atomicCopy rename 失败（EACCES）→ failed + 告警，不抛，且清理半残 .tmp', async () => {
        const { coreDir, libName } = seedBundle(platform, 'BUNDLED-CRONET-12345');
        const logs: Array<{ level: string; msg: string }> = [];
        rm.setLogManager({
          addLog: (level: string, msg: string) => logs.push({ level, msg }),
        } as any);
        // 让 fs.promises.rename 抛 EACCES（模拟 AV 锁/只读 resources）
        const fsp = require('fs/promises');
        const spy = jest
          .spyOn(fsp, 'rename')
          .mockRejectedValue(
            Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
          );
        const res = await rm.ensureCronetHealthy(coreDir);
        expect(res.action).toBe('failed');
        expect(res.reason).toMatch(/EACCES/);
        expect(logs.some((l) => l.level === 'warn' && /自愈失败/.test(l.msg))).toBe(true);
        // C 修复：copyFile 已建 .tmp、rename 失败 → catch 清理 .tmp（防跨重启累积）。
        expect(fsSync.existsSync(path.join(coreDir, `${libName}.tmp`))).toBe(false);
        spy.mockRestore();
      });
    });
  }
});

describe('mac-x64：内置无库 → 不误触发自愈（死代码反向约束）', () => {
  beforeEach(() => {
    setPlatform('darwin');
    setArch('x64');
    rm = mkRm();
  });
  afterEach(() => setArch(process.arch));

  it('src 不存在 → ok / no-bundled-lib，绝不创建 dst', async () => {
    // 生产 darwin bundle 目录是 resources/mac，但不写 libcronet.dylib（mac 静态编入，无独立库）
    const coreDir = coreUpdateDir();
    fsSync.mkdirSync(coreDir, { recursive: true });
    const res = await rm.ensureCronetHealthy(coreDir);
    expect(res.action).toBe('ok');
    expect(res.reason).toBe('no-bundled-lib');
    expect(fsSync.existsSync(path.join(coreDir, 'libcronet.dylib'))).toBe(false);
  });

  it('getCronetLibStatus 仍 available（darwin 静态编入恒可用）', async () => {
    // darwin getCronetLibStatus 走静态编入分支恒 available，不受 ensureCronetHealthy 影响
    expect(rm.getCronetLibStatus()).toBe('available');
  });
});

describe('getCronetLibStatus — size 判据', () => {
  it('linux：dst size≠bundle → copy-failed', async () => {
    setPlatform('linux');
    rm = mkRm();
    const { coreDir, libName } = seedBundle('linux', 'BUNDLED-CRONET-12345');
    // 写一个可执行 sing-box 让 getSingBoxPath 解析到 core_update 目录（linux 优先它）
    fsSync.writeFileSync(path.join(coreDir, 'sing-box'), 'BIN');
    fsSync.chmodSync(path.join(coreDir, 'sing-box'), 0o755);
    // dst libcronet 损坏（size≠bundle）
    fsSync.writeFileSync(path.join(coreDir, libName), '');
    expect(rm.getCronetLibStatus()).toBe('copy-failed');
  });

  it('linux：dst size==bundle → available', async () => {
    setPlatform('linux');
    rm = mkRm();
    const { coreDir, libName } = seedBundle('linux', 'BUNDLED-CRONET-12345');
    fsSync.writeFileSync(path.join(coreDir, 'sing-box'), 'BIN');
    fsSync.chmodSync(path.join(coreDir, 'sing-box'), 0o755);
    fsSync.writeFileSync(path.join(coreDir, libName), 'SAME-SIZE-CONTENT-XX'); // 同 size
    expect(rm.getCronetLibStatus()).toBe('available');
  });
});
