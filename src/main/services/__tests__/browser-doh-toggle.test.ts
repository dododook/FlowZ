/**
 * 浏览器 DoH 拦截：开关 + 可编辑清单的行为门。
 *
 * 背景：这两条 reject 此前**恒发射且无开关**——用户即使明确想用浏览器 DoH 也关不掉，且清单是硬编码的
 * 5 个关键词。而按域名拦本质是黑名单：浏览器可指向任意 DoH 提供商（NextDNS / AdGuard / Mullvad /
 * DNS.SB / ControlD…，Firefox 还能填任意 URL），固定内置表必然漏。故改成「开关 + 可编辑清单，内置项
 * 只作默认值」，与「绕过局域网」同一形态。
 *
 * 本门钉四件事：
 *  ① 默认（字段全缺省）保持历史行为——两条都发射且用内置清单（`undefined ≠ false`，不能因为加了开关就默默关掉）；
 *  ② 关掉开关 → 两条**都**不发射（不能只关一条，那样 DoH-over-QUIC 或 DoH-over-TCP 仍被拦，行为自相矛盾）；
 *  ③ 自定义清单 → 两条**都**改用它，且是**同一份**数组（原注释就强调过两处必须同源，漏改一处即行为漂移）；
 *  ④ 清单被删空 → 等价于关（不能退化成 `domain_keyword: []` 这种匹配语义不明的规则）。
 *
 * ②③④ 的「两条都」是本门的核心：单看一条会让「只改了 TCP 那条」这类漏改全绿。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-doh-toggle-test-'));
jest.mock('electron', () => ({
  app: { getPath: () => TMP, getAppPath: () => TMP, isPackaged: false },
  net: {},
}));

import { buildRouteConfig, type RouteConfigDeps } from '../singbox-route-builder';
import { getRuleSetRuntimeDir } from '../builtin-geo-rulesets';
import { DEFAULT_BROWSER_DOH_KEYWORDS } from '../../../shared/browser-doh';
import type { ServerConfig, UserConfig } from '../../../shared/types';

{
  const dir = getRuleSetRuntimeDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['geosite-cn.srs', 'geosite-geolocation-!cn.srs', 'geoip-cn.srs']) {
    fs.writeFileSync(path.join(dir, f), Buffer.from('SRS'));
  }
}

const deps = (): RouteConfigDeps => ({
  probeDirectPort: null,
  probeProxyPort: null,
  updateInPort: null,
  lanResolverForDns: null,
  pendingEndpoints: [],
  log: () => {},
  onDegraded: () => {},
});

const build = (extra: Partial<UserConfig>): any =>
  buildRouteConfig(
    {
      proxyMode: 'smart',
      servers: [
        {
          id: 'p1',
          name: 'HK',
          protocol: 'vless',
          address: 'a.example.com',
          port: 443,
          uuid: 'u1',
        } as ServerConfig,
      ],
      selectedServerId: 'p1',
      customRules: [],
      appRules: [],
      ...extra,
    } as unknown as UserConfig,
    new Map([['p1', 'HK']]),
    deps()
  );

/** DoH 拦截的两条腿：TCP(443/853) 与 UDP(443)。各返回其 domain_keyword，缺席则 null。 */
const dohLegs = (rc: any): { tcp: string[] | null; udp: string[] | null } => {
  const rejects = (rc.rules || []).filter(
    (r: any) => r.action === 'reject' && Array.isArray(r.domain_keyword)
  );
  const tcp = rejects.find(
    (r: any) => r.network === undefined && Array.isArray(r.port) && r.port.includes(853)
  );
  const udp = rejects.find(
    (r: any) => Array.isArray(r.network) && r.network.includes('udp') && !r.domain_suffix
  );
  return { tcp: tcp?.domain_keyword ?? null, udp: udp?.domain_keyword ?? null };
};

describe('浏览器 DoH 拦截：开关 + 可编辑清单', () => {
  it('① 默认（字段全缺省）：两条腿都发射，且用内置清单（undefined ≠ false）', () => {
    const { tcp, udp } = dohLegs(build({}));
    expect(tcp).toEqual([...DEFAULT_BROWSER_DOH_KEYWORDS]);
    expect(udp).toEqual([...DEFAULT_BROWSER_DOH_KEYWORDS]);
    // 反平凡：内置清单不能是空的，否则上面两条恒成立。
    expect(DEFAULT_BROWSER_DOH_KEYWORDS.length).toBeGreaterThanOrEqual(3);
  });

  it('② 关掉开关：两条腿都不发射', () => {
    expect(dohLegs(build({ blockBrowserDoh: false } as Partial<UserConfig>))).toEqual({
      tcp: null,
      udp: null,
    });
  });

  it('③ 自定义清单：两条腿都改用它（同一份，杜绝只改一处的漂移）', () => {
    const list = ['dns.nextdns.io', 'dns.adguard-dns.com'];
    const { tcp, udp } = dohLegs(build({ browserDohList: list } as unknown as Partial<UserConfig>));
    expect(tcp).toEqual(list);
    expect(udp).toEqual(list);
    // 内置项必须真被替换掉，否则「可编辑」是假的。
    expect(tcp).not.toContain('dns.google');
  });

  it('④ 清单删空（含只剩空白项）：等价于关，不发射空匹配器的规则', () => {
    expect(
      dohLegs(build({ browserDohList: ['  ', ''] } as unknown as Partial<UserConfig>))
    ).toEqual({ tcp: null, udp: null });
  });
});
