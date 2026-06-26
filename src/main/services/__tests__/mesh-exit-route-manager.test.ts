import { execFile } from 'child_process';
import { MeshExitRouteManager } from '../mesh-exit-route-manager';
import type { UserConfig } from '../../../shared/types';

jest.mock('child_process', () => ({ execFile: jest.fn() }));
const mockExecFile = execFile as unknown as jest.Mock;

const realPlatform = process.platform;
function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
// 模拟「读 flowz-ts 接口 metric」(Get-NetIPInterface) 的返回(逗号分隔两族 metric)。
function metricReadReturns(value: string): void {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], cb: (e: unknown, r: { stdout: string; stderr: string }) => void) =>
      cb(null, { stdout: value, stderr: '' })
  );
}
afterEach(() => {
  setPlatform(realPlatform);
  jest.clearAllMocks();
});

const tsExitConfig = {
  servers: [
    {
      id: 'ts',
      name: 'TS',
      protocol: 'tailscale',
      tailscaleSettings: { reverseMesh: true, exitNode: '100.1.1.1', allowInternet: true },
    },
  ],
  selectedServerId: 'ts',
} as unknown as UserConfig;

const tsGvisorConfig = {
  servers: [
    {
      id: 'ts',
      name: 'TS',
      protocol: 'tailscale',
      tailscaleSettings: { reverseMesh: false, exitNode: '100.1.1.1', allowInternet: true },
    },
  ],
  selectedServerId: 'ts',
} as unknown as UserConfig;

function mockHelper() {
  return {
    routeAdd: jest.fn(),
    routeDel: jest.fn(),
    setInterfaceMetric: jest.fn().mockResolvedValue({ ok: true }),
  };
}
function newMgr(helper: ReturnType<typeof mockHelper>) {
  return new MeshExitRouteManager(
    () => helper as never,
    () => {}
  );
}

describe('MeshExitRouteManager — Windows 周期巡检降权 flowz-ts 接口 metric', () => {
  it('巡检读到 metric≠9000 → 经 helper 补设(flowz-ts,9000;不装 OS 路由)', async () => {
    setPlatform('win32');
    metricReadReturns('5,5');
    const helper = mockHelper();
    await (newMgr(helper) as unknown as { ensureWindowsTsMetric(): Promise<void> }).ensureWindowsTsMetric();
    expect(helper.setInterfaceMetric).toHaveBeenCalledWith('flowz-ts', 9000);
    expect(helper.routeAdd).not.toHaveBeenCalled();
  });

  it('巡检读到已是 9000 → 不重复补设(幂等)', async () => {
    setPlatform('win32');
    metricReadReturns('9000,9000');
    const helper = mockHelper();
    await (newMgr(helper) as unknown as { ensureWindowsTsMetric(): Promise<void> }).ensureWindowsTsMetric();
    expect(helper.setInterfaceMetric).not.toHaveBeenCalled();
  });

  it('flowz-ts 接口不存在(NONE) → 跳过、不补设(下轮再试)', async () => {
    setPlatform('win32');
    metricReadReturns('NONE');
    const helper = mockHelper();
    await (newMgr(helper) as unknown as { ensureWindowsTsMetric(): Promise<void> }).ensureWindowsTsMetric();
    expect(helper.setInterfaceMetric).not.toHaveBeenCalled();
  });

  it('AutomaticMetric(读出空,join 得 ",") → 视为需降权、补设(真机踩坑:勿当未就绪跳过)', async () => {
    setPlatform('win32');
    metricReadReturns(','); // 两族 InterfaceMetric 均空(AutomaticMetric)
    const helper = mockHelper();
    await (newMgr(helper) as unknown as { ensureWindowsTsMetric(): Promise<void> }).ensureWindowsTsMetric();
    expect(helper.setInterfaceMetric).toHaveBeenCalledWith('flowz-ts', 9000);
  });

  it('reconcile: win32 + System TS exit → 启动巡检定时器;clear → 停(覆盖重启/切节点)', async () => {
    setPlatform('win32');
    metricReadReturns('9000,9000');
    const helper = mockHelper();
    const mgr = newMgr(helper);
    await mgr.reconcile(tsExitConfig, false);
    expect((mgr as unknown as { windowsMetricTimer: unknown }).windowsMetricTimer).not.toBeNull();
    await mgr.clear();
    expect((mgr as unknown as { windowsMetricTimer: unknown }).windowsMetricTimer).toBeNull();
  });

  it('reconcile: win32 + gVisor TS(reverseMesh=false) → 不启动巡检(无 System 内核接口)', async () => {
    setPlatform('win32');
    const helper = mockHelper();
    const mgr = newMgr(helper);
    await mgr.reconcile(tsGvisorConfig, false);
    expect((mgr as unknown as { windowsMetricTimer: unknown }).windowsMetricTimer).toBeNull();
  });
});
