/**
 * §15.11 测速 × 核生命周期竞态硬化单测（生成号状态机，无网络/无真核）。验证：
 *  · 超代 abort（主核池，R-a/R-c）：gen 变 → 停发新波、丢在飞结果、返部分 map；未测节点**缺席**（不写假 -1）。
 *  · 真实失败(-1) vs 超代未测 分流：measureViaTunnel 返 null + gen 不变 → 照常记 null；gen 变 → 丢弃、缺席。
 *  · 切节点不 abort（R-d）：gen 恒定 → 全量结果。
 *  · 缺省 ()=>0 恒不超代（回归保护）。
 *  · 超代 abort（临时核兜底，R-b）：核中途 START（gen 变）→ 剩余节点不写假 -1、临时核 finally 仍杀。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');
const { EventEmitter } = require('events');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-lifecycle-gen-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  net: {},
}));
jest.mock('fs/promises', () => ({
  ...jest.requireActual('fs/promises'),
  writeFile: jest.fn(async () => {}),
  unlink: jest.fn(async () => {}),
}));
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
}));

import { spawn } from 'child_process';
import { SpeedTestService } from '../SpeedTestService';
import type { MainCoreProbe } from '../../../shared/speed-test';
import type { ServerConfig } from '../../../shared/types';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const mockLog = { addLog: () => {} } as unknown as ConstructorParameters<typeof SpeedTestService>[0];
const vless = (id: string): ServerConfig =>
  ({ id, name: id.toUpperCase(), protocol: 'vless', address: `${id}.ex.com`, port: 443, uuid: 'u' }) as unknown as ServerConfig;

// K=1 探测池（单槽 → 波严格串行，超代检查时序确定）。
const probeK1 = (): MainCoreProbe => ({
  poolPorts: [100],
  available: () => true,
  isRunning: () => true,
  selectSlot: async () => {},
  tagOf: (id: string) => `tag-${id}`,
  hasTag: () => true,
  tsNodeReady: () => true,
  isDirty: () => false,
});

const fakeProc = (): any => {
  const p: any = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.killed = false;
  p.kill = () => {
    p.killed = true;
  };
  return p;
};

describe('§15.11 主核池 — 生成号超代', () => {
  it('波边界超代（R-a/R-c）：wave0 测完、gen 变 → wave1 停发；未测节点缺席、无假 -1', async () => {
    // K=1 串行；getCoreGeneration 调用序：head→wave0-top→s1 cb-top→s1 post-measure（前 4 次=0，wave1-top=第 5 次→1）。
    const getGen = jest
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(1);
    const svc = new SpeedTestService(mockLog, undefined, () => probeK1(), getGen);
    const measureSpy = jest
      .spyOn(svc as any, 'measureViaTunnel')
      .mockResolvedValue({ latency: 42 });
    const { results } = await svc.testAllServers([vless('s1'), vless('s2'), vless('s3')]);

    expect(results.get('s1')).toBe(42); // gen0 期测得
    expect(results.has('s2')).toBe(false); // wave1 超代 abort → 缺席
    expect(results.has('s3')).toBe(false);
    expect([...results.values()].every((v) => v !== null)).toBe(true); // 无假 -1
    expect(measureSpy).toHaveBeenCalledTimes(1); // 仅 s1 被测（s2/s3 未测）
  });

  it('超代②（measure 期间 gen 变）：丢在飞结果、节点缺席（非 null、非真值）', async () => {
    // head→wave0-top→s1 cb-top 三次=0，s1 post-measure=第 4 次→1 → 丢弃 s1。
    const getGen = jest
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(1);
    const svc = new SpeedTestService(mockLog, undefined, () => probeK1(), getGen);
    jest.spyOn(svc as any, 'measureViaTunnel').mockResolvedValue({ latency: 30 });
    const { results } = await svc.testAllServers([vless('s1')]);
    expect(results.has('s1')).toBe(false); // 超代 → 丢弃在飞真值、缺席（不写）
  });

  it('诚实性分流：真实失败(null) + gen 不变 → 照常记 null（下游 -1）', async () => {
    const svc = new SpeedTestService(mockLog, undefined, () => probeK1(), () => 5); // gen 恒 5
    jest.spyOn(svc as any, 'measureViaTunnel').mockResolvedValue({ latency: null, reason: 'timeout' });
    const { results } = await svc.testAllServers([vless('s1')]);
    expect(results.has('s1')).toBe(true);
    expect(results.get('s1')).toBeNull(); // 真实失败 → 记 null，非缺席
  });

  it('切节点不 abort（R-d）：gen 恒定 → 全量结果', async () => {
    const svc = new SpeedTestService(mockLog, undefined, () => probeK1(), () => 7); // hot-switch 不 bump → 恒 7
    jest.spyOn(svc as any, 'measureViaTunnel').mockResolvedValue({ latency: 11 });
    const { results } = await svc.testAllServers([vless('s1'), vless('s2')]);
    expect(results.get('s1')).toBe(11);
    expect(results.get('s2')).toBe(11); // 全测完、无 abort
  });

  it('缺省 getCoreGeneration（未注入 ()=>0）→ 恒不超代（回归保护）', async () => {
    const svc = new SpeedTestService(mockLog, undefined, () => probeK1()); // 无第 4 参
    jest.spyOn(svc as any, 'measureViaTunnel').mockResolvedValue({ latency: 9 });
    const { results } = await svc.testAllServers([vless('s1'), vless('s2')]);
    expect(results.get('s1')).toBe(9);
    expect(results.get('s2')).toBe(9);
  });

  it('F1 核自发崩溃（gen 不变但 probe.isRunning() 翻 false）→ 崩溃窗口/后续节点缺席、无假 -1、已测保留', async () => {
    // 崩溃分支不 bump lifecycleGeneration（gen 恒 0），故仅靠 !probe.isRunning() 判超代。K=1 串行。
    let running = true;
    let measureCall = 0;
    const probe: MainCoreProbe = {
      poolPorts: [100],
      available: () => true,
      isRunning: () => running,
      selectSlot: async () => {},
      tagOf: (id: string) => `tag-${id}`,
      hasTag: () => true,
      tsNodeReady: () => true,
  isDirty: () => false,
    };
    const svc = new SpeedTestService(mockLog, undefined, () => probe, () => 0); // gen 恒 0（崩溃不 bump）
    const measureSpy = jest.spyOn(svc as any, 'measureViaTunnel').mockImplementation(async () => {
      measureCall++;
      if (measureCall === 2) running = false; // s2 measure 期间核崩溃 → connect-refused
      return running ? { latency: 20 } : { latency: null, reason: 'connect-error' };
    });
    const { results } = await svc.testAllServers([vless('s1'), vless('s2'), vless('s3')]);

    expect(results.get('s1')).toBe(20); // 崩溃前测得 → 保留
    expect(results.has('s2')).toBe(false); // 崩溃窗口在飞（connect-refused）→ 判未测、缺席（非假 -1）
    expect(results.has('s3')).toBe(false); // 崩溃后波超代 → 停发、缺席
    expect([...results.values()].every((v) => v !== null)).toBe(true); // 绝无假 -1
    expect(measureSpy).toHaveBeenCalledTimes(2); // s3 未测（wave 超代拦下）
  });
});

describe('§15.11 临时核兜底（R-b）— 生成号超代', () => {
  it('核中途 START（gen 变）→ 剩余节点不写假 -1、缺席 map、临时核 finally 仍杀', async () => {
    let gen = 0;
    const svc = new SpeedTestService(
      mockLog,
      () => ({ type: 'vless', tag: 'x' }), // buildOutboundFn 注入 → 走 testServersViaProxy
      undefined, // 无主核池 → 分流到临时核路径
      () => gen
    );
    const proc = fakeProc();
    (spawn as jest.Mock).mockReturnValue(proc);
    jest.spyOn(svc as any, 'findFreePorts').mockResolvedValue([7001, 7002]);
    // waitForPortReady 期间核 START（临时核 + 新主核瞬态双会话）→ gen 跃迁。
    jest.spyOn(svc as any, 'waitForPortReady').mockImplementation(async () => {
      gen = 1;
      return true;
    });
    const measureSpy = jest.spyOn(svc as any, 'measureViaTunnel').mockResolvedValue({ latency: 42 });

    const { results } = await svc.testAllServers([vless('s1'), vless('s2')]);
    proc.emit('exit', 0); // 触发 finally 挂的 exit 监听 → clearTimeout(forceKillTimer)，避免 2s 定时器泄漏

    // 超代（gen0=0，现 gen=1）：runWithLimit 内每节点 measure 前 guard-1 拦下 → 不测、不 report、不写假 -1。
    expect(results.has('s1')).toBe(false);
    expect(results.has('s2')).toBe(false);
    expect(measureSpy).not.toHaveBeenCalled();
    expect([...results.values()].every((v) => v !== null)).toBe(true);
    expect(proc.killed).toBe(true); // 临时核 finally 仍杀（清理不受超代影响）
  });
});
