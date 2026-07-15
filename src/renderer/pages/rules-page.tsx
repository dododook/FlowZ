import { useState, useEffect, useMemo } from 'react';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc/api-client';
import { availableResourceTagSet, missingResourceRuleIds } from '../../shared/rule-resource-refs';
import { Plus, ListOrdered, Search } from 'lucide-react';
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
          <span
            className="rl-badge warn"
            title={t('rules.targetMissingTip', '指定节点已删除，运行时回退为跟随全局选中节点')}
          >
            {t('rules.targetMissing', '节点已失效')}
          </span>
        );
      }
      return <>→ {srv.name}</>;
    }
    return (
      <>
        → {selectedServer?.name || '—'} · {t('rules.followGlobal', '跟随全局')}
      </>
    );
  };

  // 底部「分流优先级」链：步骤 label 复用既有 key（自定义规则/应用分流/组网），其余用带默认值的新 key（待翻译补全）。
  const chainSteps: { label: string; on?: boolean }[] = [
    { label: t('rules.customRules'), on: true },
    { label: t('rules.appRulesTitle') },
    { label: t('servers.meshNodes', '组网') },
    { label: t('rules.chainStepBypassLan', '绕过局域网') },
    { label: t('rules.chainStepSmart', '智能分流') },
    { label: t('rules.chainStepDefault', '默认出口') },
  ];

  const showSearchBox =
    (customRules.length > SEARCH_THRESHOLD || search.trim() !== '') && !isOrderEditing;

  return (
    <section className="flex flex-col gap-4" data-page="rules">
      <div className="page-h">
        <h1>{t('sidebar.rules')}</h1>
        <span className="sub">{t('rules.customRulesDesc')}</span>
        <button
          type="button"
          className="btn flow sm rl-add"
          onClick={() => setIsAddDialogOpen(true)}
          disabled={isOrderEditing}
        >
          <Plus size={15} />
          {t('rules.addRule')}
        </button>
      </div>

      <p className="rl-lead">{t('rules.ruleListDesc')}</p>

      {!isSmartMode && (
        <div className="rl-notice">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
            <path d="M12 3l9 16H3z" strokeLinejoin="round" />
            <path d="M12 10v4M12 16.5h.01" strokeLinecap="round" />
          </svg>
          <div>{t('rules.smartOnlyHint', '当前模式下不生效，仅「智能分流」模式生效。')}</div>
        </div>
      )}

      <RegionRoutingCard />

      <div className="card rl-tablecard">
        <div className="rl-toolbar">
          <div className="field-lbl" style={{ margin: 0 }}>
            {t('rules.ruleList')}
          </div>
          <div className="rl-toolbar-r">
            {showSearchBox && (
              <label className="rl-search-box rl-search">
                <Search size={15} />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('rules.searchPlaceholder', '搜索规则（备注 / 值 / 类型 / 策略）')}
                  aria-label={t('rules.searchPlaceholder', '搜索规则（备注 / 值 / 类型 / 策略）')}
                />
              </label>
            )}
            {/* 排序编辑入口（≥2 条才显示；编辑态下由底部草稿条提供保存/取消） */}
            {customRules.length >= 2 && !isOrderEditing && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={enterOrderEdit}
                disabled={searchActive}
                title={
                  searchActive ? t('rules.editOrderHintSearch', '清除搜索后可编辑顺序') : undefined
                }
              >
                <ListOrdered size={15} />
                {t('rules.editOrder', '编辑顺序')}
              </button>
            )}
          </div>
        </div>

        {customRules.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
            <p className="text-[13px]" style={{ color: 'hsl(var(--fg-faint))' }}>
              {t('rules.noRules')}
            </p>
            <button type="button" className="btn ghost sm" onClick={() => setIsAddDialogOpen(true)}>
              <Plus size={15} />
              {t('rules.addFirstRule')}
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div
            className="px-4 py-10 text-center text-[13px]"
            style={{ color: 'hsl(var(--fg-faint))' }}
          >
            {t('rules.searchNoMatch', '无匹配规则')}
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
              {isOrderEditing ? (
                <div className="rl-sortcard">
                  {rows.map((rule, index) => (
                    <SortableRuleRow
                      key={rule.id}
                      rule={rule}
                      index={index}
                      rowsLength={rows.length}
                      isOrderEditing
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
                  <div className="rl-draftbar">
                    <span className="rl-draft-note">
                      <span className="dot warn" />
                      {t('rules.orderDraftUnsaved', '未保存的排序草稿')}
                    </span>
                    <div className="rl-draft-btns">
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={cancelOrderEdit}
                        disabled={savingOrder}
                      >
                        {t('common.cancel', '取消')}
                      </button>
                      <button
                        type="button"
                        className="btn flow sm"
                        onClick={saveOrderEdit}
                        disabled={savingOrder}
                      >
                        {t('rules.saveOrder', '保存顺序')}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rl-table">
                  <div className="rl-thead">
                    <span>{t('rules.enable')}</span>
                    <span>{t('rules.ruleColumn', '规则')}</span>
                    <span>{t('rules.policy')}</span>
                    <span className="rl-th-ops">{t('common.actions')}</span>
                  </div>
                  {rows.map((rule, index) => (
                    <SortableRuleRow
                      key={rule.id}
                      rule={rule}
                      index={index}
                      rowsLength={rows.length}
                      isOrderEditing={false}
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
                </div>
              )}
            </SortableContext>
          </DndContext>
        )}
      </div>

      <div className="card rl-chain">
        <div className="field-lbl">{t('rules.ruleInstructions')}</div>
        <div className="rl-chain-flow">
          {chainSteps.map((s, i) => (
            <span key={s.label} style={{ display: 'contents' }}>
              <span className={s.on ? 'rl-step on' : 'rl-step'}>{s.label}</span>
              {i < chainSteps.length - 1 && <span className="rl-arrow">›</span>}
            </span>
          ))}
        </div>
        <div className="cc-hair" style={{ margin: '13px 0 3px' }} />
        <div className="flex flex-col gap-1.5">
          {/* 优先级黄字说明已移除：与上方 .rl-chain-flow 视觉步骤重复（用户反馈）。 */}
          <p className="rl-lead" style={{ marginTop: 0 }}>
            {t('rules.instruction1')}
          </p>
          <p className="rl-lead" style={{ marginTop: 0 }}>
            {t('rules.instruction2')}
          </p>
          <p className="rl-lead" style={{ marginTop: 0 }}>
            {t('rules.instruction3')}
          </p>
          <p className="rl-lead" style={{ marginTop: 0 }}>
            {t('rules.instruction5')}
          </p>
          <p className="rl-lead" style={{ marginTop: 0 }}>
            <Trans i18nKey="rules.instruction6" components={{ strong: <strong /> }} />
          </p>
        </div>
      </div>

      <RuleDialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen} mode="add" />

      {editingRule && (
        <RuleDialog
          open={!!editingRule}
          onOpenChange={(open: boolean) => !open && setEditingRule(null)}
          mode="edit"
          rule={editingRule}
        />
      )}

      {deletingRule && (
        <DeleteRuleDialog
          open={!!deletingRule}
          onOpenChange={(open: boolean) => !open && setDeletingRule(null)}
          rule={deletingRule}
        />
      )}
    </section>
  );
}
