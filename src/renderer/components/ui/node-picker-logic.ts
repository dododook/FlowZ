/**
 * 「一步选节点」下拉（NodePicker / `.npick`）的纯逻辑与数据模型 —— 从组件抽出，无 react/store/@别名依赖，
 * 可被 .test.ts 直接 import 覆盖「分组 / 过滤 / 选中回填 / 是否显搜索 / 延迟色档」矩阵。
 *
 * 数据源解耦：调用方把「已算好的节点项列表 + 分组定义 + 当前 id + onSelect」喂进来，组件只负责
 * 分组渲染 / 搜索 / 键盘 / 双主题。故本模块只认 NodePickerItem（与 ServerConfig 解耦），供首页出口、
 * 应用分流指定节点、路由目标节点、Tailscale 出口设备等所有「选出口」场景共用。
 */

/** 延迟色档：good=<100 绿 / medium=<300 琥珀 / bad=超时或 >=300 红 / idle=未测或不可测（灰）。 */
export type LatencyTone = 'good' | 'medium' | 'bad' | 'idle';

/** 状态点色（触发器/选项左侧圆点）：ok 绿 / warn 琥珀 / err 红 / mesh 品牌青 / idle 灰。 */
export type DotTone = 'ok' | 'warn' | 'err' | 'mesh' | 'idle';

export interface NodePickerItem {
  /** 选中回填 / onSelect 回调的唯一值（节点 id、直连哨兵、跟随全局哨兵等）。 */
  id: string;
  name: string;
  /** 协议角标（如 vless）；缺省不显。 */
  protocol?: string;
  /** 延迟 ms：>=0 有效、-1 超时、undefined 未测。 */
  latency?: number;
  /** 不可测节点（Tailscale / endpoint 组网）→ 显 N/A，不显延迟数值。 */
  latencyNA?: boolean;
  /** 异常态文案（「出口无效」/「未登录」）：有值时 LatencyLabel 优先渲染为 warn 文案，压过 latency/latencyNA
   *  （由 deriveLatencyBadge 在 buildServerPickerModel 处预算——纯项无 store 访问，态须构建期喂入）。 */
  statusLabel?: string;
  /** 地址（触发器副文本 + 参与搜索）。 */
  address?: string;
  /** 分组 id（映射到 groups 顺序）；缺省 → 归「无分组」桶（如直连哨兵恒置顶）。 */
  groupId?: string;
  /** 特殊项角色（direct/none/follow）→ 弱化延迟等差异化样式；默认 node。 */
  role?: 'node' | 'direct' | 'none' | 'follow';
  /** 状态点色；缺省由 role/latency 派生。 */
  dotTone?: DotTone;
  /** 额外搜索关键词（如国家/地区别名）。 */
  keywords?: string;
  /** 禁用项：radix DropdownMenuItem 原生跳焦点/typeahead + data-[disabled]:opacity-50；不可选中。 */
  disabled?: boolean;
  /** 名称后、协议徽标前的补充说明（如 tailnet peer 的「ip · 使用中/离线/未广告」）；缺省不显。 */
  note?: string;
}

export interface NodePickerGroup {
  id: string;
  label: string;
}

/** 分组后的一段：group=null 为「无分组」桶（置顶，如直连）。 */
export interface NodePickerSection {
  group: NodePickerGroup | null;
  items: NodePickerItem[];
}

/** 延迟数值 → 色档（阈值单一真值：server-list-helpers 的 getLatencyColor / getLatencyBg 均由此派生）。 */
export function latencyTone(latency: number | undefined, _na?: boolean): LatencyTone {
  // _na（不可测标记）不再影响色档：无值→idle 灰（未测/不可测且伴测未写入），有值即按数值上色。出口伴测
  // （exit-probe-latency）会给「当前 TS/组网出口」写入真实延迟，那时该显真实色档；组网身份由 dotToneOf 的 mesh
  // 青点单独标识，不靠这里的灰。保留 _na 入参仅为调用点签名兼容。
  if (latency === undefined) return 'idle';
  if (latency < 0) return 'bad'; // 超时（-1）
  if (latency < 100) return 'good';
  if (latency < 300) return 'medium';
  return 'bad';
}

/**
 * 色档 → 文字色 class（Tailwind design token，纯字符串、零 react 依赖）：单一映射真值，
 * 供 .npick 延迟徽标（LatencyLabel）与 settings 的 getLatencyColor 共用，杜绝映射双写漂移。
 */
export const LATENCY_TONE_TEXT_CLASS: Record<LatencyTone, string> = {
  good: 'text-success',
  medium: 'text-warning',
  bad: 'text-destructive',
  idle: 'text-muted-foreground',
};

/** 单项是否命中查询（名/协议/地址/关键词，大小写不敏感；空查询恒命中）。 */
export function matchesQuery(item: NodePickerItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const hay =
    `${item.name} ${item.protocol ?? ''} ${item.address ?? ''} ${item.keywords ?? ''}`.toLowerCase();
  return hay.includes(needle);
}

/** 按查询过滤（保留入参顺序）。 */
export function filterItems(items: NodePickerItem[], query: string): NodePickerItem[] {
  return items.filter((item) => matchesQuery(item, query));
}

/**
 * 分组：无分组项（无 groupId）合成置顶桶（group=null），其后按 groups 顺序各成一段；空段省略。
 * 未传 groups（或空）→ 全平铺为单段（group=null），单一来源不显冗余分组头。
 */
export function groupItems(
  items: NodePickerItem[],
  groups?: NodePickerGroup[]
): NodePickerSection[] {
  if (!groups || groups.length === 0) {
    return items.length ? [{ group: null, items }] : [];
  }
  const sections: NodePickerSection[] = [];
  const ungrouped = items.filter((i) => !i.groupId);
  if (ungrouped.length) sections.push({ group: null, items: ungrouped });
  for (const g of groups) {
    const gi = items.filter((i) => i.groupId === g.id);
    if (gi.length) sections.push({ group: g, items: gi });
  }
  return sections;
}

/** 当前选中项（供触发器回填）；id 空 → undefined。 */
export function findItem(
  items: NodePickerItem[],
  id: string | null | undefined
): NodePickerItem | undefined {
  if (id == null) return undefined;
  return items.find((i) => i.id === id);
}

export function shouldShowSearch(count: number, threshold = 6): boolean {
  return count > threshold;
}

/**
 * 视觉顺序首个可选（非 disabled）项——搜索框 Enter 选中它，跳过被禁用的项（如未广告出口的 tailnet peer）。
 * 全禁用 / 空 → undefined（Enter 不选中）。按 section 顺序、段内顺序遍历，与渲染视觉顺序一致。
 */
export function firstSelectable(sections: NodePickerSection[]): NodePickerItem | undefined {
  for (const sec of sections) {
    for (const it of sec.items) {
      if (!it.disabled) return it;
    }
  }
  return undefined;
}

/**
 * 搜索框 Enter 选中决策（单一真值，供 NodePicker 的 onSearchEnter 复用）：
 * **仅当有真实查询词（trim 非空）时**才选中视觉首个可选项；空 query 的裸 Enter → undefined（no-op）。
 * 修复：空 query 时首个可选往往是顶部哨兵（None / 直连 / 跟随全局），用户开下拉未输入直接 Enter 会误选哨兵、
 * 把已配置出口/exit_node 静默清空。加此 gate 后，裸 Enter 不选任何项，只有搜到词回车才确认首个匹配。
 */
export function enterSelection(
  query: string,
  sections: NodePickerSection[]
): NodePickerItem | undefined {
  if (!query.trim()) return undefined;
  return firstSelectable(sections);
}
