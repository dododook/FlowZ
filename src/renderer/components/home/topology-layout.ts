/**
 * 连接拓扑（首页 Sankey 图）布局计算 —— 纯函数，从 connection-topology.tsx 抽出（审计 §2/§6 Tier-2：布局计算不可测）。
 * 输入连接快照 + 容器宽度 + i18n 取值器，输出三列 Sankey 的 {nodes, links} 坐标与缎带路径；
 * 无 react/electron/@别名依赖，可被 .test.ts 直接 import 单测。原 useMemo 体逐字保留，t 由参数注入。
 */
import type { ConnectionEntry } from '../../../shared/types';

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
 * 聚合连接 → 三列 Sankey（source / rule[按 host 细分] / outbound）节点与缎带。
 * Top-15 + Others 收敛；高度按连接数比例缩放（MAX_SCALE 封顶）；各列垂直居中。
 */
export function computeTopologyLayout(
  connections: ConnectionEntry[],
  width: number,
  t: (key: string) => string
): { nodes: Node[]; links: Link[] } {
  // Only recalc if we have width and connections
  if (connections.length === 0 || width === 0) return { nodes: [], links: [] };

  // --- 1. Data Aggregation ---
  // We want to breakdown generic rules (final) by Host to give more detail

  // Better Aggregation Structure
  const middleNodes = new Map<string, { value: number; flows: Map<string, number> }>();
  const outboundTotals = new Map<string, number>();

  connections.forEach((conn) => {
    let name = conn.rule;
    const metadata = conn.metadata || {};

    // Prioritize Host/IP for display to show actual websites, falling back to Rule
    if (metadata.host) {
      name = metadata.host;
    } else if (metadata.destinationIP) {
      name = metadata.destinationIP;
    } else if (conn.rulePayload) {
      name = `${conn.rule}: ${conn.rulePayload}`;
    }

    let outbound = 'Direct';
    if (conn.chains && conn.chains.length > 0) {
      outbound = conn.chains[0];
    }

    // Update Middle Node
    if (!middleNodes.has(name)) {
      middleNodes.set(name, { value: 0, flows: new Map() });
    }
    const node = middleNodes.get(name)!;
    node.value += 1;
    node.flows.set(outbound, (node.flows.get(outbound) || 0) + 1);

    // Update Outbound Totals
    outboundTotals.set(outbound, (outboundTotals.get(outbound) || 0) + 1);
  });

  // --- 2. Node Selection (Top N) ---
  const MAX_NODES = 15;
  let sortedMiddle = Array.from(middleNodes.entries()).sort((a, b) => b[1].value - a[1].value);

  // Filter out potential noise or empty names if any
  sortedMiddle = sortedMiddle.filter(([n]) => n && n.trim() !== '');

  if (sortedMiddle.length > MAX_NODES) {
    const top = sortedMiddle.slice(0, MAX_NODES);
    const others = sortedMiddle.slice(MAX_NODES);

    const startValue = { value: 0, flows: new Map<string, number>() };
    const othersNode = others.reduce((acc, [_, data]) => {
      acc.value += data.value;
      data.flows.forEach((v, k) => {
        acc.flows.set(k, (acc.flows.get(k) || 0) + v);
      });
      return acc;
    }, startValue);

    sortedMiddle = [...top, [t('home.others'), othersNode]];
  }

  // --- 3. Layout Calculation (Responsive) ---
  const nodeList: Node[] = [];
  const availableHeight = FIXED_HEIGHT - 2 * PADDING_Y;

  // Prepare Outbounds
  const sortedOutbounds = Array.from(outboundTotals.entries()).sort((a, b) => b[1] - a[1]);

  // Determine total connections (for source node)
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
  sourceNode.y = (FIXED_HEIGHT - sourceNode.height) / 2;
  nodeList.push(sourceNode);

  // Middle Nodes
  // Center the group vertically
  const middleGroupHeight =
    sortedMiddle.reduce((acc, [_, d]) => acc + Math.max(2, d.value * scale), 0) + totalMiddleGap;
  let currentY = (FIXED_HEIGHT - middleGroupHeight) / 2;

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
      color: name === t('home.others') ? 'fill-muted-foreground' : 'fill-success', // token: Others slate / 域名 live 绿
    };
    nodeList.push(node);
    midNodeParams.set(name, node);
    currentY += h + NODE_GAP;
  });

  // Outbound Nodes
  const outGroupHeight =
    sortedOutbounds.reduce((acc, [_, v]) => acc + Math.max(2, v * scale), 0) + totalOutboundGap;
  currentY = (FIXED_HEIGHT - outGroupHeight) / 2;

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
