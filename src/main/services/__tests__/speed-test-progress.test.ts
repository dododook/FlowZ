import { SpeedTestService } from '../SpeedTestService';

// SpeedTestService 进度/流式回调单测：覆盖 report() 的不可用节点分支（#1 修复点——原未就绪/不可用节点
// 静默 null，UI 卡住；现逐个 onResult(null)+onProgress 通知 UI）。不起临时 sing-box（buildOutboundFn
// 全 null → usable 为空早退），纯逻辑验证 tested/ok 计数与回调时序。
describe('SpeedTestService 进度与流式回调', () => {
  const makeServer = (id: string): unknown => ({
    id,
    name: id,
    protocol: 'vless',
    address: '1.2.3.4',
    port: 443,
  });

  it('不可用节点（buildOutboundFn 全 null）逐个 onResult(null)+onProgress，tested=N ok=0', async () => {
    const logManager = { addLog: jest.fn() };
    const svc = new SpeedTestService(logManager as never, () => null); // 出站构造器全 null → 全不可用
    const servers = [makeServer('s1'), makeServer('s2'), makeServer('s3')] as never;

    const results: Array<[string, number | null]> = [];
    const progress: Array<{ tested: number; ok: number; total: number }> = [];
    await svc.testAllServers(
      servers,
      (id, latency) => results.push([id, latency]),
      (tested, ok, total) => progress.push({ tested, ok, total })
    );

    // 每个不可用节点立即回调 null（顺序=输入顺序），进度 tested 递增、ok 恒 0、total=节点总数。
    expect(results).toEqual([
      ['s1', null],
      ['s2', null],
      ['s3', null],
    ]);
    expect(progress).toEqual([
      { tested: 1, ok: 0, total: 3 },
      { tested: 2, ok: 0, total: 3 },
      { tested: 3, ok: 0, total: 3 },
    ]);
    expect(svc.getLastSpeedTestDiagnostics()).toMatchObject({
      total: 3,
      usable: 0,
      resolvedIpProbes: [],
      failures: [
        { serverId: 's1', serverName: 's1', tag: 'out-s1', reason: 'unusable' },
        { serverId: 's2', serverName: 's2', tag: 'out-s2', reason: 'unusable' },
        { serverId: 's3', serverName: 's3', tag: 'out-s3', reason: 'unusable' },
      ],
    });
  });

  it('空 servers 列表不触发 onResult/onProgress', async () => {
    const logManager = { addLog: jest.fn() };
    const svc = new SpeedTestService(logManager as never, () => null);
    let resultCalled = false;
    let progressCalled = false;
    const r = await svc.testAllServers(
      [],
      () => {
        resultCalled = true;
      },
      () => {
        progressCalled = true;
      }
    );
    expect(r.size).toBe(0);
    expect(resultCalled).toBe(false);
    expect(progressCalled).toBe(false);
  });
});
