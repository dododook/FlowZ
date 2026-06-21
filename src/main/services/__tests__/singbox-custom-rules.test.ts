/**
 * buildCustomRules 单测（自定义路由规则生成）—— 原 ProxyManager.generateCustomRules 无单测覆盖（仅 config-snapshot
 * 集成锁字节）；抽到 singbox-custom-rules 后补纯逻辑分支：出站映射(applyRuleAction)/OR 合并/logical AND·OR/
 * fail-closed/onDegraded/legacy 告警。geosite/geoip 条件走 inline 分支（非 EXT、不触 ext 文件），避开 fs/电子路径噪声。
 */
jest.mock('electron', () => ({
  app: { getPath: () => '/fake/userData', getAppPath: () => '/fake/app', isPackaged: false },
  net: {},
}));

import { buildCustomRules, type CustomRulesDeps } from '../singbox-custom-rules';
import type { Rule } from '../../../shared/types';
import { withPlatform } from './platform-test-utils';

function mkDeps(): CustomRulesDeps & { logs: string[]; degraded: boolean } {
  const logs: string[] = [];
  const o = {
    logs,
    degraded: false,
    log: (_l: any, m: string) => {
      logs.push(m);
    },
    onDegraded: () => {
      o.degraded = true;
    },
  };
  return o;
}

/** geosite/geoip 条件（inline，不外化）→ 干净测出站映射与 logical 结构。 */
const rule = (over: Partial<Rule>): Rule =>
  ({
    id: 'r1',
    type: 'geosite',
    values: ['youtube'],
    action: 'proxy',
    enabled: true,
    ...over,
  }) as Rule;

const idMap = new Map([['srv-2', '日本节点']]);

describe('buildCustomRules — 出站映射（applyRuleAction）', () => {
  it('proxy + 指定 ruleId → rule-sel-<id>（anti-drift，绝不直绑节点）', () => {
    const deps = mkDeps();
    const { rules } = buildCustomRules(
      [rule({ id: 'rx', action: 'proxy', targetServerId: 'srv-2' })],
      [],
      's1',
      idMap,
      'proxy-selector',
      [],
      false,
      deps
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].outbound).toBe('rule-sel-rx'); // ruleId 优先于 targetServerId（铁律）
    expect(rules[0].rule_set).toEqual(['geosite-youtube']);
  });

  it('direct → outbound=direct；block → outbound=block', () => {
    const deps = mkDeps();
    const { rules } = buildCustomRules(
      [
        rule({ id: 'd', action: 'direct', type: 'geoip', values: ['cn'] }),
        rule({ id: 'b', action: 'block' }),
      ],
      [],
      undefined,
      idMap,
      'proxy-selector',
      [],
      false,
      deps
    );
    expect(rules.find((r) => r.rule_set?.includes('geoip-cn'))?.outbound).toBe('direct');
    expect(rules.find((r) => r.rule_set?.includes('geosite-youtube'))?.outbound).toBe('block');
  });
});

describe('buildCustomRules — 条件合并 / logical', () => {
  it('单 geosite 条件 → 单 default rule（rule_set 合并值）', () => {
    const deps = mkDeps();
    const { rules } = buildCustomRules(
      [rule({ values: ['youtube', 'netflix'] })],
      [],
      undefined,
      idMap,
      'proxy-selector',
      [],
      false,
      deps
    );
    expect(rules[0].rule_set).toEqual(['geosite-youtube', 'geosite-netflix']);
    expect(rules[0].type).toBeUndefined(); // 单条件不走 logical
  });

  it('多条件 + combineMode=and（geosite+geoip 跨维度）→ logical AND 子规则', () => {
    const deps = mkDeps();
    const r: Rule = {
      id: 'm',
      action: 'proxy',
      enabled: true,
      combineMode: 'and',
      conditions: [
        { type: 'geosite', values: ['youtube'] },
        { type: 'geoip', values: ['us'] },
      ],
    } as unknown as Rule;
    const { rules } = buildCustomRules(
      [r],
      [],
      undefined,
      idMap,
      'proxy-selector',
      [],
      false,
      deps
    );
    expect(rules[0].type).toBe('logical');
    expect(rules[0].mode).toBe('and');
    expect(rules[0].rules).toHaveLength(2);
    expect(rules[0].outbound).toBe('rule-sel-m');
  });

  it('禁用规则跳过', () => {
    const deps = mkDeps();
    const { rules } = buildCustomRules(
      [rule({ enabled: false })],
      [],
      undefined,
      idMap,
      'proxy-selector',
      [],
      false,
      deps
    );
    expect(rules).toHaveLength(0);
  });
});

describe('buildCustomRules — legacy customRuleSets 告警', () => {
  it('legacy remote ruleSet（含 url）→ 仅告警、不产 rules', () => {
    const deps = mkDeps();
    const { rules, ruleSets } = buildCustomRules(
      [],
      [{ id: 'ls', enabled: true, url: 'https://x/legacy.srs' } as any],
      undefined,
      idMap,
      'proxy-selector',
      [],
      false,
      deps
    );
    expect(rules).toHaveLength(0);
    expect(ruleSets).toHaveLength(0);
    expect(deps.logs.some((m) => m.includes('legacy 远程规则集已不再支持'))).toBe(true);
  });
});

// P3a：route action TLS spoof（sing-box 1.14 tls_spoof/tls_spoof_method）。规则携带成对 spoof SNI + 方法时，
// applyRuleAction 在非 block 规则上挂 tls_spoof/tls_spoof_method。门控：arch(非 ARM64)+方法合法+域名 SNI。
describe('buildCustomRules — route TLS spoof（P3a 抗审查）', () => {
  // CI 修复：spoof 门控读 process.arch；正向用例统一 mock x64（macOS CI runner = arm64 否则误失败），
  // 下方 ARM64 负向用例体内自 mock arm64 再还原。
  const REAL_ARCH = process.arch;
  beforeAll(() => Object.defineProperty(process, 'arch', { value: 'x64', configurable: true }));
  afterAll(() => Object.defineProperty(process, 'arch', { value: REAL_ARCH, configurable: true }));

  it('proxy 规则 + 域名 spoof + 合法方法 → tls_spoof/tls_spoof_method 下发', () => {
    const deps = mkDeps();
    const { rules } = buildCustomRules(
      [rule({ id: 'rs', action: 'proxy', tlsSpoof: 'www.spoof.com', tlsSpoofMethod: 'wrong-ack' })],
      [],
      's1',
      idMap,
      'proxy-selector',
      [],
      false,
      deps
    );
    expect(rules[0].tls_spoof).toBe('www.spoof.com');
    expect(rules[0].tls_spoof_method).toBe('wrong-ack');
  });

  it('direct 规则也可挂 spoof（非 block 即可）', () => {
    const deps = mkDeps();
    const { rules } = buildCustomRules(
      [
        rule({
          id: 'rd',
          action: 'direct',
          tlsSpoof: 'cdn.example.com',
          tlsSpoofMethod: 'wrong-md5',
        }),
      ],
      [],
      undefined,
      idMap,
      'proxy-selector',
      [],
      false,
      deps
    );
    expect(rules[0].outbound).toBe('direct');
    expect(rules[0].tls_spoof).toBe('cdn.example.com');
    expect(rules[0].tls_spoof_method).toBe('wrong-md5');
  });

  it('block 规则不挂 spoof（reject 无握手）', () => {
    const deps = mkDeps();
    const { rules } = buildCustomRules(
      [rule({ id: 'rb', action: 'block', tlsSpoof: 'x.com', tlsSpoofMethod: 'wrong-ack' })],
      [],
      undefined,
      idMap,
      'proxy-selector',
      [],
      false,
      deps
    );
    expect(rules[0].outbound).toBe('block');
    expect(rules[0].tls_spoof).toBeUndefined();
    expect(rules[0].tls_spoof_method).toBeUndefined();
  });

  it('IP 字面量 spoof SNI → 不下发（内核拒）', () => {
    const deps = mkDeps();
    const { rules } = buildCustomRules(
      [rule({ id: 'rip', action: 'proxy', tlsSpoof: '203.0.113.5', tlsSpoofMethod: 'wrong-ack' })],
      [],
      's1',
      idMap,
      'proxy-selector',
      [],
      false,
      deps
    );
    expect(rules[0].tls_spoof).toBeUndefined();
    expect(rules[0].tls_spoof_method).toBeUndefined();
  });

  it('缺方法或缺 spoof（任一缺）→ 不下发（成对才生效）', () => {
    const deps = mkDeps();
    const { rules } = buildCustomRules(
      [
        rule({ id: 'rm', action: 'proxy', tlsSpoof: 'a.com' }), // 缺方法
        rule({
          id: 'rn',
          action: 'proxy',
          type: 'geoip',
          values: ['cn'],
          tlsSpoofMethod: 'wrong-ack',
        }), // 缺 spoof
      ],
      [],
      's1',
      idMap,
      'proxy-selector',
      [],
      false,
      deps
    );
    for (const r of rules) {
      expect(r.tls_spoof).toBeUndefined();
      expect(r.tls_spoof_method).toBeUndefined();
    }
  });

  it('ARM64（mock process.arch=arm64）→ 不下发 spoof', () => {
    const orig = process.arch;
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    try {
      const deps = mkDeps();
      const { rules } = buildCustomRules(
        [
          rule({
            id: 'ra',
            action: 'proxy',
            tlsSpoof: 'www.spoof.com',
            tlsSpoofMethod: 'wrong-ack',
          }),
        ],
        [],
        's1',
        idMap,
        'proxy-selector',
        [],
        false,
        deps
      );
      expect(rules[0].tls_spoof).toBeUndefined();
      expect(rules[0].tls_spoof_method).toBeUndefined();
    } finally {
      Object.defineProperty(process, 'arch', { value: orig, configurable: true });
    }
  });
});

// P6 LAN 网关：源设备 MAC / 主机名 route 规则（sing-box 1.14 source_mac_address/source_hostname）。
// 平台门控：仅 Linux/macOS 发射，win32 整条不产 matcher（内核不支持→发射即 FATAL）。
describe('buildCustomRules — 源设备 MAC / 主机名（P6 LAN 网关）', () => {
  it('Linux：sourceMac → source_mac_address；脏 MAC 剔除', () => {
    const deps = mkDeps();
    const { rules } = withPlatform('linux', () =>
      buildCustomRules(
        [
          rule({
            id: 'rm',
            type: 'sourceMac',
            values: ['00:11:22:33:44:55', 'bad-mac'],
            action: 'block',
          }),
        ],
        [],
        undefined,
        idMap,
        'proxy-selector',
        [],
        false,
        deps
      )
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].source_mac_address).toEqual(['00:11:22:33:44:55']); // bad-mac 剔除
    expect(rules[0].outbound).toBe('block');
  });

  it('macOS：sourceHostname → source_hostname（DHCP 名）', () => {
    const deps = mkDeps();
    const { rules } = withPlatform('darwin', () =>
      buildCustomRules(
        [rule({ id: 'rh', type: 'sourceHostname', values: ['my-laptop'], action: 'direct' })],
        [],
        undefined,
        idMap,
        'proxy-selector',
        [],
        false,
        deps
      )
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].source_hostname).toEqual(['my-laptop']);
    expect(rules[0].outbound).toBe('direct');
  });

  it('win32：sourceMac 不支持 → 整条不产规则（内核不支持，fail-closed）', () => {
    const deps = mkDeps();
    const { rules } = withPlatform('win32', () =>
      buildCustomRules(
        [rule({ id: 'rw', type: 'sourceMac', values: ['00:11:22:33:44:55'], action: 'block' })],
        [],
        undefined,
        idMap,
        'proxy-selector',
        [],
        false,
        deps
      )
    );
    expect(rules).toHaveLength(0);
  });

  it('全脏 MAC（Linux）→ 无合法值 → 整条不产规则', () => {
    const deps = mkDeps();
    const { rules } = withPlatform('linux', () =>
      buildCustomRules(
        [rule({ id: 'rd', type: 'sourceMac', values: ['nope', '001122334455'], action: 'block' })],
        [],
        undefined,
        idMap,
        'proxy-selector',
        [],
        false,
        deps
      )
    );
    expect(rules).toHaveLength(0);
  });
});
