/**
 * buildRouteConfig 专项单测 —— D-direct（direct 模式也生成组网 force-route）+ Phase2 system endpoint 路由。
 * 路由全量字节由 config-snapshot 集成锁；config-snapshot 无 direct+mesh 用例，故此处专项锁 D-direct 行为。
 */
jest.mock('electron', () => ({
  app: { getPath: () => '/fake/userData', getAppPath: () => '/fake/app', isPackaged: false },
  net: {},
}));

import { buildRouteConfig, type RouteConfigDeps } from '../singbox-route-builder';
import type { ServerConfig, UserConfig } from '../../../shared/types';
import type { SingBoxEndpoint } from '../singbox-config-types';

const wgEp = (tag: string, system = false): SingBoxEndpoint => ({ type: 'wireguard', tag, system });

const deps = (
  pendingEndpoints: SingBoxEndpoint[],
  over: Partial<RouteConfigDeps> = {}
): RouteConfigDeps => ({
  coreVersion: '1.13.0',
  probeDirectPort: null,
  probeProxyPort: null,
  lanResolverForDns: null,
  pendingEndpoints,
  log: () => {},
  onDegraded: () => {},
  ...over,
});

const wgNode = (id: string, name: string, allowedIPs: string[], over: any = {}): ServerConfig =>
  ({
    id,
    name,
    protocol: 'wireguard',
    address: 'wg.example.com',
    port: 51820,
    wireguardSettings: {
      privateKey: 'pk',
      peerPublicKey: 'pub',
      localAddress: ['10.0.0.2/32'],
      allowedIPs,
      ...over,
    },
  }) as unknown as ServerConfig;

const cfg = (servers: ServerConfig[], over: Partial<UserConfig> = {}): UserConfig =>
  ({
    proxyMode: 'smart',
    servers,
    selectedServerId: servers[0]?.id,
    customRules: [],
    appRules: [],
    ...over,
  }) as unknown as UserConfig;

const idMap = (servers: ServerConfig[]): Map<string, string> =>
  new Map(servers.map((s) => [s.id, s.name]));

// 找到「组网 force-route」规则：action=route、outbound=节点 tag、带 ip_cidr。
const meshRule = (rc: any, tag: string): any =>
  (rc.rules || []).find(
    (r: any) => r.outbound === tag && r.action === 'route' && Array.isArray(r.ip_cidr)
  );

describe('buildRouteConfig — D-direct 组网 force-route', () => {
  const node = wgNode('w1', 'WG', ['10.8.0.0/24']);

  it('smart 模式：组网具体段 force-route 到节点自身 tag（基线）', () => {
    const rc = buildRouteConfig(
      cfg([node], { proxyMode: 'smart' }),
      idMap([node]),
      deps([wgEp('WG')])
    );
    const r = meshRule(rc, 'WG');
    expect(r).toBeDefined();
    expect(r.ip_cidr).toContain('10.8.0.0/24');
  });

  it('D-direct：direct 模式也生成组网 force-route（修复前 direct 跳过 → 对端内网不可达）', () => {
    const rc = buildRouteConfig(
      cfg([node], { proxyMode: 'direct' }),
      idMap([node]),
      deps([wgEp('WG')])
    );
    const r = meshRule(rc, 'WG');
    expect(r).toBeDefined();
    expect(r.ip_cidr).toContain('10.8.0.0/24');
  });

  it('system endpoint（reverseMesh）在 direct 模式同样 force-route（egress 仍经 route.rules）', () => {
    const sysNode = wgNode('w1', 'WGsys', ['10.9.0.0/24'], { reverseMesh: true });
    const rc = buildRouteConfig(
      cfg([sysNode], { proxyMode: 'direct' }),
      idMap([sysNode]),
      deps([wgEp('WGsys', true)])
    );
    const r = meshRule(rc, 'WGsys');
    expect(r).toBeDefined();
    expect(r.ip_cidr).toContain('10.9.0.0/24');
  });

  it('未发射的 endpoint（不在 pendingEndpoints）→ 不生成 force-route（防死引用）', () => {
    const rc = buildRouteConfig(cfg([node], { proxyMode: 'direct' }), idMap([node]), deps([]));
    expect(meshRule(rc, 'WG')).toBeUndefined();
  });
});
