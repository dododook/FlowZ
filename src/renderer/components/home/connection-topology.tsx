import { useEffect, useState, useMemo, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Network } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc';
import { toast } from 'sonner';
import type { Rule, RuleAction, ConnectionsAggregate } from '../../../shared/types';
import { getRuleActionStyle } from '@/lib/rule-action-style';
import { computeTopologyLayout, FIXED_HEIGHT, NODE_WIDTH, type Node } from './topology-layout';

const EMPTY_AGGREGATE: ConnectionsAggregate = { total: 0, hosts: [], outbounds: [], at: 0 };

export function ConnectionTopology() {
  const [aggregate, setAggregate] = useState<ConnectionsAggregate>(EMPTY_AGGREGATE);
  const [loading, setLoading] = useState(true);
  const [hovered, setHovered] = useState<{ type: 'node' | 'link'; id: string } | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; domain: string } | null>(
    null
  );
  const { t } = useTranslation();
  const config = useAppStore((state) => state.config);
  const saveConfig = useAppStore((state) => state.saveConfig);
  // F17：仅订阅 running 布尔（primitive），避免每 2s 轮询整体替换 connectionStatus 触发本组件空转重渲染
  const proxyRunning = useAppStore((s) => s.connectionStatus?.proxyCore?.running ?? false);

  // Responsive Container Logic
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800); // Default start width

  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentBoxSize) {
          // Provide a slight debounce or just set it? React 18 handles batching well.
          // We need the width of the container content
          setWidth(entry.contentRect.width);
        }
      }
    });

    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  // issue #227：拓扑改消费 main 侧【连接聚合】（小载荷，与连接总数解耦），取代旧「每秒全量 ConnectionEntry[] 广播」。
  // 挂载即用 CONNECTIONS_AGGREGATE_GET 回填初值，再订阅 EVENT_CONNECTIONS_AGGREGATE 收增量。main 连接流订阅跟随
  // started（代理运行即推送），停止代理时 main 广播空聚合 → 自然落入空态。渲染端不再直连 :9090、不持 secret。
  useEffect(() => {
    let mounted = true;
    api.connections.aggregate
      .get()
      .then((agg) => {
        if (mounted) {
          setAggregate(agg);
          setLoading(false);
        }
      })
      .catch(() => {
        if (mounted) setLoading(false);
      });
    const unsub = api.connections.aggregate.onUpdated((agg) => {
      setAggregate(agg);
      setLoading(false);
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  const { nodes, links } = useMemo(
    () => computeTopologyLayout(aggregate, width, t),
    [aggregate, width, t]
  );

  // --- Interaction Logic ---

  // Trace Logic: Identify all connected nodes/links for a given hover
  const highlightedIds = useMemo(() => {
    if (!hovered) return new Set<string>();

    const set = new Set<string>();
    set.add(hovered.id);

    // 焦点节点：hover 节点本身即焦点；hover 连线则其两端节点皆为焦点。
    let focusNodes: string[] = [];
    if (hovered.type === 'node') {
      focusNodes = [hovered.id];
    } else {
      const idx = parseInt(hovered.id.split('-')[1]);
      const hLink = links[idx];
      if (hLink) focusNodes = [hLink.source, hLink.target];
    }

    // 沿链路向上游(target→source)与下游(source→target)各做一次 BFS，收敛即停。
    // 合计 O(L²)，覆盖经过焦点的完整链路（上游全部来源 + 下游全部去向）。
    const upstreamNodes = new Set<string>(focusNodes);
    let changed = true;
    while (changed) {
      changed = false;
      links.forEach((l) => {
        if (upstreamNodes.has(l.target) && !upstreamNodes.has(l.source)) {
          upstreamNodes.add(l.source);
          changed = true;
        }
      });
    }

    const downstreamNodes = new Set<string>(focusNodes);
    changed = true;
    while (changed) {
      changed = false;
      links.forEach((l) => {
        if (downstreamNodes.has(l.source) && !downstreamNodes.has(l.target)) {
          downstreamNodes.add(l.target);
          changed = true;
        }
      });
    }

    // 焦点上下游所有节点高亮；两端都在集合内的连线即落在链路上，一并高亮。
    const pathNodes = new Set([...upstreamNodes, ...downstreamNodes]);
    pathNodes.forEach((id) => set.add(id));
    links.forEach((l, i) => {
      if (pathNodes.has(l.source) && pathNodes.has(l.target)) {
        set.add(`link-${i}`);
      }
    });

    return set;
  }, [hovered, links]);

  const getNodeOpacity = (nodeId: string) => {
    if (!hovered) return 1;
    return highlightedIds.has(nodeId) ? 1 : 0.1;
  };

  const getLinkOpacity = (index: number) => {
    if (!hovered) return 0.4;
    return highlightedIds.has(`link-${index}`) ? 0.8 : 0.05;
  };

  // Tooltip Content logic
  const getTooltipContent = () => {
    if (!hovered) return null;

    if (hovered.type === 'node') {
      const node = nodes.find((n) => n.id === hovered.id);
      if (!node) return null;
      return (
        <div className="bg-popover text-popover-foreground px-3 py-2 rounded-md shadow-lg border border-border text-xs z-50 animate-in fade-in zoom-in-95 duration-200">
          <div className="font-bold mb-1">{node.name}</div>
          <div>
            {t('home.type')}: {node.type}
          </div>
          <div>
            {t('home.connections')}: {node.value}
          </div>
        </div>
      );
    }

    if (hovered.type === 'link') {
      const index = parseInt(hovered.id.split('-')[1]);
      const link = links[index];
      if (!link) return null;

      // Find the "Middle" node associated with this link to show its details
      // Link is either Source->Middle or Middle->Outbound
      let mainNodeId: string | null = null;
      if (link.target.startsWith('mid-')) mainNodeId = link.target;
      if (link.source.startsWith('mid-')) mainNodeId = link.source;

      const mainNode = mainNodeId ? nodes.find((n) => n.id === mainNodeId) : null;

      // If we found a middle node, show its details primarily
      if (mainNode) {
        return (
          <div className="bg-popover text-popover-foreground px-3 py-2 rounded-md shadow-lg border border-border text-xs z-50 animate-in fade-in zoom-in-95 duration-200 chat-bubble">
            <div className="font-bold mb-1">{mainNode.name}</div>
            <div className="text-muted-foreground mb-1">
              {t('home.type')}: {mainNode.type}
            </div>
            <div className="border-t border-border my-1 pt-1 flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{t('home.flow')}</span>
              <span>
                {mainNode.value === 1
                  ? t('home.connectionSingle', { count: link.value })
                  : t('home.connectionPlural', { count: link.value })}
              </span>
            </div>
          </div>
        );
      }

      const sourceName = nodes.find((n) => n.id === link.source)?.name || link.source;
      const targetName = nodes.find((n) => n.id === link.target)?.name || link.target;

      return (
        <div className="bg-popover text-popover-foreground px-3 py-2 rounded-md shadow-lg border border-border text-xs z-50 animate-in fade-in zoom-in-95 duration-200 chat-bubble">
          <div className="font-bold mb-1">{t('home.flowDetail')}</div>
          <div className="flex items-center gap-1 mb-1">
            <span className="max-w-[100px] truncate">{sourceName}</span>
            <span>→</span>
            <span className="max-w-[100px] truncate">{targetName}</span>
          </div>
          <div>
            {t('home.connections')}: {link.value}
          </div>
        </div>
      );
    }
    return null;
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    // Relative to the container
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setMousePos({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    }
  };

  const handleMouseLeave = () => {
    setHovered(null);
  };

  const handleMouseEnter = (type: 'node' | 'link', id: string) => {
    setHovered({ type, id });
  };

  // -------- Right-click: Add domain to rule --------
  const handleNodeContextMenu = (e: React.MouseEvent, node: Node) => {
    // Only allow right-click on domain (middle/rule) nodes, not source or outbound
    if (node.type !== 'rule') return;
    // Skip 'Others' group node
    if (node.name === t('home.others')) return;
    // Only show menu for domain-like names (contains dots or is a valid host)
    if (!node.name.includes('.') && !node.name.includes(':')) return;

    e.preventDefault();
    e.stopPropagation();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setContextMenu({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      domain: node.name,
    });
  };

  const addDomainRule = async (domain: string, action: RuleAction) => {
    if (!config) return;
    setContextMenu(null);

    // Extract root domain (e.g. 'sub.example.com' -> 'example.com')
    const parts = domain.split('.');
    const rootDomain = parts.length > 2 ? parts.slice(-2).join('.') : domain;

    // Check if a domain-type rule already covers this domain
    const isDomainType = (r: Rule) =>
      r.type === 'domain' || r.type === 'domainSuffix' || r.type === 'domainKeyword';
    const existing = config.customRules.find(
      (r) => isDomainType(r) && (r.values.includes(domain) || r.values.includes(rootDomain))
    );
    if (existing) {
      toast.info(t('home.domainAlreadyInRule', { domain }));
      return;
    }

    const newRule: Rule = {
      id: `topology-${Date.now()}`,
      type: 'domainSuffix',
      values: [domain],
      action,
      enabled: true,
    };

    try {
      await saveConfig({
        ...config,
        customRules: [...config.customRules, newRule],
      });
      const actionLabel =
        action === 'proxy'
          ? t('home.ruleProxy')
          : action === 'direct'
            ? t('home.ruleDirect')
            : t('home.ruleBlock');
      toast.success(t('home.domainRuleAdded', { domain, action: actionLabel }));
    } catch {
      toast.error(t('home.domainRuleAddFail'));
    }
  };

  return (
    <Card className="col-span-1">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Network className="h-5 w-5" />
          {t('home.connectionTopology')}
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-hidden">
        <div
          ref={containerRef}
          style={{ width: '100%', height: `${FIXED_HEIGHT}px` }}
          className="relative cursor-default"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {loading && nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground h-full">
              {t('home.loading')}
            </div>
          )}

          {!loading && nodes.length === 0 && (
            <div className="absolute inset-0 text-muted-foreground text-sm flex flex-col items-center justify-center gap-2 h-full">
              <Network className="h-8 w-8 opacity-50" />
              <span>{proxyRunning ? t('home.noActiveConnections') : t('home.plsStartProxy')}</span>
            </div>
          )}

          {/* Tooltip Layer */}
          {hovered && !contextMenu && (
            <div
              className="absolute pointer-events-none"
              style={{
                left: mousePos.x + 10,
                top: mousePos.y + 10,
              }}
            >
              {getTooltipContent()}
            </div>
          )}

          {/* Right-click Context Menu */}
          {contextMenu && (
            <>
              {/* Backdrop to close menu */}
              <div
                className="fixed inset-0 z-40"
                onClick={() => setContextMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu(null);
                }}
              />
              <div
                className="absolute z-50 min-w-[180px] rounded-lg border border-border bg-popover shadow-lg text-popover-foreground text-sm overflow-hidden"
                style={{ left: contextMenu.x, top: contextMenu.y }}
              >
                <div className="px-3 py-2 border-b border-border">
                  <p className="font-medium truncate max-w-[160px]" title={contextMenu.domain}>
                    {contextMenu.domain}
                  </p>
                  <p className="text-xs text-muted-foreground">{t('home.addToRule')}</p>
                </div>
                <div className="py-1">
                  <button
                    className="w-full text-start px-3 py-2 hover:bg-accent flex items-center gap-2 transition-colors"
                    onClick={() => addDomainRule(contextMenu.domain, 'proxy')}
                  >
                    <span
                      className={`h-2 w-2 rounded-full inline-block ${getRuleActionStyle('proxy').dot}`}
                    />
                    {t('home.ruleProxy')}
                  </button>
                  <button
                    className="w-full text-start px-3 py-2 hover:bg-accent flex items-center gap-2 transition-colors"
                    onClick={() => addDomainRule(contextMenu.domain, 'direct')}
                  >
                    <span
                      className={`h-2 w-2 rounded-full inline-block ${getRuleActionStyle('direct').dot}`}
                    />
                    {t('home.ruleDirect')}
                  </button>
                  <button
                    className={`w-full text-start px-3 py-2 hover:bg-accent flex items-center gap-2 transition-colors ${getRuleActionStyle('block').text}`}
                    onClick={() => addDomainRule(contextMenu.domain, 'block')}
                  >
                    <span
                      className={`h-2 w-2 rounded-full inline-block ${getRuleActionStyle('block').dot}`}
                    />
                    {t('home.ruleBlock')}
                  </button>
                </div>
              </div>
            </>
          )}

          <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${width} ${FIXED_HEIGHT}`}
            className="overflow-visible font-sans"
          >
            <defs>
              <linearGradient
                id="gradient-source"
                gradientUnits="userSpaceOnUse"
                x1="0"
                x2={width * 0.45}
                y1="0"
                y2="0"
              >
                <stop offset="0%" style={{ stopColor: 'hsl(var(--primary))' }} stopOpacity="0.4" />
                <stop
                  offset="100%"
                  style={{ stopColor: 'hsl(var(--success))' }}
                  stopOpacity="0.4"
                />
              </linearGradient>
              <linearGradient
                id="gradient-rule"
                gradientUnits="userSpaceOnUse"
                x1={width * 0.45}
                x2={width}
                y1="0"
                y2="0"
              >
                <stop offset="0%" style={{ stopColor: 'hsl(var(--success))' }} stopOpacity="0.4" />
                <stop
                  offset="100%"
                  style={{ stopColor: 'hsl(var(--warning))' }}
                  stopOpacity="0.4"
                />
              </linearGradient>
            </defs>

            {/* Links */}
            {links.map((link, i) => (
              <path
                key={`link-${i}`}
                d={link.path}
                fill={link.color}
                opacity={getLinkOpacity(i)}
                className="transition-opacity duration-300"
                onMouseEnter={() => handleMouseEnter('link', `link-${i}`)}
                // don't leave immediately to allow moving to node
              />
            ))}

            {/* Nodes */}
            {nodes.map((node) => (
              <g
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                opacity={getNodeOpacity(node.id)}
                className="transition-opacity duration-300"
                onMouseEnter={() => handleMouseEnter('node', node.id)}
                onContextMenu={(e) => handleNodeContextMenu(e, node)}
                style={node.type === 'rule' ? { cursor: 'context-menu' } : undefined}
              >
                <rect width={NODE_WIDTH} height={node.height} className={node.color} rx={1} />
                <text
                  x={node.type === 'outbound' ? NODE_WIDTH + 8 : -8}
                  y={node.height / 2}
                  dy=".32em"
                  className="text-[11px] font-medium fill-foreground select-none pointer-events-none"
                  textAnchor={node.type === 'outbound' ? 'start' : 'end'}
                >
                  {/* Truncate name based on available space? For now fixed len is safe */}
                  {node.name.length > 25 ? node.name.substring(0, 22) + '...' : node.name}
                </text>
                <text
                  x={node.type === 'outbound' ? -6 : NODE_WIDTH + 6}
                  y={node.height / 2}
                  dy=".32em"
                  className="text-[9px] text-muted-foreground fill-muted-foreground select-none pointer-events-none"
                  textAnchor={node.type === 'outbound' ? 'end' : 'start'}
                >
                  {node.value}
                </text>
                {/* Hit area for easier hover */}
                <rect
                  x={-10}
                  y={0}
                  width={NODE_WIDTH + 20}
                  height={node.height}
                  fill="transparent"
                />
              </g>
            ))}
          </svg>
        </div>
      </CardContent>
    </Card>
  );
}
