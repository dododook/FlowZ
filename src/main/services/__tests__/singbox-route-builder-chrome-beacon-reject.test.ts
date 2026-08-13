/**
 * #352 —— 「无条件域名黑名单」禁令门。
 *
 * 缺陷形态：`buildRouteConfig` 曾有一张无条件（`proxyMode !== 'direct'` 即发射）的 `action: 'reject'`
 * 域名表，收录 14 个 Google 域名，本意是拒掉 Chrome 周期性后台服务、防它们在代理出口超时"耗尽连接池"。
 * 其中 **`clients2.google.com` 是扩展商店 CRX 的更新与下载端点** —— 于是每个 FlowZ 用户装扩展/主题必失败
 * （Chrome 报 `Download interrupted`），系统代理与 TUN 同症（route 规则模式无关），而其他 sing-box
 * 客户端无此表故不复现。真内核 A/B 实测：表在场 `connection closed: rejected`；移除后同一 URL
 * 302 → CRX 200 / 47794 B。表内另有三处静默功能损失：Chrome 自升级、Google 账号登录、FCM 网页推送。
 *
 * 根因不是"名单里多收了一个域名"，是**这类名单本身**：声称的连接池机制不成立（sing-box 无跨目的地共享池、
 * Chrome socket 上限是每 host 6 条），引入时无 issue、无复现、无测试，且注释写"强制直连"而代码写 `reject`
 * —— 从第一天起就未被复核。故整块删除，而非缩表。
 *
 * 本门钉的是**判据**而不是那 14 个域名：**任何按域名匹配、且不带 `network`/`port` 收窄的 reject 规则
 * 都不得出现**。缩表版、换一批域名的新表、别处再塞一张，全部判红。
 *
 * 为什么用"不带 network/port"划界：FlowZ 有两类刻意的 reject —— QUIC(UDP 443) 迫使回退 TCP、
 * DoH 域名(443/853) 防泄漏绕过 hijack-dns。它们都带收窄字段，且都不是"整类域名一律拒"。
 * 另两类不按域名匹配（`protocol: 'stun'` 的 WebRTC block 档、自定义规则的 logical AND udp443），
 * 天然不在射程内 —— 下方 blockQuic 档就是为证明本门不误伤它们而设。
 *
 * "不存在某物"是负面断言，单独立会在「matcher 根本遍历不到 reject 规则」时空过。故配正向对照：
 * 放宽收窄豁免后，同一份配置里必须能查出带域名匹配的 reject（DoH 那两条）。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-route-beacon-test-'));
jest.mock('electron', () => ({
  app: { getPath: () => TMP, getAppPath: () => TMP, isPackaged: false },
  net: {},
}));

import { buildRouteConfig, type RouteConfigDeps } from '../singbox-route-builder';
import { getRuleSetRuntimeDir } from '../builtin-geo-rulesets';
import type { ServerConfig, UserConfig } from '../../../shared/types';

// smart 默认地区分流(cn) 引用 CN 三件套；不种本地副本会被末尾剪枝。与同目录其它 route-builder 单测同约定。
{
  const dir = getRuleSetRuntimeDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['geosite-cn.srs', 'geosite-geolocation-!cn.srs', 'geoip-cn.srs']) {
    fs.writeFileSync(path.join(dir, f), Buffer.from('SRS'));
  }
}

/**
 * 旧表里掉了会产生**用户可见功能损失**的端点。本门的主断言已覆盖它们（无条件域名 reject 一律禁），
 * 这里再逐条点名是为了让失败信息直接指向用户症状，而不是只报"多了一条规则"。
 */
const LOAD_BEARING: Array<[host: string, why: string]> = [
  ['clients2.google.com', '扩展商店 CRX 更新与下载端点（#352 本体）'],
  ['clients2.googleusercontent.com', 'CRX blob 实际落点（clients2 的 302 目标）'],
  ['edgedl.me.gvt1.com', 'Google 二进制下载 CDN（组件更新 / CRX blob）'],
  ['redirector.gvt1.com', '下载 CDN 重定向入口'],
  ['update.googleapis.com', 'Chrome 自身升级检查'],
  ['oauthaccountmanager.googleapis.com', 'Google 账号登录 / 令牌刷新'],
  ['mtalk.google.com', 'FCM —— 网页推送通知的承载通道'],
  ['chromewebstore.google.com', '扩展商店页面本体'],
];

const proxyNode = (): ServerConfig =>
  ({
    id: 'p1',
    name: 'HK',
    protocol: 'vless',
    address: 'a.example.com',
    port: 443,
    uuid: 'u1',
  }) as ServerConfig;

const deps = (): RouteConfigDeps => ({
  probeDirectPort: null,
  probeProxyPort: null,
  updateInPort: null,
  lanResolverForDns: null,
  pendingEndpoints: [],
  log: () => {},
  onDegraded: () => {},
});

/** 带域名匹配（domain / domain_suffix / domain_keyword）的 reject 规则。 */
const domainRejects = (rc: any, opts: { includeNarrowed: boolean }): any[] =>
  (rc.rules || []).filter((r: any) => {
    if (r.action !== 'reject') return false;
    if (r.domain === undefined && r.domain_suffix === undefined && r.domain_keyword === undefined) {
      return false;
    }
    return opts.includeNarrowed || (r.network === undefined && r.port === undefined);
  });

const matchesHost = (r: any, host: string): boolean =>
  (r.domain ?? []).includes(host) ||
  (r.domain_suffix ?? []).some((s: string) => host === s || host.endsWith(s)) ||
  (r.domain_keyword ?? []).some((k: string) => host.includes(k));

/**
 * 三个档位：smart / global 覆盖旧表的发射条件；smart + blockQuic + 一条走代理的自定义规则，
 * 用来发射 QUIC 收窄 reject 与 logical AND udp443 reject —— 证明本门不把它们误判成黑名单。
 */
const ARMS: Array<[name: string, cfg: UserConfig]> = [
  [
    'smart',
    {
      proxyMode: 'smart',
      servers: [proxyNode()],
      selectedServerId: 'p1',
      customRules: [],
      appRules: [],
    } as unknown as UserConfig,
  ],
  [
    'global',
    {
      proxyMode: 'global',
      servers: [proxyNode()],
      selectedServerId: 'p1',
      customRules: [],
      appRules: [],
    } as unknown as UserConfig,
  ],
  [
    'smart + blockQuic + 自定义代理规则（正向不误伤对照）',
    {
      proxyMode: 'smart',
      servers: [proxyNode()],
      selectedServerId: 'p1',
      blockQuic: true,
      // 两条件 + combineMode='and' → 走 logical 分支，发射 (原 logical) ∧ (udp:443) 的 reject。
      customRules: [
        {
          id: 'c1',
          enabled: true,
          combineMode: 'and',
          conditions: [
            { type: 'domain', values: ['example.org'] },
            { type: 'port', values: ['8443'] },
          ],
          action: 'proxy',
          targetServerId: 'p1',
        },
      ],
      appRules: [],
    } as unknown as UserConfig,
  ],
];

describe.each(ARMS)('#352 无条件域名黑名单禁令（%s）', (_name, userConfig) => {
  const rc: any = buildRouteConfig(userConfig, new Map([['p1', 'HK']]), deps());

  it('正向对照：放宽收窄豁免后确实能查出带域名匹配的 reject（证明 matcher 不是瞎的）', () => {
    expect(domainRejects(rc, { includeNarrowed: true }).length).toBeGreaterThan(0);
  });

  it('不存在任何「按域名匹配且无 network/port 收窄」的 reject 规则', () => {
    expect(domainRejects(rc, { includeNarrowed: false })).toEqual([]);
  });

  it.each(LOAD_BEARING)('承载功能的端点未被无条件拒绝：%s（%s）', (host) => {
    expect(
      domainRejects(rc, { includeNarrowed: false }).filter((r) => matchesHost(r, host))
    ).toEqual([]);
  });
});

// 第三档「不误伤」若本就没发射出那两类刻意 reject，该档等于白跑。此处证明它们确实在场，
// 从而上面「无条件域名 reject 为空」是**在有收窄 reject 共存的配置里**取得的，不是因为整份配置没有 reject。
describe('#352 门的不误伤对照非空（QUIC / logical 两类刻意 reject 确实发射）', () => {
  const rc: any = buildRouteConfig(ARMS[2][1], new Map([['p1', 'HK']]), deps());
  const rejects = (rc.rules || []).filter((r: any) => r.action === 'reject');

  it('存在带 network/port 收窄的域名 reject（QUIC 阻断 / DoH 防泄漏）', () => {
    expect(
      rejects.filter((r: any) => r.network !== undefined || r.port !== undefined).length
    ).toBeGreaterThan(0);
  });

  it('存在 logical 型 reject（自定义代理规则 ∧ udp443），且其顶层不带域名匹配故不入本门射程', () => {
    const logical = rejects.filter((r: any) => r.type === 'logical');
    expect(logical.length).toBeGreaterThan(0);
    for (const r of logical) {
      expect([r.domain, r.domain_suffix, r.domain_keyword]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    }
  });
});
