import { ruleHasProcessCondition } from '../config-portability';

describe('ruleHasProcessCondition（跨平台导入禁用判定）', () => {
  it('首条件 type=processName → true', () =>
    expect(ruleHasProcessCondition({ type: 'processName' })).toBe(true));

  it('首条件 type=processPath → true', () =>
    expect(ruleHasProcessCondition({ type: 'processPath' })).toBe(true));

  it('多条件含 processName（首条件非进程）→ true', () =>
    expect(
      ruleHasProcessCondition({
        type: 'domain',
        conditions: [
          { type: 'domain', values: ['a.com'] },
          { type: 'processName', values: ['chrome.exe'] },
        ],
      })
    ).toBe(true));

  it('纯域名规则 → false', () =>
    expect(
      ruleHasProcessCondition({
        type: 'domain',
        conditions: [{ type: 'domainSuffix', values: ['.cn'] }],
      })
    ).toBe(false));

  it('无 conditions 的非进程规则 → false', () =>
    expect(ruleHasProcessCondition({ type: 'ipCidr' })).toBe(false));
});
