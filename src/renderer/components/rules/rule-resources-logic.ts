/**
 * 规则资源页纯逻辑（离线安全网）：资源分类过滤 / 内置守卫（操作派生）/ 更新态派生。
 * 组件只做渲染与 IPC 接线，数据变换收敛到此，便于单测且供资源库对话框与已下载表复用。
 */
import type {
  RuleResourceCategory,
  RuleResourceListItem,
  RuleResourceProgress,
} from '@/bridge/types';

/** 资源库分类筛选：全部 / geosite / geoip / 精简（lite）。catalog 永不含 custom（仅手动 URL），故不设该项。 */
export type CatalogFilter = 'all' | 'geosite' | 'geoip' | 'lite';
export const CATALOG_FILTERS: CatalogFilter[] = ['all', 'geosite', 'geoip', 'lite'];

/**
 * 资源分类过滤匹配：
 * - 'all'  → 全通过。
 * - 'lite' → 命中所有 `-lite` 分类（geosite-lite / geoip-lite）。
 * - 其余   → 分类精确匹配（geosite / geoip）。
 */
export function matchesCategoryFilter(
  category: RuleResourceCategory,
  filter: CatalogFilter
): boolean {
  if (filter === 'all') return true;
  if (filter === 'lite') return category.endsWith('-lite');
  return category === filter;
}

/**
 * 内置守卫 → 操作派生：内置随包资源**不可删除**、只能「重置为出厂」；外置（用户下载）资源只能「删除」。
 * 决定已下载表操作列渲染哪个次操作按钮，与主进程 `delete`/`resetBuiltin` 的 builtin 分流一致。
 */
export function resourceRowAction(item: Pick<RuleResourceListItem, 'builtin'>): 'reset' | 'delete' {
  return item.builtin ? 'reset' : 'delete';
}

/**
 * 更新态派生：把进度快照分成「进行中（下载 / 排队）」与「失败」两组临时行。
 * `done` 不入表——完成后 refresh() 会把它转成正式已下载行，临时行随即从 map 删除。
 */
export function partitionProgress(values: RuleResourceProgress[]): {
  active: RuleResourceProgress[];
  error: RuleResourceProgress[];
} {
  const active = values.filter((p) => p.status === 'downloading' || p.status === 'queued');
  const error = values.filter((p) => p.status === 'error');
  return { active, error };
}

/** 「全部更新」禁用判据：无任何资源可更新，或已有下载在途（避免与进行中的任务重复触发）。 */
export function isUpdateAllDisabled(itemCount: number, activeCount: number): boolean {
  return itemCount === 0 || activeCount > 0;
}
