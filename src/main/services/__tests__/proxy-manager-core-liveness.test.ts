/**
 * ProxyManager 内核探活三态单测 —— 「探活失败 ≠ 已死」修复的回归基线。
 *
 * 背景（真机取证，见 CoreLiveness 注释）：原实现 `catch { return false }` 把「探不出结论」编码成「已死」，
 * 而 false 会立刻触发「清 pid → 扫残留 → 自动重启」的破坏性级联。app.log 里同一 PID 在被判定已死后 11s
 * 又被残留清扫的 tasklist 列出，且 Node 'exit' 事件是在 FlowZ 自己 `taskkill /F` 完成后 8–16ms 才到达
 * ——即核一直活着，是那次误判把它杀掉的；taskkill /F 的退出码恰为 1，又被 parseExitError 报成
 * 「启动失败，请检查配置文件」。用户侧表现就是「弹窗说崩溃了，但完全没感觉断线」。
 *
 * 本文件锁死四条不变量：
 *  1) 三态判定表：EPERM 必须算**活着**（存在但无权限），命令失败必须算 **unknown**（绝不是 dead）；
 *  2) performHealthCheck 只在 'dead' 时进入破坏性级联，'unknown' 不动任何状态、不重启；
 *  3) parseExitError(1) 按存活时长区分「启动失败」与「运行中退出」；
 *  4) getProcessExitInfo 从内核输出通道取尾部，不再读恒为 0 字节的 singbox.log。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-liveness-'));

const mockGetAppMetrics = jest.fn(() => []);

jest.mock('electron', () => ({
  app: {
    getPath: () => TMP,
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => TMP,
    getAppMetrics: () => mockGetAppMetrics(),
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

// 只替换 execFile（回落腿的入口，需可控）；spawn 等保留真实实现——ProxyManager 导入链里
// SystemProxyManager 等在模块加载期就 promisify(execFile)，缺了会 import 即崩。
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));

import { ProxyManager } from '../ProxyManager';

const execFileMock = (jest.requireMock('child_process') as any).execFile as jest.Mock;

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeSvc(): any {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  return new ProxyManager(undefined, undefined, configPath, '/fake/sing-box');
}

/**
 * 让 healthProbeExecFile 立刻以给定 stdout / 错误收尾（promisify 回调形态）。
 * 回调**取末位实参**：Windows 腿传了 options（回调在第 4 位），POSIX 腿没传（回调在第 3 位）。
 */
function stubExecFile(outcome: { stdout?: string; error?: Error }): void {
  execFileMock.mockImplementation((...callArgs: any[]) => {
    const cb = callArgs[callArgs.length - 1];
    if (typeof cb !== 'function') return;
    if (outcome.error) cb(outcome.error);
    else cb(null, { stdout: outcome.stdout ?? '', stderr: '' });
  });
}

/** 临时改写 process.platform（命令腿是平台分支，CI 双平台都要能跑）。 */
async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
}

/** 让系统调用腿抛出指定 errno（ESRCH / EPERM / 其它）。 */
function stubKill(errno: string | null): jest.SpyInstance {
  return jest.spyOn(process, 'kill').mockImplementation((() => {
    if (errno === null) return true;
    const err: any = new Error(`kill ${errno}`);
    err.code = errno;
    throw err;
  }) as any);
}

beforeEach(() => {
  execFileMock.mockReset();
  mockGetAppMetrics.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('probeCoreLiveness：三态判定表（EPERM=活，命令失败=unknown）', () => {
  it('系统调用成功 → alive（不再派生 tasklist）', async () => {
    const svc = makeSvc();
    const killSpy = stubKill(null);
    await expect(svc.probeCoreLiveness(4321)).resolves.toBe('alive');
    expect(killSpy).toHaveBeenCalledWith(4321, 0);
    expect(execFileMock).not.toHaveBeenCalled(); // 常态下零派生
  });

  it('真实存活进程（自身 PID）→ alive', async () => {
    const svc = makeSvc();
    await expect(svc.probeCoreLiveness(process.pid)).resolves.toBe('alive');
  });

  it('ESRCH → dead（确认已死，放行级联）', async () => {
    const svc = makeSvc();
    stubKill('ESRCH');
    await expect(svc.probeCoreLiveness(4321)).resolves.toBe('dead');
  });

  it('EPERM → alive：进程存在但当前权限发不出信号，绝不能当死', async () => {
    const svc = makeSvc();
    stubKill('EPERM');
    await expect(svc.probeCoreLiveness(4)).resolves.toBe('alive');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('系统调用给出未预期错误 → 交由命令腿裁决（不直接判死）', async () => {
    const svc = makeSvc();
    stubKill('EINVAL');
    stubExecFile({ stdout: 'sing-box.exe    4321 Console    1    80,000 K' });
    await withPlatform('win32', async () => {
      await expect(svc.probeCoreLiveness(4321)).resolves.toBe('alive');
    });
    expect(execFileMock).toHaveBeenCalled();
  });

  it('非法 PID 不调系统调用，且不崩溃', async () => {
    const svc = makeSvc();
    const killSpy = stubKill(null);
    stubExecFile({ error: new Error('invalid pid') });
    await expect(svc.probeCoreLiveness(0)).resolves.toBe('unknown');
    expect(killSpy).not.toHaveBeenCalled();
  });

  // ── 回落腿：命令文本探活 ──
  describe('回落腿（命令文本探活）', () => {
    it('Windows：tasklist 命中 PID → alive', async () => {
      const svc = makeSvc();
      stubKill('EINVAL');
      stubExecFile({ stdout: 'sing-box.exe    39340 Console    1    81,264 K' });
      await withPlatform('win32', async () => {
        await expect(svc.probeCoreLiveness(39340)).resolves.toBe('alive');
      });
    });

    it('Windows：tasklist 无匹配 → dead', async () => {
      const svc = makeSvc();
      stubKill('EINVAL');
      stubExecFile({ stdout: 'INFO: No tasks are running which match the specified criteria.' });
      await withPlatform('win32', async () => {
        await expect(svc.probeCoreLiveness(39340)).resolves.toBe('dead');
      });
    });

    it('POSIX：ps 命中 → alive，未命中 → dead', async () => {
      const svc = makeSvc();
      stubKill('EINVAL');
      stubExecFile({ stdout: '4321\n' });
      await withPlatform('linux', async () => {
        await expect(svc.probeCoreLiveness(4321)).resolves.toBe('alive');
      });
      stubExecFile({ stdout: '\n' });
      await withPlatform('linux', async () => {
        await expect(svc.probeCoreLiveness(4321)).resolves.toBe('dead');
      });
    });

    it('★命令超时/失败 → unknown，绝不返回 dead（本次修复的核心）', async () => {
      const svc = makeSvc();
      stubKill('EINVAL');
      // 对应线上那一次：tasklist 3s 超时 → execFile reject。
      stubExecFile({ error: new Error('Command failed: tasklist (timeout 3000ms)') });
      await withPlatform('win32', async () => {
        await expect(svc.probeCoreLiveness(39340)).resolves.toBe('unknown');
      });
    });
  });
});

describe('performHealthCheck：只有确认已死才动状态', () => {
  /** 造一个「正在跑核」的最小状态，并把不可控副作用 stub 掉。 */
  function runningSvc(): any {
    const svc = makeSvc();
    svc.pid = 39340;
    svc.singboxPid = 39340;
    svc.startTime = new Date();
    svc.currentConfig = { servers: [], selectedServerId: 'x' };
    svc.autoRestartEnabled = true;
    jest.spyOn(svc, 'attemptAutoRestart').mockImplementation(() => {});
    jest.spyOn(svc, 'reconcileLoginFallback').mockImplementation(() => {});
    jest.spyOn(svc, 'getProcessExitInfo').mockReturnValue('');
    return svc;
  }

  it("★探活无结论（'unknown'）→ 清 pid / 自动重启**都不得发生**", async () => {
    const svc = runningSvc();
    jest.spyOn(svc, 'probeCoreLiveness').mockResolvedValue('unknown');
    const logSpy = jest.spyOn(svc, 'logToManager').mockImplementation(() => {});

    await svc.performHealthCheck();

    expect(svc.pid).toBe(39340); // 旧实现此处已置 null → 随后残留清扫把活核杀掉
    expect(svc.singboxPid).toBe(39340);
    expect(svc.attemptAutoRestart).not.toHaveBeenCalled();
    expect(svc.reconcileLoginFallback).not.toHaveBeenCalledWith(expect.anything());
    expect(logSpy).toHaveBeenCalledWith('warn', expect.stringContaining('既未判死也未判活'));
    expect(svc.coreProbeUnknownStreak).toBe(1);
  });

  it("探活确认已死（'dead'）→ 照旧清 pid 并自动重启", async () => {
    const svc = runningSvc();
    jest.spyOn(svc, 'probeCoreLiveness').mockResolvedValue('dead');
    jest.spyOn(svc, 'logToManager').mockImplementation(() => {});
    jest.spyOn(svc, 'readLastStartupFatal').mockReturnValue(null);

    await svc.performHealthCheck();

    expect(svc.pid).toBeNull();
    expect(svc.attemptAutoRestart).toHaveBeenCalledTimes(1);
  });

  it("探活为 'alive' → 不重启，仅做出口让位对账", async () => {
    const svc = runningSvc();
    jest.spyOn(svc, 'probeCoreLiveness').mockResolvedValue('alive');

    await svc.performHealthCheck();

    expect(svc.pid).toBe(39340);
    expect(svc.attemptAutoRestart).not.toHaveBeenCalled();
    expect(svc.reconcileLoginFallback).toHaveBeenCalled();
    expect(svc.coreProbeUnknownStreak).toBe(0);
  });

  it('明确的 alive/dead 结论会把连续无结论计数清零', async () => {
    const svc = runningSvc();
    svc.coreProbeUnknownStreak = 5;
    jest.spyOn(svc, 'probeCoreLiveness').mockResolvedValue('alive');

    await svc.performHealthCheck();

    expect(svc.coreProbeUnknownStreak).toBe(0);
  });

  it('连续无结论按阈值告警「检测已降级」，且不刷屏', async () => {
    const svc = runningSvc();
    jest.spyOn(svc, 'probeCoreLiveness').mockResolvedValue('unknown');
    const logSpy = jest.spyOn(svc, 'logToManager').mockImplementation(() => {});
    const DEGRADE = (ProxyManager as any).PROBE_UNKNOWN_DEGRADE_AFTER as number;

    for (let i = 0; i < DEGRADE; i++) await svc.performHealthCheck();

    expect(svc.coreProbeUnknownStreak).toBe(DEGRADE);
    // 首帧 1 条 + 降级阈值 1 条，中间静默
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[1][1]).toContain('检测已降级');
  });
});

describe('parseExitError：退出码 1 按存活时长区分两种语义', () => {
  it('刚起核就退 1 → 仍是「启动失败，请检查配置文件」', () => {
    const svc = makeSvc();
    svc.lastErrorOutput = '';
    svc.startTime = new Date(Date.now() - 200);
    expect(svc.parseExitError(1)).toBe('sing-box 启动失败，请检查配置文件');
  });

  it('★已运行数小时后退 1 → 报「运行中退出」，不再诬指配置', () => {
    const svc = makeSvc();
    svc.lastErrorOutput = '';
    svc.startTime = new Date(Date.now() - 6.7 * 3600 * 1000);
    const msg = svc.parseExitError(1);
    expect(msg).toContain('运行中退出');
    expect(msg).not.toContain('启动失败');
    expect(msg).toContain('6.7 小时');
  });

  it('startTime 缺失（未起核/已清理）→ 保守回落原文案', () => {
    const svc = makeSvc();
    svc.lastErrorOutput = '';
    svc.startTime = null;
    expect(svc.parseExitError(1)).toBe('sing-box 启动失败，请检查配置文件');
  });

  it('分界常量两侧取值符合预期（60s）', () => {
    expect((ProxyManager as any).STARTUP_MAX_UPTIME_MS).toBe(60_000);
    const svc = makeSvc();
    svc.lastErrorOutput = '';
    svc.startTime = new Date(Date.now() - 59_000);
    expect(svc.parseExitError(1)).toBe('sing-box 启动失败，请检查配置文件');
    svc.startTime = new Date(Date.now() - 61_000);
    expect(svc.parseExitError(1)).toContain('运行中退出');
  });

  it('其它退出码语义不受影响（回归）', () => {
    const svc = makeSvc();
    svc.lastErrorOutput = '';
    svc.startTime = new Date();
    expect(svc.parseExitError(2)).toBe('sing-box 配置文件格式错误');
    expect(svc.parseExitError(137)).toBe('sing-box 进程被强制终止');
    expect(svc.parseExitError(1073807364)).toContain('1073807364');
  });
});

describe('getProcessExitInfo：从内核输出通道取尾部', () => {
  it('读 LogManager 的 sing-box 通道（不再读恒空的 singbox.log）', () => {
    const svc = makeSvc();
    svc.logManager = {
      getLogs: () => [
        { timestamp: '', level: 'info', source: 'ProxyManager', message: '编排行，不应入选' },
        { timestamp: '', level: 'info', source: 'sing-box', message: 'sing-box started (0.18s)' },
        {
          timestamp: '',
          level: 'fatal',
          source: 'sing-box',
          message:
            'FATAL[0000] start inbound: listen tcp 127.0.0.1:5045: bind: address already in use',
        },
      ],
    };
    const info = svc.getProcessExitInfo();
    expect(info).toContain('address already in use');
    expect(info).not.toContain('编排行');
  });

  it('无错误行 → 返回空串（不误报）', () => {
    const svc = makeSvc();
    svc.logManager = {
      getLogs: () => [
        {
          timestamp: '',
          level: 'info',
          source: 'sing-box',
          message: 'inbound/mixed: tcp server started',
        },
      ],
    };
    expect(svc.getProcessExitInfo()).toBe('');
  });

  it('logManager 缺失/抛错 → 不崩、返回空串', () => {
    const svc = makeSvc();
    svc.logManager = null;
    expect(svc.getProcessExitInfo()).toBe('');

    svc.logManager = {
      getLogs: () => {
        throw new Error('boom');
      },
    };
    expect(svc.getProcessExitInfo()).toBe('');
  });
});
