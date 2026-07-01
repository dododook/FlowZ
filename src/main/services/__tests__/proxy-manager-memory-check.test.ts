/**
 * ProxyManager 逐进程内存自检单测（issue #210 主进程 + #242 扩展到全进程）。
 *
 * 验证 checkMemoryUsage：经 app.getAppMetrics() 采样，任一进程内存 > 阈值时记 warn（含 type/pid 定位是哪个
 * 进程），冷却期内（5min）不重复告警。私有方法经 (svc as any) 直调，mock getAppMetrics，不启动 sing-box。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-mem-'));

// mock 前缀允许被 jest.mock 工厂引用；测试内 mockReturnValue 控制每个 case 的进程指标。
const mockGetAppMetrics = jest.fn();

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

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));

import { ProxyManager } from '../ProxyManager';

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

const THRESHOLD = (ProxyManager as any).RSS_WARN_THRESHOLD as number;
const COOLDOWN = (ProxyManager as any).MEMORY_WARN_COOLDOWN_MS as number;

/**
 * 造一个进程指标（workingSetSize 单位 KB，与 Electron 口径一致）。
 * name/serviceName 语义见 shared/process-metrics.ts 顶部注释：Electron utilityProcess.fork 传入的
 * 自定义 serviceName 选项实际落在 getAppMetrics() 的 `.name`，`.serviceName` 恒是 Chromium 通用接口名
 * （如 'node.mojom.NodeService'）——本机 xvfb 探针实测坐实，非猜测。
 */
function proc(type: string, pid: number, memKb: number, name?: string) {
  return {
    type,
    pid,
    memory: { workingSetSize: memKb },
    cpu: { percentCPUUsage: 0 },
    ...(name ? { name, serviceName: 'node.mojom.NodeService' } : {}),
  };
}

const KB = 1024;
const overKb = Math.ceil((THRESHOLD + 1) / KB); // 略超阈值的 workingSetSize（KB）

beforeEach(() => mockGetAppMetrics.mockReset());

describe('逐进程内存自检 checkMemoryUsage（#210 + #242）', () => {
  it('全部进程 < 阈值 → 不告警（lastMemoryWarnAt 不变）', () => {
    mockGetAppMetrics.mockReturnValue([
      proc('Browser', 1, 300 * KB), // 300MB
      proc('Renderer', 2, 150 * KB),
      proc('GPU', 3, 80 * KB),
    ]);
    const svc = makeSvc();
    const before = svc.lastMemoryWarnAt;
    svc.checkMemoryUsage();
    expect(svc.lastMemoryWarnAt).toBe(before);
  });

  it('某子进程 > 阈值 → 记 warn，且日志含该进程 type/pid（定位是哪个）', () => {
    mockGetAppMetrics.mockReturnValue([
      proc('Browser', 100, 300 * KB),
      proc('Utility', 374035, overKb, 'flowz-stats'), // #242 场景：utility 子进程暴涨
    ]);
    const svc = makeSvc();
    const logSpy = jest.spyOn(svc as any, 'logToManager').mockImplementation(() => {});
    svc.checkMemoryUsage();
    expect(svc.lastMemoryWarnAt).toBeGreaterThan(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toBe('warn');
    const msg = String(logSpy.mock.calls[0][1]);
    expect(msg).toContain('Utility');
    expect(msg).toContain('374035');
    expect(msg).toContain('flowz-stats');
    logSpy.mockRestore();
  });

  it('getAppMetrics 抛异常 → 不告警、不抛（不阻断健康检查）', () => {
    mockGetAppMetrics.mockImplementation(() => {
      throw new Error('boom');
    });
    const svc = makeSvc();
    const logSpy = jest.spyOn(svc as any, 'logToManager').mockImplementation(() => {});
    expect(() => svc.checkMemoryUsage()).not.toThrow();
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('冷却期内不重复告警（5min 内持续超标只 warn 一次，超冷却再告警）', () => {
    mockGetAppMetrics.mockReturnValue([proc('Renderer', 5, overKb)]);
    const svc = makeSvc();
    const logSpy = jest.spyOn(svc as any, 'logToManager').mockImplementation(() => {});

    svc.checkMemoryUsage();
    expect(logSpy).toHaveBeenCalledTimes(1);

    // 冷却期内再次检查（不推进时间）→ 不重复
    svc.checkMemoryUsage();
    svc.checkMemoryUsage();
    expect(logSpy).toHaveBeenCalledTimes(1);

    // 推进超过冷却 → 再次告警
    const realNow = Date.now;
    Date.now = () => svc.lastMemoryWarnAt + COOLDOWN + 1;
    try {
      svc.checkMemoryUsage();
      expect(logSpy).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
    logSpy.mockRestore();
  });
});
