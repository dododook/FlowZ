import { planMeshExitRoute } from '../mesh-exit-route';
import type { ServerConfig, UserConfig } from '../types';

const tsNode = (over: Record<string, unknown>): ServerConfig =>
  ({
    id: 'ts1',
    name: 'TS',
    protocol: 'tailscale',
    tailscaleSettings: { allowInternet: true, exitNode: '100.1.1.1', reverseMesh: true, ...over },
  }) as unknown as ServerConfig;

const wgNode = (over: Record<string, unknown>): ServerConfig =>
  ({
    id: 'wg1',
    name: 'WG',
    protocol: 'wireguard',
    address: 'h',
    port: 1,
    wireguardSettings: {
      privateKey: 'k',
      peerPublicKey: 'p',
      localAddress: ['10.0.0.2/32'],
      allowInternet: true,
      reverseMesh: true,
      ...over,
    },
  }) as unknown as ServerConfig;

const cfg = (servers: ServerConfig[], selectedId: string): UserConfig =>
  ({ servers, selectedServerId: selectedId }) as unknown as UserConfig;

describe('planMeshExitRoute（不依赖全局选中：exit-capable TS 即装，可能被路由规则指向）', () => {
  it('TS System + 全隧道 → 装 flowz-ts 单条 ifscope default(v4)（选中与否无关）', () => {
    const ts = tsNode({});
    expect(planMeshExitRoute(cfg([ts], 'ts1'), false)).toEqual({
      iface: 'flowz-ts',
      cidrs: ['0.0.0.0/0'],
    });
  });

  it('enableIPv6 → 含 v6 default', () => {
    const ts = tsNode({});
    expect(planMeshExitRoute(cfg([ts], 'ts1'), true)?.cidrs).toEqual(['0.0.0.0/0', '::/0']);
  });

  it('TS System + 全隧道 但全局出口是别的节点 → 仍装（可能被路由规则指向当出口）', () => {
    const ts = tsNode({});
    const other = { id: 'x', name: 'x', protocol: 'vless' } as unknown as ServerConfig;
    expect(planMeshExitRoute(cfg([ts, other], 'x'), false)).toEqual({
      iface: 'flowz-ts',
      cidrs: ['0.0.0.0/0'],
    });
  });

  it('TS gVisor(reverseMesh=false) → null(gVisor 栈内出口,无需 OS 路由)', () => {
    expect(planMeshExitRoute(cfg([tsNode({ reverseMesh: false })], 'ts1'), false)).toBeNull();
  });

  it('TS System 但无 exit_node(allowInternet=false) → null(不承载全隧道)', () => {
    expect(planMeshExitRoute(cfg([tsNode({ allowInternet: false })], 'ts1'), false)).toBeNull();
  });

  it('TS System + allowInternet=true 但 exitNode 为空(旧/导入配置)→ null(无 exit peer,不装路由防黑洞)', () => {
    expect(
      planMeshExitRoute(cfg([tsNode({ allowInternet: true, exitNode: '' })], 'ts1'), false)
    ).toBeNull();
  });

  it('WG System + 全隧道 → null(sing-box 按 allowed_ips 自装,FlowZ 不重复;本函数只管 TS)', () => {
    expect(planMeshExitRoute(cfg([wgNode({})], 'wg1'), false)).toBeNull();
  });

  it('无 TS 节点 → null', () => {
    const other = { id: 'x', name: 'x', protocol: 'vless' } as unknown as ServerConfig;
    expect(planMeshExitRoute(cfg([other], 'x'), false)).toBeNull();
  });
});
