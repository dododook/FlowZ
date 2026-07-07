/**
 * 规则编辑对话框纯逻辑单测：字段级校验（条件空/非法、备注必填）+ 提交值派生（目标节点、bypassFakeIP）。
 * 离线安全网：把从 rule-dialog 抽出的提交 gate / 派生锁死，防内联校验迁移后回归。
 */
import {
  collectRuleFormErrors,
  hasRuleFormErrors,
  deriveTargetServerId,
  isBypassApplicable,
  deriveBypassFakeIp,
  showsTargetNode,
} from '../rule-dialog-logic';
import type { RuleType } from '../../../../shared/types';

describe('collectRuleFormErrors', () => {
  it('空条件 → empty', () => {
    const e = collectRuleFormErrors(['domain'], {}, 'remark');
    expect(e.conditions.domain).toBe('empty');
    expect(e.remarksRequired).toBeUndefined();
  });

  it('只有空白/换行的条件 → empty（parseLines 去空）', () => {
    const e = collectRuleFormErrors(['domain'], { domain: '  \n \n' }, 'remark');
    expect(e.conditions.domain).toBe('empty');
  });

  it('含非法值 → invalid', () => {
    const e = collectRuleFormErrors(['ipCidr'], { ipCidr: '10.0.0.0/40' }, 'remark');
    expect(e.conditions.ipCidr).toBe('invalid');
  });

  it('全部合法值 → 无该条件错误', () => {
    const e = collectRuleFormErrors(
      ['domainSuffix'],
      { domainSuffix: 'google.com\nopenai.com' },
      'remark'
    );
    expect(e.conditions.domainSuffix).toBeUndefined();
  });

  it('空优先于非法（同块既空也谈不上非法）', () => {
    const e = collectRuleFormErrors(['port'], { port: '' }, 'remark');
    expect(e.conditions.port).toBe('empty');
  });

  it('多条件各自独立判定', () => {
    const types: RuleType[] = ['domainSuffix', 'port', 'ipCidr'];
    const e = collectRuleFormErrors(
      types,
      { domainSuffix: 'google.com', port: '', ipCidr: '999.0.0.0' },
      'remark'
    );
    expect(e.conditions.domainSuffix).toBeUndefined();
    expect(e.conditions.port).toBe('empty');
    expect(e.conditions.ipCidr).toBe('invalid');
  });

  it('ruleSet res:<id> 合法', () => {
    const e = collectRuleFormErrors(['ruleSet'], { ruleSet: 'res:builtin:geosite-cn' }, 'r');
    expect(e.conditions.ruleSet).toBeUndefined();
  });

  it('备注为空/纯空白 → remarksRequired', () => {
    expect(collectRuleFormErrors(['domain'], { domain: 'a.com' }, '').remarksRequired).toBe(true);
    expect(collectRuleFormErrors(['domain'], { domain: 'a.com' }, '   ').remarksRequired).toBe(
      true
    );
  });

  it('备注非空 → 无 remarksRequired', () => {
    expect(
      collectRuleFormErrors(['domain'], { domain: 'a.com' }, 'my rule').remarksRequired
    ).toBeUndefined();
  });
});

describe('hasRuleFormErrors', () => {
  it('无错误 → false', () => {
    expect(hasRuleFormErrors({ conditions: {} })).toBe(false);
  });
  it('有条件错误 → true', () => {
    expect(hasRuleFormErrors({ conditions: { domain: 'empty' } })).toBe(true);
  });
  it('仅备注必填 → true', () => {
    expect(hasRuleFormErrors({ conditions: {}, remarksRequired: true })).toBe(true);
  });
});

describe('deriveTargetServerId', () => {
  it("哨兵 'default'（跟随全局）→ undefined", () => {
    expect(deriveTargetServerId('default')).toBeUndefined();
  });
  it('具体节点 id → 原样', () => {
    expect(deriveTargetServerId('srv_123')).toBe('srv_123');
  });
});

describe('isBypassApplicable', () => {
  it('域名类（domain/domainSuffix/domainKeyword）→ 适用', () => {
    expect(isBypassApplicable(['domain'])).toBe(true);
    expect(isBypassApplicable(['domainSuffix'])).toBe(true);
    expect(isBypassApplicable(['domainKeyword'])).toBe(true);
  });
  it('domainRegex 不在 bypass 适用集', () => {
    expect(isBypassApplicable(['domainRegex'])).toBe(false);
  });
  it('非域名类 → 不适用', () => {
    expect(isBypassApplicable(['ipCidr', 'port'])).toBe(false);
  });
  it('多条件含任一域名类即适用', () => {
    expect(isBypassApplicable(['ipCidr', 'domainSuffix'])).toBe(true);
  });
});

describe('deriveBypassFakeIp', () => {
  it('不适用 → undefined（不写字段）', () => {
    expect(deriveBypassFakeIp(false, true, true)).toBeUndefined();
  });
  it('适用 + 全局 FakeIP 开 + 勾选 → true', () => {
    expect(deriveBypassFakeIp(true, true, true)).toBe(true);
  });
  it('适用 + 全局 FakeIP 关 → false（天然 no-op，不写 true）', () => {
    expect(deriveBypassFakeIp(true, false, true)).toBe(false);
  });
  it('适用 + 未勾选 → false', () => {
    expect(deriveBypassFakeIp(true, true, false)).toBe(false);
  });
});

describe('showsTargetNode', () => {
  it('仅 proxy 显目标节点', () => {
    expect(showsTargetNode('proxy')).toBe(true);
    expect(showsTargetNode('direct')).toBe(false);
    expect(showsTargetNode('block')).toBe(false);
  });
});
