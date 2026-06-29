import { useState } from 'react';
import { SelectGroup, SelectItem } from '@/components/ui/select';
import { groupServersBySubscription } from '@shared/server-grouping';
import { sortServersByLatency } from '@shared/server-latency-sort';
import type { ServerConfig } from '@/bridge/types';
import { useAppStore } from '@/store/app-store';
import { useNodeSortStore } from '@/store/use-node-sort-store';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DIRECT_SERVER_ID } from '@shared/direct-selection';
import { SpeedBadge } from './speed-badge';

/** 稳定空引用：showLatency=false 时作 latencyMap 选择器返回值，避免订阅 latencyMap、防测速期无谓重渲染（F2）。 */
const EMPTY_LATENCY: Record<string, number> = {};

interface ServerSelectGroupsProps {
  servers: ServerConfig[];
  /** 排除某节点（用于 detour 选择器避免自指） */
  excludeId?: string;
  /** 排除某些协议（小写）：如 detour 选择器排除 endpoint（WireGuard/Tailscale）——endpoint 不作前置代理目标 */
  excludeProtocols?: readonly string[];
  /** option value 前缀（如应用分流用 'node-'），默认空 */
  valuePrefix?: string;
  /** SelectItem 透传类名（适配不同选择器字号） */
  itemClassName?: string;
  /** 当前选中的节点 id：决定默认展开哪个分组（其余默认折叠），并天然定位当前节点 */
  selectedId?: string;
  /** 顶部加「直连」项（仅首页全局节点选择用；应用分流/路由规则/detour 不传——它们有各自 action=直连） */
  includeDirect?: boolean;
  /** 每项名字右侧显示测速延迟徽标（读全局 latencyMap）；首页 + 应用分流 + 路由规则传 true，节点编辑 detour 不传 */
  showLatency?: boolean;
  /** 是否随「延迟排序」开关重排本列表（仅首页传 true）；与 showLatency 解耦——其余选择器显徽标但不被开关重排（用户定「开关只管下拉+托盘」） */
  enableLatencySort?: boolean;
}

/**
 * 在 <SelectContent> 内渲染「按订阅/自建分组」的节点选项，供路由规则 / 应用分流 / 代理链 / 首页共用。
 * 多分组时为可折叠手风琴：默认仅展开「当前选中节点所在组」，其余折叠；单击组头切换。
 * 单一来源时退化为平铺（不显冗余分组标签）。
 *
 * radix Select 交互注意：组头用 onClick（非 pointerup，避开 radix 拖选手势）、用普通 div（非 SelectItem，
 * 不进键盘焦点序列）；折叠 state 留在本组件（Content 子树）内，关闭重挂载回到默认态、保证选中项被渲染。
 */
export function ServerSelectGroups({
  servers,
  excludeId,
  excludeProtocols,
  valuePrefix = '',
  itemClassName,
  selectedId,
  includeDirect,
  showLatency,
  enableLatencySort,
}: ServerSelectGroupsProps) {
  const { t } = useTranslation();
  const subscriptions = useAppStore((s) => s.config?.subscriptions || []);
  // 仅 showLatency（首页）时订阅 latencyMap：其余消费方拿稳定空引用 → 测速期间 latencyMap 频繁更新不触其重渲染。
  const latencyMap = useAppStore((s) => (showLatency ? s.latencyMap : EMPTY_LATENCY));
  // 「按延迟排序」开关（与托盘同序，共用比较器）：仅 enableLatencySort（首页）订阅并生效；应用分流/路由规则只显徽标、不被开关重排
  // （用户定「开关只管下拉+托盘」），其余选择器拿 false（零订阅 churn）。开关关 → 不排序、保留 config 原序。开关开 → 按延迟（无结果按名称降级）。
  const sortByLatency = useNodeSortStore((s) => (enableLatencySort ? s.sortByLatency : false));
  const sortNodes = (arr: ServerConfig[]): ServerConfig[] =>
    enableLatencySort && sortByLatency ? sortServersByLatency(arr, (id) => latencyMap[id]) : arr;
  const list = servers.filter(
    (s) =>
      (!excludeId || s.id !== excludeId) &&
      !(excludeProtocols && excludeProtocols.includes((s.protocol || '').toLowerCase()))
  );
  const groups = groupServersBySubscription(list, subscriptions);
  const val = (id: string) => `${valuePrefix}${id}`;
  // 节点项渲染（DRY 单组/多组两处）：showLatency 时经 SelectItem 的 trailing 槽挂 SpeedBadge（名字 truncate、
  // 徽标恒右对齐可见，见 ui/select）；否则纯名字——其余消费方（应用分流/路由规则/节点编辑）行为逐字不变。
  const renderItem = (s: ServerConfig) => (
    <SelectItem
      key={s.id}
      value={val(s.id)}
      className={itemClassName}
      trailing={showLatency ? <SpeedBadge server={s} latencyMap={latencyMap} /> : undefined}
    >
      {s.name}
    </SelectItem>
  );
  // 「直连」置顶项（全局直连哨兵，#73）：选中即 proxy-selector default=direct；不分组、恒第一项。
  const directItem = includeDirect ? (
    <SelectItem value={val(DIRECT_SERVER_ID)} className={itemClassName}>
      {t('servers.directGlobal', '直连')}
    </SelectItem>
  ) : null;

  // 默认展开组：仅展开「当前选中节点所在组」；未选中、或选中项不属任何分组（如直连/默认哨兵）→ 全部折叠（不再默认展开第一组）。
  // 注意：ServerSelectGroups 挂在 radix Select 的常驻 Content 子树里，会在 config 加载完成前先挂载，
  // 那时 selectedId 还是 undefined。若用 useState 惰性初始化会把展开组锁死、之后不更新。
  // 故改为「每次渲染从 defaultGroup 派生 expanded」（随 selectedId 到位而更新），用户手动展开/折叠后才接管(override)。
  const defaultGroup =
    selectedId && groups.length
      ? groups.find((g) => g.servers.some((s) => s.id === selectedId))?.id
      : undefined;
  const [override, setOverride] = useState<Set<string> | null>(null);
  const expanded = override ?? new Set(defaultGroup ? [defaultGroup] : []);
  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOverride(next);
  };

  // 仅一个分组（纯自建或仅一个订阅）：不加分组头，平铺更清爽
  if (groups.length <= 1) {
    return (
      <>
        {directItem}
        {sortNodes(list).map(renderItem)}
      </>
    );
  }

  return (
    <>
      {directItem}
      {groups.map((g) => {
        const open = expanded.has(g.id);
        const label = g.isMesh
          ? t('servers.meshNodes', '组网')
          : g.isManual
            ? t('servers.manualNodes', '自建节点')
            : g.name;
        return (
          <SelectGroup key={g.id}>
            <div
              role="button"
              onClick={() => toggle(g.id)}
              className="flex cursor-pointer select-none items-center gap-1.5 px-2 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')}
              />
              <span className="truncate" title={label}>
                {label}
              </span>
              <span className="ms-auto shrink-0 text-[10px] opacity-60">{g.servers.length}</span>
            </div>
            {open && sortNodes(g.servers).map(renderItem)}
          </SelectGroup>
        );
      })}
    </>
  );
}
