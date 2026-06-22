/**
 * 通用集合工具 —— 纯函数、无 I/O、可单测。
 *
 * 把散落各处的 `Array.from(new Set(...))` 去重惯用法收敛为单一真值（主进程 + 渲染端共用），
 * 杜绝同款去重逻辑多份重复实现。
 */

/** 去重保序：按首次出现顺序返回去重后的数组（= Array.from(new Set(items))）。 */
export function dedupe<T>(items: Iterable<T>): T[] {
  return Array.from(new Set(items));
}

/** 字符串去重 + 修剪空白 + 丢弃空串（dedupe 的「trim + filter(Boolean)」变体），保序。 */
export function dedupeTrim(list: Iterable<string>): string[] {
  return dedupe(Array.from(list, (s) => s.trim()).filter(Boolean));
}
