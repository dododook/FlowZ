import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Merge, Network, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { useStatsTopic } from '@/hooks/use-stats-topic';
import { toast } from 'sonner';
import type { Rule, RuleAction, ConnectionsAggregate } from '../../../shared/types';
import { getRuleActionStyle } from '@/lib/rule-action-style';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RulePickDialog } from '@/components/rules/rule-pick-dialog';
import { RULE_TYPE_NAME } from '@/components/rules/rule-type-meta';
import {
  analyzeDomainCoverage,
  appendValueToRule,
  isRuleableHost,
  NEW_COND_TYPE,
  ruleAppendTargets,
  type RuleAppendTarget,
} from '@/components/rules/rule-append';
import {
  collectLinkedIds,
  computeTopologyLayout,
  hitBox,
  matchNodeIds,
  FIXED_HEIGHT,
  NODE_WIDTH,
  type Node,
} from './topology-layout';

const EMPTY_AGGREGATE: ConnectionsAggregate = { total: 0, hosts: [], outbounds: [], at: 0 };

/** 右键菜单三动作的 i18n key（与 RuleAction 同名，集中一处避免散落硬编码）。 */
const RULE_ACTION_LABEL_KEY: Record<'proxy' | 'direct' | 'block', string> = {
  proxy: 'home.ruleProxy',
  direct: 'home.ruleDirect',
  block: 'home.ruleBlock',
};

export function ConnectionTopology() {
  const [aggregate, setAggregate] = useState<ConnectionsAggregate>(EMPTY_AGGREGATE);
  const [loading, setLoading] = useState(true);
  const [hovered, setHovered] = useState<{ type: 'node' | 'link'; id: string } | null>(null);
  const [search, setSearch] = useState('');
  const tooltipRef = useRef<HTMLDivElement>(null);
  // tooltip 实测尺寸：靠近视口边缘时翻到指针另一侧（首帧 0 → 落在指针右下，测得后即修正）
  const [tooltipSize, setTooltipSize] = useState({ w: 0, h: 0 });
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; domain: string } | null>(
    null
  );
  /** 「加入已有规则…」选择器的目标域名（null = 未打开）。 */
  const [pickDomain, setPickDomain] = useState<string | null>(null);
  const { t } = useTranslation();
  const config = useAppStore((state) => state.config);
  const saveConfig = useAppStore((state) => state.saveConfig);
  // F17：仅订阅 running 布尔（primitive），避免每 2s 轮询整体替换 connectionStatus 触发本组件空转重渲染
  const proxyRunning = useAppStore((s) => s.connectionStatus?.proxyCore?.running ?? false);

  // Responsive Container Logic：hero 随窗口宽/高自适应——实测容器尺寸喂布局（高度回退 FIXED_HEIGHT 防首帧塌陷）。
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [height, setHeight] = useState(FIXED_HEIGHT);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // 直接量 getBoundingClientRect（比 RO entry.contentRect 稳）；RO 观容器 + window resize 双兜底。
    // 修真机「拖窗放大跟涨、缩小不回缩」：单靠 RO 在某些缩小路径未回调，viewBox 卡死旧宽 → 图不随窗回缩。
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0) setWidth(r.width);
      if (r.height > 0) setHeight(r.height);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // §3.7：拓扑订阅 'aggregate' topic——挂载即拿初始帧（= 原 CONNECTIONS_AGGREGATE_GET 回填），之后增量 push 同一通道；
  // 隐藏/卸载自动退订。非首页可见视图下本组件不挂载 → 无 aggregate 订阅者 → main 停上游 Connections 流（逐级停机）。
  // 载荷仍是小聚合（~Top-N host + 出口数），渲染端不直连 :9090、不持 secret。
  useStatsTopic<ConnectionsAggregate>(
    'aggregate',
    useCallback((agg: ConnectionsAggregate) => {
      setAggregate(agg);
      setLoading(false);
    }, [])
  );

  const { nodes, links } = useMemo(
    () => computeTopologyLayout(aggregate, width, t, height),
    [aggregate, width, height, t]
  );

  // 检索命中集：载荷恒为小聚合（≤Top-N host + 出口，issue #227），每帧 O(~20) 子串匹配，无需 debounce。
  const searchMatches = useMemo(() => matchNodeIds(nodes, search), [nodes, search]);
  const searching = search.trim().length > 0;

  const highlightedIds = useMemo(() => {
    // hover 与检索共用同一套链路高亮；hover 优先（指针离开即回落检索态）。
    let focusNodes: string[] = [];
    if (hovered) {
      if (hovered.type === 'node') {
        focusNodes = [hovered.id];
      } else {
        const idx = parseInt(hovered.id.split('-')[1]);
        const hLink = links[idx];
        if (hLink) focusNodes = [hLink.source, hLink.target];
      }
    } else if (searching) {
      focusNodes = searchMatches;
    }
    return collectLinkedIds(links, focusNodes);
  }, [hovered, searching, searchMatches, links]);

  // 检索中即使零命中也算激活态（全图淡出 + 空态提示），与"未检索"的全亮区分。
  const dimming = hovered !== null || searching;

  // tooltip 尺寸随内容变（域名长短/链路条目数），每次 hover 换目标后重测。
  useEffect(() => {
    if (!hovered || !tooltipRef.current) return;
    const r = tooltipRef.current.getBoundingClientRect();
    setTooltipSize((prev) =>
      prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }
    );
  }, [hovered]);

  // fixed 定位（原 absolute 挂 overflow-hidden 容器内会被裁）+ 约束在图容器内：
  // 默认落指针右下，越界则翻到左/上侧，再 clamp 兜底——判据取容器边界而非视口，否则不裁但会溢出到卡片外。
  const tooltipPos = useMemo(() => {
    const OFFSET = 12;
    const PAD = 8;
    const b = containerRef.current?.getBoundingClientRect();
    const minX = b ? b.left + PAD : PAD;
    const maxX = (b ? b.right : window.innerWidth) - PAD;
    const minY = b ? b.top + PAD : PAD;
    const maxY = (b ? b.bottom : window.innerHeight) - PAD;

    const flipX = mousePos.x + OFFSET + tooltipSize.w > maxX;
    const flipY = mousePos.y + OFFSET + tooltipSize.h > maxY;
    const left = flipX ? mousePos.x - OFFSET - tooltipSize.w : mousePos.x + OFFSET;
    const top = flipY ? mousePos.y - OFFSET - tooltipSize.h : mousePos.y + OFFSET;

    // clamp：翻转后仍越界（容器比 tooltip 还窄/矮）时贴边，绝不超出容器
    return {
      left: Math.min(Math.max(minX, left), Math.max(minX, maxX - tooltipSize.w)),
      top: Math.min(Math.max(minY, top), Math.max(minY, maxY - tooltipSize.h)),
    };
  }, [mousePos, tooltipSize]);

  const getNodeOpacity = (nodeId: string) => {
    if (!dimming) return 1;
    return highlightedIds.has(nodeId) ? 1 : 0.1;
  };

  const getLinkOpacity = (index: number) => {
    if (!dimming) return 0.4;
    return highlightedIds.has(`link-${index}`) ? 0.8 : 0.05;
  };

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
    if (containerRef.current) {
      // 存视口坐标：tooltip 用 fixed 定位（原 absolute 挂在 overflow-hidden [contain:size] 容器内，
      // 靠下/靠右 hover 时被卡片裁掉——与右键菜单同一个病）。
      setMousePos({ x: e.clientX, y: e.clientY });
    }
  };

  const handleMouseLeave = () => {
    setHovered(null);
  };

  const handleMouseEnter = (type: 'node' | 'link', id: string) => {
    setHovered({ type, id });
  };

  const handleNodeContextMenu = (e: React.MouseEvent, node: Node) => {
    // Only allow right-click on domain (middle/rule) nodes, not source or outbound
    if (node.type !== 'rule') return;
    if (node.name === t('home.others')) return;
    // 只对「能当规则值」的名字弹菜单（中列节点名可能是 host / destIP / rule 名）。判据与
    // rule-append 共用一份，防这里放行的名字在选择器里全被判成 valueUnfit。
    if (!isRuleableHost(node.name)) return;

    e.preventDefault();
    e.stopPropagation();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    // 清 hovered：菜单打开后指针不再移动，hover 高亮会冻结在右键那一瞬（issue #303 报告者截图即此态，
    // 被误读为"渲染太淡"）。菜单期间维持全亮，关闭后由 mouseMove/mouseLeave 正常接管。
    setHovered(null);
    setContextMenu({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      domain: node.name,
    });
  };

  const customRules = useMemo(() => config?.customRules ?? [], [config]);

  /**
   * 右键那个域名今天被哪条**已启用**规则先命中（issue #336）。
   *
   * 两个用途，都只是**提示不是门**：① 有命中时把「加入已有规则…」排到「加入自定义规则」之上并显示
   * 命中的那条 —— 判据是新规则恒落列表末尾（下方 `[...customRules, newRule]`）+ 路由「先匹配先生效」，
   * 那种情况下新建的那条压根不生效；② 选择器里的「前面可能先命中」角标。
   * 判定是渲染端启发式（geo/进程类条件这里判不了，权威匹配器在内核），故绝不据此阻断新建。
   */
  const coverage = useMemo(
    () => analyzeDomainCoverage(customRules, contextMenu?.domain ?? ''),
    [customRules, contextMenu?.domain]
  );
  const coveringRule = coverage.firstId
    ? (customRules.find((r) => r.id === coverage.firstId) ?? null)
    : null;
  const coveringName = coveringRule
    ? coveringRule.remarks?.trim() ||
      t(`rules.types.${coveringRule.type}.name`, RULE_TYPE_NAME[coveringRule.type])
    : '';

  const addDomainRule = async (domain: string, action: RuleAction) => {
    if (!config) return;
    setContextMenu(null);

    // 「已存在」只认**同一个值真的已经在某条域名族条件里**（口径与选择器的 contains 档一致）。
    // 旧实现按 `parts.slice(-2)` 猜根域再比对，不看条件类型：一条 `domain: foo.com` 的精确规则
    // 会把 `cdn.foo.com` 的新建挡掉，而它其实并不覆盖后者 —— 那是把一个错的启发式当成了闸门。
    // 真正的「新建可能不生效」由菜单排序 + 选择器角标如实提示，不阻断。
    // 直接复用选择器那套判据（而不是在这里重列一份域名类型表）：两处对「已存在」的口径结构上不可能漂。
    const dup = ruleAppendTargets(customRules, domain).some((tg) => tg.block === 'contains');
    if (dup) {
      toast.info(t('home.domainAlreadyInRule', { domain }));
      return;
    }

    const newRule: Rule = {
      id: `topology-${Date.now()}`,
      // 与「加入已有规则」的新开条件腿同一个常量：同一个菜单不该产出两种规则类型。
      type: NEW_COND_TYPE,
      values: [domain],
      action,
      enabled: true,
    };

    try {
      await saveConfig({
        ...config,
        customRules: [...customRules, newRule],
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

  /** 追加到已有规则（issue #336）—— 整条 Rule 原地替换，写入变换在 `appendValueToRule`。 */
  const appendToRule = async (domain: string, target: RuleAppendTarget) => {
    if (!config) return;
    const base = customRules.find((r) => r.id === target.ruleId) ?? null;
    const next = base ? appendValueToRule(base, target, domain) : null;
    if (!next) {
      // `null` 有两种由来：**已包含**（成功的无事可做）与**目标漂移**（选中后规则被别处改了）。
      // 前者不该报错吓人，后者不该假装成功。
      if (target.block === 'contains') toast.info(t('home.domainAlreadyInRule', { domain }));
      else toast.error(t('rules.appendFail'));
      return;
    }
    const label =
      next.remarks?.trim() || t(`rules.types.${next.type}.name`, RULE_TYPE_NAME[next.type]);
    try {
      await saveConfig({
        ...config,
        customRules: customRules.map((r) => (r.id === next.id ? next : r)),
      });
      toast.success(t('rules.appendDone', { domain, rule: label }));
    } catch {
      toast.error(t('rules.appendFail'));
    }
  };

  return (
    <div className="card topo-card">
      <div className="field-lbl topo-head" style={{ marginBottom: 8 }}>
        <span>
          {t('home.connectionTopology')} <small>{t('home.topologyHint')}</small>
        </span>
        <label className="rl-search-box topo-search">
          <Search size={15} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('home.searchTopology')}
            aria-label={t('home.searchTopology')}
          />
        </label>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          ref={containerRef}
          // hero flex-1 填满 topo-card（conduit .topo-card{flex:1} flex-col）；下限 300px 防挤扁。
          // 用 flex-1 而非 h-full：h-full(height:100%) 在 flex 父级下不稳解析、会塌成内容高（同 logs 修复根因）。
          // [contain:size]：内容不参与自身尺寸——否则 svg viewBox 纵横比把上次高度变成内容地板，intrinsic 经
          // flex-basis:0 链传进 .container(min-h-full auto 高)，缩窗时 RO 永远量不到更小值（高度棘轮）。
          className="relative min-h-[300px] w-full min-w-0 flex-1 cursor-default overflow-hidden [contain:size]"
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

          {/* 检索零命中：全图已淡出，须说明缘由——「其他」组的成员名在 main 侧聚合时即丢弃，检索不可达 */}
          {nodes.length > 0 && searching && searchMatches.length === 0 && (
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
              <span className="rounded-md bg-surface-2/90 px-3 py-1.5 text-xs text-muted-foreground">
                {t('home.searchTopologyNoMatch')}
              </span>
            </div>
          )}

          {hovered && !contextMenu && (
            <div ref={tooltipRef} className="pointer-events-none fixed z-50" style={tooltipPos}>
              {getTooltipContent()}
            </div>
          )}

          {/* 右键菜单（issue #303）：radix 受控 open + 0 尺寸虚拟锚点。
              Content 走 Portal 挂 body → 逃出本容器的 overflow-hidden [contain:size]（原自绘 absolute 菜单被卡片裁切）；
              avoidCollisions 默认开 → 靠近卡片/窗口下缘时自动向上翻转（原自绘定位零边界感知）。
              ESC / 点击外部关闭 / 键盘导航由 radix 提供，无需自绘 overlay。 */}
          <DropdownMenu
            open={contextMenu !== null}
            onOpenChange={(open) => {
              if (!open) setContextMenu(null);
            }}
          >
            <DropdownMenuTrigger asChild>
              <span
                aria-hidden
                className="absolute h-0 w-0"
                style={{ left: contextMenu?.x ?? 0, top: contextMenu?.y ?? 0 }}
              />
            </DropdownMenuTrigger>
            {contextMenu && (
              <DropdownMenuContent align="start" collisionPadding={8} className="min-w-[200px] p-0">
                <div className="border-b border-border px-3 py-2">
                  <p className="max-w-[180px] truncate font-medium" title={contextMenu.domain}>
                    {contextMenu.domain}
                  </p>
                  <p className="text-xs text-muted-foreground">{t('home.addToRule')}</p>
                </div>
                {/* 直写三动作（新建规则，落列表末尾）与「加入已有规则…」的**先后按事实自适应**：
                    已被某条启用规则先命中时，新建的那条不生效 ⇒ 默认动作不该指向一条无效路径。
                    只改排序、不禁用任何一项（判据是启发式，见 coverage 头注）。 */}
                {coveringRule && (
                  <div className="border-b border-border py-1">
                    <DropdownMenuItem
                      className="gap-2 px-3 py-2"
                      onSelect={() => {
                        setPickDomain(contextMenu.domain);
                        setContextMenu(null);
                      }}
                    >
                      <Merge className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{t('home.addToExistingRule')}</span>
                      <span className="ms-auto max-w-[80px] truncate text-xs text-muted-foreground">
                        {coveringName}
                      </span>
                    </DropdownMenuItem>
                  </div>
                )}
                <div className="py-1">
                  {(['proxy', 'direct', 'block'] as const).map((action) => (
                    <DropdownMenuItem
                      key={action}
                      className={`gap-2 px-3 py-2 ${action === 'block' ? getRuleActionStyle('block').text : ''}`}
                      onSelect={() => addDomainRule(contextMenu.domain, action)}
                    >
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${getRuleActionStyle(action).dot}`}
                      />
                      {t(RULE_ACTION_LABEL_KEY[action])}
                    </DropdownMenuItem>
                  ))}
                </div>
                {!coveringRule && (
                  <div className="border-t border-border py-1">
                    <DropdownMenuItem
                      className="gap-2 px-3 py-2"
                      onSelect={() => {
                        setPickDomain(contextMenu.domain);
                        setContextMenu(null);
                      }}
                    >
                      <Merge className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{t('home.addToExistingRule')}</span>
                    </DropdownMenuItem>
                  </div>
                )}
              </DropdownMenuContent>
            )}
          </DropdownMenu>

          {/* 「加入已有规则…」选择器（issue #336）。Dialog 自带 Portal 挂 body，故挂在本容器内不受
              overflow-hidden [contain:size] 影响；与右键菜单互斥（选完/取消即回 null）。 */}
          {pickDomain !== null && (
            <RulePickDialog
              open
              onOpenChange={(next) => {
                if (!next) setPickDomain(null);
              }}
              domain={pickDomain}
              rules={customRules}
              onPick={(target) => void appendToRule(pickDomain, target)}
            />
          )}

          <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${width} ${height}`}
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
                {/* 命中区：连接数一多，条本身只剩几 px 高（scale 反比缩水），6×9px 的靶子右键根本戳不中。
                    故命中区独立于条的视觉尺寸：纵向至少 HIT_MIN_HEIGHT 且不超过条+间距（绝不与相邻节点重叠），
                    横向覆盖到标签文字（文字本身 pointer-events:none，否则点域名会穿透）。 */}
                <rect
                  x={hitBox(node).x}
                  y={hitBox(node).y}
                  width={hitBox(node).width}
                  height={hitBox(node).height}
                  fill="transparent"
                />
              </g>
            ))}
          </svg>
        </div>
      </div>
    </div>
  );
}
