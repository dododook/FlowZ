import { execFile } from 'child_process';
import { MeshExitRouteManager } from '../mesh-exit-route-manager';
import type { UserConfig } from '../../../shared/types';

jest.mock('child_process', () => ({ execFile: jest.fn() }));
const mockExecFile = execFile as unknown as jest.Mock;

const realPlatform = process.platform;
function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
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

function mockHelper() {
  return {
    routeAdd: jest.fn(),
    routeDel: jest.fn(),
  };
}
function newMgr(helper: ReturnType<typeof mockHelper>) {
  return new MeshExitRouteManager(
    () => helper as never,
    () => {}
  );
}

// Windows 禁 System（mesh 节点强制 gVisor，无 flowz-ts 内核接口）→ 出口路由托管在 win32 一律 no-op：不读接口
// metric、不调 helper、不装/删 OS 路由。（macOS/Linux 的「该不该装/装哪条」决策见 shared mesh-exit-route.test.ts。）
describe('MeshExitRouteManager — Windows 禁 System：本管理器 no-op', () => {
  it('win32 + System TS exit → reconcile no-op（不读 metric、不调 helper、不装路由）', async () => {
    setPlatform('win32');
    const helper = mockHelper();
    const mgr = newMgr(helper);
    await mgr.reconcile(tsExitConfig, false);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(helper.routeAdd).not.toHaveBeenCalled();
  });

  it('win32 + clear → no-op（无路由可清、不抛、不调 helper）', async () => {
    setPlatform('win32');
    const helper = mockHelper();
    const mgr = newMgr(helper);
    await expect(mgr.clear()).resolves.toBeUndefined();
    expect(helper.routeDel).not.toHaveBeenCalled();
  });
});
