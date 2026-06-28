/**
 * shared/rules 纯逻辑单测。当前聚焦 isRuleTypePlatformSupported（路由规则条件字段的平台门控）：
 * device 类别（source_mac_address / source_hostname）仅 Linux/macOS，其余类别全平台。
 */
import { isRuleTypePlatformSupported, findAddableRuleType } from '../rules';
import type { RuleType } from '../types';

const DEVICE_TYPES: RuleType[] = ['sourceMac', 'sourceHostname'];
const NON_DEVICE_TYPES: RuleType[] = [
  'domain',
  'domainSuffix',
  'domainKeyword',
  'domainRegex',
  'ipCidr',
  'sourceIpCidr',
  'port',
  'sourcePort',
  'processName',
  'processPath',
  'geosite',
  'geoip',
  'ruleSet',
];

describe('isRuleTypePlatformSupported（device 类别仅 Linux/macOS，其余全平台）', () => {
  it('device 类别在 win32 不支持', () => {
    for (const tp of DEVICE_TYPES) {
      expect(isRuleTypePlatformSupported(tp, 'win32')).toBe(false);
    }
  });

  it('device 类别在 linux/darwin 支持', () => {
    for (const p of ['linux', 'darwin']) {
      for (const tp of DEVICE_TYPES) {
        expect(isRuleTypePlatformSupported(tp, p)).toBe(true);
      }
    }
  });

  it('device 类别在未知/undefined 平台保守视为不支持', () => {
    expect(isRuleTypePlatformSupported('sourceMac', undefined)).toBe(false);
    expect(isRuleTypePlatformSupported('sourceHostname', 'unknown')).toBe(false);
  });

  it('非 device 类别全平台支持（含 win32 与 undefined）', () => {
    for (const tp of NON_DEVICE_TYPES) {
      expect(isRuleTypePlatformSupported(tp, 'win32')).toBe(true);
      expect(isRuleTypePlatformSupported(tp, 'linux')).toBe(true);
      expect(isRuleTypePlatformSupported(tp, undefined)).toBe(true);
    }
  });

  it('进程类别（processName/processPath）桌面全平台支持（非平台受限）', () => {
    for (const tp of ['processName', 'processPath'] as RuleType[]) {
      expect(isRuleTypePlatformSupported(tp, 'win32')).toBe(true);
    }
  });
});

describe('findAddableRuleType（添加条件单一来源：未用 ∧ 平台支持）', () => {
  it('空集 → 第一个类型 domain（任意平台）', () => {
    expect(findAddableRuleType(new Set(), 'win32')).toBe('domain');
    expect(findAddableRuleType(new Set(), 'linux')).toBe('domain');
  });

  it('跳过已用，返回下一个未用且支持的类型', () => {
    const used = new Set<RuleType>(['domain', 'domainSuffix']);
    expect(findAddableRuleType(used, 'win32')).toBe('domainKeyword');
  });

  it('win32：非 device 类型用尽 → undefined（device 平台不支持，不作候选 → 按钮隐藏）', () => {
    const used = new Set<RuleType>(NON_DEVICE_TYPES);
    expect(findAddableRuleType(used, 'win32')).toBeUndefined();
  });

  it('linux：非 device 用尽 → 仍可加 device（sourceMac）', () => {
    const used = new Set<RuleType>(NON_DEVICE_TYPES);
    expect(findAddableRuleType(used, 'linux')).toBe('sourceMac');
  });

  it('全部 15 类型用尽 → undefined（任意平台）', () => {
    const all = new Set<RuleType>([...NON_DEVICE_TYPES, ...DEVICE_TYPES]);
    expect(findAddableRuleType(all, 'linux')).toBeUndefined();
    expect(findAddableRuleType(all, 'win32')).toBeUndefined();
  });
});
