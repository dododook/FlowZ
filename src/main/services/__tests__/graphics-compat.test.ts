import { shouldDisableHardwareAcceleration } from '../graphics-compat';

describe('shouldDisableHardwareAcceleration', () => {
  it('returns true only when disableHardwareAcceleration === true', () => {
    expect(shouldDisableHardwareAcceleration('{"disableHardwareAcceleration": true}')).toBe(true);
    // 与其它合法字段共存也正确取值
    expect(
      shouldDisableHardwareAcceleration(
        '{"autoStart": false, "disableHardwareAcceleration": true, "logLevel": "info"}'
      )
    ).toBe(true);
  });

  it('returns false when the flag is false', () => {
    expect(shouldDisableHardwareAcceleration('{"disableHardwareAcceleration": false}')).toBe(false);
  });

  it('returns false when the field is missing', () => {
    expect(shouldDisableHardwareAcceleration('{"autoStart": true}')).toBe(false);
    expect(shouldDisableHardwareAcceleration('{}')).toBe(false);
  });

  it('returns false for broken / non-JSON text (never throws)', () => {
    expect(shouldDisableHardwareAcceleration('{ not valid json ')).toBe(false);
    expect(shouldDisableHardwareAcceleration('not json at all')).toBe(false);
    // 截断的合法前缀
    expect(shouldDisableHardwareAcceleration('{"disableHardwareAcceleration": tr')).toBe(false);
  });

  it('returns false for empty / whitespace / nullish input', () => {
    expect(shouldDisableHardwareAcceleration('')).toBe(false);
    expect(shouldDisableHardwareAcceleration('   \n  ')).toBe(false);
    expect(shouldDisableHardwareAcceleration(null)).toBe(false);
    expect(shouldDisableHardwareAcceleration(undefined)).toBe(false);
  });

  it('returns false for non-object JSON or non-boolean flag values (no dirty-value coercion)', () => {
    expect(shouldDisableHardwareAcceleration('[]')).toBe(false);
    expect(shouldDisableHardwareAcceleration('42')).toBe(false);
    expect(shouldDisableHardwareAcceleration('null')).toBe(false);
    expect(shouldDisableHardwareAcceleration('"true"')).toBe(false);
    // 字段是脏字符串/数字，不做真值强转
    expect(shouldDisableHardwareAcceleration('{"disableHardwareAcceleration": "true"}')).toBe(
      false
    );
    expect(shouldDisableHardwareAcceleration('{"disableHardwareAcceleration": 1}')).toBe(false);
  });
});
