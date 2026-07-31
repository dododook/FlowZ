/**
 * **显式 HTTP client 门**：锁住「生成产物里不存在任何依赖隐式默认 HTTP client 的消费点」。
 *
 * # 这扇门守的是什么
 *
 * sing-box 1.14.0 把「隐式默认 HTTP client（走默认出站）」标为弃用、**计划 1.16.0 移除**
 * （上游 `experimental/deprecated/constants.go` 的 `OptionImplicitDefaultHTTPClient`：
 * DeprecatedVersion "1.14.0" / ScheduledVersion "1.16.0"）。移除后
 * `httpclient.Manager.DefaultTransport()` 拿不到回落工厂即返回 nil，消费点直接报错——
 * 对 dashboard 是 `create dashboard http client` → api service 起不来。FlowZ 新装默认
 * `singboxDashboard: true`（ConfigManager 种子），故影响面是全量新装用户。
 *
 * 核里**只有两个**消费点索取那个默认 transport（1.14.0-alpha.45 源码全仓 `DefaultTransport()`
 * 调用面：`service/api/dashboard.go` 与 `route/rule/rule_set_remote.go`）。本门按这两条逐一断言。
 *
 * # 为什么门里带「谓词有牙」对照
 *
 * 本仓当前**不生成任何 `type:'remote'` rule_set**（远程能力已 fail-closed 移除，见
 * `singbox-custom-rules.ts`），所以「远端 rule-set 必须带 http_client」这条在真实语料上恒真——
 * **恒真的断言等于没有断言**。故末尾用合成配置反向证明：把违规形态喂给同一个谓词，必须报出违规。
 * 语料侧转绿 + 谓词侧有牙，合起来才是有信息量的门。
 *
 * # 不要往 local rule_set 上加 http_client
 *
 * 真机实测（1.14.0-alpha.45）：`type:'local'` 条目上的 `http_client` / `download_detour` 被按未知字段
 * 拒绝，`sing-box check` 直接 FATAL。故本门只要求 **remote** 条目带，local 条目带了反而是违规。
 */
jest.mock('electron', () => ({
  app: {
    getPath: () => '/fake/userData',
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => '/fake/app',
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ProxyManager } from '../ProxyManager';
import { resourceManager } from '../ResourceManager';
import type { UserConfig, ServerConfig } from '../../../shared/types';
import type { SingBoxConfig } from '../singbox-config-types';

/** 1.14 才注入 services[]（hasManagementApi 门控）；<1.14 的核没有 services schema。 */
const CORE_1_14 = '1.14.0';

function makeSvc(coreVersion = CORE_1_14): any {
  const svc: any = new ProxyManager(undefined, undefined, '/fake/cfg.json', '/fake/sing-box');
  svc.coreVersion = coreVersion;
  return svc;
}

function server(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 's1',
    name: 'HK',
    protocol: 'vless',
    address: 'a.example.com',
    port: 443,
    uuid: 'uuid-1',
    ...over,
  } as ServerConfig;
}

function cfg(over: Partial<UserConfig> = {}): UserConfig {
  return {
    subscriptions: [],
    servers: [server()],
    selectedServerId: 's1',
    proxyMode: 'smart',
    proxyModeType: 'systemProxy',
    tunConfig: { mtu: 1350, stack: 'auto', autoRoute: true, strictRoute: true },
    customRules: [],
    appRules: [],
    customAppPresets: [],
    autoStart: false,
    silentStart: false,
    autoConnect: false,
    minimizeToTray: false,
    socksPort: 1080,
    httpPort: 1087,
    mixedPort: 7890,
    logLevel: 'info',
    clashApiSecret: 'testsecret',
    singboxDashboard: true,
    ...over,
  } as unknown as UserConfig;
}

/**
 * 谓词：返回该 config 上所有「依赖隐式默认 HTTP client」的违规点。空数组 = 合规。
 *
 * 吃 `SingBoxConfig`（= 落到核嘴里的 JSON 形态）而非中间态：门要守的是最终产物，
 * 走中间变量会把「算出来了但没写进 config」这类失效方式漏掉。
 */
function violations(cfg_: SingBoxConfig): string[] {
  const out: string[] = [];

  // 配置里真实存在的出站 tag 全集（detour 必须命中其一，否则核 "outbound not found" FATAL）。
  const knownTags = new Set<string>(
    [
      ...(cfg_.outbounds ?? []).map((o) => o.tag),
      ...(cfg_.endpoints ?? []).map((e) => e.tag),
    ].filter((t): t is string => !!t)
  );

  // ── 消费点 1：services[].dashboard（核 service/api/dashboard.go 的 resolveTransport）──
  (cfg_.services ?? []).forEach((svc, i) => {
    const dash = svc.dashboard;
    if (!dash || dash.enabled !== true) return;
    const detour = dash.http_client?.detour;
    if (detour === undefined) {
      out.push(`services[${i}].dashboard 缺少 http_client（会落到已弃用的隐式默认 HTTP client）`);
      return;
    }
    // 空串会被核判 IsEmpty() 而重新落回隐式默认——声明了等于没声明。
    if (detour.trim() === '') out.push(`services[${i}].dashboard.http_client.detour 为空`);
    else if (!knownTags.has(detour)) {
      out.push(`services[${i}].dashboard.http_client.detour 指向不存在的出站: ${detour}`);
    }
  });

  // ── 消费点 2：type:'remote' 的 rule_set（核 route/rule/rule_set_remote.go）──
  // local 条目**不得**带这两个键：1.14.0-alpha.45 按未知字段拒绝，check 即 FATAL。
  (cfg_.route?.rule_set ?? []).forEach((rs, i) => {
    const raw = rs as unknown as Record<string, unknown>;
    if (rs.type === 'remote') {
      const hc = raw.http_client as { detour?: string } | undefined;
      if (!hc || typeof hc.detour !== 'string' || hc.detour.trim() === '') {
        out.push(`route.rule_set[${i}](${rs.tag}) 是 remote 但没有非空 http_client.detour`);
      } else if (!knownTags.has(hc.detour)) {
        out.push(
          `route.rule_set[${i}](${rs.tag}).http_client.detour 指向不存在的出站: ${hc.detour}`
        );
      }
    } else if (raw.http_client !== undefined || raw.download_detour !== undefined) {
      out.push(
        `route.rule_set[${i}](${rs.tag}) 是 ${rs.type} 却带了 http_client/download_detour（核按未知字段 FATAL）`
      );
    }
  });

  return out;
}

/** 语料：每条覆盖一个会改变 route.final 或 dashboard 形态的维度。 */
const CASES: { name: string; config: UserConfig; serveDir: string | null }[] = [
  { name: 'smart 模式 + 本地 serve 目录', config: cfg(), serveDir: '/fake/dashboard' },
  { name: 'smart 模式 + 无 serve 目录（联网兜底腿）', config: cfg(), serveDir: null },
  {
    name: 'global 模式（final = 选中节点/selector）',
    config: cfg({ proxyMode: 'global' } as Partial<UserConfig>),
    serveDir: '/fake/dashboard',
  },
  {
    name: 'direct 模式（final = direct）',
    config: cfg({ proxyMode: 'direct' } as Partial<UserConfig>),
    serveDir: null,
  },
  {
    name: 'direct 模式 + 本地 serve 目录',
    config: cfg({ proxyMode: 'direct' } as Partial<UserConfig>),
    serveDir: '/fake/dashboard',
  },
  {
    name: '自定义域名规则（route.rules 扩张）',
    config: cfg({
      customRules: [
        { id: 'r1', type: 'domainSuffix', values: ['example.com'], action: 'proxy', enabled: true },
      ],
    } as unknown as Partial<UserConfig>),
    serveDir: null,
  },
];

function generate(config: UserConfig, serveDir: string | null): SingBoxConfig {
  jest.spyOn(resourceManager, 'resolveDashboardServeDir').mockReturnValue(serveDir);
  return makeSvc().generateSingBoxConfig(config) as SingBoxConfig;
}

describe('显式 HTTP client 门（sing-box 1.16.0 将移除隐式默认）', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(CASES)('$name → 无隐式默认 HTTP client 消费点', ({ config, serveDir }) => {
    expect(violations(generate(config, serveDir))).toEqual([]);
  });

  it.each(CASES)(
    '$name → dashboard.http_client.detour 逐字等于 route.final',
    ({ config, serveDir }) => {
      const out = generate(config, serveDir);
      const dash = out.services?.[0]?.dashboard;
      expect(dash?.enabled).toBe(true);
      // 等价性断言：被替换掉的隐式回落在核里就是「走默认出站」，而默认出站正是 route.final 指的 tag。
      // 有人把它改成写死 'direct' 时本条必红（那会把 path 省略时的联网下载腿从走代理改成走直连）。
      expect(dash?.http_client?.detour).toBe(out.route?.final);
    }
  );

  it('dashboard 关闭 → 不注入 dashboard，也就没有这个消费点', () => {
    const out = generate(
      cfg({ singboxDashboard: false } as Partial<UserConfig>),
      '/fake/dashboard'
    );
    expect(out.services?.[0]?.dashboard).toBeUndefined();
    expect(violations(out)).toEqual([]);
  });

  it('本仓不生成任何 remote rule_set（故消费点 2 在真实语料上恒真——见下条谓词有牙对照）', () => {
    const out = generate(cfg(), '/fake/dashboard');
    expect((out.route?.rule_set ?? []).filter((rs) => rs.type === 'remote')).toEqual([]);
  });

  // ── 谓词有牙：合成违规形态逐个喂给同一个谓词，必须都被抓到 ──
  describe('谓词有牙（防恒真断言）', () => {
    const base = (): SingBoxConfig =>
      ({
        log: { level: 'info' },
        inbounds: [],
        outbounds: [
          { type: 'direct', tag: 'direct' },
          { type: 'selector', tag: 'proxy-selector' },
        ],
        route: { final: 'proxy-selector', rule_set: [] },
        services: [{ type: 'api', listen: '127.0.0.1', listen_port: 9091 }],
      }) as unknown as SingBoxConfig;

    it('dashboard 缺 http_client → 抓到', () => {
      const c = base();
      c.services![0].dashboard = { enabled: true, path: '/x' };
      expect(violations(c)).toHaveLength(1);
      expect(violations(c)[0]).toContain('缺少 http_client');
    });

    it('detour 为空串 → 抓到（核判 IsEmpty 后重新落回隐式默认）', () => {
      const c = base();
      c.services![0].dashboard = { enabled: true, http_client: { detour: '' } };
      expect(violations(c)[0]).toContain('为空');
    });

    it('detour 指向不存在的出站 → 抓到（核 outbound not found FATAL）', () => {
      const c = base();
      c.services![0].dashboard = { enabled: true, http_client: { detour: 'ghost' } };
      expect(violations(c)[0]).toContain('不存在的出站');
    });

    it('remote rule_set 无 http_client → 抓到', () => {
      const c = base();
      c.route!.rule_set = [
        { tag: 'rs', type: 'remote', format: 'binary', url: 'https://example.com/a.srs' },
      ] as never;
      expect(violations(c)[0]).toContain('remote 但没有非空 http_client.detour');
    });

    it('local rule_set 带 http_client → 抓到（核按未知字段 FATAL）', () => {
      const c = base();
      c.route!.rule_set = [
        {
          tag: 'rs',
          type: 'local',
          format: 'source',
          path: '/x.json',
          http_client: { detour: 'direct' },
        },
      ] as never;
      expect(violations(c)[0]).toContain('却带了 http_client/download_detour');
    });

    it('合规形态 → 零违规（防谓词恒报错）', () => {
      const c = base();
      c.services![0].dashboard = { enabled: true, http_client: { detour: 'proxy-selector' } };
      c.route!.rule_set = [
        { tag: 'rs', type: 'local', format: 'source', path: '/x.json' },
      ] as never;
      expect(violations(c)).toEqual([]);
    });
  });
});
