import { useState, useEffect, useMemo } from 'react';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc/api-client';
import { availableResourceTagSet, missingResourceRuleIds } from '../../shared/rule-resource-refs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Plus, ListOrdered, Check, X, Search } from 'lucide-react';
import { RuleDialog } from '@/components/rules/rule-dialog';
import { DeleteRuleDialog } from '@/components/rules/delete-rule-dialog';
import { SortableRuleRow } from '@/components/rules/sortable-rule-row';
import { RegionRoutingCard } from '@/components/rules/region-routing-card';
import type { Rule } from '@/bridge/types';
import { ruleConditions, ruleIpCidrs } from '../../shared/rules';
import {
  meshForcedRouteCidrs,
  meshForceRoutedServers,
  collectRuleTargetedServerIds,
} from '../../shared/endpoint-routes';
import { cidrOverlapsAny } from '../../shared/ip';
import { useTranslation, Trans } from 'react-i18next';
import { toast } from 'sonner';
import { RULE_TYPE_NAME } from '@/components/rules/rule-type-meta';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';

const SEARCH_THRESHOLD = 10;

export function RulesPage() {
  const { t } = useTranslation();
  const config = useAppStore((state) => state.config);
  const updateCustomRule = useAppStore((state) => state.updateCustomRule);
  const commitRuleOrder = useAppStore((state) => state.commitRuleOrder);
  const loadConfig = useAppStore((state) => state.loadConfig);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);
  const [deletingRule, setDeletingRule] = useState<Rule | null>(null);
  // 排序编辑态：null=常态；非 null=本地 draft 序（纯本地，零 store 写、零 IPC，直到「保存顺序」）
  const [orderDraft, setOrderDraft] = useState<string[] | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const [search, setSearch] = useState('');
  // 本地可用规则资源 tag 集合（fileExists 为真者）：用于就地标注「引用了缺失资源」的规则。
  const [availableResTags, setAvailableResTags] = useState<Set<string>>(() => new Set());

  const customRules = config?.customRules || [];
  const isOrderEditing = orderDraft !== null;
  const searchActive = !isOrderEditing && search.trim() !== '';

  // 外部变更（别处增删规则）防御：编辑态下 draft 与当前 id 集不一致 → 自动退出，避免影子序错位
  useEffect(() => {
    if (
      orderDraft &&
      (orderDraft.length !== customRules.length ||
        !orderDraft.every((id) => customRules.some((r) => r.id === id)))
    ) {
      setOrderDraft(null);
      toast.info(t('rules.orderConflict', '规则已在别处变更，已退出排序编辑'));
    }
  }, [customRules, orderDraft, t]);

  // 规则资源可用性：挂载即拉一次，并随 config 变化（别处删除/恢复资源会改 config）重新计算，使「资源缺失」角标即时反映。
  useEffect(() => {
    let active = true;
    api.ruleResources
      .list()
      .then((list) => {
        if (active) setAvailableResTags(availableResourceTagSet(list));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [config]);

  // 用户路由仅「智能分流」模式生效（global=一律走选中节点、direct=全直连，自定义规则均不生效）。
  const isSmartMode = (config?.proxyMode || 'smart').toLowerCase() === 'smart';

  // 引用了缺失资源（已删除/文件丢失）的规则 id 集合：运行期被 fail-closed 跳过，列内标角标提示去「规则资源」页恢复。
  // 仅 smart 模式标注——非 smart 下规则本就被模式忽略（已由顶部提示说明），再标「资源缺失·下载恢复」会误导（下载也不会让规则生效）。
  const missingResRuleIds = useMemo(
    () => (isSmartMode ? missingResourceRuleIds(customRules, availableResTags) : new Set<string>()),
    [isSmartMode, customRules, availableResTags]
  );

  const handleToggleRule = async (rule: Rule) => {
    try {
      await updateCustomRule({ ...rule, enabled: !rule.enabled });
    } catch {
      toast.error(t('common.saveFailed'));
    }
  };

  const handleEditRule = (rule: Rule) => setEditingRule(rule);
  const handleDeleteRule = (rule: Rule) => setDeletingRule(rule);

  const servers = config?.servers || [];
  const selectedServer = servers.find((s) => s.id === config?.selectedServerId);

  // 与组网(WG/Tailscale)force-route 段重叠的规则 id（仅 smart）：优先级重排后这些规则覆盖组网路由 → 列内 ⚠ 角标提醒。
  // 依赖直接挂 config?.servers/customRules（store 引用稳定）而非本地 `|| []`（每 render 新数组会令 memo 失效空转）。
  const meshOverlapRuleIds = useMemo(() => {
    // 基准与 route-builder 同 gate：仅「本轮实际发射 force-route」的节点（ON/选中/被规则指向），不含仅出网且未 engaged 节点。
    const meshCidrs = meshForcedRouteCidrs(
      meshForceRoutedServers(
        config?.servers,
        config?.selectedServerId,
        collectRuleTargetedServerIds([...(config?.customRules ?? []), ...(config?.appRules ?? [])])
      )
    );
    if (!isSmartMode || meshCidrs.length === 0) return new Set<string>();
    const ids = new Set<string>();
    for (const r of config?.customRules ?? []) {
      if (r.enabled && ruleIpCidrs(r).some((c) => cidrOverlapsAny(c, meshCidrs))) ids.add(r.id);
    }
    return ids;
  }, [
    isSmartMode,
    config?.servers,
    config?.customRules,
    config?.selectedServerId,
    config?.appRules,
  ]);

  // ── 排序编辑态 ──────────────────────────────────────────────────────────
  const enterOrderEdit = () => {
    setSearch('');
    setOrderDraft(customRules.map((r) => r.id));
  };
  const cancelOrderEdit = () => setOrderDraft(null);
  const moveDraft = (index: number, dir: -1 | 1) => {
    setOrderDraft((prev) => {
      if (!prev) return prev;
      const j = index + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  };
  // 置顶/置底：长距离移动一步到位（解 40→1 需 39 次点击）
  const moveDraftToEdge = (index: number, edge: 'top' | 'bottom') => {
    setOrderDraft((prev) => {
      if (!prev || index < 0 || index >= prev.length) return prev;
      const next = prev.slice();
      const [id] = next.splice(index, 1);
      if (edge === 'top') next.unshift(id);
      else next.push(id);
      return next;
    });
  };
  // 拖拽落点：把 active 从原位移到 over 位（@dnd-kit 自带越界自动滚动覆盖屏外目标）
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setOrderDraft((prev) => {
      if (!prev) return prev;
      const from = prev.indexOf(String(active.id));
      const to = prev.indexOf(String(over.id));
      if (from < 0 || to < 0) return prev;
      return arrayMove(prev, from, to);
    });
  };
  // PointerSensor 5px 激活距离：点击行内按钮（置顶/上下/置底）不误触发拖拽；KeyboardSensor 给无障碍
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const saveOrderEdit = async () => {
    if (!orderDraft) return;
    setSavingOrder(true);
    try {
      await commitRuleOrder(orderDraft); // 立即提交，≤1 次重启；净零序由 server 端跳过 save
      setOrderDraft(null);
    } catch {
      toast.error(t('common.saveFailed'));
      await loadConfig(); // 回滚到磁盘真值
    } finally {
      setSavingOrder(false);
    }
  };

  // ── 搜索过滤（备注/值/类型/策略，大小写不敏感；遍历全部条件，覆盖多条件规则的次级条件） ──
  const matchesSearch = (rule: Rule): boolean => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const actionName = t(`rules.${rule.action}`).toLowerCase();
    if ((rule.remarks || '').toLowerCase().includes(q) || actionName.includes(q)) return true;
    return ruleConditions(rule).some((c) => {
      const typeName = t(`rules.types.${c.type}.name`, RULE_TYPE_NAME[c.type]).toLowerCase();
      return typeName.includes(q) || c.values.some((v) => (v || '').toLowerCase().includes(q));
    });
  };

  // 渲染序：编辑态=draft 映射；搜索=过滤；否则=全量（config 为单一真值）
  const byId = new Map(customRules.map((r) => [r.id, r]));
  const rows: Rule[] = isOrderEditing
    ? orderDraft.map((id) => byId.get(id)).filter((r): r is Rule => !!r)
    : searchActive
      ? customRules.filter(matchesSearch)
      : customRules;

  // 策略=代理时展示实际出口：固定节点名 / 节点已失效 / 跟随全局
  const renderExitNode = (rule: Rule) => {
    if (rule.action !== 'proxy') return null;
    if (rule.targetServerId) {
      const srv = servers.find((s) => s.id === rule.targetServerId);
      if (!srv) {
        return (
          <Badge
            variant="outline"
            className="whitespace-nowrap border-transparent bg-destructive/15 text-xs text-destructive"
            title={t('rules.targetMissingTip', '指定节点已删除，运行时回退为跟随全局选中节点')}
          >
            {t('rules.targetMissing', '节点已失效')}
          </Badge>
        );
      }
      return (
        <span
          className="max-w-[140px] truncate whitespace-nowrap text-xs text-muted-foreground"
          title={srv.name}
        >
          → {srv.name}
        </span>
      );
    }
    return (
      <span
        className="max-w-[140px] truncate whitespace-nowrap text-xs text-muted-foreground/80"
        title={selectedServer?.name}
      >
        → {selectedServer?.name || '—'} · {t('rules.followGlobal', '跟随全局')}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">{t('rules.customRules')}</h2>
          <p className="text-muted-foreground mt-1">{t('rules.customRulesDesc')}</p>
          {!isSmartMode && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              {t(
                'rules.customRulesInactiveModeHint',
                '当前分流模式下自定义路由规则不生效，仅「智能分流」模式生效。'
              )}
            </p>
          )}
        </div>
        <Button onClick={() => setIsAddDialogOpen(true)} disabled={isOrderEditing}>
          <Plus className="me-2 h-4 w-4" />
          {t('rules.addRule')}
        </Button>
      </div>

      <RegionRoutingCard />

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle>{t('rules.ruleList')}</CardTitle>
              <CardDescription className="mt-1.5 leading-relaxed">
                {t('rules.ruleListDesc')}
              </CardDescription>
            </div>
            {/* 排序编辑工具栏（≥2 条才显示） */}
            {customRules.length >= 2 &&
              (isOrderEditing ? (
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={cancelOrderEdit}
                    disabled={savingOrder}
                  >
                    <X className="me-1 h-4 w-4" />
                    {t('common.cancel')}
                  </Button>
                  <Button size="sm" onClick={saveOrderEdit} disabled={savingOrder}>
                    <Check className="me-1 h-4 w-4" />
                    {t('rules.saveOrder', '保存顺序')}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={enterOrderEdit}
                  disabled={searchActive}
                  title={
                    searchActive
                      ? t('rules.editOrderHintSearch', '清除搜索后可编辑顺序')
                      : undefined
                  }
                >
                  <ListOrdered className="me-1 h-4 w-4" />
                  {t('rules.editOrder', '编辑顺序')}
                </Button>
              ))}
          </div>
          {/* 搜索框：>阈值 或 已有查询（删到 ≤阈值时仍显示，否则隐形过滤无法清除）；非排序编辑态 */}
          {(customRules.length > SEARCH_THRESHOLD || search.trim() !== '') && !isOrderEditing && (
            <div className="relative mt-3">
              <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('rules.searchPlaceholder', '搜索规则（备注 / 值 / 类型 / 策略）')}
                className="ps-8"
              />
            </div>
          )}
        </CardHeader>
        <CardContent>
          {customRules.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground mb-4">{t('rules.noRules')}</p>
              <Button variant="outline" onClick={() => setIsAddDialogOpen(true)}>
                <Plus className="me-2 h-4 w-4" />
                {t('rules.addFirstRule')}
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {t('rules.searchNoMatch', '无匹配规则')}
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[72px]">
                      {isOrderEditing ? '#' : t('rules.enable')}
                    </TableHead>
                    <TableHead>{t('rules.ruleColumn', '规则')}</TableHead>
                    <TableHead className="hidden w-[110px] lg:table-cell">
                      {t('rules.typeColumn', '类型')}
                    </TableHead>
                    <TableHead className="w-[120px]">{t('rules.policy')}</TableHead>
                    <TableHead className="w-[100px] text-end">{t('common.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <SortableContext
                    items={rows.map((r) => r.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {rows.map((rule, index) => (
                      <SortableRuleRow
                        key={rule.id}
                        rule={rule}
                        index={index}
                        rowsLength={rows.length}
                        isOrderEditing={isOrderEditing}
                        savingOrder={savingOrder}
                        onToggle={handleToggleRule}
                        onEdit={handleEditRule}
                        onDelete={handleDeleteRule}
                        onMove={moveDraft}
                        onMoveToEdge={moveDraftToEdge}
                        renderExitNode={renderExitNode}
                        hasMissingResource={missingResRuleIds.has(rule.id)}
                        hasMeshOverlap={meshOverlapRuleIds.has(rule.id)}
                      />
                    ))}
                  </SortableContext>
                </TableBody>
              </Table>
            </DndContext>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('rules.ruleInstructions')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 font-medium text-amber-700 dark:text-amber-400">
            {t(
              'rules.priorityFlow',
              '优先级（从高到低）：自定义规则 → 应用分流 → 组网(WG/Tailscale) → 绕过局域网 → 智能分流 → 默认出口。靠前先匹配，你的自定义规则最高。'
            )}
          </p>
          <p>{t('rules.instruction1')}</p>
          <p>{t('rules.instruction2')}</p>
          <p>{t('rules.instruction3')}</p>
          <p>{t('rules.instruction5')}</p>
          <p>
            <Trans i18nKey="rules.instruction6" components={{ strong: <strong /> }} />
          </p>
        </CardContent>
      </Card>

      {/* Add Rule Dialog */}
      <RuleDialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen} mode="add" />

      {/* Edit Rule Dialog */}
      {editingRule && (
        <RuleDialog
          open={!!editingRule}
          onOpenChange={(open: boolean) => !open && setEditingRule(null)}
          mode="edit"
          rule={editingRule}
        />
      )}

      {/* Delete Rule Dialog */}
      {deletingRule && (
        <DeleteRuleDialog
          open={!!deletingRule}
          onOpenChange={(open: boolean) => !open && setDeletingRule(null)}
          rule={deletingRule}
        />
      )}
    </div>
  );
}
