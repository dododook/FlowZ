/**
 * §15 主核测速探测池 —— ProxyManager 端口分配 + getSpeedTestMainCoreProbe 句柄单测（无核、仅绑临时回环端口）。
 * 验证：allocateProbePorts 产 3+K 端口（probe*Port + probePoolPorts=K）、全互异；失败/未 start → 池空；
 * getSpeedTestMainCoreProbe.available()=池非空、isRunning()=主核存活+client 就绪、tagOf 回退、selectSlot 无 client 时 reject。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-probe-pool-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ProxyManager } from '../ProxyManager';
import { PROBE_POOL_SIZE } from '../../../shared/speed-test';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeSvc(): any {
  return new ProxyManager(undefined, undefined, path.join(TMP, 'cfg.json'), path.join(TMP, 'sing-box'));
}

describe('§15 ProxyManager 探测池端口分配', () => {
  it('allocateProbePorts → 3 固定端口 + K 池端口，全互异', async () => {
    const svc = makeSvc();
    await svc.allocateProbePorts();
    expect(svc.probeDirectPort).toBeGreaterThan(0);
    expect(svc.probeProxyPort).toBeGreaterThan(0);
    expect(svc.updateInPort).toBeGreaterThan(0);
    expect(svc.probePoolPorts).toHaveLength(PROBE_POOL_SIZE);
    const all = [svc.probeDirectPort, svc.probeProxyPort, svc.updateInPort, ...svc.probePoolPorts];
    expect(new Set(all).size).toBe(all.length); // 全互异
  });

  it('getSpeedTestMainCoreProbe：池就绪 available=true / 未运行 isRunning=false / tagOf 回退 / selectSlot 无 client reject', async () => {
    const svc = makeSvc();
    await svc.allocateProbePorts();
    const probe = svc.getSpeedTestMainCoreProbe();
    expect(probe.available()).toBe(true);
    expect(probe.poolPorts).toEqual(svc.probePoolPorts);
    expect(probe.isRunning()).toBe(false); // 无运行核
    expect(probe.tagOf('unknown-id')).toBe('unknown-id'); // 无 idToTagMap → 回退 id
    await expect(probe.selectSlot(0, 'x')).rejects.toBeTruthy(); // 无管理 API 客户端
  });

  it('未 start（未分配）→ 池空，available=false', () => {
    const svc = makeSvc();
    expect(svc.probePoolPorts).toEqual([]);
    expect(svc.getSpeedTestMainCoreProbe().available()).toBe(false);
  });

  it('§15.11 getLifecycleGeneration → 暴露既有 lifecycleGeneration token（纯读值）', () => {
    const svc = makeSvc();
    expect(svc.getLifecycleGeneration()).toBe(0);
    svc.lifecycleGeneration = 3; // 模拟 start/stop 累加（start/stop 各 ++、restart ×2）
    expect(svc.getLifecycleGeneration()).toBe(3);
  });
});
