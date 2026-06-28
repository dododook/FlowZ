/**
 * ProxyManager 内存自检单测（issue #210 P4 可观测性）。
 *
 * 验证 checkMemoryUsage：RSS > 阈值时记 warn（经 logToManager），冷却期内（5min）不重复告警。
 * 私有方法经 (svc as any) 直调，mock process.memoryUsage，不启动 sing-box。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-mem-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
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

/** mock process.memoryUsage 返回指定 rss（其余字段补 0）。返回还原函数。 */
function mockRss(rss: number): () => void {
  const real = process.memoryUsage;
  // 新版 @types/node 的 memoryUsage 是方法链对象；用 any 绕过精确类型，运行时只调 rss()。
  (process as any).memoryUsage = () => ({
    rss,
    heapTotal: 0,
    heapUsed: 0,
    external: 0,
    arrayBuffers: 0,
  });
  return () => {
    (process as any).memoryUsage = real;
  };
}

describe('issue #210 P4 — 内存自检 checkMemoryUsage', () => {
  it('RSS < 阈值 → 不告警（lastMemoryWarnAt 不变）', () => {
    const restore = mockRss(100 * 1024 * 1024);
    try {
      const svc = makeSvc();
      const before = svc.lastMemoryWarnAt;
      svc.checkMemoryUsage();
      expect(svc.lastMemoryWarnAt).toBe(before);
    } finally {
      restore();
    }
  });

  it('RSS > 阈值 → 记 warn（lastMemoryWarnAt 更新）', () => {
    const restore = mockRss(THRESHOLD + 1);
    try {
      const svc = makeSvc();
      const logSpy = jest.spyOn(svc as any, 'logToManager').mockImplementation(() => {});
      svc.checkMemoryUsage();
      expect(svc.lastMemoryWarnAt).toBeGreaterThan(0);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][0]).toBe('warn'); // 级别为 warn
      logSpy.mockRestore();
    } finally {
      restore();
    }
  });

  it('冷却期内不重复告警（5min 内 RSS 持续超标只 warn 一次）', () => {
    const restore = mockRss(THRESHOLD + 100);
    try {
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
    } finally {
      restore();
    }
  });
});
