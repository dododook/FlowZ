/**
 * `rule-append.ts` 的判据门（issue #336）。
 *
 * 分三组：
 *  ① **候选枚举**（`ruleAppendTargets` / 排序 / 检索）—— 每条规则至少一项、置灰项带原因且仍可搜；
 *  ② **写入变换**（`appendValueToRule`）—— 镜像不变式、字段保全、漂移防御逐条有牙；
 *  ③ **覆盖启发式**（`analyzeDomainCoverage`）—— 只判域名族、`unknown` 不冒充命中、只看已启用。
 *
 * 第 ③ 组的断言口径要注意：它守的是「**不误报**」，不是「全都判得出」。geosite/进程 这类条件渲染端
 * 判不了，故那类规则不出现在 `coveredIds` 里是**预期**而非缺陷。
 */
import type { Rule, RuleType } from '../../../../shared/types';
import {
  APPENDABLE_HOST_TYPES,
  NEW_COND_TYPE,
  analyzeDomainCoverage,
  appendValueToRule,
  isRuleableHost,
  isShadowedTarget,
  matchAppendTargets,
  ruleAppendTargets,
  sortAppendTargets,
  type RuleAppendTarget,
} from '../rule-append';

function rule(over: Partial<Rule> & Pick<Rule, 'id'>): Rule {
  return {
    type: 'domainSuffix',
    values: [],
    action: 'proxy',
    enabled: true,
    ...over,
  } as Rule;
}

/** 取某条规则的（唯一/首个）目标，测试里高频。 */
function targetOf(targets: RuleAppendTarget[], ruleId: string): RuleAppendTarget {
  const t = targets.find((x) => x.ruleId === ruleId);
  if (!t) throw new Error(`no target for ${ruleId}`);
  return t;
}

describe('可追加类型集（派生自 RULE_TYPE_CATEGORY，只减掉模式类）', () => {
  it('= 域名族里的三个字面量类型，domainRegex 被排除', () => {
    expect([...APPENDABLE_HOST_TYPES]).toEqual(['domain', 'domainSuffix', 'domainKeyword']);
  });

  it('新开条件用 domainSuffix —— 与右键直写腿同一个常量', () => {
    expect(NEW_COND_TYPE).toBe<RuleType>('domainSuffix');
  });

  it('isRuleableHost：含 . 或 : 才可当规则值', () => {
    expect(isRuleableHost('example.com')).toBe(true);
    expect(isRuleableHost('2606:4700::1')).toBe(true);
    expect(isRuleableHost('其他')).toBe(false);
    expect(isRuleableHost('   ')).toBe(false);
  });
});

describe('ruleAppendTargets —— 每条规则至少一项', () => {
  it('空值 → 空数组（没有目标可谈）', () => {
    expect(ruleAppendTargets([rule({ id: 'a', values: ['x.com'] })], '  ')).toEqual([]);
  });

  it('已有域名族条件 → 目标指向该条件，且带上它的现值', () => {
    const rs = [rule({ id: 'a', type: 'domainSuffix', values: ['foo.com'] })];
    const t = targetOf(ruleAppendTargets(rs, 'bar.com'), 'a');
    expect(t).toMatchObject({
      condIndex: 0,
      type: 'domainSuffix',
      values: ['foo.com'],
      block: null,
    });
  });

  it('该条件已含这个值 → block=contains（成功的无事可做，不是失败）', () => {
    const rs = [rule({ id: 'a', type: 'domain', values: ['Bar.com'] })];
    // 大小写不敏感：Bar.com 与 bar.com 是同一个值
    expect(targetOf(ruleAppendTargets(rs, 'bar.com'), 'a').block).toBe('contains');
  });

  it('无域名族条件且非 and → 新开条件腿（condIndex=-1、type=domainSuffix、可点）', () => {
    const rs = [rule({ id: 'a', type: 'geosite', values: ['youtube'] })];
    expect(targetOf(ruleAppendTargets(rs, 'bar.com'), 'a')).toMatchObject({
      condIndex: -1,
      type: 'domainSuffix',
      values: [],
      block: null,
    });
  });

  it('只有 domainRegex 的规则同样走新开条件腿（不把整条规则从清单里删掉）', () => {
    const rs = [rule({ id: 'a', type: 'domainRegex', values: ['^stun\\..+'] })];
    expect(targetOf(ruleAppendTargets(rs, 'bar.com'), 'a')).toMatchObject({
      condIndex: -1,
      block: null,
    });
  });

  it('combineMode=and 且无域名族条件 → block=andMode（新开条件会变成求交）', () => {
    const rs = [
      rule({
        id: 'a',
        type: 'geosite',
        values: ['youtube'],
        conditions: [
          { type: 'geosite', values: ['youtube'] },
          { type: 'processName', values: ['chrome'] },
        ],
        combineMode: 'and',
      }),
    ];
    expect(targetOf(ruleAppendTargets(rs, 'bar.com'), 'a').block).toBe('andMode');
  });

  it('单条件 + combineMode=and 也拦：那个 and 今天潜伏，新开条件会把它激活成求交', () => {
    const rs = [rule({ id: 'a', type: 'geosite', values: ['youtube'], combineMode: 'and' })];
    expect(targetOf(ruleAppendTargets(rs, 'bar.com'), 'a').block).toBe('andMode');
  });

  it('值本身进不了域名条件（IPv6 主机名）→ block=valueUnfit，且优先于 andMode', () => {
    const rs = [rule({ id: 'a', type: 'geosite', values: ['youtube'], combineMode: 'and' })];
    expect(targetOf(ruleAppendTargets(rs, '2606:4700::1'), 'a').block).toBe('valueUnfit');
  });

  it('一条规则有多个域名族条件 → 列成多项，各自认自己的条件', () => {
    const rs = [
      rule({
        id: 'a',
        type: 'domain',
        values: ['a.com'],
        conditions: [
          { type: 'domain', values: ['a.com'] },
          { type: 'ipCidr', values: ['1.1.1.1/32'] },
          { type: 'domainKeyword', values: ['kw'] },
        ],
      }),
    ];
    const out = ruleAppendTargets(rs, 'bar.com');
    expect(out.map((t) => [t.condIndex, t.type])).toEqual([
      [0, 'domain'],
      [2, 'domainKeyword'],
    ]);
  });

  it('顺序 = 规则顺序（本函数不排序）；ruleIndex 逐字等于下标', () => {
    const rs = [rule({ id: 'a' }), rule({ id: 'b' }), rule({ id: 'c' })];
    const out = ruleAppendTargets(rs, 'x.com');
    expect(out.map((t) => t.ruleId)).toEqual(['a', 'b', 'c']);
    expect(out.map((t) => t.ruleIndex)).toEqual([0, 1, 2]);
  });

  it('禁用规则也是合法目标，但 enabled 标出来', () => {
    const rs = [rule({ id: 'a', values: ['foo.com'], enabled: false })];
    expect(targetOf(ruleAppendTargets(rs, 'bar.com'), 'a')).toMatchObject({
      block: null,
      enabled: false,
    });
  });

  it('检索语料覆盖整条规则的备注/类型/全部条件值（含非目标条件）', () => {
    const rs = [
      rule({
        id: 'a',
        type: 'domain',
        values: ['a.com'],
        remarks: '我的规则',
        conditions: [
          { type: 'domain', values: ['a.com'] },
          { type: 'processName', values: ['Telegram'] },
        ],
      }),
    ];
    const out = ruleAppendTargets(rs, 'bar.com');
    expect(matchAppendTargets(out, 'telegram')).toHaveLength(1); // 非目标条件的值也搜得到
    expect(matchAppendTargets(out, '我的规则')).toHaveLength(1);
    expect(matchAppendTargets(out, 'nope')).toHaveLength(0);
    expect(matchAppendTargets(out, '  ')).toHaveLength(1); // 空词 = 原样
  });

  it('置灰项同样参与检索（搜得到名字却搜不到规则会被当成规则不存在）', () => {
    const rs = [
      rule({ id: 'a', type: 'geosite', values: ['youtube'], remarks: '油管', combineMode: 'and' }),
    ];
    const out = ruleAppendTargets(rs, 'bar.com');
    expect(out[0].block).toBe('andMode');
    expect(matchAppendTargets(out, '油管')).toHaveLength(1);
  });

  it('脏值防御：values 非数组 / 含非字符串 → 不抛，按空/过滤处理', () => {
    const dirty = rule({ id: 'a', type: 'domain', values: [42 as unknown as string, 'ok.com'] });
    const broken = rule({ id: 'b', type: 'domain', values: null as unknown as string[] });
    const out = ruleAppendTargets([dirty, broken], 'bar.com');
    expect(out).toHaveLength(2);
    expect(targetOf(out, 'a').values).toEqual(['ok.com']);
  });
});

describe('sortAppendTargets —— 可追加 → 已包含 → 其余置灰，档内保序', () => {
  it('分档正确且同档内保持规则顺序（顺序即优先级，不许打乱）', () => {
    const rs = [
      rule({ id: 'and1', type: 'geosite', values: ['g'], combineMode: 'and' }), // andMode
      rule({ id: 'ok1', type: 'domainSuffix', values: ['foo.com'] }), // ok
      rule({ id: 'has', type: 'domainSuffix', values: ['bar.com'] }), // contains
      rule({ id: 'ok2', type: 'domainSuffix', values: ['baz.com'] }), // ok
    ];
    const sorted = sortAppendTargets(ruleAppendTargets(rs, 'bar.com'));
    expect(sorted.map((t) => t.ruleId)).toEqual(['ok1', 'ok2', 'has', 'and1']);
  });
});

describe('appendValueToRule —— 写入变换', () => {
  it('往已有条件追加：值并进去，单条件形态保持（conditions/combineMode 清空）', () => {
    const base = rule({ id: 'a', type: 'domainSuffix', values: ['foo.com'] });
    const t = targetOf(ruleAppendTargets([base], 'bar.com'), 'a');
    const next = appendValueToRule(base, t, 'bar.com')!;
    expect(next.values).toEqual(['foo.com', 'bar.com']);
    expect(next.conditions).toBeUndefined();
    expect(next.combineMode).toBeUndefined();
  });

  it('新开条件：追加在末尾，首条件不动，镜像仍取 conditions[0]', () => {
    const base = rule({ id: 'a', type: 'geosite', values: ['youtube'] });
    const t = targetOf(ruleAppendTargets([base], 'bar.com'), 'a');
    const next = appendValueToRule(base, t, 'bar.com')!;
    expect(next.conditions).toEqual([
      { type: 'geosite', values: ['youtube'] },
      { type: 'domainSuffix', values: ['bar.com'] },
    ]);
    // 镜像不变式：type/values 恒 = conditions[0]
    expect(next.type).toBe('geosite');
    expect(next.values).toEqual(['youtube']);
  });

  it('多条件规则里追加：只动目标条件，combineMode 保留', () => {
    const base = rule({
      id: 'a',
      type: 'domain',
      values: ['a.com'],
      conditions: [
        { type: 'domain', values: ['a.com'] },
        { type: 'ipCidr', values: ['1.1.1.1/32'] },
      ],
      combineMode: 'or',
    });
    const t = targetOf(ruleAppendTargets([base], 'bar.com'), 'a');
    const next = appendValueToRule(base, t, 'bar.com')!;
    expect(next.conditions).toEqual([
      { type: 'domain', values: ['a.com', 'bar.com'] },
      { type: 'ipCidr', values: ['1.1.1.1/32'] },
    ]);
    expect(next.type).toBe('domain');
    expect(next.values).toEqual(['a.com', 'bar.com']);
    expect(next.combineMode).toBe('or');
  });

  it('保全视野外字段（targetServerId / bypassFakeIP / tlsSpoof / remarks / action）', () => {
    const base = rule({
      id: 'a',
      type: 'domainSuffix',
      values: ['foo.com'],
      action: 'proxy',
      targetServerId: 's9',
      bypassFakeIP: true,
      tlsSpoof: 'www.example.com',
      tlsSpoofMethod: 'wrong-ack',
      remarks: '备注',
    });
    const t = targetOf(ruleAppendTargets([base], 'bar.com'), 'a');
    const next = appendValueToRule(base, t, 'bar.com')!;
    expect(next).toMatchObject({
      id: 'a',
      action: 'proxy',
      targetServerId: 's9',
      bypassFakeIP: true,
      tlsSpoof: 'www.example.com',
      tlsSpoofMethod: 'wrong-ack',
      remarks: '备注',
    });
  });

  it('已包含 / 置灰目标 / 空值 / 规则身份不符 → null（调用方按 no-op 处理）', () => {
    const base = rule({ id: 'a', type: 'domainSuffix', values: ['bar.com'] });
    const contains = targetOf(ruleAppendTargets([base], 'bar.com'), 'a');
    expect(contains.block).toBe('contains');
    expect(appendValueToRule(base, contains, 'bar.com')).toBeNull();

    const ok = targetOf(ruleAppendTargets([base], 'new.com'), 'a');
    expect(appendValueToRule(base, ok, '   ')).toBeNull();
    expect(appendValueToRule(rule({ id: 'other' }), ok, 'new.com')).toBeNull();
  });

  it('漂移防御①：目标条件位置换成了别的类型 → 放弃写入', () => {
    const before = rule({ id: 'a', type: 'domainSuffix', values: ['foo.com'] });
    const t = targetOf(ruleAppendTargets([before], 'bar.com'), 'a');
    // 打开选择器后规则被别处改了：条件 0 变成 ipCidr
    const after = rule({ id: 'a', type: 'ipCidr', values: ['1.1.1.1/32'] });
    expect(appendValueToRule(after, t, 'bar.com')).toBeNull();
  });

  it('漂移防御②：新开条件腿，但规则已被改成 and → 放弃（不悄悄改成求交）', () => {
    const before = rule({ id: 'a', type: 'geosite', values: ['g'] });
    const t = targetOf(ruleAppendTargets([before], 'bar.com'), 'a');
    const after = rule({ id: 'a', type: 'geosite', values: ['g'], combineMode: 'and' });
    expect(appendValueToRule(after, t, 'bar.com')).toBeNull();
  });

  it('漂移防御③：新开条件腿，但规则已多出能收下该值的域名条件 → 放弃（不挂多余条件）', () => {
    const before = rule({ id: 'a', type: 'geosite', values: ['g'] });
    const t = targetOf(ruleAppendTargets([before], 'bar.com'), 'a');
    const after = rule({
      id: 'a',
      type: 'geosite',
      values: ['g'],
      conditions: [
        { type: 'geosite', values: ['g'] },
        { type: 'domainSuffix', values: ['x.com'] },
      ],
    });
    expect(appendValueToRule(after, t, 'bar.com')).toBeNull();
  });

  it('值对目标类型非法 → null（fail-closed，与保存侧 validateRule 同口径）', () => {
    const base = rule({ id: 'a', type: 'geosite', values: ['g'] });
    const t = targetOf(ruleAppendTargets([base], 'bar.com'), 'a');
    // 目标类型是 domainSuffix，喂一个 IPv6 字面量：过不了域名形状
    expect(appendValueToRule(base, t, '2606:4700::1')).toBeNull();
  });

  it('不改原对象（纯变换）', () => {
    const base = rule({ id: 'a', type: 'domainSuffix', values: ['foo.com'] });
    const t = targetOf(ruleAppendTargets([base], 'bar.com'), 'a');
    appendValueToRule(base, t, 'bar.com');
    expect(base.values).toEqual(['foo.com']);
  });
});

describe('analyzeDomainCoverage —— 只判域名族的启发式（宁可漏报不误报）', () => {
  it('domain 全等 / domainSuffix 含子域 / domainKeyword 子串 → 命中', () => {
    const rs = [
      rule({ id: 'exact', type: 'domain', values: ['www.a.com'] }),
      rule({ id: 'suffix', type: 'domainSuffix', values: ['a.com'] }),
      rule({ id: 'kw', type: 'domainKeyword', values: ['w.a'] }),
    ];
    expect([...analyzeDomainCoverage(rs, 'www.a.com').coveredIds].sort()).toEqual([
      'exact',
      'kw',
      'suffix',
    ]);
  });

  it('domainSuffix 只认「本身或其子域」，不认裸字符串后缀', () => {
    const rs = [rule({ id: 's', type: 'domainSuffix', values: ['a.com'] })];
    expect(analyzeDomainCoverage(rs, 'a.com').coveredIds.has('s')).toBe(true);
    expect(analyzeDomainCoverage(rs, 'www.a.com').coveredIds.has('s')).toBe(true);
    // 裸后缀不算：nota.com 以 "a.com" 结尾，但它不是 a.com 的子域
    expect(analyzeDomainCoverage(rs, 'nota.com').coveredIds.has('s')).toBe(false);
  });

  it('geosite / ipCidr / 进程 等条件判不了 → 不进 coveredIds（漏报是预期，不是缺陷）', () => {
    const rs = [
      rule({ id: 'g', type: 'geosite', values: ['youtube'] }),
      rule({ id: 'ip', type: 'ipCidr', values: ['1.1.1.1/32'] }),
      rule({ id: 'p', type: 'processName', values: ['chrome'] }),
    ];
    expect(analyzeDomainCoverage(rs, 'www.youtube.com').coveredIds.size).toBe(0);
  });

  it('and 规则：域名条件命中但另一条件判不了 → 不算命中（unknown 不冒充 hit）', () => {
    const rs = [
      rule({
        id: 'a',
        type: 'domainSuffix',
        values: ['a.com'],
        conditions: [
          { type: 'domainSuffix', values: ['a.com'] },
          { type: 'processName', values: ['chrome'] },
        ],
        combineMode: 'and',
      }),
    ];
    expect(analyzeDomainCoverage(rs, 'www.a.com').coveredIds.size).toBe(0);
  });

  it('and 规则：域名条件明确 miss → 直接 miss（即便另一条件 unknown）', () => {
    const rs = [
      rule({
        id: 'a',
        type: 'domainSuffix',
        values: ['b.com'],
        conditions: [
          { type: 'domainSuffix', values: ['b.com'] },
          { type: 'processName', values: ['chrome'] },
        ],
        combineMode: 'and',
      }),
    ];
    expect(analyzeDomainCoverage(rs, 'www.a.com').coveredIds.size).toBe(0);
  });

  it('禁用规则不算命中（不下发就遮蔽不了任何东西）', () => {
    const rs = [rule({ id: 'a', type: 'domainSuffix', values: ['a.com'], enabled: false })];
    expect(analyzeDomainCoverage(rs, 'www.a.com').coveredIds.size).toBe(0);
  });

  it('firstIndex/firstId = 顺序上第一条命中的（先匹配先生效）', () => {
    const rs = [
      rule({ id: 'miss', type: 'domainSuffix', values: ['z.com'] }),
      rule({ id: 'first', type: 'domainSuffix', values: ['a.com'] }),
      rule({ id: 'second', type: 'domain', values: ['www.a.com'] }),
    ];
    const cov = analyzeDomainCoverage(rs, 'www.a.com');
    expect(cov.firstIndex).toBe(1);
    expect(cov.firstId).toBe('first');
  });

  it('非法正则不冒充「没命中」（unknown），合法正则照常判', () => {
    const bad = [rule({ id: 'r', type: 'domainRegex', values: ['('] })];
    expect(analyzeDomainCoverage(bad, 'www.a.com').coveredIds.size).toBe(0); // unknown ≠ hit
    const good = [rule({ id: 'r', type: 'domainRegex', values: ['^www\\.a\\.com$'] })];
    expect(analyzeDomainCoverage(good, 'www.a.com').coveredIds.has('r')).toBe(true);
  });

  it('isShadowedTarget：更靠前的规则命中 → 提示遮蔽；自己就是第一条 → 不提示', () => {
    const rs = [
      rule({ id: 'first', type: 'domainSuffix', values: ['a.com'] }),
      rule({ id: 'later', type: 'domainSuffix', values: ['other.com'] }),
    ];
    const cov = analyzeDomainCoverage(rs, 'www.a.com');
    const targets = ruleAppendTargets(rs, 'www.a.com');
    expect(isShadowedTarget(cov, targetOf(targets, 'later'))).toBe(true);
    expect(isShadowedTarget(cov, targetOf(targets, 'first'))).toBe(false);
  });
});
