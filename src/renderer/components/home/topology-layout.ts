/**
 * 连接拓扑（首页 Sankey 图）布局计算 —— 纯函数，从 connection-topology.tsx 抽出（审计 §2/§6 Tier-2：布局计算不可测）。
 * 输入【main 已聚合好的连接快照（ConnectionsAggregate，issue #227）】+ 容器宽度 + i18n 取值器，输出三列 Sankey 的
 * {nodes, links} 坐标与缎带路径；无 react/electron/@别名依赖，可被 .test.ts 直接 import 单测。
 */
import { TOPOLOGY_OTHERS_KEY, type ConnectionsAggregate } from '../../../shared/types';

export interface Node {
  id: string;
  name: string;
  type: 'source' | 'rule' | 'outbound';
  value: number;
  x: number;
  y: number;
  height: number;
  color: string;
}

export interface Link {
  source: string;
  target: string;
  value: number;
  path: string;
  color: string;
  sourceY: number;
  targetY: number;
  heightSource: number;
  heightTarget: number;
}

export const FIXED_HEIGHT = 450; // 画布固定高度（与 RealTimeLogs 视觉对齐）
const PADDING_Y = 20;
const PADDING_X = 20;
const PADDING_LEFT = 20; // 左内边距：维持左侧「块状」对齐（按设计调回 20）
export const NODE_WIDTH = 6; // 节点条宽（偏细）
const NODE_GAP = 12; // 同列堆叠节点间距（偏紧，避免缎带过"粗"）
const SOURCE_HEIGHT = 80; // source 条恒定高度：设备只有单个，不随流量缩放，作视觉锚
const PER_CONN_MAX = 80; // 每连接高度上限：单连接时中/右列与 source 等高
const MID_TOTAL_RATIO = 0.8; // 中列总高上限 = 可容纳高度 * 此比例
const OUT_TOTAL_SINGLE = 80; // 右列总高上限：单出口（与 source 等高）
const OUT_TOTAL_MULTI = 120; // 右列总高上限：多出口分列

/** 命中区最小高度：条随连接数反比缩水（50 连接时仅几 px），靶子太小右键戳不中，故命中区不跟随视觉尺寸。 */
const HIT_MIN_HEIGHT = 18;
/** 命中区向标签文字侧的横向延伸：标签 pointer-events:none，不覆盖则点域名会穿透。 */
const HIT_LABEL_REACH = 96;

/**
 * 节点命中区（相对节点 g 原点）：纵向至少 HIT_MIN_HEIGHT，但不超过「条高 + NODE_GAP - 2」——
 * 恒不与相邻节点的命中区重叠（同列间距恒为 NODE_GAP）；横向覆盖条 + 标签文字侧。
 * 与视觉尺寸解耦：条可以细到 2px，命中区仍可点。
 */
export function hitBox(node: Node): { x: number; y: number; width: number; height: number } {
  const maxH = node.height + NODE_GAP - 2; // 上界：吃掉间距但留 2px，杜绝相邻重叠
  const height = Math.min(Math.max(node.height, HIT_MIN_HEIGHT), Math.max(maxH, node.height));
  const y = (node.height - height) / 2; // 以条为中心纵向扩展
  // 标签在 source/rule 左侧、outbound 右侧（见 text 的 x 与 textAnchor）
  const towardLabelLeft = node.type !== 'outbound';
  return {
    x: towardLabelLeft ? -HIT_LABEL_REACH : -10,
    y,
    width: HIT_LABEL_REACH + NODE_WIDTH + 10,
    height,
  };
}

/**
 * 从焦点节点出发收集整条链路上的节点 id + 缎带 id（`link-<i>`）——hover 与检索共用同一套高亮语义。
 * 沿链路向上游(target→source)与下游(source→target)各做一次 BFS，收敛即停；两端都在链路集内的缎带一并纳入。
 * focusNodes 为空 → 返回空集（调用方据此判定"无命中"，与"未激活"是两回事）。
 */
export function collectLinkedIds(links: Link[], focusNodes: string[]): Set<string> {
  const set = new Set<string>(focusNodes);
  if (focusNodes.length === 0) return set;

  const walk = (forward: boolean) => {
    const acc = new Set<string>(focusNodes);
    let changed = true;
    while (changed) {
      changed = false;
      links.forEach((l) => {
        const [from, to] = forward ? [l.source, l.target] : [l.target, l.source];
        if (acc.has(from) && !acc.has(to)) {
          acc.add(to);
          changed = true;
        }
      });
    }
    return acc;
  };

  const pathNodes = new Set([...walk(false), ...walk(true)]);
  pathNodes.forEach((id) => set.add(id));
  links.forEach((l, i) => {
    if (pathNodes.has(l.source) && pathNodes.has(l.target)) set.add(`link-${i}`);
  });
  return set;
}

/**
 * 检索匹配：大小写不敏感子串，命中 host 节点名（域名或 IP——main 侧本就是同一字段，见 connections-aggregate
 * 的 hostNameOf）与出口节点名。source 节点不参与匹配（它是设备锚，非检索目标）。
 * 空 query → 空数组（调用方据此判定未检索）。
 *
 * 注意：被 Top-N 合并进「其他」的 host，其名字在 main 侧聚合时即已丢弃，载荷里不存在 → 此处无从匹配。
 */
export function matchNodeIds(nodes: Node[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return nodes
    .filter((n) => n.type !== 'source' && n.name.toLowerCase().includes(q))
    .map((n) => n.id);
}

/** Sankey 缎带路径：两段三次贝塞尔（顶/底）+ 直线闭合。纯字符串数学。 */
export function getSankeyPath(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  h0: number,
  h1: number
) {
  const xi = (x0 + x1) / 2;
  const topCurve = `M ${x0} ${y0} C ${xi} ${y0}, ${xi} ${y1}, ${x1} ${y1}`;
  const rightLine = `L ${x1} ${y1 + h1}`;
  const bottomCurve = `C ${xi} ${y1 + h1}, ${xi} ${y0 + h0}, ${x0} ${y0 + h0}`;
  const close = `L ${x0} ${y0} Z`;
  return `${topCurve} ${rightLine} ${bottomCurve} ${close}`;
}

/**
 * 把【main 已聚合好的】连接快照摆成三列 Sankey（source / host / outbound）节点与缎带坐标。
 * 聚合（Top-15 host + others 合并 + 出口分布）已下沉 main 的 aggregateConnections（issue #227）——本函数不再
 * 遍历全量连接明细，只做坐标布局。各列垂直居中。
 *
 * 三列各自独立 scale（issue #303）：source 恒定高度（设备只有单个，不表达流量）；中/右列按 PER_CONN_MAX 与各自
 * 总量上限取小——少连接时每条 PER_CONN_MAX，连接多了才被上限压下去。故三列高度互不守恒（有意为之）：
 * 缎带两端本就按各自列的比例独立计算（见 heightSource/heightTarget），异 scale 不影响缎带正确性。
 */
export function computeTopologyLayout(
  aggregate: ConnectionsAggregate,
  width: number,
  t: (key: string) => string,
  // 画布高度（首页 hero 随窗口自适应传入实测高度）；缺省 FIXED_HEIGHT，旧调用/单测行为不变。
  canvasHeight: number = FIXED_HEIGHT
): { nodes: Node[]; links: Link[] } {
  if (aggregate.hosts.length === 0 || width === 0 || canvasHeight <= 0)
    return { nodes: [], links: [] };

  // host 显示名：main 用 TOPOLOGY_OTHERS_KEY sentinel 标记「其它」合并组（main 不知 i18n）→ 此处替换为本地化文案。
  const displayName = (name: string): string =>
    name === TOPOLOGY_OTHERS_KEY ? t('home.others') : name;

  // 摆成原布局代码消费的形态。main 已按 count 降序 + Top-N + others 合并，保持其次序（不再渲染端聚合/排序）。
  // isOthers 由 main 下发的 sentinel 判定（非显示名比较），杜绝真实 host 恰为本地化「其它」文案时被误染/撞 id。
  const sortedMiddle: Array<
    [string, { value: number; flows: Map<string, number>; isOthers: boolean }]
  > = aggregate.hosts.map((h) => [
    displayName(h.name),
    {
      value: h.count,
      flows: new Map(h.flows.map((f) => [f.outbound, f.count])),
      isOthers: h.name === TOPOLOGY_OTHERS_KEY,
    },
  ]);
  const sortedOutbounds: Array<[string, number]> = aggregate.outbounds.map((o) => [
    o.name,
    o.count,
  ]);

  const nodeList: Node[] = [];
  const availableHeight = canvasHeight - 2 * PADDING_Y;

  // Determine total connections (for source node)：有名 host 连接数之和（与原 layout 同口径，不含无名连接）。
  const totalConnections = sortedMiddle.reduce((acc, [_, d]) => acc + d.value, 0);

  const middleCount = sortedMiddle.length;
  const outboundCount = sortedOutbounds.length;

  const totalMiddleGap = Math.max(0, middleCount - 1) * NODE_GAP;
  const totalOutboundGap = Math.max(0, outboundCount - 1) * NODE_GAP;

  const maxContentHeight = availableHeight - Math.max(totalMiddleGap, totalOutboundGap);
  // 上限是天花板不是目标值：连接少时每条 PER_CONN_MAX，多了才被总量上限压下去。
  const midCap = maxContentHeight * MID_TOTAL_RATIO;
  const outCap = outboundCount === 1 ? OUT_TOTAL_SINGLE : OUT_TOTAL_MULTI;
  const scale = Math.min(PER_CONN_MAX, midCap / (totalConnections || 1));
  const outScale = Math.min(PER_CONN_MAX, outCap / (totalConnections || 1));

  const SHIFT_RIGHT = 35; // Shift the entire layout right to fill empty space

  const sourceNode: Node = {
    id: 'source',
    name: t('home.myDevice'),
    type: 'source',
    value: totalConnections,
    x: PADDING_LEFT + SHIFT_RIGHT,
    y: PADDING_Y,
    height: SOURCE_HEIGHT,
    color: 'fill-primary', // Conduit token(双主题自适配,见 connection-topology rect className)
  };
  sourceNode.y = (canvasHeight - sourceNode.height) / 2;
  nodeList.push(sourceNode);

  const middleGroupHeight =
    sortedMiddle.reduce((acc, [_, d]) => acc + Math.max(2, d.value * scale), 0) + totalMiddleGap;
  let currentY = (canvasHeight - middleGroupHeight) / 2;

  const midNodeParams = new Map<string, Node>();
  const middleX = width * 0.45 + SHIFT_RIGHT;

  sortedMiddle.forEach(([name, data]) => {
    const h = Math.max(2, data.value * scale);
    const node: Node = {
      id: `mid-${name}`,
      name: name,
      type: 'rule',
      value: data.value,
      x: middleX,
      y: currentY,
      height: h,
      color: data.isOthers ? 'fill-muted-foreground' : 'fill-success', // token: Others slate / 域名 live 绿（按 sentinel 判定）
    };
    nodeList.push(node);
    midNodeParams.set(name, node);
    currentY += h + NODE_GAP;
  });

  const outGroupHeight =
    sortedOutbounds.reduce((acc, [_, v]) => acc + Math.max(2, v * outScale), 0) + totalOutboundGap;
  currentY = (canvasHeight - outGroupHeight) / 2;

  const outNodeParams = new Map<string, Node>();
  const outYCursorMap = new Map<string, number>();
  const outboundX = width - PADDING_X - 120 + SHIFT_RIGHT; // Right side with padding for text + shift

  sortedOutbounds.forEach(([name, val]) => {
    const h = Math.max(2, val * outScale);
    const node: Node = {
      id: `out-${name}`,
      name: name,
      type: 'outbound',
      value: val,
      x: outboundX,
      y: currentY,
      height: h,
      color: 'fill-warning', // token: 出口 warn 琥珀
    };
    nodeList.push(node);
    outNodeParams.set(name, node);
    outYCursorMap.set(name, currentY);
    currentY += h + NODE_GAP;
  });

  const linkList: Link[] = [];

  let sourceCursor = sourceNode.y;
  sortedMiddle.forEach(([name, data]) => {
    const midNode = midNodeParams.get(name)!;
    const val = data.value;
    const h = (val / totalConnections) * sourceNode.height; // Proportional height at source

    linkList.push({
      source: sourceNode.id,
      target: midNode.id,
      value: val,
      sourceY: sourceCursor,
      targetY: midNode.y,
      heightSource: h,
      heightTarget: midNode.height,
      color: 'url(#gradient-source)',
      path: getSankeyPath(
        sourceNode.x + NODE_WIDTH,
        sourceCursor,
        midNode.x,
        midNode.y,
        h,
        midNode.height
      ),
    });
    sourceCursor += h;
  });

  sortedMiddle.forEach(([name, data]) => {
    const midNode = midNodeParams.get(name)!;
    let midCursor = midNode.y;

    sortedOutbounds.forEach(([outName, _]) => {
      const flowVal = data.flows.get(outName);
      if (!flowVal) return;

      const outNode = outNodeParams.get(outName)!;

      // Proportions based on Node Heights
      const midH = (flowVal / data.value) * midNode.height;
      const outH = (flowVal / outNode.value) * outNode.height;
      const outCursor = outYCursorMap.get(outName)!;

      linkList.push({
        source: midNode.id,
        target: outNode.id,
        value: flowVal,
        sourceY: midCursor,
        targetY: outCursor,
        heightSource: midH,
        heightTarget: outH,
        color: 'url(#gradient-rule)',
        path: getSankeyPath(midNode.x + NODE_WIDTH, midCursor, outNode.x, outCursor, midH, outH),
      });

      midCursor += midH;
      outYCursorMap.set(outName, outCursor + outH);
    });
  });

  return { nodes: nodeList, links: linkList };
}
