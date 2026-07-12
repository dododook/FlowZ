/**
 * runSpeedTest 编排单测（L1 根治）：锁定唯一传播——渲染逐节点广播 + 托盘回写 + 测速态置位/复位。
 * 修复的历史漂移：渲染（服务器页/首页）入口测速曾只广播、漏 trayManager.updateSpeedTestResults → 托盘列表不同步。
 * 不起临时 sing-box（buildOutboundFn 全 null → testAllServers 对可测节点逐个 onResult(null) 早退）。
 */
import { SpeedTestService } from '../SpeedTestService';
import { runSpeedTest, type SpeedTestRunnerDeps } from '../speed-test-runner';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';

const makeServer = (id: string): unknown => ({
  id,
  name: id,
  protocol: 'vless',
  address: '1.2.3.4',
  port: 443,
});

function makeDeps(servers: unknown[], speedTestUrl?: string) {
  const logManager = { addLog: jest.fn() };
  const speedTestService = new SpeedTestService(logManager as never, () => null);
  const send = jest.fn();
  const win = { isDestroyed: () => false, webContents: { send } };
  const tray = { setSpeedTesting: jest.fn(), updateSpeedTestResults: jest.fn() };
  const deps = {
    configManager: { loadConfig: jest.fn().mockResolvedValue({ servers, speedTestUrl }) },
    speedTestService,
    getMainWindow: () => win,
    getTrayManager: () => tray,
    logManager,
  } as unknown as SpeedTestRunnerDeps;
  return { deps, send, tray, speedTestService };
}

const resultSends = (send: jest.Mock) =>
  send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.EVENT_SPEED_TEST_RESULT).map((c) => c[1]);

describe('runSpeedTest', () => {
  it('成功路径：托盘测速态置位 + 渲染逐节点广播 + 托盘回写同一份结果（修 tray-sync 根因）', async () => {
    const servers = [makeServer('s1'), makeServer('s2')];
    const { deps, send, tray } = makeDeps(servers, 'http://x/generate_204');

    const results = await runSpeedTest(deps);

    expect(tray.setSpeedTesting).toHaveBeenCalledWith(true);
    // 关键：渲染入口也回写托盘（历史漏点），传同一份结果 Map + 全量 servers
    expect(tray.updateSpeedTestResults).toHaveBeenCalledTimes(1);
    expect(tray.updateSpeedTestResults.mock.calls[0][0]).toBe(results.results);
    expect(tray.updateSpeedTestResults.mock.calls[0][1]).toBe(servers);
    // 渲染入口默认不弹托盘完成 toast（避免与 use-speed-test 自弹的 toast 重复）；§16.2 透传 outcome。
    expect(tray.updateSpeedTestResults.mock.calls[0][2]).toEqual({
      toast: undefined,
      outcome: 'completed',
      skipped: 0,
    });
    // 逐节点广播（不可用→null→-1）
    expect(resultSends(send)).toEqual([
      { serverId: 's1', latency: -1 },
      { serverId: 's2', latency: -1 },
    ]);
  });

  it('serverIds 限定子集：仅测指定节点', async () => {
    const servers = [makeServer('s1'), makeServer('s2'), makeServer('s3')];
    const { deps, send } = makeDeps(servers);

    await runSpeedTest(deps, { serverIds: ['s2'] });

    expect(resultSends(send).map((r) => r.serverId)).toEqual(['s2']);
  });

  it('失败路径：仅复位托盘测速态（setSpeedTesting(false)）、不清空已有延迟、并抛出', async () => {
    const { deps, tray, speedTestService } = makeDeps([makeServer('s1')]);
    jest.spyOn(speedTestService, 'testAllServers').mockRejectedValue(new Error('boom'));

    await expect(runSpeedTest(deps)).rejects.toThrow('boom');
    expect(tray.setSpeedTesting).toHaveBeenLastCalledWith(false);
    expect(tray.updateSpeedTestResults).not.toHaveBeenCalled();
  });

  it('notifyTrayToast=true（托盘入口）：回写托盘并请求完成 toast', async () => {
    const { deps, tray } = makeDeps([makeServer('s1')]);
    await runSpeedTest(deps, { notifyTrayToast: true });
    expect(tray.updateSpeedTestResults.mock.calls[0][2]).toEqual({
      toast: true,
      outcome: 'completed',
      skipped: 0,
    });
  });

  it('0 节点：复位托盘测速态（托盘入口已先置 true，否则永久卡「测速中」）+ 不回写结果', async () => {
    const { deps, tray } = makeDeps([]);
    const results = await runSpeedTest(deps);
    expect(results.results.size).toBe(0);
    expect(tray.setSpeedTesting).toHaveBeenCalledWith(false);
    expect(tray.updateSpeedTestResults).not.toHaveBeenCalled();
  });
});
