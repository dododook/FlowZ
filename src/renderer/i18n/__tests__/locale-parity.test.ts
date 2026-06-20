/**
 * i18n locale 完整性护栏。
 *
 * - en-US 是基准（source of truth）。
 * - 全部受支持 locale（zh-CN/zh-TW/ru/fa-IR）要求与 en-US **精确 parity**：零缺漏、零多余键，
 *   且每个含插值占位符的键，占位符集合与 en-US 一致（机翻草稿/漏译也不能漏变量、漏嵌套引用）。
 *   当前 4 个 locale 均已满 parity，本护栏防后续新增键时漏译。
 * - 占位符识别两类：① i18next 插值 {{var}}；② i18next 嵌套引用 $t(key)（变量名/键名含 `.`、`:`、`$`，
 *   旧正则 [\w.-] 捕获组漏 `$t(...)` 的键名与 `$` 起始引用 → 补认，防嵌套引用键在某 locale 漏写不被察觉）。
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

/**
 * 提取字符串中的占位符集合（变量占位 + 嵌套引用），跨 locale 须一致：
 *  - i18next 插值 {{var}} / {{ var, format }} → 收 `{{var}}`；
 *  - i18next 嵌套引用 $t(key) → 收 `$t:key`（键名可含 `.` / `:` 命名空间分隔 / `-`，旧 [\w.-] 捕获组
 *    既不含 `$`（引用起始符）也不含 `:`（命名空间），会漏整条 $t 引用 → 单独正则补认）。
 */
function placeholders(value: unknown): Set<string> {
  const set = new Set<string>();
  if (typeof value !== 'string') return set;
  let m: RegExpExecArray | null;
  const interp = /\{\{\s*([\w.-]+)/g;
  while ((m = interp.exec(value)) !== null) {
    set.add(`{{${m[1]}}}`);
  }
  // 嵌套引用 $t(some.namespaced:key)：捕获键名（含 . : - _），归一为 `$t:<key>` 参与 parity 比对。
  const nested = /\$t\(\s*([\w.:-]+)/g;
  while ((m = nested.exec(value)) !== null) {
    set.add(`$t:${m[1]}`);
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

  // 全 locale：与 en-US 精确 parity（零缺漏）。当前 4 个 locale 均满足，护栏防后续新增键漏译。
  for (const [name, data] of Object.entries(allLocales)) {
    it(`${name} has full key parity with en-US (no missing keys)`, () => {
      const keySet = new Set(leafKeys(data));
      const missing = enKeys.filter((k) => !keySet.has(k));
      expect(missing).toEqual([]);
    });
  }

  // 全 locale：每个键的占位符（{{var}} 插值 + $t(key) 嵌套引用）与 en-US 一致（机翻/漏译不得漏改）。
  for (const [name, data] of Object.entries(allLocales)) {
    it(`${name} preserves interpolation placeholders from en-US`, () => {
      const mismatches: string[] = [];
      for (const key of enKeys) {
        const enPlaceholders = placeholders(getByPath(enUS as JsonObject, key));
        if (enPlaceholders.size === 0) continue;
        const locPlaceholders = placeholders(getByPath(data, key));
        const same =
          enPlaceholders.size === locPlaceholders.size &&
          [...enPlaceholders].every((p) => locPlaceholders.has(p));
        if (!same) {
          mismatches.push(
            `${key}: en={${[...enPlaceholders].sort().join(',')}} ${name}={${[...locPlaceholders].sort().join(',')}}`
          );
        }
      }
      expect(mismatches).toEqual([]);
    });
  }
});
