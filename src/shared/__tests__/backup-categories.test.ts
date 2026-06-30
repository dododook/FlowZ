import {
  BACKUP_CATEGORIES,
  countCategory,
  detectCategories,
  pickCategories,
  mergeCategories,
} from '../backup-categories';
import type { UserConfig, ServerConfig } from '../types';

// 最小 mock：纯函数只读 id/protocol/subscriptionId，其余字段类型断言绕过。
const srv = (id: string, protocol: string, subscriptionId?: string): ServerConfig =>
  ({ id, name: id, protocol, subscriptionId }) as unknown as ServerConfig;

const cfg = (over: Partial<UserConfig>): UserConfig =>
  ({
    servers: [],
    selectedServerId: null,
    proxyMode: 'smart',
    customRules: [],
    ...over,
  }) as unknown as UserConfig;

describe('countCategory / detectCategories', () => {
  const config = cfg({
    servers: [
      srv('m1', 'vless'),
      srv('m2', 'vmess'),
      srv('x1', 'tailscale'),
      srv('s1', 'vmess', 'sub1'),
    ],
    subscriptions: [{ id: 'sub1' } as never],
    customRules: [{} as never],
    customRuleSets: [{} as never, {} as never],
    appRules: [{} as never],
  });

  it('各类计数（手动/组网/订阅源/规则=rules+ruleSets/应用分流/设置）', () => {
    expect(countCategory(config, 'manualNodes')).toBe(2);
    expect(countCategory(config, 'meshNodes')).toBe(1);
    expect(countCategory(config, 'subscriptions')).toBe(1);
    expect(countCategory(config, 'customRules')).toBe(3);
    expect(countCategory(config, 'appRules')).toBe(1);
    expect(countCategory(config, 'generalSettings')).toBe(1);
  });

  it('detectCategories 只列有数据的类', () => {
    expect(detectCategories(config)).toEqual(BACKUP_CATEGORIES);
    expect(detectCategories(cfg({ servers: [srv('m1', 'vless')] }))).toEqual([
      'manualNodes',
      'generalSettings',
    ]);
    // 仅订阅源（无展开节点）也应检出 subscriptions
    expect(detectCategories(cfg({ servers: [], subscriptions: [{ id: 's' } as never] }))).toEqual([
      'subscriptions',
      'generalSettings',
    ]);
  });
});

describe('pickCategories（导出：只抽选中类）', () => {
  const config = cfg({
    servers: [srv('m1', 'vless'), srv('x1', 'tailscale'), srv('s1', 'vmess', 'sub1')],
    subscriptions: [{ id: 'sub1' } as never],
    customRules: [{ a: 1 } as never],
    appRules: [{ b: 2 } as never],
    proxyMode: 'global',
    enableIPv6: true,
  });

  it('单选手动节点：只含该类、不含订阅/设置', () => {
    const out = pickCategories(config, ['manualNodes']);
    expect(out.servers?.map((s) => s.id)).toEqual(['m1']);
    expect(out.subscriptions).toBeUndefined();
    expect(out.proxyMode).toBeUndefined();
  });

  it('订阅源带其展开节点', () => {
    const out = pickCategories(config, ['subscriptions']);
    expect(out.servers?.map((s) => s.id)).toEqual(['s1']);
    expect(out.subscriptions).toHaveLength(1);
  });

  it('通用设置走排除法（带所有非数据字段、不带 servers）', () => {
    const out = pickCategories(config, ['generalSettings']);
    expect(out.proxyMode).toBe('global');
    expect(out.enableIPv6).toBe(true);
    expect(out.servers).toBeUndefined();
  });
});

describe('mergeCategories（导入：整类替换 + 空跳过 + 未选保留）', () => {
  const current = cfg({
    servers: [srv('cm1', 'vless'), srv('cx1', 'tailscale'), srv('cs1', 'vmess', 'subA')],
    subscriptions: [{ id: 'subA' } as never],
    customRules: [{ cur: 1 } as never],
    appRules: [{ cur: 2 } as never],
    proxyMode: 'smart',
  });
  const backup = cfg({
    servers: [srv('bm1', 'vless'), srv('bm2', 'vmess')],
    customRules: [{ bak: 1 } as never],
    proxyMode: 'global',
  });

  it('选中类整类替换，未选类保留', () => {
    const { config, skipped } = mergeCategories(current, backup, ['manualNodes']);
    const manual = config.servers.filter((s) => !s.subscriptionId && s.protocol !== 'tailscale');
    expect(manual.map((s) => s.id)).toEqual(['bm1', 'bm2']); // 手动节点替换
    expect(config.servers.some((s) => s.id === 'cx1')).toBe(true); // 组网未选→保留
    expect(config.servers.some((s) => s.id === 'cs1')).toBe(true); // 订阅未选→保留
    expect(config.customRules).toEqual(current.customRules); // 未选→保留
    expect(config.proxyMode).toBe('smart'); // 设置未选→保留
    expect(skipped).toEqual([]);
  });

  it('空跳过：选了但备份该类为空 → 保留 current + 记 skipped', () => {
    const { config, skipped } = mergeCategories(current, backup, ['meshNodes', 'appRules']);
    expect(config.servers.some((s) => s.id === 'cx1')).toBe(true);
    expect(config.appRules).toEqual(current.appRules);
    expect(skipped).toEqual(['meshNodes', 'appRules']);
  });

  it('选中类有数据则替换（customRules / generalSettings）', () => {
    const { config, skipped } = mergeCategories(current, backup, [
      'customRules',
      'generalSettings',
    ]);
    expect(config.customRules).toEqual([{ bak: 1 }]);
    expect(config.proxyMode).toBe('global');
    expect(skipped).toEqual([]);
  });
});

describe('review 回归：依赖字段随类 + selectedServerId 兜底 + 敏感字段排除', () => {
  it('H1 导入节点后失效 selectedServerId → 归零（validateConfig 会 throw）', () => {
    const cur = cfg({ servers: [srv('cm1', 'vless')], selectedServerId: 'cm1' });
    const bak = cfg({ servers: [srv('bm1', 'vmess')] });
    const { config } = mergeCategories(cur, bak, ['manualNodes']);
    expect(config.servers.map((s) => s.id)).toEqual(['bm1']);
    expect(config.selectedServerId).toBeNull(); // cm1 已不在 → 归零
  });

  it('H1 选中节点仍在新 servers / direct 哨兵 → 不动', () => {
    const cur = cfg({ servers: [srv('m1', 'vless')], selectedServerId: 'm1' });
    const bak = cfg({ servers: [srv('m1', 'vless'), srv('m2', 'vmess')] });
    expect(mergeCategories(cur, bak, ['manualNodes']).config.selectedServerId).toBe('m1');
    const curD = cfg({ servers: [srv('m1', 'vless')], selectedServerId: '__direct__' });
    expect(mergeCategories(curD, bak, ['manualNodes']).config.selectedServerId).toBe('__direct__');
  });

  it('M2 ruleResources 随自定义规则类整类替换', () => {
    const cur = cfg({
      customRules: [{ cur: 1 } as never],
      ruleResources: [{ id: 'r-cur' } as never],
    });
    const bak = cfg({
      customRules: [{ bak: 1 } as never],
      ruleResources: [{ id: 'r-bak' } as never],
    });
    const { config } = mergeCategories(cur, bak, ['customRules']);
    expect(config.ruleResources).toEqual([{ id: 'r-bak' }]);
    // pick 也带 ruleResources
    expect(pickCategories(bak, ['customRules']).ruleResources).toEqual([{ id: 'r-bak' }]);
  });

  it('M3 customAppPresets 随应用分流类整类替换', () => {
    const cur = cfg({
      appRules: [{ cur: 1 } as never],
      customAppPresets: [{ id: 'p-cur' } as never],
    });
    const bak = cfg({
      appRules: [{ bak: 1 } as never],
      customAppPresets: [{ id: 'p-bak' } as never],
    });
    const { config } = mergeCategories(cur, bak, ['appRules']);
    expect(config.customAppPresets).toEqual([{ id: 'p-bak' }]);
    expect(pickCategories(bak, ['appRules']).customAppPresets).toEqual([{ id: 'p-bak' }]);
  });

  it('M4 customRuleSets 整类替换（备份无 ruleSets → 清空，不保留 current）', () => {
    const cur = cfg({
      customRules: [{ c: 1 } as never],
      customRuleSets: [{ id: 'rs-cur' } as never],
    });
    const bak = cfg({ customRules: [{ b: 1 } as never] }); // 无 customRuleSets
    expect(mergeCategories(cur, bak, ['customRules']).config.customRuleSets).toEqual([]);
  });

  it('L6 通用设置导出/导入排除敏感+临时字段（clashApiSecret/diagnosticCapture/builtinGeoMeta）', () => {
    const config = cfg({
      proxyMode: 'global',
      clashApiSecret: 'secret123',
      diagnosticCapture: { prevLogLevel: 'info' },
      builtinGeoMeta: { x: {} },
    } as never);
    const out = pickCategories(config, ['generalSettings']);
    expect(out.proxyMode).toBe('global');
    expect(out.clashApiSecret).toBeUndefined();
    expect((out as Record<string, unknown>).diagnosticCapture).toBeUndefined();
    expect((out as Record<string, unknown>).builtinGeoMeta).toBeUndefined();
  });
});
