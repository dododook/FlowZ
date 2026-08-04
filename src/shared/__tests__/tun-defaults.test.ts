/**
 * tun-defaults 单测 —— resolveTunStack / resolveTunMtu（Auto 映射 / 显式 verbatim / 恒具体值）
 * + migrateTunDefaults（stack 与 mtu 各自独立幂等）。
 */
import {
  resolveTunStack,
  resolveTunMtu,
  migrateTunDefaults,
  PLATFORM_DEFAULT_STACK,
  PLATFORM_DEFAULT_MTU,
  TUN_STACK_VALUES,
  CONCRETE_TUN_STACKS,
  TUN_MTU_MIN,
  TUN_MTU_MAX,
} from '../tun-defaults';

describe('resolveTunStack — Auto 平台映射', () => {
  it('auto → 平台默认（mac gvisor / win·linux system）', () => {
    expect(resolveTunStack('auto', 'darwin')).toBe('gvisor');
    expect(resolveTunStack('auto', 'win32')).toBe('system');
    expect(resolveTunStack('auto', 'linux')).toBe('system');
  });

  it('缺省（undefined/null）等同 auto → 平台默认', () => {
    expect(resolveTunStack(undefined, 'darwin')).toBe('gvisor');
    expect(resolveTunStack(undefined, 'win32')).toBe('system');
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
  it('auto → 各平台历史默认（mac 1400 / win·linux 1350），三栈当前同值', () => {
    for (const st of CONCRETE_TUN_STACKS) {
      expect(resolveTunMtu('auto', 'darwin', st)).toBe(1400);
      expect(resolveTunMtu('auto', 'win32', st)).toBe(1350);
      expect(resolveTunMtu('auto', 'linux', st)).toBe(1350);
    }
  });

  it('缺省（undefined/null）等同 auto', () => {
    expect(resolveTunMtu(undefined, 'darwin', 'gvisor')).toBe(1400);
    expect(resolveTunMtu(null, 'win32', 'system')).toBe(1350);
  });

  it('未知平台 → 兜底 linux 档', () => {
    expect(resolveTunMtu('auto', 'freebsd', 'system')).toBe(1350);
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
    expect(resolveTunMtu(0, 'win32', 'system')).toBe(1350);
    expect(resolveTunMtu(-1, 'darwin', 'gvisor')).toBe(1400);
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

describe('迁移后解析闭环：行为零变化（本次上线的硬要求）', () => {
  it('存量 (平台默认 stack + 平台默认 mtu) 迁移成 auto 后，解析回完全相同的下发值', () => {
    const cases = [
      { platform: 'darwin' as const, stack: 'gvisor' as const, mtu: 1400 },
      { platform: 'win32' as const, stack: 'system' as const, mtu: 1350 },
      { platform: 'linux' as const, stack: 'system' as const, mtu: 1350 },
    ];
    for (const { platform, stack, mtu } of cases) {
      const before = { stack: resolveTunStack(stack, platform), mtu };
      const c: MigCfg = { tunConfig: { stack, mtu } };
      migrateTunDefaults(c);
      const afterStack = resolveTunStack(c.tunConfig?.stack, platform);
      const after = {
        stack: afterStack,
        mtu: resolveTunMtu(c.tunConfig?.mtu, platform, afterStack),
      };
      expect(after).toEqual(before);
    }
  });
});

describe('常量单一真值', () => {
  it('PLATFORM_DEFAULT_MTU 覆盖三平台 × 三栈，且当前值 = 各平台历史默认', () => {
    for (const p of ['darwin', 'win32', 'linux'] as const) {
      for (const st of CONCRETE_TUN_STACKS) {
        expect(PLATFORM_DEFAULT_MTU[p][st]).toBe(p === 'darwin' ? 1400 : 1350);
      }
    }
  });

  it('MTU 区间常量与 sing-box 可接受范围一致', () => {
    expect(TUN_MTU_MIN).toBe(1280);
    expect(TUN_MTU_MAX).toBe(65535);
  });

  it('PLATFORM_DEFAULT_STACK 映射正确', () => {
    expect(PLATFORM_DEFAULT_STACK.darwin).toBe('gvisor');
    expect(PLATFORM_DEFAULT_STACK.win32).toBe('system');
    expect(PLATFORM_DEFAULT_STACK.linux).toBe('system');
  });

  it('TUN_STACK_VALUES 含 auto + 三具体栈；CONCRETE_TUN_STACKS 不含 auto', () => {
    expect([...TUN_STACK_VALUES].sort()).toEqual(['auto', 'gvisor', 'mixed', 'system']);
    expect([...CONCRETE_TUN_STACKS].sort()).toEqual(['gvisor', 'mixed', 'system']);
    expect(CONCRETE_TUN_STACKS).not.toContain('auto');
  });
});
