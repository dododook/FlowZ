/**
 * 规则集选择器（ResourcePicker 下拉复选）的纯逻辑（无 react/@别名依赖）：分区、搜索过滤、
 * 引用勾选切换、fail-closed 可选性、摘要。抽出以便 .test.ts 覆盖「规则集选择」矩阵。
 */
import type { RuleResourceListItem } from '../../../shared/types';

/** 资源数超阈值才显搜索框：直接复用 .npick 的 shouldShowSearch（同阈值 6、同谓词），单一真值。 */
export { shouldShowSearch } from '../ui/node-picker-logic';

/** 规则集引用值：res:<资源 id>（本地资源，内置随包 + 已下载）。 */
export function resourceRef(id: string): string {
  return `res:${id}`;
}

/** 该资源是否已被引用（values 含 res:<id>）。 */
export function isResourceSelected(values: string[], id: string): boolean {
  return values.includes(resourceRef(id));
}

/** 切换引用：已选则移除，否则追加（保序）。 */
export function toggleResourceRef(values: string[], id: string): string[] {
  const ref = resourceRef(id);
  return values.includes(ref) ? values.filter((v) => v !== ref) : [...values, ref];
}

/**
 * fail-closed 可选性：文件存在恒可选；文件缺失且未被引用 → 不可新选（后端会跳过失效引用，
 * 避免用户建一条静默失效规则）；文件缺失但已被引用 → 仍可（取消失效引用）。
 */
export function isResourceSelectable(item: RuleResourceListItem, selected: boolean): boolean {
  return item.fileExists || selected;
}

/** 内置（随包）/ 外置（已下载）分区（保序）。 */
export function partitionResources(list: RuleResourceListItem[]): {
  builtin: RuleResourceListItem[];
  external: RuleResourceListItem[];
} {
  return {
    builtin: list.filter((r) => r.builtin),
    external: list.filter((r) => !r.builtin),
  };
}

/** 按名称大小写不敏感过滤（空查询恒全量，保序）。 */
export function filterResources(
  list: RuleResourceListItem[],
  query: string
): RuleResourceListItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((r) => r.name.toLowerCase().includes(q));
}
