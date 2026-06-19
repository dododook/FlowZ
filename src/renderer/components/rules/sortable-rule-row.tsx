import type { ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { TableCell, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import {
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
  ArrowUpToLine,
  ArrowDownToLine,
  GripVertical,
  AlertTriangle,
} from 'lucide-react';
import type { Rule } from '@/bridge/types';
import { ruleConditions } from '../../../shared/rules';
import { TYPE_TO_CATEGORY, CATEGORY_BADGE_CLASS, RULE_TYPE_NAME } from './rule-type-meta';
import { getRuleActionStyle, ruleActionLabel } from '@/lib/rule-action-style';

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

/** 规则详情悬浮卡内容：多条件头(AND/OR) + 逐条件(类型 badge + 值) + 策略。备注列与类型列共用。 */
function RuleDetailContent({
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
    <div className="space-y-2 text-sm">
      {rule.remarks && <div className="truncate font-semibold text-foreground">{rule.remarks}</div>}
      {multi && (
        <div className="text-xs font-medium text-muted-foreground">
          {t('rules.multiCondition', '多条件')} ·{' '}
          {rule.combineMode === 'and'
            ? t('rules.combineAnd', '全部满足')
            : t('rules.combineOr', '满足任一')}
        </div>
      )}
      <div className="space-y-1.5">
        {conds.map((c, i) => (
          <div key={i} className="flex items-start gap-2">
            <Badge
              variant="outline"
              className={`${CATEGORY_BADGE_CLASS[TYPE_TO_CATEGORY[c.type]]} shrink-0 whitespace-nowrap`}
            >
              {t(`rules.types.${c.type}.name`, RULE_TYPE_NAME[c.type])}
            </Badge>
            <span className="min-w-0 break-all font-mono text-xs text-foreground/90">
              {c.values.join(', ')}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t pt-2">
        <span className="text-xs text-muted-foreground">{t('rules.policyLabel', '策略')}</span>
        <Badge
          variant="default"
          className={`whitespace-nowrap border-transparent ${getRuleActionStyle(rule.action).text} ${getRuleActionStyle(rule.action).badgeBg} ${getRuleActionStyle(rule.action).badgeBgHover}`}
        >
          {ruleActionLabel(rule.action, t)}
        </Badge>
        {rule.action === 'proxy' && renderExitNode(rule)}
      </div>
    </div>
  );
}

/**
 * 单条规则行（可拖拽排序）。编辑态：首列为拖拽手柄 + 序号，操作列为 置顶/上/下/置底；
 * 常态：首列为启用开关，操作列为 编辑/删除。useSortable 的 transform 施加到 TableRow。
 * 规则列只显示备注名（悬浮看完整规则）；类型列首条件 badge + 多条件计数，悬浮看全部条件。
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

  const conds = ruleConditions(rule);
  const extraConds = conds.length - 1;

  return (
    <TableRow ref={setNodeRef} style={style} data-dragging={isDragging || undefined}>
      <TableCell>
        {isOrderEditing ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="cursor-grab touch-none text-muted-foreground active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={t('rules.dragToReorder', '拖拽排序')}
              disabled={savingOrder}
              {...attributes}
              {...listeners}
            >
              <GripVertical className="h-4 w-4" />
            </button>
            <span className="w-6 text-end text-xs tabular-nums text-muted-foreground">
              {index + 1}
            </span>
          </div>
        ) : (
          <Switch checked={rule.enabled} onCheckedChange={() => onToggle(rule)} />
        )}
      </TableCell>
      <TableCell>
        {/* 规则列：只显示备注名（悬浮展开完整规则）。遗留规则无备注 → 回退首值摘要（灰）。 */}
        <div className="flex items-center gap-1.5">
          <HoverCard openDelay={120} closeDelay={80}>
            <HoverCardTrigger asChild>
              <button type="button" className="block max-w-[360px] cursor-default text-start">
                {rule.remarks ? (
                  <span className="block truncate text-sm font-semibold text-foreground">
                    {rule.remarks}
                  </span>
                ) : (
                  <span className="block truncate font-mono text-sm text-muted-foreground">
                    {rule.values.slice(0, 2).join(', ') || t('rules.unnamedRule', '未命名规则')}
                  </span>
                )}
              </button>
            </HoverCardTrigger>
            <HoverCardContent>
              <RuleDetailContent rule={rule} t={t} renderExitNode={renderExitNode} />
            </HoverCardContent>
          </HoverCard>
          {/* 资源缺失角标：引用的规则资源已删除/文件丢失 → 运行期被 fail-closed 跳过，需到「规则资源」页下载恢复。 */}
          {hasMissingResource && (
            <Badge
              variant="outline"
              className="shrink-0 gap-1 whitespace-nowrap border-transparent bg-destructive/15 text-xs text-destructive"
              title={t(
                'rules.resourceMissingTip',
                '该规则引用的规则资源缺失（已删除或文件丢失），当前不生效；请到「规则资源」页下载恢复'
              )}
            >
              <AlertTriangle className="h-3 w-3" />
              {t('rules.resourceMissing', '资源缺失')}
            </Badge>
          )}
          {/* 覆盖组网角标：本规则 ip_cidr 与组网(WG/Tailscale)路由段重叠，优先级更高会覆盖组网路由（非阻断，按需调整）。 */}
          {hasMeshOverlap && (
            <Badge
              variant="outline"
              className="shrink-0 gap-1 whitespace-nowrap border-transparent bg-amber-500/15 text-xs text-amber-600 dark:text-amber-400"
              title={t(
                'rules.meshOverlapTip',
                '该规则网段与组网(WG/Tailscale)路由段重叠，优先级更高将覆盖组网路由，该段可能不走组网节点。如非有意请调整。'
              )}
            >
              <AlertTriangle className="h-3 w-3" />
              {t('rules.meshOverlap', '覆盖组网')}
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        {/* 类型列：首条件 badge + 多条件计数；悬浮看全部条件类型与值（与备注列共用卡片）。 */}
        <HoverCard openDelay={120} closeDelay={80}>
          <HoverCardTrigger asChild>
            <button type="button" className="flex cursor-default items-center gap-1">
              <Badge
                variant="outline"
                className={`${CATEGORY_BADGE_CLASS[TYPE_TO_CATEGORY[rule.type]]} whitespace-nowrap`}
              >
                {t(`rules.types.${rule.type}.name`, RULE_TYPE_NAME[rule.type])}
              </Badge>
              {extraConds > 0 && (
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  +{extraConds}
                </span>
              )}
            </button>
          </HoverCardTrigger>
          <HoverCardContent>
            <RuleDetailContent rule={rule} t={t} renderExitNode={renderExitNode} />
          </HoverCardContent>
        </HoverCard>
      </TableCell>
      <TableCell>
        {/* 两行：action badge 在上、出口节点/realDns 第二行——避免窄窗竖压 */}
        <div className="flex flex-col items-start gap-1">
          <Badge
            variant="default"
            className={`whitespace-nowrap border-transparent ${getRuleActionStyle(rule.action).text} ${getRuleActionStyle(rule.action).badgeBg} ${getRuleActionStyle(rule.action).badgeBgHover}`}
          >
            {ruleActionLabel(rule.action, t)}
          </Badge>
          {(rule.action === 'proxy' || rule.bypassFakeIP) && (
            <div className="flex min-w-0 items-center gap-1.5">
              {renderExitNode(rule)}
              {rule.bypassFakeIP && (
                <Badge
                  variant="outline"
                  className="whitespace-nowrap text-xs text-muted-foreground"
                >
                  {t('rules.realDns')}
                </Badge>
              )}
            </div>
          )}
        </div>
      </TableCell>
      <TableCell className="text-end">
        <div className="flex justify-end gap-0.5">
          {isOrderEditing ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={savingOrder || index === 0}
                onClick={() => onMoveToEdge(index, 'top')}
                title={t('rules.moveTop', '置顶')}
              >
                <ArrowUpToLine className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={savingOrder || index === 0}
                onClick={() => onMove(index, -1)}
                title={t('rules.moveUp', '上移')}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={savingOrder || index === rowsLength - 1}
                onClick={() => onMove(index, 1)}
                title={t('rules.moveDown', '下移')}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={savingOrder || index === rowsLength - 1}
                onClick={() => onMoveToEdge(index, 'bottom')}
                title={t('rules.moveBottom', '置底')}
              >
                <ArrowDownToLine className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => onEdit(rule)}>
                <Pencil className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onDelete(rule)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
