/**
 * 通用集合工具 —— 纯函数、无 I/O、可单测。
 *
 * 把散落各处的 `Array.from(new Set(...))` 去重惯用法收敛为单一真值（主进程 + 渲染端共用），
 * 杜绝同款去重逻辑多份重复实现。
 */

/** 去重且保留首次出现顺序。 */
export function dedupe<T>(items: Iterable<T>): T[] {
  return Array.from(new Set(items));
}

/** 去重 + trim + 丢弃空串，保序（dedupe 的字符串变体）。 */
export function dedupeTrim(list: Iterable<string>): string[] {
  return dedupe(Array.from(list, (s) => s.trim()).filter(Boolean));
}
