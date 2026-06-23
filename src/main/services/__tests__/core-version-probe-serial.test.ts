/**
 * `sing-box version` 探测串行化单测（issue #150：缩小并发探测与启动期换核写盘的 race 窗口）。
 *
 * 所有版本探测（startInternal 检测/换核重读/CoreUpdateService 检查/关于页）汇流 ProxyManager.spawnCoreVersionFirstLine，
 * 经 versionProbeChain 串行排队 → 任一时刻至多一个 version 子进程 execve 内核二进制。并发探测会同时占用二进制，
 * 与原地 copyFile 换核并发即 ETXTBSY 高发；串行化把「同时占用」收敛为「逐个占用」。
 *
 * 全 mock、零真进程：mock child_process.exec 记录在飞并发数，断言并发 N 次 getCoreVersion(force) → maxInFlight===1。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-ver-serial-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {
    static isSupported() {
      return false;
    }
  },
  shell: { openExternal: jest.fn(() => Promise.resolve()) },
  net: {},
  session: {},
}));

jest.mock('../ResourceManager', () => ({
  resourceManager: {
    ensureWritableCore: jest.fn(async () => '/fake/sing-box'),
    getSingBoxPath: jest.fn(() => '/fake/sing-box'),
  },
}));

// child_process.exec mock：每次「在飞」追踪并发峰值；setTimeout 制造 await 间隙——未串行则并发调用会重叠。
// spread 真实模块保留 execFile/spawn 等（SystemProxyManager 等在模块加载期 promisify(execFile)，缺则 import 即崩）。
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  return {
    ...actual,
    exec: (_cmd: string, cb: (e: unknown, r: { stdout: string }) => void) => {
      calls += 1;
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      setTimeout(() => {
        inFlight -= 1;
        cb(null, { stdout: 'sing-box version 1.14.0-alpha.33 (go1.25)\n environment ...' });
      }, 5);
    },
    __stats: () => ({ calls, maxInFlight }),
    __reset: () => {
      inFlight = 0;
      maxInFlight = 0;
      calls = 0;
    },
  };
});

import { ProxyManager } from '../ProxyManager';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeSvc(): any {
  const mainWindow: any = { isDestroyed: () => false, webContents: { send: jest.fn() } };
  return new ProxyManager(
    { addLog: jest.fn() } as any,
    mainWindow,
    path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`),
    '/fake/sing-box'
  );
}

describe('spawnCoreVersionFirstLine 串行化（issue #150）', () => {
  beforeEach(() => {
    require('child_process').__reset();
  });

  it('并发 5 次 getCoreVersion(force) → 全部 spawn 但任一时刻至多 1 个在飞', async () => {
    const svc = makeSvc();
    const results = await Promise.all([
      svc.getCoreVersion(true),
      svc.getCoreVersion(true),
      svc.getCoreVersion(true),
      svc.getCoreVersion(true),
      svc.getCoreVersion(true),
    ]);
    const stats = require('child_process').__stats();
    expect(stats.calls).toBe(5); // force=true 不吃缓存，5 次真探测
    expect(stats.maxInFlight).toBe(1); // 串行化关键断言：绝不并发 execve 内核
    // 解析结果正确（不因串行而损坏）
    for (const r of results) expect(r).toBe('1.14.0-alpha.33');
  });

  it('一次探测失败不毒化链：后续探测仍正常排队执行', async () => {
    const svc = makeSvc();
    const cp = require('child_process');
    // 第一次 exec 抛错（回调 err），其余正常
    let first = true;
    const orig = cp.exec;
    cp.exec = (cmd: string, cb: (e: unknown, r?: { stdout: string }) => void) => {
      if (first) {
        first = false;
        setTimeout(() => cb(new Error('boom')), 5);
        return;
      }
      orig(cmd, cb as any);
    };

    const failed = await svc.getCoreVersion(true); // 失败 → 回落随包基线（不抛）
    const ok = await svc.getCoreVersion(true); // 链未被毒化 → 正常解析
    expect(typeof failed).toBe('string');
    expect(ok).toBe('1.14.0-alpha.33');

    cp.exec = orig;
  });
});
