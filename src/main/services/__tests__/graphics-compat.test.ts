import { shouldDisableHardwareAcceleration } from '../graphics-compat';

/**
 * 字段为正向语义（hardwareAcceleration 默认开）→ 本函数仅在严格 === false 时判「该禁用」。
 * 其余一切情况（缺字段/坏 JSON/空文件/脏值）均为「不禁」，且绝不抛（早期崩=启动失败）。
 */
describe('shouldDisableHardwareAcceleration', () => {
  it('disables only when hardwareAcceleration === false', () => {
    expect(shouldDisableHardwareAcceleration('{"hardwareAcceleration": false}')).toBe(true);
    // 与其它合法字段共存也正确取值
    expect(
      shouldDisableHardwareAcceleration(
        '{"autoStart": false, "hardwareAcceleration": false, "logLevel": "info"}'
      )
    ).toBe(true);
  });

  it('does not disable when the flag is true', () => {
    expect(shouldDisableHardwareAcceleration('{"hardwareAcceleration": true}')).toBe(false);
  });

  it('does not disable when the field is missing (undefined = default on)', () => {
    expect(shouldDisableHardwareAcceleration('{"autoStart": true}')).toBe(false);
    expect(shouldDisableHardwareAcceleration('{}')).toBe(false);
  });

  it('does not disable for broken / non-JSON text (never throws)', () => {
    expect(shouldDisableHardwareAcceleration('{ not valid json ')).toBe(false);
    expect(shouldDisableHardwareAcceleration('not json at all')).toBe(false);
    // 截断的合法前缀
    expect(shouldDisableHardwareAcceleration('{"hardwareAcceleration": fal')).toBe(false);
  });

  it('does not disable for empty / whitespace / nullish input', () => {
    expect(shouldDisableHardwareAcceleration('')).toBe(false);
    expect(shouldDisableHardwareAcceleration('   \n  ')).toBe(false);
    expect(shouldDisableHardwareAcceleration(null)).toBe(false);
    expect(shouldDisableHardwareAcceleration(undefined)).toBe(false);
  });

  it('does not disable for non-object JSON or non-boolean flag values (no dirty-value coercion)', () => {
    expect(shouldDisableHardwareAcceleration('[]')).toBe(false);
    expect(shouldDisableHardwareAcceleration('42')).toBe(false);
    expect(shouldDisableHardwareAcceleration('null')).toBe(false);
    expect(shouldDisableHardwareAcceleration('"false"')).toBe(false);
    // 字段是脏字符串/数字/null：不做假值强转，绝不误禁用户硬件加速
    expect(shouldDisableHardwareAcceleration('{"hardwareAcceleration": "false"}')).toBe(false);
    expect(shouldDisableHardwareAcceleration('{"hardwareAcceleration": 0}')).toBe(false);
    expect(shouldDisableHardwareAcceleration('{"hardwareAcceleration": null}')).toBe(false);
  });
});
