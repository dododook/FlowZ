/**
 * i18n locale 完整性护栏。
 *
 * - en-US 是基准（source of truth）。
 * - fa-IR（波斯语，本期新增）要求与 en-US **精确 parity**：零缺漏、零多余键，
 *   且每个含插值占位符 {{var}} 的键，占位符集合与 en-US 一致（机翻草稿也不能漏变量）。
 * - 其余 locale 仅校验「无多余键」（不能残留 en-US 已删除的过时键）；
 *   是否补齐新键由各自维护者推进，不在此处强制（避免把别处的待译项变成本测试的红灯）。
 */
import enUS from '../locales/en-US.json';
import zhCN from '../locales/zh-CN.json';
import zhTW from '../locales/zh-TW.json';
import ru from '../locales/ru.json';
import faIR from '../locales/fa-IR.json';

type JsonObject = { [key: string]: unknown };

/** 递归收集所有叶子键（点分路径）。数组按叶子处理（本项目 locale 无数组值）。 */
function leafKeys(obj: JsonObject, prefix = ''): string[] {
  const out: string[] = [];
  for (const key of Object.keys(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...leafKeys(value as JsonObject, full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/** 按点分路径取叶子值。 */
function getByPath(obj: JsonObject, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, seg) => {
    if (acc !== null && typeof acc === 'object') {
      return (acc as JsonObject)[seg];
    }
    return undefined;
  }, obj);
}

/** 提取字符串中的 i18next 插值占位符变量名集合（{{var}} / {{ var, format }}）。 */
function placeholders(value: unknown): Set<string> {
  const set = new Set<string>();
  if (typeof value !== 'string') return set;
  const re = /\{\{\s*([\w.-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    set.add(m[1]);
  }
  return set;
}

const enKeys = leafKeys(enUS as JsonObject);
const enKeySet = new Set(enKeys);

const allLocales: Record<string, JsonObject> = {
  'zh-CN': zhCN as JsonObject,
  'zh-TW': zhTW as JsonObject,
  ru: ru as JsonObject,
  'fa-IR': faIR as JsonObject,
};

describe('i18n locale parity', () => {
  it('en-US base has keys', () => {
    expect(enKeys.length).toBeGreaterThan(0);
  });

  // 全 locale：禁止残留 en-US 已无的过时键。
  for (const [name, data] of Object.entries(allLocales)) {
    it(`${name} has no extra keys beyond en-US`, () => {
      const extra = leafKeys(data).filter((k) => !enKeySet.has(k));
      expect(extra).toEqual([]);
    });
  }

  // fa-IR：本期交付，要求与 en-US 精确 parity（零缺漏）。
  it('fa-IR has full key parity with en-US (no missing keys)', () => {
    const faKeySet = new Set(leafKeys(faIR as JsonObject));
    const missing = enKeys.filter((k) => !faKeySet.has(k));
    expect(missing).toEqual([]);
  });

  // fa-IR：每个键的插值占位符变量与 en-US 一致（机翻不得漏/改 {{var}}）。
  it('fa-IR preserves interpolation placeholders from en-US', () => {
    const mismatches: string[] = [];
    for (const key of enKeys) {
      const enPlaceholders = placeholders(getByPath(enUS as JsonObject, key));
      if (enPlaceholders.size === 0) continue;
      const faPlaceholders = placeholders(getByPath(faIR as JsonObject, key));
      const same =
        enPlaceholders.size === faPlaceholders.size &&
        [...enPlaceholders].every((p) => faPlaceholders.has(p));
      if (!same) {
        mismatches.push(
          `${key}: en={${[...enPlaceholders].sort().join(',')}} fa={${[...faPlaceholders].sort().join(',')}}`
        );
      }
    }
    expect(mismatches).toEqual([]);
  });
});
