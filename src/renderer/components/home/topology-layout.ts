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
 * 遍历全量连接明细，只做坐标布局。高度按连接数比例缩放（MAX_SCALE 封顶）；各列垂直居中。
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

  // --- Layout Calculation (Responsive) ---
  const nodeList: Node[] = [];
  const availableHeight = canvasHeight - 2 * PADDING_Y;

  // Determine total connections (for source node)：有名 host 连接数之和（与原 layout 同口径，不含无名连接）。
  const totalConnections = sortedMiddle.reduce((acc, [_, d]) => acc + d.value, 0);

  const middleCount = sortedMiddle.length;
  const outboundCount = sortedOutbounds.length;

  const totalMiddleGap = Math.max(0, middleCount - 1) * NODE_GAP;
  const totalOutboundGap = Math.max(0, outboundCount - 1) * NODE_GAP;

  // Scale Logic: Ensure items fit in height.
  const maxContentHeight = availableHeight - Math.max(totalMiddleGap, totalOutboundGap);
  const autoScale = maxContentHeight / (totalConnections || 1);
  const MAX_SCALE = 30; // Max pixels per connection (prevents single connection from being massive)
  const scale = Math.min(autoScale > 0 ? autoScale : MAX_SCALE, MAX_SCALE);

  const SHIFT_RIGHT = 35; // Shift the entire layout right to fill empty space

  // Source Node
  const sourceNode: Node = {
    id: 'source',
    name: t('home.myDevice'),
    type: 'source',
    value: totalConnections,
    x: PADDING_LEFT + SHIFT_RIGHT,
    y: PADDING_Y,
    height: Math.max(2, totalConnections * scale),
    color: 'fill-primary', // Conduit token(双主题自适配,见 connection-topology rect className)
  };
  sourceNode.y = (canvasHeight - sourceNode.height) / 2;
  nodeList.push(sourceNode);

  // Middle Nodes
  // Center the group vertically
  const middleGroupHeight =
    sortedMiddle.reduce((acc, [_, d]) => acc + Math.max(2, d.value * scale), 0) + totalMiddleGap;
  let currentY = (canvasHeight - middleGroupHeight) / 2;

  const midNodeParams = new Map<string, Node>();
  // Responsive X positions
  const middleX = width * 0.45 + SHIFT_RIGHT; // 45% of width + shift

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

  // Outbound Nodes
  const outGroupHeight =
    sortedOutbounds.reduce((acc, [_, v]) => acc + Math.max(2, v * scale), 0) + totalOutboundGap;
  currentY = (canvasHeight - outGroupHeight) / 2;

  const outNodeParams = new Map<string, Node>();
  const outYCursorMap = new Map<string, number>();
  const outboundX = width - PADDING_X - 120 + SHIFT_RIGHT; // Right side with padding for text + shift

  sortedOutbounds.forEach(([name, val]) => {
    const h = Math.max(2, val * scale);
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

  // --- 4. Links ---
  const linkList: Link[] = [];

  // Source -> Middle
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

  // Middle -> Outbound
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
