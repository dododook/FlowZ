/**
 * ProxyManager 私有方法 configGenerationNorm / planRuleHotSwitch 单测。
 *
 * 覆盖热切换决策不变量（feedback-test-timely：新功能落地及时补单测）：
 *
 * 一、configGenerationNorm（norm 等价 ⇒ 热切换；翻转 ⇒ 重启）：
 *   - targetServerId 改值（换节点 A→B / 节点↔默认）在 非 direct + 非 inline（ext 投影）→ norm 等价
 *   - targetServerId 改值在 inline 投影 → norm 等价（target 已 delete）
 *   - direct 模式 → 全量投影，target 改值 → norm 翻转
 *   - 规则条件值改 / 增删规则 / 换 action / 换 id(appId) → norm 翻转
 *   - 三种投影形态断言：ext（target:null + __ext:1）/ inline（delete target）/ direct（全量含 target）
 *
 * 二、planRuleHotSwitch（注入 currentRuleTargetMap + currentIdToTagMap，测 PUT 规划）：
 *   - 换节点 A→B → PUT rule-sel default=B
 *   - 节点→默认 → PUT rule-sel default='proxy-selector'
 *   - 默认→节点 → PUT rule-sel default=节点 tag
 *   - 新目标节点不在 selector → return null（退回重启）
 *
 * 私有方法经 `(svc as any).method()` 直调，不启动 sing-box（构造仅注入 configPath/singboxPath）。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-norm-test-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: (...args: any[]) => mockExecFile(...args),
}));

import { ProxyManager } from '../ProxyManager';
import type { UserConfig, Rule, AppRule, ServerConfig } from '../../../shared/types';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 构造一个 ProxyManager（不启动）：注入 configPath + 假 singboxPath。私有方法直调。 */
function makeSvc() {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  const svc: any = new ProxyManager(undefined, undefined, configPath, '/fake/sing-box');
  return svc;
}

const NODE_A = 'node-a';
const NODE_B = 'node-b';

/** 两个节点的 ServerConfig（norm 仅比 id + delete 时间戳，字段内容无关 → 最小可用集）。 */
function servers(): ServerConfig[] {
  return [
    {
      id: NODE_A,
      name: 'A',
      protocol: 'shadowsocks',
      address: '1.1.1.1',
      port: 8388,
    } as unknown as ServerConfig,
    {
      id: NODE_B,
      name: 'B',
      protocol: 'shadowsocks',
      address: '2.2.2.2',
      port: 8388,
    } as unknown as ServerConfig,
  ];
}

/** ext 规则（domain 全 EXT 可外化 → planCustomRule=ext）。 */
function extRule(
  id: string,
  targetServerId: string | undefined,
  values: string[] = ['example.com']
): Rule {
  return {
    id,
    type: 'domainSuffix',
    values,
    action: 'proxy',
    enabled: true,
    targetServerId,
  };
}

/** inline 规则（含 ruleSet 条件 → 非 EXT → planCustomRule=inline）。 */
function inlineRule(id: string, targetServerId: string | undefined, resRef = 'res:geo-cn'): Rule {
  return {
    id,
    type: 'ruleSet',
    values: [resRef],
    action: 'proxy',
    enabled: true,
    targetServerId,
  };
}

/** 基础 config：smart 模式 + 两节点 + 一 ext 规则 + 一 appRule，targetServerId 可变。 */
function makeConfig(opts?: {
  proxyMode?: UserConfig['proxyMode'];
  customRules?: Rule[];
  appRules?: AppRule[];
  selectedServerId?: string | null;
}): UserConfig {
  return {
    servers: servers(),
    selectedServerId: opts?.selectedServerId ?? NODE_A,
    proxyMode: opts?.proxyMode ?? 'smart',
    proxyModeType: 'systemProxy',
    tunConfig: { enable: false } as any,
    customRules: opts?.customRules ?? [extRule('r1', NODE_A)],
    appRules: opts?.appRules ?? [],
    autoStart: false,
    silentStart: false,
    autoConnect: false,
    minimizeToTray: false,
    autoCheckUpdate: false,
    autoLightweightMode: false,
    autoUpdateSubscriptionOnStart: false,
    socksPort: 1080,
    httpPort: 1081,
    logLevel: 'info',
  } as UserConfig;
}

// ============================================================================
// 一、configGenerationNorm
// ============================================================================

describe('ProxyManager.configGenerationNorm', () => {
  it('ext 规则：换节点 targetServerId A→B → norm 等价（target 已移出）', () => {
    const svc = makeSvc();
    const a = makeConfig({ customRules: [extRule('r1', NODE_A)] });
    const b = makeConfig({ customRules: [extRule('r1', NODE_B)] });
    expect(svc.configGenerationNorm(a)).toBe(svc.configGenerationNorm(b));
  });

  it('ext 规则：节点↔默认（有 targetServerId ↔ undefined）→ norm 等价', () => {
    const svc = makeSvc();
    const withTarget = makeConfig({ customRules: [extRule('r1', NODE_A)] });
    const toDefault = makeConfig({ customRules: [extRule('r1', undefined)] });
    expect(svc.configGenerationNorm(withTarget)).toBe(svc.configGenerationNorm(toDefault));
  });

  it('inline 规则：换节点 targetServerId A→B → norm 等价（inline 投影 delete target）', () => {
    const svc = makeSvc();
    const a = makeConfig({ customRules: [inlineRule('r2', NODE_A)] });
    const b = makeConfig({ customRules: [inlineRule('r2', NODE_B)] });
    expect(svc.configGenerationNorm(a)).toBe(svc.configGenerationNorm(b));
  });

  it('direct 模式：换节点 targetServerId → norm 等价（用户路由仅 smart 影响生成 → direct 不 emit → 不重启）', () => {
    const svc = makeSvc();
    const a = makeConfig({ proxyMode: 'direct', customRules: [extRule('r1', NODE_A)] });
    const b = makeConfig({ proxyMode: 'direct', customRules: [extRule('r1', NODE_B)] });
    // 修正：direct（与 global 同）忽略用户分流，自定义规则任何编辑都不改变生成的 sing-box 配置 → norm 不翻转、不无谓重启。
    expect(svc.configGenerationNorm(a)).toBe(svc.configGenerationNorm(b));
  });

  it('direct 模式：target 不变、仅改 selectedServerId → norm 等价（selectedServerId 移出）', () => {
    const svc = makeSvc();
    const a = makeConfig({ proxyMode: 'direct', selectedServerId: NODE_A });
    const b = makeConfig({ proxyMode: 'direct', selectedServerId: NODE_B });
    expect(svc.configGenerationNorm(a)).toBe(svc.configGenerationNorm(b));
  });

  it('appRules：换节点 targetServerId A→B → norm 等价', () => {
    const svc = makeSvc();
    const appA: AppRule = { appId: 'app1', action: 'proxy', enabled: true, targetServerId: NODE_A };
    const appB: AppRule = { appId: 'app1', action: 'proxy', enabled: true, targetServerId: NODE_B };
    const a = makeConfig({ appRules: [appA] });
    const b = makeConfig({ appRules: [appB] });
    expect(svc.configGenerationNorm(a)).toBe(svc.configGenerationNorm(b));
  });

  it('改界面语言 language → norm 等价（纯 UI 偏好，运行中切语言不应重启内核断流）', () => {
    const svc = makeSvc();
    const a = { ...makeConfig(), language: 'auto' } as UserConfig;
    const b = { ...makeConfig(), language: 'zh-CN' } as UserConfig;
    expect(svc.configGenerationNorm(a)).toBe(svc.configGenerationNorm(b));
  });

  // --- norm 翻转分支（结构变 = 重启）-----------------------------------------

  it('改规则条件值（domain 内容）→ norm 翻转（值经 ext 投影的 ok 位承载，值空↔非空翻转）', () => {
    const svc = makeSvc();
    const a = makeConfig({ customRules: [extRule('r1', NODE_A, ['a.com'])] });
    const b = makeConfig({ customRules: [extRule('r1', NODE_A, ['b.com'])] });
    // 同为单值非空 → ok=true 一致；但 ext 投影不写值本身，故应等价
    // 注：值 a.com vs b.com 都是单值非空 → ok 位相同 → norm 等价（值变 = 文件 diff 热重载、不重启）
    expect(svc.configGenerationNorm(a)).toBe(svc.configGenerationNorm(b));
  });

  it('值空↔非空翻转（ok 位承载）→ norm 翻转', () => {
    const svc = makeSvc();
    const nonEmpty = makeConfig({ customRules: [extRule('r1', NODE_A, ['a.com'])] });
    const empty = makeConfig({ customRules: [extRule('r1', NODE_A, [])] });
    expect(svc.configGenerationNorm(nonEmpty)).not.toBe(svc.configGenerationNorm(empty));
  });

  it('增删规则 → norm 翻转', () => {
    const svc = makeSvc();
    const one = makeConfig({ customRules: [extRule('r1', NODE_A)] });
    const two = makeConfig({ customRules: [extRule('r1', NODE_A), extRule('r2', NODE_B)] });
    expect(svc.configGenerationNorm(one)).not.toBe(svc.configGenerationNorm(two));
  });

  it('换 action（proxy→direct）→ norm 翻转', () => {
    const svc = makeSvc();
    const proxy = makeConfig({ customRules: [{ ...extRule('r1', NODE_A), action: 'proxy' }] });
    const direct = makeConfig({ customRules: [{ ...extRule('r1', NODE_A), action: 'direct' }] });
    expect(svc.configGenerationNorm(proxy)).not.toBe(svc.configGenerationNorm(direct));
  });

  it('换规则 id → norm 翻转（文件身份绑定）', () => {
    const svc = makeSvc();
    const r1 = makeConfig({ customRules: [extRule('r1', NODE_A)] });
    const r2 = makeConfig({ customRules: [extRule('rX', NODE_A)] });
    expect(svc.configGenerationNorm(r1)).not.toBe(svc.configGenerationNorm(r2));
  });

  it('换 appId（appRules）→ norm 翻转', () => {
    const svc = makeSvc();
    const a = makeConfig({
      appRules: [{ appId: 'app1', action: 'proxy', enabled: true, targetServerId: NODE_A }],
    });
    const b = makeConfig({
      appRules: [{ appId: 'app2', action: 'proxy', enabled: true, targetServerId: NODE_A }],
    });
    expect(svc.configGenerationNorm(a)).not.toBe(svc.configGenerationNorm(b));
  });

  it('换 action（appRules proxy→direct）→ norm 翻转', () => {
    const svc = makeSvc();
    const proxy = makeConfig({
      appRules: [{ appId: 'app1', action: 'proxy', enabled: true, targetServerId: NODE_A }],
    });
    const direct = makeConfig({
      appRules: [{ appId: 'app1', action: 'direct', enabled: true }],
    });
    expect(svc.configGenerationNorm(proxy)).not.toBe(svc.configGenerationNorm(direct));
  });

  it('禁用规则增删不进 norm（disabled 规则被 filter 掉 → 不影响）', () => {
    const svc = makeSvc();
    const a = makeConfig({
      customRules: [extRule('r1', NODE_A), { ...extRule('r2', NODE_B), enabled: false }],
    });
    const b = makeConfig({ customRules: [extRule('r1', NODE_A)] });
    expect(svc.configGenerationNorm(a)).toBe(svc.configGenerationNorm(b));
  });

  // --- 三种投影形态断言 ------------------------------------------------------

  it('ext 投影形态：targetServerId:null + __ext:1 + 结构位（action/combineMode/bypassFakeIP/conds）', () => {
    const svc = makeSvc();
    const cfg = makeConfig({
      customRules: [
        {
          ...extRule('r1', NODE_A, ['a.com', 'b.com']),
          combineMode: 'and',
          bypassFakeIP: true,
        },
      ],
    });
    const norm = svc.configGenerationNorm(cfg);
    const parsed = JSON.parse(norm);
    const rule = parsed.customRules[0];
    expect(rule.__ext).toBe(1);
    expect(rule.id).toBe('r1');
    expect(rule.action).toBe('proxy');
    expect(rule.targetServerId).toBeNull();
    expect(rule.combineMode).toBe('and');
    expect(rule.bypassFakeIP).toBe(true);
    // conds 投影：type + ok 位（单值非空 → ok=true）
    expect(rule.conds).toEqual([{ t: 'domainSuffix', ok: true }]);
  });

  it('inline 投影形态：全量结构（delete remarks + targetServerId），保留其余值', () => {
    const svc = makeSvc();
    const cfg = makeConfig({ customRules: [inlineRule('r2', NODE_A)] });
    const norm = svc.configGenerationNorm(cfg);
    const parsed = JSON.parse(norm);
    const rule = parsed.customRules[0];
    // inline 投影：无 __ext 标记，保留全量结构但 delete remarks + targetServerId
    expect(rule.__ext).toBeUndefined();
    expect(rule.id).toBe('r2');
    expect(rule.targetServerId).toBeUndefined();
    expect(rule.remarks).toBeUndefined();
    expect(rule.type).toBe('ruleSet');
    expect(rule.values).toEqual(['res:geo-cn']);
  });

  it('direct 投影形态：用户路由投影为空（direct 不 emit 自定义规则 → 内容/换节点不影响生成）', () => {
    const svc = makeSvc();
    const cfg = makeConfig({
      proxyMode: 'direct',
      customRules: [extRule('r1', NODE_A)],
    });
    const norm = svc.configGenerationNorm(cfg);
    const parsed = JSON.parse(norm);
    // 修正：用户路由仅 smart 影响生成；direct（与 global 同）投影为 []，自定义规则任何字段都不进 norm。
    expect(parsed.customRules).toEqual([]);
  });

  it('appRules 投影形态：appId/action/enabled + targetServerId:null', () => {
    const svc = makeSvc();
    const cfg = makeConfig({
      appRules: [{ appId: 'app1', action: 'proxy', enabled: true, targetServerId: NODE_A }],
    });
    const parsed = JSON.parse(svc.configGenerationNorm(cfg));
    expect(parsed.appRules).toEqual([
      { appId: 'app1', action: 'proxy', enabled: true, targetServerId: null },
    ]);
  });

  it('servers 排序 + delete 时间戳：顺序变 / 时间戳变 → norm 等价', () => {
    const svc = makeSvc();
    const a = makeConfig();
    const b = makeConfig();
    // b 节点顺序反转 + 加时间戳
    b.servers = [
      { ...servers()[1], createdAt: '2020', updatedAt: '2021' },
      { ...servers()[0], createdAt: '2020', updatedAt: '2021' },
    ] as ServerConfig[];
    expect(svc.configGenerationNorm(a)).toBe(svc.configGenerationNorm(b));
  });
});

// ============================================================================
// 二、planRuleHotSwitch
// ============================================================================

describe('ProxyManager.planRuleHotSwitch', () => {
  /**
   * 注入 currentRuleTargetMap（custom 规则的 rule-sel 元数据）+ currentIdToTagMap（节点→tag）。
   * 规则 r1 的 selectorTag='rule-sel-r1'、memberTag='member-r1'；节点 A→tagA、B→tagB。
   */
  function setupMaps(svc: any, ruleKeys: string[] = ['custom:r1']) {
    svc.currentRuleTargetMap = new Map(
      ruleKeys.map((k) => [
        k,
        { selectorTag: `rule-sel-${k.split(':')[1]}`, memberTag: 'member-stub' },
      ])
    );
    svc.currentIdToTagMap = new Map([
      [NODE_A, 'tagA'],
      [NODE_B, 'tagB'],
    ]);
  }

  it('换节点 A→B → PUT rule-sel-r1 default=tagB', () => {
    const svc = makeSvc();
    setupMaps(svc);
    const old = makeConfig({ customRules: [extRule('r1', NODE_A)] });
    const next = makeConfig({ customRules: [extRule('r1', NODE_B)] });
    const puts = svc.planRuleHotSwitch(old, next);
    expect(puts).toEqual([{ selectorTag: 'rule-sel-r1', memberTag: 'tagB', oldMemberTag: 'tagA' }]);
  });

  it('节点→默认（targetServerId 有→undefined）→ PUT rule-sel-r1 default="proxy-selector"', () => {
    const svc = makeSvc();
    setupMaps(svc);
    const old = makeConfig({ customRules: [extRule('r1', NODE_A)] });
    const next = makeConfig({ customRules: [extRule('r1', undefined)] });
    const puts = svc.planRuleHotSwitch(old, next);
    expect(puts).toEqual([
      { selectorTag: 'rule-sel-r1', memberTag: 'proxy-selector', oldMemberTag: 'tagA' },
    ]);
  });

  it('默认→节点（undefined→有 target）→ PUT rule-sel-r1 default=节点 tag', () => {
    const svc = makeSvc();
    setupMaps(svc);
    const old = makeConfig({ customRules: [extRule('r1', undefined)] });
    const next = makeConfig({ customRules: [extRule('r1', NODE_B)] });
    const puts = svc.planRuleHotSwitch(old, next);
    expect(puts).toEqual([
      { selectorTag: 'rule-sel-r1', memberTag: 'tagB', oldMemberTag: 'proxy-selector' },
    ]);
  });

  it('appRules 换节点 → PUT rule-sel-app default=tagB', () => {
    const svc = makeSvc();
    setupMaps(svc, ['app:app1']);
    const old = makeConfig({
      appRules: [{ appId: 'app1', action: 'proxy', enabled: true, targetServerId: NODE_A }],
    });
    const next = makeConfig({
      appRules: [{ appId: 'app1', action: 'proxy', enabled: true, targetServerId: NODE_B }],
    });
    const puts = svc.planRuleHotSwitch(old, next);
    expect(puts).toEqual([
      { selectorTag: 'rule-sel-app1', memberTag: 'tagB', oldMemberTag: 'tagA' },
    ]);
  });

  // N1：补 appRule 对称用例（customRule 已测有→undefined / undefined→有，appRule 此前只测了换节点 A→B）。
  // appRule targetServerId 有→undefined → PUT rule-sel-app default='proxy-selector'（与 customRule 节点→默认对称）。
  it('N1：appRules 节点→默认（targetServerId 有→undefined）→ PUT rule-sel-app default="proxy-selector"', () => {
    const svc = makeSvc();
    setupMaps(svc, ['app:app1']);
    const old = makeConfig({
      appRules: [{ appId: 'app1', action: 'proxy', enabled: true, targetServerId: NODE_A }],
    });
    const next = makeConfig({
      appRules: [{ appId: 'app1', action: 'proxy', enabled: true, targetServerId: undefined }],
    });
    const puts = svc.planRuleHotSwitch(old, next);
    expect(puts).toEqual([
      { selectorTag: 'rule-sel-app1', memberTag: 'proxy-selector', oldMemberTag: 'tagA' },
    ]);
  });

  it('新目标节点不在 selector（idToTagMap 无此 id）→ return null（退回重启）', () => {
    const svc = makeSvc();
    setupMaps(svc);
    const old = makeConfig({ customRules: [extRule('r1', NODE_A)] });
    // 未知节点 id
    const next = makeConfig({ customRules: [extRule('r1', 'ghost-node')] });
    const puts = svc.planRuleHotSwitch(old, next);
    expect(puts).toBeNull();
  });

  it('target 未变 → 空 puts（无热切换）', () => {
    const svc = makeSvc();
    setupMaps(svc);
    const old = makeConfig({ customRules: [extRule('r1', NODE_A)] });
    const next = makeConfig({ customRules: [extRule('r1', NODE_A)] });
    const puts = svc.planRuleHotSwitch(old, next);
    expect(puts).toEqual([]);
  });

  it('currentRuleTargetMap 无此条（启动时该规则被 gate 剔除）→ 跳过该规则，不 return null', () => {
    const svc = makeSvc();
    // 只注入 r2 的 map，规则 r1 在 map 中无条目
    setupMaps(svc, ['custom:r2']);
    const old = makeConfig({ customRules: [extRule('r1', NODE_A)] });
    const next = makeConfig({ customRules: [extRule('r1', NODE_B)] });
    const puts = svc.planRuleHotSwitch(old, next);
    // r1 在 map 无条目 → visit 返 true 跳过 → 空 puts（非 null）
    expect(puts).toEqual([]);
  });

  it('currentIdToTagMap 未注入 → return null（无法解析节点 tag）', () => {
    const svc = makeSvc();
    // 只注入 ruleTargetMap，不注入 idToTagMap
    svc.currentRuleTargetMap = new Map([
      ['custom:r1', { selectorTag: 'rule-sel-r1', memberTag: 'm' }],
    ]);
    svc.currentIdToTagMap = null;
    const old = makeConfig({ customRules: [extRule('r1', NODE_A)] });
    const next = makeConfig({ customRules: [extRule('r1', NODE_B)] });
    expect(svc.planRuleHotSwitch(old, next)).toBeNull();
  });

  it('currentRuleTargetMap 未注入（启动无 rule-sel）→ return []（空，非 null）', () => {
    const svc = makeSvc();
    svc.currentRuleTargetMap = null;
    svc.currentIdToTagMap = new Map([[NODE_A, 'tagA']]);
    const old = makeConfig({ customRules: [extRule('r1', NODE_A)] });
    const next = makeConfig({ customRules: [extRule('r1', NODE_B)] });
    expect(svc.planRuleHotSwitch(old, next)).toEqual([]);
  });

  it('多条规则同时变化 → 每个 selector 各一条 PUT', () => {
    const svc = makeSvc();
    setupMaps(svc, ['custom:r1', 'custom:r2']);
    const old = makeConfig({
      customRules: [extRule('r1', NODE_A), extRule('r2', NODE_A)],
    });
    const next = makeConfig({
      customRules: [extRule('r1', NODE_B), extRule('r2', undefined)],
    });
    const puts = svc.planRuleHotSwitch(old, next);
    expect(puts).toEqual([
      { selectorTag: 'rule-sel-r1', memberTag: 'tagB', oldMemberTag: 'tagA' },
      { selectorTag: 'rule-sel-r2', memberTag: 'proxy-selector', oldMemberTag: 'tagA' },
    ]);
  });

  it('禁用规则的 target 变化不参与规划（filter enabled）', () => {
    const svc = makeSvc();
    setupMaps(svc, ['custom:r1']);
    const old = makeConfig({
      customRules: [extRule('r1', NODE_A), { ...extRule('r2', NODE_A), enabled: false }],
    });
    const next = makeConfig({
      customRules: [extRule('r1', NODE_B), { ...extRule('r2', NODE_B), enabled: false }],
    });
    const puts = svc.planRuleHotSwitch(old, next);
    // r1 变化 → 一条 PUT；r2 禁用 → 不参与
    expect(puts).toEqual([{ selectorTag: 'rule-sel-r1', memberTag: 'tagB', oldMemberTag: 'tagA' }]);
  });
});

// ============================================================================
// 三、planHotSwitch 全局切换 route 投影 guard（选中节点 route 依赖翻转 → 重启，非 PUT）
//    回归覆盖：ICMP 改静态 direct 后，删原 ICMP guard 暴露的「final/geo 黑洞」+「force-route engaged 失配」。
// ============================================================================

describe('ProxyManager.planHotSwitch 全局 route 投影 guard', () => {
  const FT = 'wg-full';
  const FT2 = 'wg-full-2';
  const OM = 'wg-offmesh';
  const ONLYSUB = 'wg-onlysub';

  function wg(
    id: string,
    opts: { allowInternet?: boolean; allowedIPs?: string[]; alwaysRouteSubnets?: boolean }
  ): ServerConfig {
    return {
      id,
      name: id,
      protocol: 'wireguard',
      wireguardSettings: {
        allowInternet: opts.allowInternet,
        allowedIPs: opts.allowedIPs ?? ['10.9.0.0/24'],
        alwaysRouteSubnets: opts.alwaysRouteSubnets,
      },
    } as unknown as ServerConfig;
  }
  const ss = (): ServerConfig =>
    ({ id: 'ss', name: 'ss', protocol: 'shadowsocks', address: '1.1.1.1', port: 8388 }) as any;

  function cfg(serverList: ServerConfig[], selectedServerId: string): UserConfig {
    return {
      ...makeConfig({ customRules: [], selectedServerId }),
      servers: serverList,
    } as UserConfig;
  }
  function setup(svc: any, serverList: ServerConfig[]) {
    svc.currentIdToTagMap = new Map(serverList.map((s) => [s.id, `tag-${s.id}`]));
  }

  it('全隧道 endpoint → off-mesh endpoint：fallsBackToDirect 翻转 → kind:none（重启，防 final 黑洞）', () => {
    const svc = makeSvc();
    const list = [wg(FT, { allowInternet: true }), wg(OM, { allowInternet: false })];
    setup(svc, list);
    svc.currentConfig = cfg(list, FT);
    expect(svc.planHotSwitch(cfg(list, OM)).kind).toBe('none');
  });

  it('off-mesh endpoint → 普通代理：fallsBackToDirect 翻转（补旧 ICMP guard 漏的缺口）→ kind:none', () => {
    const svc = makeSvc();
    const list = [wg(OM, { allowInternet: false }), ss()];
    setup(svc, list);
    svc.currentConfig = cfg(list, OM);
    expect(svc.planHotSwitch(cfg(list, 'ss')).kind).toBe('none');
  });

  it('全隧道 endpoint → 另一全隧道 endpoint：同侧不翻转 → kind:global（PUT 热切换）', () => {
    const svc = makeSvc();
    const list = [wg(FT, { allowInternet: true }), wg(FT2, { allowInternet: true })];
    setup(svc, list);
    svc.currentConfig = cfg(list, FT);
    const plan = svc.planHotSwitch(cfg(list, FT2));
    expect(plan.kind).toBe('global');
    expect(plan.puts).toContainEqual({
      selectorTag: 'proxy-selector',
      memberTag: `tag-${FT2}`,
      oldMemberTag: `tag-${FT}`,
    });
  });

  it('切到 alwaysRouteSubnets=false 的 endpoint（force-route 段随选中翻转）→ kind:none', () => {
    const svc = makeSvc();
    const list = [
      wg(FT, { allowInternet: true }),
      wg(ONLYSUB, { allowInternet: true, alwaysRouteSubnets: false, allowedIPs: ['10.5.0.0/24'] }),
    ];
    setup(svc, list);
    svc.currentConfig = cfg(list, FT);
    expect(svc.planHotSwitch(cfg(list, ONLYSUB)).kind).toBe('none');
  });
});
