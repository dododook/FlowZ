/**
 * tun-stack 单测 —— resolveTunStack（Auto 平台映射 / 全平台显式 verbatim / 恒具体值）
 * + migrateTunStackConfig（迁移纯逻辑幂等）。
 */
import {
  resolveTunStack,
  migrateTunStackConfig,
  PLATFORM_DEFAULT_STACK,
  TUN_STACK_VALUES,
  CONCRETE_TUN_STACKS,
} from '../tun-stack';

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

describe('migrateTunStackConfig — 一次性迁移纯逻辑（幂等）', () => {
  it('legacy 显式 stack（旧 Win 默认 system）→ auto + 置 migrated，返回 true', () => {
    const c: {
      tunStackMigrated?: boolean;
      tunConfig?: { stack: 'auto' | 'system' | 'gvisor' | 'mixed' };
    } = { tunConfig: { stack: 'system' } };
    expect(migrateTunStackConfig(c)).toBe(true);
    expect(c.tunConfig?.stack).toBe('auto');
    expect(c.tunStackMigrated).toBe(true);
  });

  it('legacy gvisor（旧 mac 默认）同样归 auto', () => {
    const c = { tunConfig: { stack: 'gvisor' as const } };
    migrateTunStackConfig(c);
    expect(c.tunConfig.stack).toBe('auto');
  });

  it('已迁移（tunStackMigrated=true）→ 幂等不动，返回 false（护用户显式选择不被回灌）', () => {
    const c = { tunStackMigrated: true, tunConfig: { stack: 'mixed' as const } };
    expect(migrateTunStackConfig(c)).toBe(false);
    expect(c.tunConfig.stack).toBe('mixed');
  });

  it('缺 tunConfig → 仅置 migrated，不抛，返回 true', () => {
    const c: { tunStackMigrated?: boolean; tunConfig?: { stack: 'auto' } } = {};
    expect(migrateTunStackConfig(c)).toBe(true);
    expect(c.tunStackMigrated).toBe(true);
  });

  it('连续两次：第二次 no-op（幂等）', () => {
    const c = { tunConfig: { stack: 'system' as const } };
    migrateTunStackConfig(c);
    expect(migrateTunStackConfig(c)).toBe(false);
  });
});

describe('常量单一真值', () => {
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
