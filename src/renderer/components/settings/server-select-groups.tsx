import { useState } from 'react';
import { SelectGroup, SelectItem } from '@/components/ui/select';
import { groupServersBySubscription } from '@shared/server-grouping';
import type { ServerConfig } from '@/bridge/types';
import { useAppStore } from '@/store/app-store';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DIRECT_SERVER_ID } from '@shared/direct-selection';

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
}: ServerSelectGroupsProps) {
  const { t } = useTranslation();
  const subscriptions = useAppStore((s) => s.config?.subscriptions || []);
  const list = servers.filter(
    (s) =>
      (!excludeId || s.id !== excludeId) &&
      !(excludeProtocols && excludeProtocols.includes((s.protocol || '').toLowerCase()))
  );
  const groups = groupServersBySubscription(list, subscriptions);
  const val = (id: string) => `${valuePrefix}${id}`;
  // 「直连」置顶项（全局直连哨兵，#73）：选中即 proxy-selector default=direct；不分组、恒第一项。
  const directItem = includeDirect ? (
    <SelectItem value={val(DIRECT_SERVER_ID)} className={itemClassName}>
      {t('servers.directGlobal', '直连')}
    </SelectItem>
  ) : null;

  // 默认展开组：当前选中节点所在组；无则第一组。
  // 注意：ServerSelectGroups 挂在 radix Select 的常驻 Content 子树里，会在 config 加载完成前先挂载，
  // 那时 selectedId 还是 undefined。若用 useState 惰性初始化会把展开组锁死在「第一组(自建)」、之后不更新。
  // 故改为「每次渲染从 defaultGroup 派生 expanded」（随 selectedId 到位而更新），用户手动折叠后才接管(override)。
  const defaultGroup = groups.length
    ? (selectedId && groups.find((g) => g.servers.some((s) => s.id === selectedId))?.id) ||
      groups[0].id
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
        {list.map((s) => (
          <SelectItem key={s.id} value={val(s.id)} className={itemClassName}>
            {s.name}
          </SelectItem>
        ))}
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
            {open &&
              g.servers.map((s) => (
                <SelectItem key={s.id} value={val(s.id)} className={itemClassName}>
                  {s.name}
                </SelectItem>
              ))}
          </SelectGroup>
        );
      })}
    </>
  );
}
