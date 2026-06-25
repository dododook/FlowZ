/**
 * shared/language 单测：fa-IR→fa 迁移、系统偏好语言映射、有效语言解析（含 auto/非法回退）。
 */
import {
  AUTO_LANGUAGE,
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  migrateLanguageCode,
  resolveAutoLanguage,
  resolveEffectiveLanguage,
} from '../language';

describe('migrateLanguageCode', () => {
  it('fa-IR → fa；其余/空值原样', () => {
    expect(migrateLanguageCode('fa-IR')).toBe('fa');
    expect(migrateLanguageCode('zh-CN')).toBe('zh-CN');
    expect(migrateLanguageCode('auto')).toBe('auto');
    expect(migrateLanguageCode(null)).toBeNull();
    expect(migrateLanguageCode(undefined)).toBeUndefined();
  });
});

describe('resolveAutoLanguage（OS 偏好 → 受支持语言）', () => {
  it.each([
    [['zh-Hans-CN'], 'zh-CN'],
    [['zh-CN'], 'zh-CN'],
    [['zh-SG'], 'zh-CN'],
    [['zh'], 'zh-CN'],
    [['zh-Hant-TW'], 'zh-TW'],
    [['zh-TW'], 'zh-TW'],
    [['zh-HK'], 'zh-TW'],
    [['zh-MO'], 'zh-TW'],
    [['fa-IR'], 'fa'],
    [['fa'], 'fa'],
    [['ru-RU'], 'ru'],
    [['ru'], 'ru'],
    [['en-GB'], 'en-US'],
    [['en'], 'en-US'],
  ])('%j → %s', (input, expected) => {
    expect(resolveAutoLanguage(input as string[])).toBe(expected);
  });

  it('全不匹配 → 回退 en-US', () => {
    expect(resolveAutoLanguage(['de-DE', 'ja-JP'])).toBe('en-US');
  });

  it('逐个匹配、命中即止（跳过不支持的，取首个受支持）', () => {
    expect(resolveAutoLanguage(['de-DE', 'ru-RU', 'zh-CN'])).toBe('ru');
  });

  it('空/缺失 → en-US', () => {
    expect(resolveAutoLanguage([])).toBe('en-US');
    expect(resolveAutoLanguage(null)).toBe('en-US');
    expect(resolveAutoLanguage(undefined)).toBe('en-US');
  });
});

describe('resolveEffectiveLanguage（选择 + 系统 → 实际语言）', () => {
  it('auto / 未设 → 按系统解析', () => {
    expect(resolveEffectiveLanguage(AUTO_LANGUAGE, ['fa-IR'])).toBe('fa');
    expect(resolveEffectiveLanguage(null, ['ru'])).toBe('ru');
    expect(resolveEffectiveLanguage(undefined, ['zh-Hant-TW'])).toBe('zh-TW');
  });

  it('具体码 → 用它（fa-IR 先迁移成 fa）', () => {
    expect(resolveEffectiveLanguage('fa-IR', ['ru'])).toBe('fa');
    expect(resolveEffectiveLanguage('zh-CN', ['ru'])).toBe('zh-CN');
    expect(resolveEffectiveLanguage('fa', [])).toBe('fa');
  });

  it('非法具体码 → 回落系统解析', () => {
    expect(resolveEffectiveLanguage('klingon', ['ru'])).toBe('ru');
    expect(resolveEffectiveLanguage('klingon', ['de'])).toBe('en-US');
  });

  it('常量自洽：DEFAULT 在受支持集、fa 在集、无 fa-IR', () => {
    expect(SUPPORTED_LANGUAGES).toContain(DEFAULT_LANGUAGE);
    expect(SUPPORTED_LANGUAGES).toContain('fa');
    expect(SUPPORTED_LANGUAGES as readonly string[]).not.toContain('fa-IR');
  });
});
