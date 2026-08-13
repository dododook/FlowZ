/**
 * 「阻断」动作迁移门：legacy `outbound: 'block'` → sing-box 1.14 路由动作 `action: 'reject'`。
 *
 * 迁移动机（实测，非推断）：真内核 1.14.0-beta.14，两份最小配置只差这一处 —— 客户端侧**行为等价**
 * （都是立即关闭、curl 502、亚毫秒），差别只在日志：legacy `block` 出站每拦一条打一行 **ERROR**
 * `operation not permitted`，`reject` 只在 DEBUG 打 `connection closed: rejected`。故收益是
 * 「阻断规则不再刷 ERROR 淹没真错误」+ 去掉 1.11 起 deprecated 的 legacy 出站，不是失败形态的改变。
 *
 * **为什么必须连 `block` 出站一起删，而不是留着不用**：留着就还有第二条能走通的路。删掉之后，若哪天
 * 又有人发出 `outbound: 'block'`，它会成为死引用被 `ProxyManager.fixRouteDeadReferences` 改写成
 * `proxy-selector` —— 用户想阻断的流量反被代理，且完全静默。本门把这条路正面钉死：**生成产物里不得
 * 出现任何 `outbound: 'block'`，也不得再定义 `block` 出站**。
 *
 * 门的判据是「产物形态」而不是「某个函数的返回值」，故两条发射腿（自定义规则 / 应用分流）与出站装配
 * 三处任一回退都判红。三条正向对照防负面断言空过：阻断规则确实生成了、两条腿都生成了、非阻断规则
 * 仍带 outbound（证明 matcher 不是把所有规则都当成 reject）。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-reject-migration-'));
jest.mock('electron', () => ({
  app: { getPath: () => TMP, getAppPath: () => TMP, isPackaged: false },
  net: {},
}));

import { buildRouteConfig, type RouteConfigDeps } from '../singbox-route-builder';
import { buildOutbounds } from '../singbox-outbound-builder';
import { getRuleSetRuntimeDir } from '../builtin-geo-rulesets';
import type { ServerConfig, UserConfig } from '../../../shared/types';

{
  const dir = getRuleSetRuntimeDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['geosite-cn.srs', 'geosite-geolocation-!cn.srs', 'geoip-cn.srs']) {
    fs.writeFileSync(path.join(dir, f), Buffer.from('SRS'));
  }
}

const NODE: ServerConfig = {
  id: 'p1',
  name: 'HK',
  protocol: 'vless',
  address: 'a.example.com',
  port: 443,
  uuid: 'u1',
} as ServerConfig;

/** 两条阻断腿同时在场：自定义规则（domainSuffix）+ 应用分流（process_name）。 */
const CONFIG = {
  proxyMode: 'smart',
  servers: [NODE],
  selectedServerId: 'p1',
  customRules: [
    { id: 'b1', type: 'domainSuffix', values: ['ads.example'], action: 'block', enabled: true },
    { id: 'p2', type: 'domainSuffix', values: ['proxied.example'], action: 'proxy', enabled: true },
  ],
  appRoutingEnabled: true,
  customAppPresets: [
    {
      id: 'blocked-app',
      name: 'BlockedApp',
      emoji: '🚫',
      geositeTags: [],
      geoipTags: [],
      processNames: ['blocked.exe'],
    },
  ],
  appRules: [{ appId: 'blocked-app', action: 'block', enabled: true }],
} as unknown as UserConfig;

const deps = (): RouteConfigDeps => ({
  probeDirectPort: null,
  probeProxyPort: null,
  updateInPort: null,
  lanResolverForDns: null,
  pendingEndpoints: [],
  log: () => {},
  onDegraded: () => {},
});

const idMap = new Map([['p1', 'HK']]);
const rc: any = buildRouteConfig(CONFIG, idMap, deps());
const rules: any[] = rc.rules || [];

/** 该规则是否命中给定匹配值（域名后缀 / 进程名任一）。 */
const matches = (r: any, needle: string): boolean =>
  (r.domain_suffix ?? []).includes(needle) || (r.process_name ?? []).includes(needle);

describe('阻断动作迁移：outbound:block → action:reject', () => {
  it('正向对照：两条阻断腿都真的生成了规则（否则下面的断言恒绿）', () => {
    expect(rules.filter((r) => matches(r, 'ads.example'))).toHaveLength(1);
    expect(rules.filter((r) => matches(r, 'blocked.exe'))).toHaveLength(1);
  });

  it.each([
    ['自定义规则', 'ads.example'],
    ['应用分流', 'blocked.exe'],
  ])('%s 的阻断规则是 action:reject 且不带 outbound', (_leg, needle) => {
    const r = rules.find((x) => matches(x, needle));
    expect(r.action).toBe('reject');
    expect(r.outbound).toBeUndefined();
  });

  it('正向对照：非阻断规则仍带 outbound（证明不是把所有规则都判成 reject）', () => {
    const r = rules.find((x) => matches(x, 'proxied.example'));
    expect(r.action).toBe('route');
    expect(typeof r.outbound).toBe('string');
  });

  it('全部 route 规则中不存在 outbound:block（否则会被死引用兜底改写成 proxy-selector）', () => {
    expect(rules.filter((r) => r.outbound === 'block')).toEqual([]);
  });

  it('outbounds 中不再定义 legacy block 出站', () => {
    const { outbounds } = buildOutbounds(NODE, CONFIG, idMap, {
      gateInvalidNodes: new Map(),
      log: () => {},
    } as any);
    const tags = outbounds.map((o: any) => o.tag);
    // 反平凡：装配确实产出了出站，否则「不含 block」恒成立。
    expect(tags).toEqual(expect.arrayContaining(['direct', 'proxy-selector']));
    expect(tags).not.toContain('block');
    expect(outbounds.filter((o: any) => o.type === 'block')).toEqual([]);
  });
});
