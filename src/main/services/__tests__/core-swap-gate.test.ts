/**
 * core-swap 手动轴门控单测（T1 + T2，本会话改动）。
 *
 * 背景：内核二进制替换窗口（installCoreFromDir / 手动替换 / 回滚 写核期间）须拒绝手动 start/restart/switchMode，
 *   防撞半替换核致 sing-box FATAL。门控分两层：
 *
 * T1 ProxyManager 门控（src/main/services/ProxyManager.ts）：
 *   - setCoreSwapInProgress(b)：置/清 private coreSwapInProgress 字段（CoreUpdateService 调）。
 *   - rejectIfCoreSwapInProgress(action)：true → 抛带 CORE_UPDATE_IN_PROGRESS code 的 Error；false → 放行。
 *   - 真实调用方：startInternal（start 经之）+ switchMode 开头各调一次。
 *
 * T2 CoreUpdateService 4 写核路径 try/finally 置位/清位（src/main/services/CoreUpdateService.ts）：
 *   - updateCore / tryApplyStaged / replaceManualCore / rollbackCore 均在写核前 setCoreSwapInProgress(true)、
 *     finally 清 false（含异常路径）。验 spy setCoreSwapInProgress 调用序：true → install 执行 → false（异常也清）。
 *
 * 参考 core-update-scheduler.test.ts 的 makeSvc mock + spy private 模式。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

// T1 用临时目录（ProxyManager 构造需 configPath）
const TMP_PM = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-gate-pm-'));

jest.mock('electron', () => ({
  app: {
    getPath: () => TMP_PM,
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => TMP_PM,
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
  dialog: { showOpenDialog: jest.fn() },
}));

// ResourceManager 含 electron 间接依赖；T2 落位路径会读 getSingBoxUpdateTargetPath。
jest.mock('../ResourceManager', () => ({
  resourceManager: {
    getSingBoxPath: () => '/tmp/flowz-fake/sing-box',
    getSingBoxUpdateTargetPath: () => '/tmp/flowz-fake/sing-box',
    getBundledSingBoxPath: () => '/tmp/flowz-fake/sing-box-bundled',
    ensureCronetBeside: jest.fn(),
  },
}));

import { ProxyManager } from '../ProxyManager';
import { CoreUpdateService } from '../CoreUpdateService';
import { ProxyErrorCode } from '../../../shared/types';
import type { UserConfig } from '../../../shared/types';
import coreManifest from '../../../shared/core-manifest.json';

afterAll(() => {
  try {
    fsSync.rmSync(TMP_PM, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ============================================================================
// T1：ProxyManager core-swap 门控
// ============================================================================

describe('T1：ProxyManager core-swap 手动轴门控', () => {
  function makeSvc(): any {
    const configPath = path.join(TMP_PM, `pm-${Math.random().toString(36).slice(2)}.json`);
    return new ProxyManager(undefined, undefined, configPath, '/fake/sing-box');
  }

  function makeConfig(): UserConfig {
    return {
      servers: [],
      selectedServerId: null,
      proxyMode: 'smart',
      proxyModeType: 'systemProxy',
      tunConfig: { enable: false } as any,
      customRules: [],
      appRules: [],
      autoStart: false,
      silentStart: false,
      autoConnect: false,
      minimizeToTray: false,
      autoCheckUpdate: false,
      autoLightweightMode: false,
      autoUpdateSubscriptionOnStart: false,
      socksPort: 1080,
      httpPort: 1081,
      logLevel: 'info',
    } as UserConfig;
  }

  it('setCoreSwapInProgress 置/清 private coreSwapInProgress 字段', () => {
    const svc = makeSvc();
    expect(svc.coreSwapInProgress).toBe(false); // 初始 false
    svc.setCoreSwapInProgress(true);
    expect(svc.coreSwapInProgress).toBe(true);
    svc.setCoreSwapInProgress(false);
    expect(svc.coreSwapInProgress).toBe(false);
  });

  it('rejectIfCoreSwapInProgress：置位时抛带 CORE_UPDATE_IN_PROGRESS code 的 Error', () => {
    const svc = makeSvc();
    svc.setCoreSwapInProgress(true);
    expect(() => svc.rejectIfCoreSwapInProgress('启动代理')).toThrow(/内核更新进行中/);
    let threw: any;
    try {
      svc.rejectIfCoreSwapInProgress('启动代理');
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    expect(threw.code).toBe(ProxyErrorCode.CORE_UPDATE_IN_PROGRESS);
  });

  it('rejectIfCoreSwapInProgress：未置位时放行（不抛）', () => {
    const svc = makeSvc();
    svc.setCoreSwapInProgress(false);
    expect(() => svc.rejectIfCoreSwapInProgress('启动代理')).not.toThrow();
  });

  it('start（经 startInternal）：置位时被门控拒绝、抛 CORE_UPDATE_IN_PROGRESS', async () => {
    const svc = makeSvc();
    svc.setCoreSwapInProgress(true);
    // start 公开方法开头即 startInternal → rejectIfCoreSwapInProgress；不应触达 sing-box 启动
    await expect(svc.start(makeConfig())).rejects.toThrow(/内核更新进行中/);
    // 再验 code 透传
    await expect(svc.start(makeConfig())).rejects.toMatchObject({
      code: ProxyErrorCode.CORE_UPDATE_IN_PROGRESS,
    });
  });

  it('switchMode：置位时被门控拒绝（代理未运行时门控在前，不会触 sing-box）', async () => {
    const svc = makeSvc();
    svc.setCoreSwapInProgress(true);
    // 代理未运行（未 start）→ switchMode 开头 rejectIfCoreSwapInProgress 先抛
    await expect(svc.switchMode(makeConfig())).rejects.toThrow(/内核更新进行中/);
    await expect(svc.switchMode(makeConfig())).rejects.toMatchObject({
      code: ProxyErrorCode.CORE_UPDATE_IN_PROGRESS,
    });
  });

  it('switchMode：清位后放行（代理未运行 → 仅更新 currentConfig，不抛、不触 sing-box）', async () => {
    const svc = makeSvc();
    svc.setCoreSwapInProgress(false);
    const cfg = makeConfig();
    await expect(svc.switchMode(cfg)).resolves.toBeUndefined();
    // 代理未运行分支：仅 currentConfig = newConfig
    expect(svc.currentConfig).toBe(cfg);
  });
});

// ============================================================================
// T2：CoreUpdateService 4 写核路径 try/finally 置位/清位 setCoreSwapInProgress
// ============================================================================

describe('T2：CoreUpdateService 4 写核路径 setCoreSwapInProgress try/finally', () => {
  function makeLogManager() {
    return { addLog: jest.fn() } as any;
  }

  /** 真实临时 staged 目录 + sing-box 文件（tryApplyStaged 落位路径需 staged.dir 存文件）。 */
  const stagedDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-gate-staged-'));
  const coreName = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  fsSync.writeFileSync(path.join(stagedDir, coreName), 'fake-core');

  afterAll(() => {
    try {
      fsSync.rmSync(stagedDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /**
   * 构造 proxy spy 捕获 setCoreSwapInProgress 调用序列。
   * running=false 避免 tryApplyStaged/replaceManualCore 的「代理运行中 deferred/停代理」分支（聚焦门控）。
   */
  function makeProxyWithSpy() {
    const calls: boolean[] = [];
    const proxy = {
      getStatus: jest.fn(() => ({ running: false })),
      getCoreVersion: jest.fn().mockResolvedValue('1.13.13'),
      buildPreflightConfigJson: () => null,
      hasNaiveNodes: () => false,
      setAutoRestartSuppressed: jest.fn(),
      setCoreSwapInProgress: jest.fn((b: boolean) => calls.push(b)),
      stop: jest.fn().mockResolvedValue(undefined),
      start: jest.fn().mockResolvedValue(undefined),
    } as any;
    return { proxy, calls };
  }

  function makeSvc(proxy: any) {
    const svc = new CoreUpdateService(makeLogManager());
    svc.setProxyManager(proxy);
    svc.setConfigProvider(() => Promise.resolve({ autoUpdateCore: true } as any));
    svc.setEventSender(() => {});
    // rollbackCore 在 win32 分支经 privilegeService.copyFileElevated 写核（生产由 index.ts 无条件注入）；
    // 非 win32 分支直接 fs.copyFileSync。注入等价 stub（复刻 service 首步 copyFileSync），使 copySpy 计数
    // 与 'disk full' 抛错传播在 windows/linux/mac runner 上一致。
    svc.setPrivilegeService({
      copyFileElevated: async (src: string, dest: string) => {
        require('fs').copyFileSync(src, dest);
      },
    } as any);
    return svc;
  }

  afterEach(() => jest.restoreAllMocks());

  // --- updateCore：line 290-297 try installCoreFromDir / finally 清位 ---
  it('updateCore：install 成功 → setCoreSwapInProgress(true) → install → finally false', async () => {
    const { proxy, calls } = makeProxyWithSpy();
    const svc = makeSvc(proxy);
    jest.spyOn((svc as any).coreDownloader, 'downloadFile').mockResolvedValue('/tmp/fake.tar.gz');
    // 换核完整性门：updateCore 取不到官方 sha256 就拒装。本 suite 只关心 coreSwapInProgress 闩，
    // 故让摘要解析成功；「取不到摘要必须拒装」由 core-downloader-integrity / 下方专测覆盖。
    jest.spyOn(svc as any, 'resolveAssetSha256').mockResolvedValue('a'.repeat(64));
    jest
      .spyOn((svc as any).coreDownloader, 'extractCore')
      .mockResolvedValue({ corePath: '/tmp/x/sing-box', extractDir: '/tmp/x' });
    jest
      .spyOn(svc as any, 'preflightValidate')
      .mockResolvedValue({ ok: true, version: '1.13.14', versionLine: 'sing-box version 1.13.14' });
    const installSpy = jest.spyOn(svc as any, 'installCoreFromDir').mockResolvedValue(undefined);
    jest.spyOn(svc as any, 'saveAutoState').mockImplementation(() => {});

    await svc.updateCore('https://x/sing-box.tar.gz');

    expect(installSpy).toHaveBeenCalledTimes(1);
    // 序列：true（置位）→ ... → false（finally 清位）
    expect(calls).toEqual([true, false]);
  });

  it('updateCore：install 抛错 → finally 仍清位（[true, false]，不挂死闩）', async () => {
    const { proxy, calls } = makeProxyWithSpy();
    const svc = makeSvc(proxy);
    jest.spyOn((svc as any).coreDownloader, 'downloadFile').mockResolvedValue('/tmp/fake.tar.gz');
    // 换核完整性门：updateCore 取不到官方 sha256 就拒装。本 suite 只关心 coreSwapInProgress 闩，
    // 故让摘要解析成功；「取不到摘要必须拒装」由 core-downloader-integrity / 下方专测覆盖。
    jest.spyOn(svc as any, 'resolveAssetSha256').mockResolvedValue('a'.repeat(64));
    jest
      .spyOn((svc as any).coreDownloader, 'extractCore')
      .mockResolvedValue({ corePath: '/tmp/x/sing-box', extractDir: '/tmp/x' });
    jest
      .spyOn(svc as any, 'preflightValidate')
      .mockResolvedValue({ ok: true, version: '1.13.14', versionLine: 'sing-box version 1.13.14' });
    jest.spyOn(svc as any, 'installCoreFromDir').mockRejectedValue(new Error('disk full'));
    // restoreBackup 在 catch 兜底（已备份才调，此处 install 失败前未备份 → 不调）
    const restoreSpy = jest.spyOn(svc as any, 'restoreBackup').mockResolvedValue(undefined);

    await expect(svc.updateCore('https://x/sing-box.tar.gz')).rejects.toThrow('disk full');
    // 关键不变量：异常路径 finally 仍清位
    expect(calls).toEqual([true, false]);
    expect(restoreSpy).not.toHaveBeenCalled(); // 未备份不误恢复陈旧 .bak
  });

  // --- tryApplyStaged：line 850-863 setCoreSwapInProgress(true) → try install → catch restore → finally false ---
  it('tryApplyStaged：install 成功 → [true, false]', async () => {
    const { proxy, calls } = makeProxyWithSpy();
    const svc = makeSvc(proxy);
    jest.spyOn(svc as any, 'loadAutoState').mockReturnValue({
      staged: { version: '1.13.14', dir: stagedDir, stagedAt: 'now' },
    });
    jest.spyOn(svc as any, 'clearStaged').mockImplementation(() => {});
    jest.spyOn(svc as any, 'emitAutoStatus').mockImplementation(() => {});
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue('1.13.13');
    jest.spyOn(svc as any, 'isKnownBad').mockReturnValue(false);
    jest
      .spyOn(svc as any, 'preflightValidate')
      .mockResolvedValue({ ok: true, version: '1.13.14', versionLine: 'sing-box version 1.13.14' });
    jest.spyOn(svc as any, 'hasBackup').mockReturnValue(true);
    const installSpy = jest.spyOn(svc as any, 'installCoreFromDir').mockResolvedValue(undefined);

    const r = await svc.tryApplyStaged('proxy-stopped');
    expect(r).toBe('applied');
    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([true, false]);
  });

  it('tryApplyStaged：install 抛错（已备份）→ restoreBackup + finally 清位 [true, false]', async () => {
    const { proxy, calls } = makeProxyWithSpy();
    const svc = makeSvc(proxy);
    jest.spyOn(svc as any, 'loadAutoState').mockReturnValue({
      staged: { version: '1.13.14', dir: stagedDir, stagedAt: 'now' },
    });
    jest.spyOn(svc as any, 'clearStaged').mockImplementation(() => {});
    jest.spyOn(svc as any, 'emitAutoStatus').mockImplementation(() => {});
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue('1.13.13');
    jest.spyOn(svc as any, 'isKnownBad').mockReturnValue(false);
    jest
      .spyOn(svc as any, 'preflightValidate')
      .mockResolvedValue({ ok: true, version: '1.13.14', versionLine: 'sing-box version 1.13.14' });
    jest.spyOn(svc as any, 'installCoreFromDir').mockImplementation(async (...args: any[]) => {
      const onBackupDone = args[2] as (() => void) | undefined;
      onBackupDone?.(); // 备份完成
      throw new Error('mid-copy fail');
    });
    const restoreSpy = jest.spyOn(svc as any, 'restoreBackup').mockResolvedValue(undefined);

    const r = await svc.tryApplyStaged('proxy-stopped');
    expect(r).toBe('failed');
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    // 关键：异常路径 finally 仍清位
    expect(calls).toEqual([true, false]);
  });

  // --- replaceManualCore：line 1213-1234 setCoreSwapInProgress(true) → try backup+写核 → finally false ---
  it('replaceManualCore：写核成功 → [true, false]', async () => {
    const { proxy, calls } = makeProxyWithSpy();
    const svc = makeSvc(proxy);
    jest
      .spyOn(svc as any, 'preflightValidate')
      .mockResolvedValue({ ok: true, version: '1.13.14', versionLine: 'sing-box version 1.13.14' });
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue('1.13.13');
    jest.spyOn(svc as any, 'backupCurrentCore').mockResolvedValue(undefined);
    // 非 macOS 走 writeManualCoreToBundle 腿
    const writeSpy = jest.spyOn(svc as any, 'writeManualCoreToBundle').mockResolvedValue(undefined);
    jest.spyOn(svc as any, 'armPendingValidation').mockImplementation(() => {});
    jest.spyOn(svc as any, 'recordSuccessfulVersion').mockResolvedValue(undefined);

    const r = await svc.replaceManualCore({ filePath: '/tmp/chosen-sing-box', force: true });
    expect(r.ok).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([true, false]);
  });

  it('replaceManualCore：写核抛错 → finally 仍清位 [true, false]', async () => {
    const { proxy, calls } = makeProxyWithSpy();
    const svc = makeSvc(proxy);
    jest
      .spyOn(svc as any, 'preflightValidate')
      .mockResolvedValue({ ok: true, version: '1.13.14', versionLine: 'sing-box version 1.13.14' });
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue('1.13.13');
    jest.spyOn(svc as any, 'backupCurrentCore').mockResolvedValue(undefined);
    jest.spyOn(svc as any, 'writeManualCoreToBundle').mockRejectedValue(new Error('write fail'));
    jest.spyOn(svc as any, 'disarmPendingValidation').mockImplementation(() => {});
    jest.spyOn(svc as any, 'restoreBackup').mockResolvedValue(undefined);

    const r = await svc.replaceManualCore({ filePath: '/tmp/chosen-sing-box', force: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/write fail/);
    expect(calls).toEqual([true, false]);
  });

  // --- rollbackCore：line 1082-1149 setCoreSwapInProgress(true) → try 写核 → finally false ---
  it('rollbackCore：回滚成功 → [true, false]', async () => {
    const { proxy, calls } = makeProxyWithSpy();
    const svc = makeSvc(proxy);
    jest.spyOn(svc as any, 'hasBackup').mockReturnValue(true);
    jest.spyOn(svc as any, 'getBackupPath').mockReturnValue('/tmp/sing-box.bak');
    // 非受保护目录分支（isProtectedCoreActive=false）→ 普通 copy
    jest.spyOn(svc as any, 'isProtectedCoreActive').mockResolvedValue(false);
    // copyFileSync 走真实 fs（备份路径不存在会抛）→ mock resourceManager 已返固定路径，改 spy fs.copyFileSync
    const fs = require('fs');
    const copySpy = jest.spyOn(fs, 'copyFileSync').mockImplementation(() => {});
    const chmodSpy = jest.spyOn(fs, 'chmodSync').mockImplementation(() => {});
    const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    jest.spyOn(svc as any, 'recordSuccessfulVersion').mockResolvedValue(undefined);
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue('1.13.13');
    jest.spyOn(svc as any, 'saveAutoState').mockImplementation(() => {});

    await svc.rollbackCore();
    expect(copySpy).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([true, false]);
    copySpy.mockRestore();
    chmodSpy.mockRestore();
    unlinkSpy.mockRestore();
  });

  it('rollbackCore：写核抛错 → finally 仍清位 [true, false]', async () => {
    const { proxy, calls } = makeProxyWithSpy();
    const svc = makeSvc(proxy);
    jest.spyOn(svc as any, 'hasBackup').mockReturnValue(true);
    jest.spyOn(svc as any, 'getBackupPath').mockReturnValue('/tmp/sing-box.bak');
    jest.spyOn(svc as any, 'isProtectedCoreActive').mockResolvedValue(false);
    const fs = require('fs');
    // copyFileSync 抛错（模拟磁盘故障）
    jest.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    jest.spyOn(fs, 'chmodSync').mockImplementation(() => {});
    jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    await expect(svc.rollbackCore()).rejects.toThrow('disk full');
    // 关键：异常路径 finally 仍清位
    expect(calls).toEqual([true, false]);
  });
});

// ============================================================================
// T3：replaceManualCore skipBackup 分支（resetCoreToFactory 复用）
// ============================================================================
//
// 背景：reset 到出厂核时 skipBackup=true，现役核是用户要丢弃的、出厂核已知稳定 →
//   1. 不 backupCurrentCore（backupMade 始终 false）；
//   2. 不 armPendingValidation（无备份可 autoRollback）→ 改 recordSuccessfulVersion；
//   3. catch 不 restoreBackup（backupMade=false，无陈旧 .bak 可恢复）。
// 对照：skipBackup=false（手动替换）行为不变（backup + arm + catch restore）。
//
// 注意：arm/record 分支在 wasRunning=true 时才生效（line 1246），故 T3 用 running:true 的 proxy。

describe('T3：replaceManualCore skipBackup 分支（reset 到出厂）', () => {
  function makeLogManager() {
    return { addLog: jest.fn() } as any;
  }

  /** running=true 触发 wasRunning 分支（arm/record + 重启）；calls 仍记录门控序列。 */
  function makeProxyWithSpy() {
    const calls: boolean[] = [];
    const proxy = {
      getStatus: jest.fn(() => ({ running: true })),
      getCoreVersion: jest.fn().mockResolvedValue('1.13.13'),
      buildPreflightConfigJson: () => null,
      hasNaiveNodes: () => false,
      setAutoRestartSuppressed: jest.fn(),
      setCoreSwapInProgress: jest.fn((b: boolean) => calls.push(b)),
      stop: jest.fn().mockResolvedValue(undefined),
      start: jest.fn().mockResolvedValue(undefined),
    } as any;
    return { proxy, calls };
  }

  function makeSvc(proxy: any) {
    const svc = new CoreUpdateService(makeLogManager());
    svc.setProxyManager(proxy);
    svc.setConfigProvider(() => Promise.resolve({ autoUpdateCore: true } as any));
    svc.setEventSender(() => {});
    return svc;
  }

  afterEach(() => jest.restoreAllMocks());

  // --- skipBackup=true：不备份现役核 ---
  it('skipBackup=true：backupCurrentCore 未被调（backupMade 始终 false）', async () => {
    const { proxy } = makeProxyWithSpy();
    const svc = makeSvc(proxy);
    jest
      .spyOn(svc as any, 'preflightValidate')
      .mockResolvedValue({ ok: true, version: '1.13.14', versionLine: 'sing-box version 1.13.14' });
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue('1.13.13');
    const backupSpy = jest.spyOn(svc as any, 'backupCurrentCore').mockResolvedValue(undefined);
    jest.spyOn(svc as any, 'writeManualCoreToBundle').mockResolvedValue(undefined);
    jest.spyOn(svc as any, 'armPendingValidation').mockImplementation(() => {});
    jest.spyOn(svc as any, 'recordSuccessfulVersion').mockResolvedValue(undefined);

    const r = await svc.replaceManualCore({
      filePath: '/tmp/factory-sing-box',
      force: true,
      skipBackup: true,
    });
    expect(r.ok).toBe(true);
    // 核心断言：出厂核已知稳定、现役核要丢弃 → 不备份
    expect(backupSpy).not.toHaveBeenCalled();
  });

  // --- skipBackup=true：不 arm 验证闩，改 record 成功版本 ---
  it('skipBackup=true：armPendingValidation 未被调、recordSuccessfulVersion 被调', async () => {
    const { proxy } = makeProxyWithSpy();
    const svc = makeSvc(proxy);
    jest
      .spyOn(svc as any, 'preflightValidate')
      .mockResolvedValue({ ok: true, version: '1.13.14', versionLine: 'sing-box version 1.13.14' });
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue('1.13.13');
    jest.spyOn(svc as any, 'backupCurrentCore').mockResolvedValue(undefined);
    jest.spyOn(svc as any, 'writeManualCoreToBundle').mockResolvedValue(undefined);
    const armSpy = jest.spyOn(svc as any, 'armPendingValidation').mockImplementation(() => {});
    const recordSpy = jest
      .spyOn(svc as any, 'recordSuccessfulVersion')
      .mockResolvedValue(undefined);

    const r = await svc.replaceManualCore({
      filePath: '/tmp/factory-sing-box',
      force: true,
      skipBackup: true,
    });
    expect(r.ok).toBe(true);
    // 出厂核无备份可 autoRollback → 不 arm 验证闩；直接 record 成功版本
    expect(armSpy).not.toHaveBeenCalled();
    expect(recordSpy).toHaveBeenCalledTimes(1);
  });

  // --- skipBackup=true：写核抛错时 catch 不 restore（无备份可恢复）---
  it('skipBackup=true：写核抛错 → restoreBackup 未被调（backupMade=false）', async () => {
    const { proxy } = makeProxyWithSpy();
    const svc = makeSvc(proxy);
    jest
      .spyOn(svc as any, 'preflightValidate')
      .mockResolvedValue({ ok: true, version: '1.13.14', versionLine: 'sing-box version 1.13.14' });
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue('1.13.13');
    // 未 spy backupCurrentCore → 走真实路径前因 skipBackup=true 根本不进 backup 分支，backupMade=false
    jest.spyOn(svc as any, 'writeManualCoreToBundle').mockRejectedValue(new Error('write fail'));
    jest.spyOn(svc as any, 'disarmPendingValidation').mockImplementation(() => {});
    const restoreSpy = jest.spyOn(svc as any, 'restoreBackup').mockResolvedValue(undefined);

    const r = await svc.replaceManualCore({
      filePath: '/tmp/factory-sing-box',
      force: true,
      skipBackup: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/write fail/);
    // 关键不变量：未备份（backupMade=false）→ 不误恢复陈旧/不存在的 .bak
    expect(restoreSpy).not.toHaveBeenCalled();
  });

  // --- 对照：skipBackup=false（手动替换）正常 backup + arm ---
  // 用「写核成功」路径覆盖 arm（arm 在写核成功后的 wasRunning 分支才执行）；
  // catch restore 由上方 305 行既有用例覆盖，此处聚焦 skipBackup 分支对称性。
  it('skipBackup=false：backupCurrentCore + armPendingValidation 正常触发（对照 skipBackup=true）', async () => {
    const { proxy } = makeProxyWithSpy();
    const svc = makeSvc(proxy);
    jest
      .spyOn(svc as any, 'preflightValidate')
      .mockResolvedValue({ ok: true, version: '1.13.14', versionLine: 'sing-box version 1.13.14' });
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue('1.13.13');
    const backupSpy = jest.spyOn(svc as any, 'backupCurrentCore').mockResolvedValue(undefined);
    jest.spyOn(svc as any, 'writeManualCoreToBundle').mockResolvedValue(undefined);
    const armSpy = jest.spyOn(svc as any, 'armPendingValidation').mockImplementation(() => {});
    const recordSpy = jest
      .spyOn(svc as any, 'recordSuccessfulVersion')
      .mockResolvedValue(undefined);

    const r = await svc.replaceManualCore({
      filePath: '/tmp/manual-sing-box',
      force: true,
      skipBackup: false,
    });
    expect(r.ok).toBe(true);
    // 对照断言：手动替换走完整备份+验证闩链路（与 skipBackup=true 不备份/不 arm 对称）
    expect(backupSpy).toHaveBeenCalledTimes(1);
    expect(armSpy).toHaveBeenCalledTimes(1);
    // wasRunning=true + 有备份 → arm 分支，不走 record（record 是 skipBackup 或未运行时才走）
    expect(recordSpy).not.toHaveBeenCalled();
  });

  // --- resetCoreToFactory 成功后清理旧备份 ---
  // 验证 reset 到出厂的两个语义：① 不备份现役核（skipBackup=true，上方用例已覆盖）
  // ② 写核成功后调 pruneBackup 清理残留 .bak（reset = 干净状态，旧备份无意义）。
  // 直接 spy replaceManualCore（mock 返回 { ok: true }）+ spy pruneBackup，
  // 断言 pruneBackup 被调 1 次（避免触达 replaceManualCore 内部 fs/重启副作用）。
  it('resetCoreToFactory 成功后清理旧备份：pruneBackup 被调 1 次', async () => {
    const { proxy } = makeProxyWithSpy();
    const svc = makeSvc(proxy);
    // replaceManualCore 是 reset 的核心落位腿；mock 返回 ok 走「成功后清理」分支
    const replaceSpy = jest.spyOn(svc as any, 'replaceManualCore').mockResolvedValue({ ok: true });
    // pruneBackup 是清理旧 .bak 的私有方法；mock 避免触达真实 fs（getBackupPath/unlink）
    const pruneSpy = jest.spyOn(svc as any, 'pruneBackup').mockImplementation(() => {});
    // 出厂核完整性门：真实出厂核路径在测试环境下当然对不上 pin（无该文件/内容不符）→ 会先行拒绝。
    // 本 suite 关心的是换核闩与 pruneBackup 调用，故让门放行；「门本身拒不拒」由
    // core-reset-factory-verify.test.ts 覆盖（含 macOS 必须跳过那一格）。
    jest.spyOn(svc as any, 'verifyFactoryCore').mockReturnValue(null);

    const r = await svc.resetCoreToFactory();

    expect(r.ok).toBe(true);
    // 落位腿：reset 强制 force+skipBackup 传 bundled 核路径
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledWith({
      filePath: expect.any(String),
      force: true,
      skipBackup: true,
    });
    // 关键断言：成功后清理残留 .bak
    expect(pruneSpy).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// T4：replaceManualCore B-2 基线预判（诚实告知）+ B-3 来源识别（build 回传）
// ============================================================================

describe('T4：replaceManualCore B-2 基线预判 + B-3 来源识别', () => {
  function makeLogManager() {
    return { addLog: jest.fn() } as any;
  }

  // running=false：不走停代理/arm 分支，聚焦预判逻辑与返回值（build/baselineOverride）。
  function makeProxy() {
    return {
      getStatus: jest.fn(() => ({ running: false })),
      getCoreVersion: jest.fn().mockResolvedValue(coreManifest.bundledCoreVersion),
      buildPreflightConfigJson: () => null,
      hasNaiveNodes: () => false,
      setAutoRestartSuppressed: jest.fn(),
      setCoreSwapInProgress: jest.fn(),
      stop: jest.fn().mockResolvedValue(undefined),
      start: jest.fn().mockResolvedValue(undefined),
    } as any;
  }

  function makeSvc(proxy: any) {
    const svc = new CoreUpdateService(makeLogManager());
    svc.setProxyManager(proxy);
    svc.setConfigProvider(() => Promise.resolve({ autoUpdateCore: true } as any));
    svc.setEventSender(() => {});
    return svc;
  }

  // 官方核，旧于随包基线（coreManifest.bundledCoreVersion，测试动态读取，注释不写死具体版本防过期）。
  const OLDER_OFFICIAL = '1.13.13';

  afterEach(() => jest.restoreAllMocks());

  it('官方核旧于随包基线（未 force）→ baselineOverride，预判在写核前返回、现役核不动', async () => {
    const svc = makeSvc(makeProxy());
    jest.spyOn(svc as any, 'preflightValidate').mockResolvedValue({
      ok: true,
      version: OLDER_OFFICIAL,
      versionLine: `sing-box version ${OLDER_OFFICIAL}`,
    });
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue(coreManifest.bundledCoreVersion);
    const backupSpy = jest.spyOn(svc as any, 'backupCurrentCore').mockResolvedValue(undefined);
    const writeSpy = jest.spyOn(svc as any, 'writeManualCoreToBundle').mockResolvedValue(undefined);

    const r = await svc.replaceManualCore({ filePath: '/tmp/old-official' });
    expect(r).toEqual({
      ok: false,
      needConfirm: true,
      baselineOverride: true,
      uploadVersion: OLDER_OFFICIAL,
      bundledVersion: coreManifest.bundledCoreVersion,
      filePath: '/tmp/old-official',
    });
    // 预判先于停代理/备份/写核返回 → 现役核不动（永不 brick）
    expect(backupSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('官方核旧于基线 + force → 越过预判正常替换，build=official（临时用到下次连接）', async () => {
    const svc = makeSvc(makeProxy());
    jest.spyOn(svc as any, 'preflightValidate').mockResolvedValue({
      ok: true,
      version: OLDER_OFFICIAL,
      versionLine: `sing-box version ${OLDER_OFFICIAL}`,
    });
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue(coreManifest.bundledCoreVersion);
    jest.spyOn(svc as any, 'backupCurrentCore').mockResolvedValue(undefined);
    const writeSpy = jest.spyOn(svc as any, 'writeManualCoreToBundle').mockResolvedValue(undefined);
    jest.spyOn(svc as any, 'recordSuccessfulVersion').mockResolvedValue(undefined);

    const r = await svc.replaceManualCore({ filePath: '/tmp/old-official', force: true });
    expect(r).toEqual({ ok: true, build: 'official' });
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('官方核新于基线（未 force）→ 不触发预判，正常替换，build=official', async () => {
    const svc = makeSvc(makeProxy());
    jest.spyOn(svc as any, 'preflightValidate').mockResolvedValue({
      ok: true,
      version: '2.0.0',
      versionLine: 'sing-box version 2.0.0',
    });
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue(coreManifest.bundledCoreVersion);
    jest.spyOn(svc as any, 'backupCurrentCore').mockResolvedValue(undefined);
    const writeSpy = jest.spyOn(svc as any, 'writeManualCoreToBundle').mockResolvedValue(undefined);
    jest.spyOn(svc as any, 'recordSuccessfulVersion').mockResolvedValue(undefined);

    const r = await svc.replaceManualCore({ filePath: '/tmp/newer-official' });
    expect(r).toEqual({ ok: true, build: 'official' });
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('fork 核旧于基线（未 force）→ 不触发 baselineOverride（fork 恒 keep），成功 build=fork（B-3）', async () => {
    const svc = makeSvc(makeProxy());
    jest.spyOn(svc as any, 'preflightValidate').mockResolvedValue({
      ok: true,
      version: '1.13.3-nekolsd',
      versionLine: 'sing-box version 1.13.3-nekolsd',
    });
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue(coreManifest.bundledCoreVersion);
    jest.spyOn(svc as any, 'backupCurrentCore').mockResolvedValue(undefined);
    const writeSpy = jest.spyOn(svc as any, 'writeManualCoreToBundle').mockResolvedValue(undefined);
    jest.spyOn(svc as any, 'recordSuccessfulVersion').mockResolvedValue(undefined);

    const r = await svc.replaceManualCore({ filePath: '/tmp/fork-core' });
    expect(r).toEqual({ ok: true, build: 'fork' });
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('官方 dev 核（X.Y.Z-alpha.N-hex）旧于基线（未 force）→ baselineOverride（M-1：闸门用 comparable 形防完整后缀污染比较）', async () => {
    const svc = makeSvc(makeProxy());
    // 1.13.0-rc.1-abcdef1：OFFICIAL_DEV(base+prerelease+短hex) 判 official；跨 minor 旧于任何 1.14.x 基线（不依赖基线具体 alpha 号）
    jest.spyOn(svc as any, 'preflightValidate').mockResolvedValue({
      ok: true,
      version: '1.13.0-rc.1-abcdef1',
      versionLine: 'sing-box version 1.13.0-rc.1-abcdef1',
    });
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue(coreManifest.bundledCoreVersion);
    const writeSpy = jest.spyOn(svc as any, 'writeManualCoreToBundle').mockResolvedValue(undefined);

    const r = await svc.replaceManualCore({ filePath: '/tmp/dev-core' });
    // comparable 截断 -abcdef1 → 1.13.0-rc.1 < 基线 → 预判触发；uploadVersion 展示仍是完整 token
    expect(r).toEqual({
      ok: false,
      needConfirm: true,
      baselineOverride: true,
      uploadVersion: '1.13.0-rc.1-abcdef1',
      bundledVersion: coreManifest.bundledCoreVersion,
      filePath: '/tmp/dev-core',
    });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('unknown 核（X.Y 两段，过预检但非 X.Y.Z）→ 不触发 baselineOverride，成功 build=unknown（B-3 文案仅告知来源、不谎报禁用）', async () => {
    const svc = makeSvc(makeProxy());
    jest.spyOn(svc as any, 'preflightValidate').mockResolvedValue({
      ok: true,
      version: '1.14',
      versionLine: 'sing-box version 1.14',
    });
    jest.spyOn(svc as any, 'getCurrentVersion').mockResolvedValue(coreManifest.bundledCoreVersion);
    jest.spyOn(svc as any, 'backupCurrentCore').mockResolvedValue(undefined);
    const writeSpy = jest.spyOn(svc as any, 'writeManualCoreToBundle').mockResolvedValue(undefined);
    jest.spyOn(svc as any, 'recordSuccessfulVersion').mockResolvedValue(undefined);

    const r = await svc.replaceManualCore({ filePath: '/tmp/unknown-core' });
    // unknown 恒 keep（decideCoreOverride 不 reseed）→ 无 baselineOverride；成功回传 build=unknown
    expect(r).toEqual({ ok: true, build: 'unknown' });
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});
