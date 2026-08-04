/**
 * tun-defaults 单测 —— resolveTunStack / resolveTunMtu（Auto 映射 / 显式 verbatim / 恒具体值）
 * + migrateTunDefaults（stack 与 mtu 各自独立幂等）。
 */
import {
  resolveTunStack,
  resolveTunMtu,
  parseTunMtuInput,
  isDegradedMtuCombo,
  migrateTunDefaults,
  PLATFORM_DEFAULT_STACK,
  PLATFORM_DEFAULT_MTU,
  TUN_STACK_VALUES,
  CONCRETE_TUN_STACKS,
  TUN_MTU_MIN,
  TUN_MTU_MAX,
  TUN_MTU_SAFE_MAX_NON_GVISOR,
} from '../tun-defaults';

describe('resolveTunStack — Auto 平台映射', () => {
  it('auto → 平台默认（mac·win gvisor / linux system）', () => {
    expect(resolveTunStack('auto', 'darwin')).toBe('gvisor');
    expect(resolveTunStack('auto', 'win32')).toBe('gvisor');
    expect(resolveTunStack('auto', 'linux')).toBe('system');
  });

  it('缺省（undefined/null）等同 auto → 平台默认', () => {
    expect(resolveTunStack(undefined, 'darwin')).toBe('gvisor');
    expect(resolveTunStack(undefined, 'win32')).toBe('gvisor');
    expect(resolveTunStack(null, 'linux')).toBe('system');
  });

  it('未知平台 → 兜底 system', () => {
    expect(resolveTunStack('auto', 'freebsd')).toBe('system');
    expect(resolveTunStack(undefined, 'sunos')).toBe('system');
  });
});

describe('resolveTunStack — 显式选择全平台 verbatim（含 darwin，零强制回退）', () => {
  it('显式 system/gvisor/mixed 原样下发，跨平台不改写（mac 也 honor，不砌墙）', () => {
    for (const p of ['darwin', 'win32', 'linux'] as const) {
      expect(resolveTunStack('system', p)).toBe('system');
      expect(resolveTunStack('gvisor', p)).toBe('gvisor');
      expect(resolveTunStack('mixed', p)).toBe('mixed');
    }
  });

  it('darwin 显式选 system/mixed 原样下发（用户知情的实验选择，由真机判定可用性）', () => {
    expect(resolveTunStack('system', 'darwin')).toBe('system');
    expect(resolveTunStack('mixed', 'darwin')).toBe('mixed');
  });
});

describe('resolveTunStack — 恒返回具体值（显式 pin，不吃 build-tag 默认）', () => {
  it('任何输入×平台都不返回 auto，且属三具体栈之一', () => {
    const inputs = ['auto', 'system', 'gvisor', 'mixed', undefined, null] as const;
    const platforms = ['darwin', 'win32', 'linux', 'freebsd'] as const;
    for (const i of inputs) {
      for (const p of platforms) {
        const out = resolveTunStack(i, p);
        expect(out).not.toBe('auto');
        expect(CONCRETE_TUN_STACKS).toContain(out);
      }
    }
  });
});

describe('migrateTunDefaults — stack 侧一次性迁移（幂等）', () => {
  it('legacy 显式 stack（旧 Win 默认 system）→ auto + 置 migrated，返回 true', () => {
    const c: {
      tunStackMigrated?: boolean;
      tunConfig?: { stack: 'auto' | 'system' | 'gvisor' | 'mixed' };
    } = { tunConfig: { stack: 'system' } };
    expect(migrateTunDefaults(c)).toBe(true);
    expect(c.tunConfig?.stack).toBe('auto');
    expect(c.tunStackMigrated).toBe(true);
  });

  it('legacy gvisor（旧 mac 默认）同样归 auto', () => {
    const c = { tunConfig: { stack: 'gvisor' as const } };
    migrateTunDefaults(c);
    expect(c.tunConfig.stack).toBe('auto');
  });

  it('已迁移（两标记皆 true）→ 幂等不动，返回 false（护用户显式选择不被回灌）', () => {
    const c = {
      tunStackMigrated: true,
      tunMtuMigrated: true,
      tunConfig: { stack: 'mixed' as const, mtu: 9000 },
    };
    expect(migrateTunDefaults(c)).toBe(false);
    expect(c.tunConfig.stack).toBe('mixed');
    expect(c.tunConfig.mtu).toBe(9000); // 已迁移用户的显式 9000 不被回灌
  });

  it('缺 tunConfig → 仅置 migrated，不抛，返回 true', () => {
    const c: { tunStackMigrated?: boolean; tunConfig?: { stack: 'auto' } } = {};
    expect(migrateTunDefaults(c)).toBe(true);
    expect(c.tunStackMigrated).toBe(true);
  });

  it('连续两次：第二次 no-op（幂等）', () => {
    const c = { tunConfig: { stack: 'system' as const, mtu: 1350 } };
    migrateTunDefaults(c);
    expect(migrateTunDefaults(c)).toBe(false);
  });
});

describe('resolveTunMtu — Auto 按 (平台 × 具体栈) 解析', () => {
  /**
   * 同一平台不同栈差到 16 倍（Win gvisor 65535 vs system 4064）→ 查表必须是二维，不能退化成只按平台。
   * 注：Windows 与 Linux 两格是吞吐实测最优档；macOS 两格无吞吐定论（两轮均被 Wi-Fi 噪声/CPU 争抢污染），
   * 依据是 UDP 正确性 + 上游 MTU 门槛推理——别把整张表都当"实测最优"读。
   */
  it('auto → gvisor 分平台（win 65535 / mac·linux 9000），system·mixed 一律 4064', () => {
    expect(resolveTunMtu('auto', 'win32', 'gvisor')).toBe(65535);
    expect(resolveTunMtu('auto', 'darwin', 'gvisor')).toBe(9000);
    expect(resolveTunMtu('auto', 'linux', 'gvisor')).toBe(9000);
    for (const p of ['darwin', 'win32', 'linux'] as const) {
      expect(resolveTunMtu('auto', p, 'system')).toBe(4064);
      expect(resolveTunMtu('auto', p, 'mixed')).toBe(4064);
    }
  });

  /** 各平台 Auto 档的实际落值 = (Auto 栈, 该栈 MTU)，UI 占位符与下发值都依赖这条闭环。 */
  it('Auto 档端到端落值：win gvisor+65535 / mac gvisor+9000 / linux system+4064', () => {
    const autoOf = (p: string) => {
      const st = resolveTunStack('auto', p);
      return [st, resolveTunMtu('auto', p, st)];
    };
    expect(autoOf('win32')).toEqual(['gvisor', 65535]);
    expect(autoOf('darwin')).toEqual(['gvisor', 9000]);
    expect(autoOf('linux')).toEqual(['system', 4064]);
  });

  it('缺省（undefined/null）等同 auto', () => {
    expect(resolveTunMtu(undefined, 'darwin', 'gvisor')).toBe(9000);
    expect(resolveTunMtu(null, 'win32', 'system')).toBe(4064);
  });

  it('未知平台 → 兜底 linux 档', () => {
    expect(resolveTunMtu('auto', 'freebsd', 'system')).toBe(4064);
  });

  /** 旧实现用 `mtu === 9000` 当"未自定义"哨兵；模型统一后 9000 是普通显式值，须原样下发。 */
  it('显式数值原样下发，含旧哨兵值 9000 与已知劣化组合（honor 用户选择，不静默改写）', () => {
    expect(resolveTunMtu(9000, 'win32', 'system')).toBe(9000);
    expect(resolveTunMtu(65535, 'win32', 'system')).toBe(65535); // 已知劣化组合也不改写
    expect(resolveTunMtu(TUN_MTU_MIN, 'linux', 'gvisor')).toBe(TUN_MTU_MIN);
    expect(resolveTunMtu(TUN_MTU_MAX, 'darwin', 'mixed')).toBe(TUN_MTU_MAX);
  });

  /** 旧配置可能存 0；旧实现按 falsy 回落平台值，此处保持一致（防御，非新语义）。 */
  it('非正数并入 auto（回落平台值）', () => {
    expect(resolveTunMtu(0, 'win32', 'system')).toBe(4064);
    expect(resolveTunMtu(-1, 'darwin', 'gvisor')).toBe(9000);
  });

  it('恒返回具体正整数，任何输入×平台×栈都不返回 auto', () => {
    const inputs = ['auto', 1500, 0, undefined, null] as const;
    for (const i of inputs) {
      for (const p of ['darwin', 'win32', 'linux', 'freebsd'] as const) {
        for (const st of CONCRETE_TUN_STACKS) {
          const out = resolveTunMtu(i, p, st);
          expect(typeof out).toBe('number');
          expect(out).toBeGreaterThan(0);
        }
      }
    }
  });
});

/** 迁移入参形状（可选字段需显式标注，否则对象字面量推断不出 tunMtuMigrated）。 */
type MigCfg = {
  tunStackMigrated?: boolean;
  tunMtuMigrated?: boolean;
  tunConfig?: { stack: 'auto' | 'system' | 'gvisor' | 'mixed'; mtu?: 'auto' | number } | null;
};

describe('migrateTunDefaults — mtu 侧一次性迁移（与 stack 各自独立幂等）', () => {
  it('legacy 强制默认（9000 / 1350 / 1400）→ auto', () => {
    for (const legacy of [9000, 1350, 1400]) {
      const c: MigCfg = { tunConfig: { stack: 'auto', mtu: legacy } };
      expect(migrateTunDefaults(c)).toBe(true);
      expect(c.tunConfig?.mtu).toBe('auto');
      expect(c.tunMtuMigrated).toBe(true);
    }
  });

  it('用户手改过的非 legacy 数值 → 保留（不误伤真实选择）', () => {
    const c: MigCfg = { tunConfig: { stack: 'auto', mtu: 4064 } };
    migrateTunDefaults(c);
    expect(c.tunConfig?.mtu).toBe(4064);
    expect(c.tunMtuMigrated).toBe(true);
  });

  /**
   * 关键回归：tunStackMigrated 对**存量用户早已置 true**（stack 迁移先于本次上线）。若复用该标记做 mtu
   * 守卫，这批人的 mtu 将永不迁移 → 永远停在死数字、后续平台默认演进对他们无效。
   */
  it('stack 已迁移但 mtu 未迁移 → mtu 仍会被迁移（两标记不可合并）', () => {
    const c: MigCfg = { tunStackMigrated: true, tunConfig: { stack: 'mixed', mtu: 1350 } };
    expect(migrateTunDefaults(c)).toBe(true);
    expect(c.tunConfig?.stack).toBe('mixed'); // stack 侧不动（守卫生效）
    expect(c.tunConfig?.mtu).toBe('auto'); // mtu 侧照常迁移
    expect(c.tunMtuMigrated).toBe(true);
  });

  it('mtu 已是 auto → 仅置标记，值不变', () => {
    const c: MigCfg = { tunConfig: { stack: 'auto', mtu: 'auto' } };
    migrateTunDefaults(c);
    expect(c.tunConfig?.mtu).toBe('auto');
  });
});

/**
 * 迁移 + 解析的端到端闭环。**注意语义已从「行为零变化」翻转**：模型统一那批要求存量迁移后下发值不变，
 * 本批（默认值变更）恰恰要求存量用户**被抬到新档**——这正是当初把 mtu 接入 `auto` 的目的：改一张表即
 * 全量生效，不必再写第二次迁移。真正必须守住的是「用户显式选择不被回灌」。
 */
describe('迁移后解析闭环：存量被抬到新档，用户显式值不动', () => {
  it('存量 (旧强制默认 stack + 旧强制默认 mtu) 迁移成 auto 后，解析到新平台档', () => {
    const cases = [
      { platform: 'darwin' as const, stack: 'gvisor' as const, mtu: 1400, want: ['gvisor', 9000] },
      { platform: 'win32' as const, stack: 'system' as const, mtu: 1350, want: ['gvisor', 65535] },
      { platform: 'linux' as const, stack: 'system' as const, mtu: 1350, want: ['system', 4064] },
    ];
    for (const { platform, stack, mtu, want } of cases) {
      const c: MigCfg = { tunConfig: { stack, mtu } };
      migrateTunDefaults(c);
      const afterStack = resolveTunStack(c.tunConfig?.stack, platform);
      expect([afterStack, resolveTunMtu(c.tunConfig?.mtu, platform, afterStack)]).toEqual(want);
    }
  });

  it('已迁移用户的显式 stack/mtu 不被本批默认值变更改写', () => {
    const c: MigCfg = {
      tunStackMigrated: true,
      tunMtuMigrated: true,
      tunConfig: { stack: 'system', mtu: 1350 },
    };
    expect(migrateTunDefaults(c)).toBe(false);
    const st = resolveTunStack(c.tunConfig?.stack, 'win32');
    expect([st, resolveTunMtu(c.tunConfig?.mtu, 'win32', st)]).toEqual(['system', 1350]);
  });
});

describe('parseTunMtuInput — UI 文本输入 → 存储值（PR-2 逃生门）', () => {
  it('空/纯空白 → 复位 auto（存意图，不固化当前平台数值）', () => {
    expect(parseTunMtuInput('')).toBe('auto');
    expect(parseTunMtuInput('   ')).toBe('auto');
  });

  it('区间内整数 → 原值（含两端点）', () => {
    expect(parseTunMtuInput('4064')).toBe(4064);
    expect(parseTunMtuInput(String(TUN_MTU_MIN))).toBe(TUN_MTU_MIN);
    expect(parseTunMtuInput(String(TUN_MTU_MAX))).toBe(TUN_MTU_MAX);
    expect(parseTunMtuInput(' 9000 ')).toBe(9000);
  });

  /** 拒绝而非钳制：钳制会让用户以为设成了自己填的值，实际下发另一个数字。 */
  it('越界/非整数/非数字 → null（不钳制、不静默改写）', () => {
    for (const bad of [
      String(TUN_MTU_MIN - 1),
      String(TUN_MTU_MAX + 1),
      '0',
      '-1400',
      '1500.5',
      'abc',
    ]) {
      expect(parseTunMtuInput(bad)).toBeNull();
    }
  });

  /** 本函数是 shared 导出：`Number()` 认的这些形式不能静默通过，否则调用方拿到用户没打算填的值。 */
  it("非十进制写法（'1e4' / '0x500' / '+1400'）→ null，不按 Number() 的宽松语义放行", () => {
    for (const bad of ['1e4', '0x500', '+1400', ' 1_400 ', '1400.0']) {
      expect(parseTunMtuInput(bad)).toBeNull();
    }
  });

  /** null 之所以够用：合法返回值里没有 falsy 成员（'auto' 与正整数都 truthy）→ 与非法无歧义。 */
  it('合法返回值恒 truthy，故 null 判别无歧义（无需 {ok,value} 联合）', () => {
    for (const ok of ['', '1280', '65535']) expect(parseTunMtuInput(ok)).toBeTruthy();
  });
});

describe('isDegradedMtuCombo — 已知劣化组合非阻断提示', () => {
  it('win/mac + system·mixed + 超 9000 → 命中（Win system+65535 实测塌到 ~11 Mbps）', () => {
    for (const p of ['win32', 'darwin'] as const) {
      expect(isDegradedMtuCombo('system', 65535, p)).toBe(true);
      expect(isDegradedMtuCombo('mixed', 65535, p)).toBe(true);
      expect(isDegradedMtuCombo('system', TUN_MTU_SAFE_MAX_NON_GVISOR + 1, p)).toBe(true);
    }
  });

  /** Linux 的 system + 65535 两轮实测均正常（935 / 465 Mbps，无塌陷）→ 弹警告是虚警。 */
  it('linux（及未知平台）任意组合 → 不命中（该平台无实测劣化）', () => {
    expect(isDegradedMtuCombo('system', 65535, 'linux')).toBe(false);
    expect(isDegradedMtuCombo('mixed', 65535, 'linux')).toBe(false);
    expect(isDegradedMtuCombo('system', 65535, 'freebsd')).toBe(false);
  });

  it('gvisor 任意 MTU → 不命中（65535 正是 Windows gvisor 的最优档）', () => {
    expect(isDegradedMtuCombo('gvisor', 65535, 'win32')).toBe(false);
    expect(isDegradedMtuCombo('gvisor', 9000, 'darwin')).toBe(false);
  });

  it('9000 及以下 → 不命中（上游非 gvisor 的 multiPendingPackets 门槛正是 <=9000）', () => {
    expect(isDegradedMtuCombo('system', TUN_MTU_SAFE_MAX_NON_GVISOR, 'win32')).toBe(false);
    expect(isDegradedMtuCombo('mixed', 4064, 'darwin')).toBe(false);
  });

  /** Auto 档不该误报：判定入参必须是【已解析】的具体栈，'auto' 本身无 MTU 语义。 */
  it("mtu 为 'auto'/缺省 → 不命中（Auto 落值由查表保证在安全区）", () => {
    expect(isDegradedMtuCombo('system', 'auto', 'win32')).toBe(false);
    expect(isDegradedMtuCombo('mixed', undefined, 'win32')).toBe(false);
    expect(isDegradedMtuCombo('system', null, 'darwin')).toBe(false);
  });
});

describe('常量单一真值', () => {
  it('PLATFORM_DEFAULT_MTU 覆盖三平台 × 三栈，无空洞且全在合法区间', () => {
    for (const p of ['darwin', 'win32', 'linux'] as const) {
      for (const st of CONCRETE_TUN_STACKS) {
        const v = PLATFORM_DEFAULT_MTU[p][st];
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(TUN_MTU_MIN);
        expect(v).toBeLessThanOrEqual(TUN_MTU_MAX);
      }
    }
  });

  /** 默认档自身绝不能落在已知劣化区，否则 UI 会对自己的默认值报 warning。 */
  it('每个默认档都不命中 isDegradedMtuCombo（自洽性）', () => {
    for (const p of ['darwin', 'win32', 'linux'] as const) {
      for (const st of CONCRETE_TUN_STACKS) {
        expect(isDegradedMtuCombo(st, PLATFORM_DEFAULT_MTU[p][st], p)).toBe(false);
      }
    }
  });

  /** 上游按 MTU 门控的平台优化：越界即静默关掉，默认档不得踩线。 */
  it('默认档满足上游门槛：Linux GSO(gvisor <49152) / macOS multiPendingPackets(gvisor <32768)', () => {
    expect(PLATFORM_DEFAULT_MTU.linux.gvisor).toBeLessThan(49152);
    expect(PLATFORM_DEFAULT_MTU.darwin.gvisor).toBeLessThan(32768);
    expect(PLATFORM_DEFAULT_MTU.darwin.system).toBeLessThanOrEqual(TUN_MTU_SAFE_MAX_NON_GVISOR);
    expect(PLATFORM_DEFAULT_MTU.darwin.mixed).toBeLessThanOrEqual(TUN_MTU_SAFE_MAX_NON_GVISOR);
  });

  it('MTU 区间常量与 sing-box 可接受范围一致', () => {
    expect(TUN_MTU_MIN).toBe(1280);
    expect(TUN_MTU_MAX).toBe(65535);
  });

  it('PLATFORM_DEFAULT_STACK 映射正确', () => {
    expect(PLATFORM_DEFAULT_STACK.darwin).toBe('gvisor');
    expect(PLATFORM_DEFAULT_STACK.win32).toBe('gvisor'); // 本批改：实测 +133% 吞吐、CPU 减半
    expect(PLATFORM_DEFAULT_STACK.linux).toBe('system');
  });

  it('TUN_STACK_VALUES 含 auto + 三具体栈；CONCRETE_TUN_STACKS 不含 auto', () => {
    expect([...TUN_STACK_VALUES].sort()).toEqual(['auto', 'gvisor', 'mixed', 'system']);
    expect([...CONCRETE_TUN_STACKS].sort()).toEqual(['gvisor', 'mixed', 'system']);
    expect(CONCRETE_TUN_STACKS).not.toContain('auto');
  });
});
