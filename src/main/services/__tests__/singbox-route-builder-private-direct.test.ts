/**
 * buildRouteConfig — geosite-private 私网域名直连规则的「模式门控对称性」专项单测。
 *
 * 修复背景（非对称门控误报）：bypassLAN 的私网**域名**直连规则引用 `rule_set: geosite-private`，原仅受
 * `bypassLAN !== false` 门控、在 direct 模式也发射；而 rule_set **定义注入块**受 `proxyMode !== 'direct'`
 * 门控、direct 模式整块跳过 → geosite-private 成悬空引用被末尾剪枝，误报「geosite-private 缺少本地副本」
 * （实为模式门控不对称，文件并不缺）。修复=给该引用补 `proxyMode !== 'direct'` 守卫，与定义块对齐。
 *
 * 本测以「文件确实存在」（写 SRS 魔数到运行时目录）为前提，锁住：
 *  - smart 模式：仍发射 geosite-private 规则 + 注入定义 → 无 dangling 告警（正向对照，证明修复未误伤）。
 *  - direct 模式：不发射 geosite-private 规则 + 无任何「缺少本地副本」告警（修复点）。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-route-private-test-'));
jest.mock('electron', () => ({
  app: { getPath: () => TMP, getAppPath: () => TMP, isPackaged: false },
  net: {},
}));

import { buildRouteConfig, type RouteConfigDeps } from '../singbox-route-builder';
import { getRuleSetRuntimeDir } from '../builtin-geo-rulesets';
import type { ServerConfig, UserConfig } from '../../../shared/types';

// 种运行时本地副本（写 SRS 魔数即过 isValidSrsFile）——模拟「文件确实存在」，使「修复后 direct 仍不发射」
// 与「文件缺失才不发射」可区分（否则测试空过、证不出门控修复）。
// 除 geosite-private 外补 CN 三件套：smart 模式默认地区分流(cn)引用 geosite-cn/!cn/geoip-cn 做国内直连，
// 不种则它们在 smart 真 dangling、污染「smart 无告警」对照（与 dns-resolver.test 同样的 3 件套播种约定）。
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

const proxyNode = (id = 'p1', name = 'HK'): ServerConfig =>
  ({
    id,
    name,
    protocol: 'vless',
    address: 'a.example.com',
    port: 443,
    uuid: 'u1',
  }) as ServerConfig;

const cfg = (proxyMode: 'smart' | 'global' | 'direct'): UserConfig =>
  ({
    proxyMode,
    servers: [proxyNode()],
    selectedServerId: 'p1',
    customRules: [],
    appRules: [],
    // bypassLAN 缺省 → !== false → 私网直连块启用（含 geosite-private 引用）。
  }) as unknown as UserConfig;

const idMap = (): Map<string, string> => new Map([['p1', 'HK']]);

/** 捕获 deps.log 的 (level, message)，供断言「缺少本地副本」是否出现。 */
const capturingDeps = (): { deps: RouteConfigDeps; logs: string[] } => {
  const logs: string[] = [];
  const deps: RouteConfigDeps = {
    probeDirectPort: null,
    probeProxyPort: null,
    lanResolverForDns: null,
    pendingEndpoints: [],
    log: (_level, message) => logs.push(message),
    onDegraded: () => {},
  };
  return { deps, logs };
};

/** 路由规则里是否存在「rule_set 引用了 geosite-private」（字符串或数组形式均算）。 */
const refsGeositePrivate = (rc: any): boolean =>
  (rc.rules || []).some((r: any) => {
    const rs = r.rule_set;
    return rs === 'geosite-private' || (Array.isArray(rs) && rs.includes('geosite-private'));
  });

describe('buildRouteConfig — geosite-private 模式门控对称性', () => {
  it('smart 模式（文件存在）：发射 geosite-private 直连规则 + 注入定义 + 无 dangling 告警', () => {
    const { deps, logs } = capturingDeps();
    const rc: any = buildRouteConfig(cfg('smart'), idMap(), deps);

    expect(refsGeositePrivate(rc)).toBe(true);
    // 定义必须同时注入（否则会 dangling）。
    expect((rc.rule_set || []).some((rs: any) => rs.tag === 'geosite-private')).toBe(true);
    expect(logs.some((m) => m.includes('缺少本地副本'))).toBe(false);
  });

  it('direct 模式（文件存在）：不发射 geosite-private 规则 + 无「缺少本地副本」告警（修复点）', () => {
    const { deps, logs } = capturingDeps();
    const rc: any = buildRouteConfig(cfg('direct'), idMap(), deps);

    // 引用与定义在 direct 模式同生共灭：都不存在 → 不会被末尾剪枝误报。
    expect(refsGeositePrivate(rc)).toBe(false);
    expect(logs.some((m) => m.includes('缺少本地副本'))).toBe(false);
  });
});
