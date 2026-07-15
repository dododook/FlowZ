import type { ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
  ArrowUpToLine,
  ArrowDownToLine,
  GripVertical,
} from 'lucide-react';
import type { Rule } from '@/bridge/types';
import { ruleConditions } from '../../../shared/rules';
import { RULE_TYPE_NAME } from './rule-type-meta';
import { ruleActionLabel } from '@/lib/rule-action-style';

interface SortableRuleRowProps {
  rule: Rule;
  index: number;
  rowsLength: number;
  isOrderEditing: boolean;
  savingOrder: boolean;
  onToggle: (rule: Rule) => void;
  onEdit: (rule: Rule) => void;
  onDelete: (rule: Rule) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onMoveToEdge: (index: number, edge: 'top' | 'bottom') => void;
  renderExitNode: (rule: Rule) => ReactNode;
  /** 该规则引用的规则资源本地缺失（已删除 / 文件丢失）→ 运行期被 fail-closed 跳过，列内标「资源缺失」角标。 */
  hasMissingResource?: boolean;
  /** 该规则 ip_cidr 与组网(WG/Tailscale)force-route 段重叠 → 优先级更高会覆盖组网路由，列内标「覆盖组网」警示角标（非阻断）。 */
  hasMeshOverlap?: boolean;
}

/** 规则 action → Conduit pill 配色 class（代理主色 / 直连中性 / 阻断危险红）。 */
function actionPillClass(action: string): string {
  const a = (action || '').toLowerCase();
  if (a === 'direct') return 'rl-direct';
  if (a === 'block' || a === 'reject' || a === 'reject-drop' || a === 'drop') return 'rl-block';
  return 'rl-proxy';
}

/** 备注名回退：无备注 → 首值摘要 → 未命名。列表主行只显示一行名称。 */
function ruleName(rule: Rule, t: TFunction): string {
  if (rule.remarks) return rule.remarks;
  const vals = ruleConditions(rule).flatMap((c) => c.values);
  return vals.slice(0, 2).join(', ') || t('rules.unnamedRule', '未命名规则');
}

/** 副行摘要：匹配值预览（有备注时展示，作为「命中什么」的速览；无备注时主行已是值，副行留空）。 */
function ruleSummary(rule: Rule): string {
  const vals = ruleConditions(rule).flatMap((c) => c.values);
  return vals.slice(0, 4).join(', ');
}

/**
 * 规则详情悬浮卡（Conduit `.rl-hovercard`，纯 CSS `:hover` 驱动）：名称(+禁用标) + 逐条件(类型 pill + 值) +
 * 分隔线 + 策略(pill + 出口节点)。多条件时头部标 AND/OR。绝对定位于行内，不占网格。
 */
function RuleHoverCard({
  rule,
  t,
  renderExitNode,
}: {
  rule: Rule;
  t: TFunction;
  renderExitNode: (rule: Rule) => ReactNode;
}) {
  const conds = ruleConditions(rule);
  const multi = conds.length > 1;
  return (
    <div className="rl-hovercard">
      <div className="rl-hc-name">
        {ruleName(rule, t)}
        {!rule.enabled && <span className="rl-hc-off">{t('rules.disabledBadge', '已禁用')}</span>}
        {multi && (
          <span className="rl-hc-off">
            {rule.combineMode === 'and'
              ? t('rules.combineAnd', '全部满足')
              : t('rules.combineOr', '满足任一')}
          </span>
        )}
      </div>
      <div className="rl-hc-conds">
        {conds.map((c, i) => (
          <div key={i} className="rl-hc-cond">
            <span className="pill rl-cond">
              {t(`rules.types.${c.type}.name`, RULE_TYPE_NAME[c.type])}
            </span>
            <span className="mono rl-hc-val">{c.values.join(', ')}</span>
          </div>
        ))}
      </div>
      <div className="rl-hc-hair" />
      <div className="rl-hc-strat">
        <span className="rl-hc-lbl">{t('rules.policyLabel', '策略')}</span>
        <span className={`pill ${actionPillClass(rule.action)}`}>
          {ruleActionLabel(rule.action, t)}
        </span>
        {rule.action === 'proxy' && <span className="rl-hc-node">{renderExitNode(rule)}</span>}
      </div>
    </div>
  );
}

/**
 * 单条规则行（可拖拽排序）。常态渲染 Conduit `.rl-tr` 网格行（启用开关 / 名称+悬浮卡 / 策略 / 编辑·删除）；
 * 排序编辑态渲染 `.rl-sortrow`（拖拽手柄 + 名称 + 策略 pill + 置顶/上/下/置底）。useSortable 的 transform 施加到根元素。
 */
export function SortableRuleRow({
  rule,
  index,
  rowsLength,
  isOrderEditing,
  savingOrder,
  onToggle,
  onEdit,
  onDelete,
  onMove,
  onMoveToEdge,
  renderExitNode,
  hasMissingResource,
  hasMeshOverlap,
}: SortableRuleRowProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rule.id,
    disabled: !isOrderEditing || savingOrder,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // 拖拽中：抬升 + 半透明，让落点更清晰
    opacity: isDragging ? 0.6 : undefined,
    position: isDragging ? ('relative' as const) : undefined,
    zIndex: isDragging ? 1 : undefined,
  };

  if (isOrderEditing) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className={`rl-sortrow${isDragging ? ' drag' : ''}`}
        data-dragging={isDragging || undefined}
      >
        <span
          className="rl-handle"
          aria-label={t('rules.dragToReorder', '拖拽排序')}
          {...attributes}
          {...listeners}
        >
          <GripVertical />
        </span>
        <span className="rl-sortname">{ruleName(rule, t)}</span>
        <span className={`pill ${actionPillClass(rule.action)}`}>
          {ruleActionLabel(rule.action, t)}
        </span>
        <div className="rl-move">
          <button
            type="button"
            title={t('rules.moveTop', '置顶')}
            disabled={savingOrder || index === 0}
            onClick={() => onMoveToEdge(index, 'top')}
          >
            <ArrowUpToLine />
          </button>
          <button
            type="button"
            title={t('rules.moveUp', '上移')}
            disabled={savingOrder || index === 0}
            onClick={() => onMove(index, -1)}
          >
            <ArrowUp />
          </button>
          <button
            type="button"
            title={t('rules.moveDown', '下移')}
            disabled={savingOrder || index === rowsLength - 1}
            onClick={() => onMove(index, 1)}
          >
            <ArrowDown />
          </button>
          <button
            type="button"
            title={t('rules.moveBottom', '置底')}
            disabled={savingOrder || index === rowsLength - 1}
            onClick={() => onMoveToEdge(index, 'bottom')}
          >
            <ArrowDownToLine />
          </button>
        </div>
      </div>
    );
  }

  const summary = rule.remarks ? ruleSummary(rule) : '';
  return (
    <div ref={setNodeRef} style={style} className={`rl-tr${rule.enabled ? '' : ' off'}`}>
      <span className="rl-en">
        <button
          type="button"
          role="switch"
          aria-checked={rule.enabled}
          aria-label={t('rules.enableRule', '启用规则')}
          className={`swt${rule.enabled ? ' on' : ''}`}
          onClick={() => onToggle(rule)}
        />
      </span>

      <div className="rl-name">
        <span className="rl-nm">{ruleName(rule, t)}</span>
        {summary && <span className="rl-sub">{summary}</span>}
      </div>

      <div className="rl-action">
        <div className="rl-act-line">
          <span className={`pill ${actionPillClass(rule.action)}`}>
            {ruleActionLabel(rule.action, t)}
          </span>
          {rule.bypassFakeIP && <span className="rl-tag">{t('rules.realDns')}</span>}
          {hasMeshOverlap && (
            <span
              className="rl-badge mesh"
              title={t(
                'rules.meshOverlapTip',
                '该规则网段与组网(WG/Tailscale)路由段重叠，优先级更高将覆盖组网路由，该段可能不走组网节点。如非有意请调整。'
              )}
            >
              {t('rules.meshOverlap', '覆盖组网')}
            </span>
          )}
          {hasMissingResource && (
            <span
              className="rl-badge warn"
              title={t(
                'rules.resourceMissingTip',
                '该规则引用的规则资源缺失（已删除或文件丢失），当前不生效；请到「规则资源」页下载恢复'
              )}
            >
              {t('rules.resourceMissing', '资源缺失')}
            </span>
          )}
        </div>
        {rule.action === 'proxy' && <div className="rl-act-node">{renderExitNode(rule)}</div>}
      </div>

      <div className="rl-ops">
        <button
          type="button"
          className="rl-ic"
          title={t('common.edit', '编辑')}
          onClick={() => onEdit(rule)}
        >
          <Pencil />
        </button>
        <button
          type="button"
          className="rl-ic rl-del"
          title={t('rules.delete', '删除')}
          onClick={() => onDelete(rule)}
        >
          <Trash2 />
        </button>
      </div>

      <RuleHoverCard rule={rule} t={t} renderExitNode={renderExitNode} />
    </div>
  );
}
