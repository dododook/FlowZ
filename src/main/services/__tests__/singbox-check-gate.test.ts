/**
 * `sing-box check` 门 —— 把 generateSingBoxConfig 的产物交**随包内核**校验，而不是只交单测的 JS 断言。
 *
 * 为什么需要它（单测覆盖不到的逃逸面）：
 *  - 值域：`domain_resolver.strategy` 取未知值 → check FATAL `unknown domain strategy`（实证）；
 *  - 引用：`domain_resolver.server` 指向不存在的 DNS server tag → check FATAL `domain resolver not found`（实证）。
 * 这两类错误 tsc 与纯 JS 断言都拦不住（前者是内核枚举、后者是跨字段引用完整性）。
 *
 * 明确的**能力边界**（不得以「check 过了」为由省略单测）：check 对对象内**键名**无牙——实测把
 * `strategy` 写成 `stratgy` 仍 exit=0（字段被静默丢弃 → 修复静默失效）。键名形状由
 * singbox-outbound-builder.test.ts / singbox-outbounds-build.test.ts 的 `toEqual` 深等断言把守。
 *
 * **调用位置（不在默认 `npm test` 里）**：本门需随包内核，而 `npm test` / CI 测试 job 都没有它（二进制 66–74MB、
 * 已 gitignore、CI 不跑 fetch:core）。故 jest.config.js 的 testPathIgnorePatterns 把本文件排除出默认测试集，改由
 * `npm run test:core-gate` 单独跑；该 script 已接进 **package:\* / dist:\* / release:prepare** —— 这些链本就先跑
 * `fetch:core`，核在那里恒存在，且 `&&` 短路使门红即整条打包链非零退出。真实执行位置是 **main push 的完整打包链**
 * （package.yml 走 `npm run package:<platform>`）与 **tag 发布**（release.yml 同链）、以及本机手动
 * `npm run test:core-gate`——**不含 PR**：PR 走的是 inline 冒烟（`build:helper`/`fetch:core`/`fetch:cronet`/
 * `fetch:dashboard`/`build`/`electron-builder --dir`），不经过 `package:*`；且 package.yml 的 paths 过滤器不含
 * `src/main/**`，config-gen 代码改动根本不触发它。定位：这是**发版前**的 config 有效性拦截，不是 PR 门；PR 阶段
 * 的形态保护由单测 `toEqual` 精确形状锁承担（跨平台恒有效、每个 PR 都跑）。
 *
 * 门的三问（建门与功能代码同等审查）：
 *  1. 验的是不是它声称的对象？—— 每个用例在跑 check 前先**断言产物里确实存在被校验的形态**
 *     （结构化 / 字符串 domain_resolver，且深等到具体 tag 与 strategy）。否则一个「碰巧不含 domain_resolver」
 *     的 config 也会 exit=0 假绿。
 *  2. 前置缺失时失败还是静默跳过？—— 内核缺失即**硬 fail**，且**无任何豁免通道**：既没有 return 型 skip，也没有
 *     环境变量开关。豁免曾经存在的唯一理由是「CI 无核却要跑本门」；换成上述调用位置后该前提消失，再留着
 *     就只剩关门用途，故一并删净。
 *  3. 靠语义还是位置巧合？—— 断言的是内核退出码与 stderr 语义，且用**变异自检**证明本 harness 抓得到失败
 *     （最后一个用例：把 strategy 改成非法值，要求 check 必须 FATAL；否则说明 harness 恒绿=没门）。
 *
 * 覆盖范围如实：geo rule_set 在测试环境（无 .srs 运行时目录）被 applyRuleSetPrune 剪除，故本门校验的是
 * 剪枝后的 config；DNS/出站/入站/路由主体齐全，足以覆盖 domain_resolver 的值与引用面。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-sbcheck-'));
jest.mock('electron', () => ({
  app: {
    getPath: () => TMP,
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => TMP,
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ProxyManager } from '../ProxyManager';
import type { UserConfig, ServerConfig } from '../../../shared/types';
import type { SingBoxConfig, SingBoxDomainResolver } from '../singbox-config-types';

// ── 随包内核定位与前置门 ──────────────────────────────────────────────────────────
const REPO_ROOT = path.resolve(__dirname, '../../../..');
/** 与 scripts/fetch-core.mjs 的落盘目录一致（resources/{linux,win,mac-x64,mac-arm64}）。 */
function bundledCorePath(): string {
  if (process.platform === 'win32') return path.join(REPO_ROOT, 'resources/win/sing-box.exe');
  if (process.platform === 'darwin') {
    return path.join(
      REPO_ROOT,
      process.arch === 'arm64' ? 'resources/mac-arm64/sing-box' : 'resources/mac-x64/sing-box'
    );
  }
  return path.join(REPO_ROOT, 'resources/linux/sing-box');
}
const CORE = bundledCorePath();
const CORE_PRESENT = (() => {
  try {
    fs.accessSync(CORE, fs.constants.X_OK);
    return fs.statSync(CORE).isFile();
  } catch {
    return false;
  }
})();

interface CheckResult {
  code: number;
  stderr: string;
}
/** 跑 `sing-box check -c <file>`。内核缺失 → 抛错（门 fail，不静默跳过，无豁免）。 */
function runCheck(config: SingBoxConfig, name: string): CheckResult {
  if (!CORE_PRESENT) {
    throw new Error(
      `sing-box check 门无法执行：随包内核缺失或不可执行（${CORE}）。` +
        '本门只在核确定存在的链路上被调用（npm run test:core-gate，已接进 package:*/dist:*/release:prepare，' +
        '这些链先跑 fetch:core）；走到这里说明环境坏了，必须红。本机手动跑请先 `npm run fetch:core`。'
    );
  }
  const file = path.join(TMP, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  try {
    execFileSync(CORE, ['check', '-c', file], { stdio: 'pipe', timeout: 30_000 });
    return { code: 0, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer };
    return { code: err.status ?? -1, stderr: err.stderr?.toString() ?? '' };
  }
}
/** 断言 check 通过；失败时把内核 stderr 原样带出（否则只看到 exit code 无从定位）。 */
function expectCheckOk(config: SingBoxConfig, name: string): void {
  const r = runCheck(config, name);
  if (r.code !== 0) {
    throw new Error(`sing-box check 未通过（${name}，exit=${r.code}）：\n${r.stderr}`);
  }
}

// ── config 语料 ──────────────────────────────────────────────────────────────────
function svcFor(raceServerPort = 0): {
  gen: (c: UserConfig) => SingBoxConfig;
} {
  const svc: any = new ProxyManager(
    undefined,
    undefined,
    path.join(TMP, 'cfg.json'),
    '/fake/sing-box'
  );
  svc.coreVersion = '1.14.0';
  // raceServerPort>0 = race server 就绪 → 节点 dial/rule 解析器走 dns-node-race（跨字段引用面，M7 的对象）。
  svc.raceServerPort = raceServerPort;
  return { gen: (c: UserConfig) => svc.generateSingBoxConfig(c) as SingBoxConfig };
}

const domainNode = (over: Partial<ServerConfig> = {}): ServerConfig =>
  ({
    id: 's1',
    name: 'HK',
    protocol: 'vless',
    address: 'node.v6only.test', // 域名节点 = 本修复的对象（IP 字面量不经 DNS）
    port: 443,
    uuid: '00000000-0000-0000-0000-00000000000a',
    ...over,
  }) as unknown as ServerConfig;

const wgDomainNode = (): ServerConfig =>
  ({
    id: 'w1',
    name: 'WG',
    protocol: 'wireguard',
    address: 'wg.v6only.test', // 域名 peer → endpoint 侧 domain_resolver
    port: 51820,
    wireguardSettings: {
      privateKey: 'cHJpdmtleQ==',
      peerPublicKey: 'cHVia2V5',
      localAddress: ['10.0.0.2/32'],
    },
  }) as unknown as ServerConfig;

function cfg(over: Partial<UserConfig>): UserConfig {
  return {
    subscriptions: [],
    servers: [],
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
    ...over,
  } as unknown as UserConfig;
}

/** 取节点出站的 domain_resolver（gate 自检用：证明产物里确实有被校验的对象）。 */
function nodeResolverOf(c: SingBoxConfig, tag: string): SingBoxDomainResolver | undefined {
  return c.outbounds?.find((o) => o.tag === tag)?.domain_resolver;
}
/** config 里所有 DNS server tag —— 用于本地先验引用完整性（check 的 FATAL 是最终裁判）。 */
function dnsTags(c: SingBoxConfig): string[] {
  return (c.dns?.servers ?? []).map((s) => s.tag);
}

// ── 门 ──────────────────────────────────────────────────────────────────────────
jest.setTimeout(60_000);

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('sing-box check 门 — 前置', () => {
  it('随包内核存在且可执行（缺失即硬 fail，无豁免通道）', () => {
    expect(CORE_PRESENT).toBe(true);
  });
});

describe('sing-box check 门 — 生成的全量 config', () => {
  it('关 IPv6 + 域名节点（默认档）→ 产物含结构化 domain_resolver 且 check 通过', () => {
    const c = svcFor().gen(cfg({ servers: [domainNode()] }));
    // ① 验的是不是声称的对象：产物必须真的含结构化形态，否则 check 绿也无意义。
    // 用 toEqual 深等（非 typeof + 属性点检）：点检会放多余键/错键过，与本仓其余形状锁口径一致。
    // svcFor() 默认 raceServerPort=0 → race off + 缺省档 → dial tag = dns-bootstrap。
    const dr = nodeResolverOf(c, 'HK');
    expect(dr).toEqual({ server: 'dns-bootstrap', strategy: 'prefer_ipv4' });
    // ② 引用完整性先验（check 的 FATAL 是最终裁判）
    expect(dnsTags(c)).toContain('dns-bootstrap');
    expectCheckOk(c, 'ipv6-off-default');
  });

  it('开 IPv6 + 域名节点 → 产物为字符串 tag 且 check 通过（该分支形态不变也得可用）', () => {
    const c = svcFor().gen(
      cfg({ servers: [domainNode()], enableIPv6: true } as Partial<UserConfig>)
    );
    // 同① 的口径：断到具体 tag，而不是只断 typeof === 'string'（后者任何字符串都放过）。
    expect(nodeResolverOf(c, 'HK')).toBe('dns-bootstrap');
    expect(dnsTags(c)).toContain('dns-bootstrap');
    expectCheckOk(c, 'ipv6-on');
  });

  it('race on（dns-node-race）+ TUN/FakeIP + 域名节点 + 域名-peer WG endpoint → check 通过', () => {
    const wg = wgDomainNode();
    const c = svcFor(15353).gen(
      cfg({
        proxyModeType: 'tun',
        servers: [domainNode(), wg],
        dnsConfig: { enableFakeIp: true },
      } as unknown as Partial<UserConfig>)
    );
    // outbound 侧：结构化且引用 race server tag（M7 的悬空引用面由 check 兜底）
    const dr = nodeResolverOf(c, 'HK') as { server: string; strategy?: string };
    expect(dr).toEqual({ server: 'dns-node-race', strategy: 'prefer_ipv4' });
    expect(dnsTags(c)).toContain('dns-node-race');
    // endpoint 侧：WG 域名 peer 同形态（漏改 buildWireGuardEndpoint call site 在此可见）
    const ep = c.endpoints?.find((e) => e.tag === 'WG');
    expect(ep?.domain_resolver).toEqual({ server: 'dns-node-race', strategy: 'prefer_ipv4' });
    expectCheckOk(c, 'race-on-tun-wg');
  });

  it('#347 FakeIP 关 + 拨号前解析开 + 强制直连自定义规则 → 非-FakeIP 分支的出口影子规则被真核接受', () => {
    // 撤掉 usesFakeIp 前置门后**新可达**的一格（存量 systemProxy 用户的默认态就是 FakeIP 关）。
    // 该分支的影子规则由本 PR 新加，引用 getDomesticResolverTag 的 tag；悬空引用 check 会 FATAL。
    const c = svcFor().gen(
      cfg({
        servers: [domainNode()],
        dnsConfig: { enableFakeIp: false },
        resolveDestination: true,
        customRules: [
          {
            id: 'r-fd',
            type: 'domainSuffix',
            values: ['forcedirect.example'],
            action: 'direct',
            enabled: true,
            bypassFakeIP: false,
          },
        ],
      } as unknown as Partial<UserConfig>)
    );
    // ① 验的是不是声称的对象：route 侧 resolve 在、DNS 侧影子腿在（缺一则 check 绿也无意义）。
    expect(
      (c.route?.rules ?? []).some((r) => (r as { action?: string }).action === 'resolve')
    ).toBe(true);
    const shadow = (c.dns?.rules ?? []).find((r) =>
      ((r as { domain_suffix?: string[] }).domain_suffix ?? []).some((d) =>
        d.includes('forcedirect.example')
      )
    ) as { server?: string } | undefined;
    expect(shadow).toBeDefined();
    // ② 影子腿必须指向真实存在的境内解析器 tag（引用完整性先验，check 的 FATAL 是最终裁判）。
    expect(dnsTags(c)).toContain(shadow?.server);
    expectCheckOk(c, 'fakeip-off-resolve-on');
  });

  it('阻断动作迁移：自定义规则 + 应用分流的 reject 规则被真核接受，且产物无 legacy block 出站', () => {
    // 迁移把「阻断」从 legacy `outbound: 'block'` 换成 sing-box 1.14 的 `action: 'reject'`，并删除了
    // block 出站。单测只能证「生成了什么」，证不了「内核收不收」——若 1.14 对 reject 规则的字段组合
    // 另有约束（如不允许与某些匹配器共存），或 block 出站还有别处引用，check 会 FATAL。
    const c = svcFor().gen(
      cfg({
        servers: [domainNode()],
        customRules: [
          {
            id: 'r-blk',
            type: 'domainSuffix',
            values: ['ads.example'],
            action: 'block',
            enabled: true,
          },
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
      } as unknown as Partial<UserConfig>)
    );
    // ① 验的是不是声称的对象：两条阻断腿都在，且都是 reject（缺一则 check 绿也无意义）。
    const legs = (c.route?.rules ?? []).filter((r) => {
      const x = r as { domain_suffix?: string[]; process_name?: string[] };
      return (x.domain_suffix ?? []).includes('ads.example') ||
        (x.process_name ?? []).includes('blocked.exe');
    }) as { action?: string; outbound?: string }[];
    expect(legs).toHaveLength(2);
    for (const leg of legs) {
      expect(leg.action).toBe('reject');
      expect(leg.outbound).toBeUndefined();
    }
    // ② legacy 出站确已从产物消失（留着就还有第二条能走通的路）。
    expect((c.outbounds ?? []).map((o) => o.tag)).not.toContain('block');
    expectCheckOk(c, 'reject-action-migration');
  });

  it('race off + 单上游档 dnspod（tag=dns-node）→ 结构化包裹层与档位正交，check 通过', () => {
    const c = svcFor().gen(
      cfg({
        servers: [domainNode()],
        dnsConfig: { resolveNodeDomainsAhead: false, nodeDomainResolver: 'dnspod' },
      } as unknown as Partial<UserConfig>)
    );
    expect(nodeResolverOf(c, 'HK')).toEqual({ server: 'dns-node', strategy: 'prefer_ipv4' });
    expect(dnsTags(c)).toContain('dns-node');
    expectCheckOk(c, 'race-off-dnspod');
  });

  it('开 dashboard（显式 http_client）→ 内核识别该字段且 check 通过', () => {
    const c = svcFor().gen(
      cfg({ servers: [domainNode()], singboxDashboard: true } as Partial<UserConfig>)
    );
    // ① 验的是不是声称的对象：产物必须真的含 http_client，否则 check 绿只证明「没写这个字段也合法」。
    //    path 是否存在取决于本机 resources/dashboard 是否已 fetch（本门跑在 fetch:dashboard 之前），
    //    故只钉 enabled + http_client 两项，不把「有没有 path」写死进断言。
    const dash = c.services?.[0]?.dashboard;
    expect(dash?.enabled).toBe(true);
    expect(dash?.http_client).toEqual({ detour: c.route?.final });
    // ② 引用完整性先验：detour 必须是真实出站 tag（check 的 "outbound not found" 是最终裁判）。
    expect([
      ...(c.outbounds ?? []).map((o) => o.tag),
      ...(c.endpoints ?? []).map((e) => e.tag),
    ]).toContain(dash?.http_client?.detour);
    expectCheckOk(c, 'dashboard-http-client');
  });
});

// 变异自检：证明本 harness 真的抓得到内核 FATAL（恒绿的 harness = 没门）。
// 同时把 check 的**能力边界**钉成可执行事实：值/引用有牙、对象内键名无牙 → 键名只能靠单测 toEqual。
describe('sing-box check 门 — 门自身的牙（变异自检）', () => {
  const baseline = (): SingBoxConfig => svcFor().gen(cfg({ servers: [domainNode()] }));

  it('变异：strategy 取非法值 → check 必须 FATAL（否则说明本 harness 恒绿）', () => {
    const c = baseline();
    (nodeResolverOf(c, 'HK') as { strategy: string }).strategy = 'bogus_value';
    const r = runCheck(c, 'mut-bad-strategy');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/unknown domain strategy/i);
  });

  it('变异：domain_resolver.server 指向不存在的 tag → check 必须 FATAL（引用完整性有牙）', () => {
    const c = baseline();
    (nodeResolverOf(c, 'HK') as { server: string }).server = 'no-such-tag';
    const r = runCheck(c, 'mut-dangling-tag');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/domain resolver not found/i);
  });

  it('能力边界（负面事实）：键名 typo `stratgy` → check 仍 exit=0 → 键名形状只能由单测 toEqual 把守', () => {
    const c = baseline();
    const ob = c.outbounds!.find((o) => o.tag === 'HK')!;
    const server = (ob.domain_resolver as { server: string }).server;
    ob.domain_resolver = { server, stratgy: 'prefer_ipv4' } as unknown as SingBoxDomainResolver;
    // 该断言若哪天变红 = 内核开始严格校验未知键 → 届时本注释与「不得省略单测」的结论需重估。
    expect(runCheck(c, 'mut-key-typo').code).toBe(0);
  });

  it('变异：dashboard 的 http_client 写成 http_clientt → check 必须 FATAL（证明该字段是真被识别的）', () => {
    // 负向对照：`services[].dashboard` 这一层走 DisallowUnknownFields，故上面那条「键名无牙」的边界
    // **不适用于这里**。没有这条对照，「加了 http_client 后 check 仍通过」就可能只是「这个键被静默丢弃」。
    const c = svcFor().gen(
      cfg({ servers: [domainNode()], singboxDashboard: true } as Partial<UserConfig>)
    );
    const dash = c.services![0].dashboard as unknown as Record<string, unknown>;
    dash.http_clientt = dash.http_client;
    delete dash.http_client;
    expect(runCheck(c, 'mut-dashboard-key-typo').code).not.toBe(0);
  });

  it('能力边界（负面事实）：dashboard.http_client.detour 指向不存在的出站 → check 仍 exit=0', () => {
    // **与 domain_resolver 不同**：那条引用在 check 期解析（"domain resolver not found" FATAL），
    // 而 dashboard 的 detour 是**运行期**才解析的（核 `resolveTransport()` 在 service start 时才跑）。
    // ⇒ 悬空 detour 逃得过 check、只在真机起核时炸。守它的只能是 JS 侧谓词
    // （`explicit-http-client-gate.test.ts` 的「detour 必须在出站/endpoint tag 集合里」）。
    // 该断言若哪天变红 = 内核把这条引用提前到 check 期 → 届时 JS 侧那条可降级为冗余。
    const c = svcFor().gen(
      cfg({ servers: [domainNode()], singboxDashboard: true } as Partial<UserConfig>)
    );
    c.services![0].dashboard!.http_client!.detour = 'no-such-outbound';
    expect(runCheck(c, 'mut-dashboard-dangling-detour').code).toBe(0);
  });
});
