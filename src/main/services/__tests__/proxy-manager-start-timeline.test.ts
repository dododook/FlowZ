/**
 * B0 起核阶段耗时埋点的**接线**单测（不是 StartTimeline 本体的逻辑测，那在 start-timeline.test.ts）。
 *
 * 这一层要钉住的是「方法体对了但没接上」那类缺陷：收集器有没有在 public start() 建、三条出口（成功/失败/让位）
 * 是不是都出汇总行、字段有没有被接管方的 start 误清、非启动语境打标记会不会炸。
 *
 * 私有方法/字段经 `(svc as any)` 直调注入，不启动 sing-box。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-b0tl-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ProxyManager } from '../ProxyManager';
import { CoreStartSupersededError } from '../core-readiness';
import { StartTimeline } from '../start-timeline';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const CFG: any = { proxyModeType: 'tun', servers: [], selectedServerId: 'x' };

function makeSvc(): any {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  const svc: any = new ProxyManager(undefined, undefined, configPath, '/fake/sing-box');
  // 失败腿收口会真跑清理，桩掉避免碰进程/系统代理。
  svc.cleanup = jest.fn();
  svc.ensureSystemProxyCleared = jest.fn(async () => {});
  return svc;
}

/** 捕获 logToManager 的全部行。 */
function captureLogs(svc: any): string[] {
  const lines: string[] = [];
  jest.spyOn(svc, 'logToManager').mockImplementation((...args: unknown[]) => {
    lines.push(String(args[1]));
  });
  return lines;
}

function timelineLine(lines: string[]): string | undefined {
  return lines.find((l) => l.startsWith('起核阶段耗时 '));
}

describe('B0 埋点接线 — 三条出口都出汇总行', () => {
  it('成功：outcome=ok，且带至少一格阶段', async () => {
    const svc = makeSvc();
    const lines = captureLogs(svc);
    svc.startInternal = jest.fn(async () => {
      svc.markStart('fakePhase');
    });

    await svc.start(CFG);

    const line = timelineLine(lines);
    expect(line).toBeDefined();
    expect(line).toContain('outcome=ok');
    expect(line).toContain('fakePhase=');
  });

  it('失败：仍出汇总行且 outcome=failed（原异常照常上抛）', async () => {
    const svc = makeSvc();
    const lines = captureLogs(svc);
    svc.startInternal = jest.fn(async () => {
      svc.markStart('beforeBoom');
      throw new Error('boom');
    });

    await expect(svc.start(CFG)).rejects.toThrow('boom');

    const line = timelineLine(lines);
    expect(line).toContain('outcome=failed');
    expect(line).toContain('beforeBoom=');
  });

  it('让位：outcome=superseded（让位是静默返回，但耗时依然要看得见）', async () => {
    const svc = makeSvc();
    const lines = captureLogs(svc);
    svc.startInternal = jest.fn(async () => {
      throw new CoreStartSupersededError();
    });

    await expect(svc.start(CFG)).resolves.toBeUndefined();

    expect(timelineLine(lines)).toContain('outcome=superseded');
    // 让位不应被 cleanup（既有 #176 语义，顺带守住不被本改动破坏）
    expect(svc.cleanup).not.toHaveBeenCalled();
  });
});

describe('B0 埋点接线 — 字段生命周期', () => {
  it('start 收尾清空在飞收集器，并把汇总行留给诊断报告', async () => {
    const svc = makeSvc();
    captureLogs(svc);
    svc.startInternal = jest.fn(async () => {
      expect(svc.startTimeline).toBeInstanceOf(StartTimeline); // 在飞期间必须已就位
    });

    await svc.start(CFG);

    expect(svc.startTimeline).toBeNull();
    expect(svc.getLastStartTimeline()).toContain('起核阶段耗时 ');
  });

  it('被更新的 start 接管后，旧腿的收尾**不得**清掉接管方的收集器', async () => {
    const svc = makeSvc();
    captureLogs(svc);
    const taker = new StartTimeline();
    svc.startInternal = jest.fn(async () => {
      // 模拟接管方在旧腿还没收尾时装上了自己的收集器
      svc.startTimeline = taker;
    });

    await svc.start(CFG);

    // 变异守卫：若收尾无条件 `this.startTimeline = null`，接管方此后所有 markStart 会全部落空
    expect(svc.startTimeline).toBe(taker);
  });

  it('非启动语境打标记是 no-op，不抛', () => {
    const svc = makeSvc();
    expect(svc.startTimeline).toBeNull();
    expect(() => svc.markStart('孤儿标记')).not.toThrow();
    expect(svc.getLastStartTimeline()).toBeNull();
  });
});
