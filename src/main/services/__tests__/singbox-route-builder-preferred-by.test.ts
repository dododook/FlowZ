/**
 * buildRouteConfig 块0c — preferred_by 试点：endpoint 自声明归位替代手动 ip_cidr force-route（design §14/§14.1）。
 * 限「非全隧道（无 0/0）」节点：
 *  - WG 关外网（allowInternet=false，allowedIPs 无 0/0）→ 用 preferred_by（endpoint.Lookup=peer allowed_ips，与 ip_cidr 等价）。
 *  - WG 全隧道（allowInternet=true）→ 仍 ip_cidr（去 0/0）；preferred_by 会因 0/0 → PreferredAddress 恒 true 抢全局。
 *  - TS 不选 exit → 试点默认关（TS_PREFERRED_BY_TRIAL=false，routePrefixes 运行时动态 + 语义差异，待真机验）→ 仍 ip_cidr。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-route-prefby-test-'));
jest.mock('electron', () => ({
  app: { getPath: () => TMP, getAppPath: () => TMP, isPackaged: false },
  net: {},
}));

import { buildRouteConfig, type RouteConfigDeps } from '../singbox-route-builder';
import { getRuleSetRuntimeDir } from '../builtin-geo-rulesets';
import type { ServerConfig, UserConfig } from '../../../shared/types';
import type { SingBoxEndpoint } from '../singbox-config-types';

// 种 CN 三件套 + private，避免 smart 模式 geosite dangling 告警污染（与 private-direct.test 同约定；本测不断言告警，仅防噪音）。
{
  const dir = getRuleSetRuntimeDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const f of [
    'geosite-private.srs',
    'geosite-cn.srs',
    'geosite-geolocation-!cn.srs',
    'geoip-cn.srs',
  ]) {
    fs.writeFileSync(path.join(dir, f), Buffer.from('SRS'));
  }
}

const wgNode = (over: Record<string, unknown> = {}): ServerConfig =>
  ({
    id: 'w1',
    name: 'WG',
    protocol: 'wireguard',
    address: 'wg.example.com', // 域名（非 IP）→ 不进「节点排除」ip_cidr 块，避免干扰断言
    port: 51820,
    wireguardSettings: {
      privateKey: 'pk',
      peerPublicKey: 'pub',
      localAddress: ['10.0.0.2/32'],
      allowedIPs: ['10.8.0.0/24'],
      allowInternet: false,
      ...over,
    },
  }) as unknown as ServerConfig;

const tsNode = (over: Record<string, unknown> = {}): ServerConfig =>
  ({
    id: 't1',
    name: 'TS',
    protocol: 'tailscale',
    tailscaleSettings: { authKey: 'tskey', allowInternet: false, ...over }, // 不选 exit（无 exitNode）
  }) as unknown as ServerConfig;

const cfgWith = (servers: ServerConfig[]): UserConfig =>
  ({
    proxyMode: 'smart',
    servers,
    selectedServerId: servers[0]?.id,
    customRules: [],
    appRules: [],
  }) as unknown as UserConfig;

const idMapOf = (servers: ServerConfig[]): Map<string, string> =>
  new Map(servers.map((s) => [s.id, s.name]));

const depsWithEndpoints = (tags: string[]): RouteConfigDeps => ({
  probeDirectPort: null,
  probeProxyPort: null,
  lanResolverForDns: null,
  // 块 0c 仅用 endpoint.tag 判「本轮实际发射」；type 不影响（统一 wireguard 占位）。
  pendingEndpoints: tags.map((tag) => ({ type: 'wireguard', tag }) as SingBoxEndpoint),
  log: () => {},
  onDegraded: () => {},
});

/** rules 里是否有「preferred_by 含 tag 且 outbound=tag」的归位规则。 */
const hasPreferredBy = (rc: any, tag: string): boolean =>
  (rc.rules || []).some(
    (r: any) => Array.isArray(r.preferred_by) && r.preferred_by.includes(tag) && r.outbound === tag
  );
/** rules 里是否有「ip_cidr force-route 到 tag 自身」的规则（区别于 outbound=direct 的节点排除块）。 */
const hasIpCidrForceRoute = (rc: any, tag: string): boolean =>
  (rc.rules || []).some(
    (r: any) => Array.isArray(r.ip_cidr) && r.action === 'route' && r.outbound === tag
  );

describe('buildRouteConfig 块0c — preferred_by 试点替代 ip_cidr force-route', () => {
  it('WG 关外网（无 0/0）→ preferred_by 归位，不再手动 ip_cidr force-route', () => {
    const wg = wgNode({ allowInternet: false, allowedIPs: ['10.8.0.0/24'] });
    const rc: any = buildRouteConfig(cfgWith([wg]), idMapOf([wg]), depsWithEndpoints(['WG']));
    expect(hasPreferredBy(rc, 'WG')).toBe(true);
    expect(hasIpCidrForceRoute(rc, 'WG')).toBe(false);
  });

  it('WG 全隧道（allowInternet）→ 仍 ip_cidr（去 0/0），不用 preferred_by（防 0/0 抢全局）', () => {
    const wg = wgNode({ allowInternet: true, allowedIPs: ['10.8.0.0/24'] });
    const rc: any = buildRouteConfig(cfgWith([wg]), idMapOf([wg]), depsWithEndpoints(['WG']));
    expect(hasPreferredBy(rc, 'WG')).toBe(false);
    expect(hasIpCidrForceRoute(rc, 'WG')).toBe(true);
  });

  it('TS 不选 exit → 试点默认关（TS_PREFERRED_BY_TRIAL=false）仍走 ip_cidr，不用 preferred_by', () => {
    const ts = tsNode({ allowInternet: false });
    const rc: any = buildRouteConfig(cfgWith([ts]), idMapOf([ts]), depsWithEndpoints(['TS']));
    expect(hasPreferredBy(rc, 'TS')).toBe(false);
    expect(hasIpCidrForceRoute(rc, 'TS')).toBe(true);
  });
});
