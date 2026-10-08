import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, ListPlus, Plus, X } from 'lucide-react';
import { NodePicker } from '@/components/ui/node-picker';
import { buildServerPickerModel } from '@/components/ui/server-picker-items';
import { useAppStore } from '@/store/app-store';
import type { Rule, RuleType, RuleAction, RuleCondition } from '../../../shared/types';
import {
  validateRuleValue,
  isRuleTypePlatformSupported,
  findAddableRuleType,
} from '../../../shared/rules';
import {
  meshForcedRouteCidrs,
  meshForceRoutedServers,
  collectRuleTargetedServerIds,
} from '../../../shared/endpoint-routes';
import { cidrOverlapsAny } from '../../../shared/ip';
import { parseLines } from '../../../shared/parse-lines';
import { useTranslation } from 'react-i18next';
import {
  RULE_CATEGORIES,
  CATEGORY_TYPES,
  CATEGORY_NAME,
  RULE_TYPE_NAME,
  RULE_TYPE_DESC,
  RULE_TYPE_PLACEHOLDER,
  RULE_TYPE_HINT,
  SHORT_VALUE_TYPES,
  GEO_SUGGEST,
  PROCESS_TYPES,
} from './rule-type-meta';
import { ProcessPickerDialog } from './process-picker-dialog';
import { ResourcePicker } from './resource-picker';
import {
  collectRuleFormErrors,
  hasRuleFormErrors,
  deriveTargetServerId,
  isBypassApplicable,
  deriveBypassFakeIp,
  showsTargetNode,
  FOLLOW_GLOBAL_NODE_ID,
  type RuleFormErrors,
} from './rule-dialog-logic';

interface RuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'add' | 'edit';
  rule?: Rule;
}

const DEFAULT_TYPE: RuleType = 'domain';

export function RuleDialog({ open, onOpenChange, mode, rule }: RuleDialogProps) {
  const { t } = useTranslation();
  const addCustomRule = useAppStore((state) => state.addCustomRule);
  const updateCustomRule = useAppStore((state) => state.updateCustomRule);
  const servers = useAppStore((state) => state.config?.servers || []);
  const selectedServerId = useAppStore((state) => state.config?.selectedServerId ?? null);
  const subscriptions = useAppStore((state) => state.config?.subscriptions || []);
  const latencyMap = useAppStore((state) => state.latencyMap);
  const customRules = useAppStore((state) => state.config?.customRules);
  const appRules = useAppStore((state) => state.config?.appRules);
  // 组网(WG/Tailscale)force-route 段：供 ipCidr 值「与组网重叠」内联提醒（优先级重排后自定义规则会覆盖组网路由）。
  // memo 化避免每次按键 render 都重算。基准与 route-builder 同 gate：仅「本轮实际发射 force-route」的节点
  // （ON/选中/被规则指向），不含仅出网且未 engaged 节点，避免虚报「覆盖组网」。
  const meshCidrs = useMemo(
    () =>
      meshForcedRouteCidrs(
        meshForceRoutedServers(
          servers,
          selectedServerId,
          collectRuleTargetedServerIds([...(customRules ?? []), ...(appRules ?? [])])
        )
      ),
    [servers, selectedServerId, customRules, appRules]
  );
  // 全局 FakeIP 开关（usesFakeIp 已统一为纯看此开关，缺省 true）：关时本规则的「绕过 FakeIP」天然 no-op，UI 置灰提示。
  const globalFakeIpEnabled = useAppStore((state) => state.config?.dnsConfig?.enableFakeIp ?? true);

  // 多条件模型：conditionTypes 是有序的「激活条件类型」列表（[0]=首条件，镜像到 rule.type/values）。
  // 匹配值仍按类型分桶存 valuesByType（天然多类型并行编辑、切换互不污染）；每类型至多一个条件。
  const [conditionTypes, setConditionTypes] = useState<RuleType[]>([DEFAULT_TYPE]);
  const [valuesByType, setValuesByType] = useState<Partial<Record<RuleType, string>>>({});
  const [combineMode, setCombineMode] = useState<'and' | 'or'>('or');
  const [action, setAction] = useState<RuleAction>('proxy');
  const [enabled, setEnabled] = useState(true);
  const [bypassFakeIP, setBypassFakeIP] = useState(false);
  // 悬挂 targetServerId（指向已删节点）→ NodePicker findItem 落空显 placeholder（跟随全局文案），属既有边界，保留。
  const [targetServerId, setTargetServerId] = useState(FOLLOW_GLOBAL_NODE_ID);
  const [remarks, setRemarks] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // 已尝试提交：为 true 后才计算并内联展示字段级错误（避免打开即报错，与 spec §6「提交时校验」一致）。
  const [submitAttempted, setSubmitAttempted] = useState(false);
  // 进程选择器/聚焦态按「类型」定位（多块共存）：pickerType 标记哪个块的选择器打开，focusedType 标记哪个块输入中。
  const [pickerType, setPickerType] = useState<RuleType | null>(null);
  const [focusedType, setFocusedType] = useState<RuleType | null>(null);

  useEffect(() => {
    if (!open) return;
    setFocusedType(null);
    setPickerType(null);
    setSubmitAttempted(false);
    if (mode === 'edit' && rule) {
      // 多条件优先；无 conditions 退化为单条件 [{type,values}]。去重类型（桶按类型键）、合并同类型值，保序。
      const conds: RuleCondition[] =
        rule.conditions && rule.conditions.length > 0
          ? rule.conditions
          : [{ type: rule.type, values: rule.values || [] }];
      const order: RuleType[] = [];
      const buckets: Partial<Record<RuleType, string>> = {};
      for (const c of conds) {
        const existing = buckets[c.type];
        const joined = (c.values || []).join('\n');
        if (existing === undefined) {
          order.push(c.type);
          buckets[c.type] = joined;
        } else {
          buckets[c.type] = existing ? `${existing}\n${joined}` : joined;
        }
      }
      setConditionTypes(order.length > 0 ? order : [rule.type]);
      setValuesByType(buckets);
      setCombineMode(rule.combineMode ?? 'or');
      setAction(rule.action);
      setEnabled(rule.enabled);
      setBypassFakeIP(rule.bypassFakeIP ?? false);
      setTargetServerId(rule.targetServerId || FOLLOW_GLOBAL_NODE_ID);
      setRemarks(rule.remarks || '');
    } else {
      setConditionTypes([DEFAULT_TYPE]);
      setValuesByType({});
      setCombineMode('or');
      setAction('proxy');
      setEnabled(true);
      setBypassFakeIP(false);
      setTargetServerId(FOLLOW_GLOBAL_NODE_ID);
      setRemarks('');
    }
  }, [open, mode, rule]);

  const usedTypes = new Set(conditionTypes);
  // 平台门控：device 类别（source_mac_address / source_hostname）仅 Linux/macOS 内核支持（sing-box 1.14 邻居
  // 解析，已真机 check 实证，见 shared/neighbor），Windows 选了也被 main 侧 fail-closed 丢弃。故 Windows 隐藏
  // device 类型；判定下沉 shared/rules#isRuleTypePlatformSupported（与生成层单一真值），呈现/新增时再叠加
  // 「本块已选中」豁免（edit 跨平台旧规则不丢可见性/可删性）。
  const platform = window.electron?.platform;
  const isTypePlatformSupported = (tp: RuleType) => isRuleTypePlatformSupported(tp, platform);
  // 下一个可新增类型（未用 ∧ 平台支持）：决定「添加条件」按钮显隐 + addCondition 取值，单一来源防口径漂移
  // （Windows 上 device 组用尽即无候选 → 按钮隐藏）。
  const nextAddableType = findAddableRuleType(usedTypes, platform);
  const canAddCondition = nextAddableType !== undefined;
  // bypassFakeIP 是规则级设置：只要任一条件是域名类即可用（生成期对域名类条件取真实 DNS）。
  const bypassApplicable = isBypassApplicable(conditionTypes);

  // 字段级错误：仅在尝试提交后计算（随修改实时刷新，用户改好即消），内联展示、不 toast（spec §6）。
  const formErrors: RuleFormErrors = useMemo(
    () =>
      submitAttempted
        ? collectRuleFormErrors(conditionTypes, valuesByType, remarks)
        : { conditions: {} },
    [submitAttempted, conditionTypes, valuesByType, remarks]
  );

  // 目标节点选择器（`.npick`）数据：跟随全局哨兵置顶 + 按订阅/自建分组，显延迟徽标（不随全局排序开关重排）。
  const { items: targetItems, groups: targetGroups } = useMemo(
    () =>
      buildServerPickerModel({
        servers,
        subscriptions,
        latencyMap,
        meshLabel: t('servers.meshNodes', '组网'),
        manualLabel: t('servers.manualNodes', '自建节点'),
        sentinel: { id: FOLLOW_GLOBAL_NODE_ID, name: t('rules.defaultNodeTip'), role: 'follow' },
      }),
    [servers, subscriptions, latencyMap, t]
  );

  const valuesOf = (ct: RuleType) => valuesByType[ct] ?? '';
  const setValuesOf = (ct: RuleType, text: string) =>
    setValuesByType((prev) => ({ ...prev, [ct]: text }));

  // 切换某条件块的类型：目标类型未被占用才生效（占用类型在 Select 里已 disabled，双保险）；重置聚焦态。
  const changeConditionType = (index: number, next: RuleType) => {
    setFocusedType(null);
    setConditionTypes((prev) => {
      if (prev[index] === next || prev.includes(next)) return prev;
      const copy = [...prev];
      copy[index] = next;
      return copy;
    });
  };

  const addCondition = () => {
    if (!nextAddableType) return; // 全部（当前平台支持的）类型用尽
    setFocusedType(null);
    setConditionTypes((prev) => [...prev, nextAddableType]);
  };

  const removeCondition = (ct: RuleType) => {
    setFocusedType(null);
    setConditionTypes((prev) => (prev.length > 1 ? prev.filter((x) => x !== ct) : prev));
    // 保留 valuesByType[ct] 桶（再次添加该类型可恢复，且不进入提交）
  };

  // 选择器返回完整勾选集合（含初始化时带入的未运行进程），按结果替换当前桶：既保留历史选择，
  // 也允许用户取消已保存项；去重由 Set 保证，顺序采用选择器的稳定插入顺序。
  const handleProcessPicked = (ct: RuleType, picked: string[]) => {
    setValuesByType((prev) => ({ ...prev, [ct]: Array.from(new Set(picked)).join('\n') }));
  };

  const toggleValue = (ct: RuleType, v: string) => {
    setValuesByType((prev) => {
      const lines = parseLines(prev[ct] ?? '');
      const next = lines.includes(v) ? lines.filter((x) => x !== v) : [...lines, v];
      return { ...prev, [ct]: next.join('\n') };
    });
  };

  // 单条件块的实时非法值（聚焦时排除末尾「正在输入行」；ruleSet 走 ResourcePicker 不校验）
  const invalidValuesOf = (ct: RuleType): string[] => {
    if (ct === 'ruleSet') return [];
    const text = valuesOf(ct);
    const parsed = parseLines(text);
    const checkable = focusedType === ct && !text.endsWith('\n') ? parsed.slice(0, -1) : parsed;
    return checkable.filter((v) => !validateRuleValue(ct, v));
  };

  const onSubmit = async () => {
    // 提交 gate 与内联展示共用 collectRuleFormErrors：字段级错误就地红字提示，不 toast（spec §6）。
    setSubmitAttempted(true);
    const errors = collectRuleFormErrors(conditionTypes, valuesByType, remarks);
    if (hasRuleFormErrors(errors)) return;
    // 全部条件已校验通过：按 conditionTypes 顺序收集非空值。
    const conds: RuleCondition[] = conditionTypes.map((ct) => ({
      type: ct,
      values: parseLines(valuesOf(ct)),
    }));

    const tid = deriveTargetServerId(targetServerId);
    // L2：持久化对齐 UI 的 checked——全局 FakeIP 关时该字段天然 no-op，避免写入无效 bypassFakeIP:true（数据卫生）。
    const bypass = deriveBypassFakeIp(bypassApplicable, globalFakeIpEnabled, bypassFakeIP);
    // 单条件 → 退化为 type/values（不写 conditions/combineMode，与历史规则逐字节等价）；
    // 多条件 → 首条件镜像到 type/values（回滚兼容），并写 conditions + combineMode。
    const first = conds[0];
    const multi = conds.length > 1;
    const base = {
      type: first.type,
      values: first.values,
      conditions: multi ? conds : undefined,
      combineMode: multi ? combineMode : undefined,
      action,
      enabled,
      bypassFakeIP: bypass,
      targetServerId: tid,
      remarks: remarks.trim(),
    };

    setSubmitting(true);
    try {
      if (mode === 'add') {
        const newRule: Rule = {
          id: `rule_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
          ...base,
        };
        await addCustomRule(newRule);
        toast.success(t('rules.ruleAdded'));
      } else if (rule) {
        const updated: Rule = { ...rule, ...base };
        await updateCustomRule(updated);
        toast.success(t('rules.ruleUpdated'));
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(t('rules.saveFailed'), {
        description: error instanceof Error ? error.message : t('rules.saveErrorDesc'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const renderValueEditor = (ct: RuleType) => {
    if (ct === 'ruleSet') {
      return (
        <ResourcePicker
          value={parseLines(valuesOf(ct))}
          onChange={(vals) => setValuesOf(ct, vals.join('\n'))}
          onRequestClose={() => onOpenChange(false)}
        />
      );
    }
    const text = valuesOf(ct);
    const parsed = parseLines(text);
    const invalid = invalidValuesOf(ct);
    const meshOverlap = ct === 'ipCidr' ? parsed.filter((c) => cidrOverlapsAny(c, meshCidrs)) : [];
    return (
      <>
        {PROCESS_TYPES.includes(ct) && (
          <button type="button" className="btn ghost sm" onClick={() => setPickerType(ct)}>
            <ListPlus size={14} />
            {t('rules.pickProcess')}
          </button>
        )}
        <textarea
          className="rl-ta mono"
          style={{
            minHeight: SHORT_VALUE_TYPES.includes(ct) ? 60 : undefined,
            borderColor: invalid.length > 0 ? 'hsl(var(--err))' : undefined,
          }}
          spellCheck={false}
          value={text}
          onChange={(e) => setValuesOf(ct, e.target.value)}
          onFocus={() => setFocusedType(ct)}
          onBlur={() => setFocusedType((prev) => (prev === ct ? null : prev))}
          placeholder={t(`rules.types.${ct}.placeholder`, RULE_TYPE_PLACEHOLDER[ct])}
        />
        <div className="rl-cc-hint">
          {t(`rules.typeHints.${ct}`, RULE_TYPE_HINT[ct])}
          {PROCESS_TYPES.includes(ct) && ` · ${t('rules.processHint')}`}
        </div>
        {invalid.length > 0 && (
          <div className="rl-cc-hint" style={{ color: 'hsl(var(--err))' }}>
            {t('rules.invalidInline', {
              values: `${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? ' …' : ''}`,
            })}
          </div>
        )}
        {meshOverlap.length > 0 && (
          <div className="rl-cc-hint" style={{ color: 'hsl(var(--warn))' }}>
            {t('rules.meshOverlapHint', {
              values: `${meshOverlap.slice(0, 3).join(', ')}${meshOverlap.length > 3 ? ' …' : ''}`,
              defaultValue:
                '网段 {{values}} 与组网(WG/Tailscale)路由段重叠：本规则优先级更高、将覆盖组网路由，该段可能不走组网节点。如非有意请调整。',
            })}
          </div>
        )}
        {GEO_SUGGEST[ct] && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              alignItems: 'center',
              paddingTop: 2,
            }}
          >
            <span className="rl-cc-hint">{t('rules.commonTags')}</span>
            {GEO_SUGGEST[ct]!.map((tag) => {
              const active = parsed.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  className={active ? 'rl-step on' : 'rl-step'}
                  onClick={() => toggleValue(ct, tag)}
                >
                  {tag}
                </button>
              );
            })}
          </div>
        )}
      </>
    );
  };

  const multiCondition = conditionTypes.length > 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] max-w-[480px] flex-col gap-0 overflow-hidden p-0">
        <div className="rl-dlg-h">
          <div>
            <DialogTitle className="rl-dlg-title">
              {mode === 'add' ? t('rules.addRule') : t('rules.editRule')}
            </DialogTitle>
            {/* 副标题去可见（用户反馈：与「备注名」字段重复）；保 sr-only 供 radix a11y（DialogDescription 必需）。 */}
            <DialogDescription className="sr-only">{t('rules.ruleDialogDesc')}</DialogDescription>
          </div>
        </div>

        <div className="rl-dlg-body min-h-0 flex-1 overflow-y-auto">
          <div className="rl-zone">
            <label className="field">
              <div className="field-lbl">
                {t('rules.remarksLabel')} <small style={{ color: 'hsl(var(--err))' }}>*</small>
              </div>
              <input
                className={`input${formErrors.remarksRequired ? ' err' : ''}`}
                type="text"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder={t('rules.remarksPlaceholder')}
                maxLength={100}
              />
            </label>
            {formErrors.remarksRequired && (
              <div className="rl-cc-hint" style={{ color: 'hsl(var(--err))' }}>
                {t('rules.errorRemarksRequired', '请填写备注名')}
              </div>
            )}
          </div>

          <div className="rl-zone">
            <div className="rl-zone-h">
              <div className="rl-zone-lbl">
                {t('rules.matchConditions')}
                <span className="rl-zone-cnt">
                  {t('rules.conditionCount', {
                    count: conditionTypes.length,
                    defaultValue: '{{count}} 条',
                  })}
                </span>
              </div>
              {multiCondition && (
                <div className="seg2 rl-combine">
                  <button
                    type="button"
                    className={combineMode === 'or' ? 'on' : ''}
                    onClick={() => setCombineMode('or')}
                  >
                    {t('rules.combineOr')}
                  </button>
                  <button
                    type="button"
                    className={combineMode === 'and' ? 'on' : ''}
                    onClick={() => setCombineMode('and')}
                  >
                    {t('rules.combineAnd')}
                  </button>
                </div>
              )}
            </div>

            {conditionTypes.map((ct, index) => (
              <div key={ct} className="rl-cond-card">
                <div className="rl-cc-top">
                  <Select
                    value={ct}
                    onValueChange={(v) => changeConditionType(index, v as RuleType)}
                  >
                    <SelectTrigger className="rl-select rl-cond-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RULE_CATEGORIES.map((cat) => {
                        // 平台不支持的类型隐藏，但保留「当前块已选中」的（edit 跨平台旧规则仍可见/可改/可删）。
                        const types = CATEGORY_TYPES[cat].filter(
                          (tp) => isTypePlatformSupported(tp) || tp === ct
                        );
                        if (types.length === 0) return null; // 整组不支持且未选中（如 Windows 的 device 组）→ 隐藏
                        return (
                          <SelectGroup key={cat}>
                            <SelectLabel>
                              {t(`rules.category.${cat}`, CATEGORY_NAME[cat])}
                            </SelectLabel>
                            {types.map((tp) => (
                              <SelectItem
                                key={tp}
                                value={tp}
                                disabled={usedTypes.has(tp) && tp !== ct}
                              >
                                {t(`rules.types.${tp}.name`, RULE_TYPE_NAME[tp])}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  {multiCondition && (
                    <button
                      type="button"
                      className="rl-cond-rm"
                      onClick={() => removeCondition(ct)}
                      aria-label={t('rules.removeCondition')}
                    >
                      <X size={15} />
                    </button>
                  )}
                </div>
                <div className="rl-cc-desc">{t(`rules.types.${ct}.desc`, RULE_TYPE_DESC[ct])}</div>
                <div className="rl-cc-val">
                  {renderValueEditor(ct)}
                  {/* 提交后内联错误：空条件（非法值由 renderValueEditor 内实时红字，此处只兜底 ruleSet 等无实时校验的空/非法） */}
                  {formErrors.conditions[ct] === 'empty' && (
                    <div className="rl-cc-hint" style={{ color: 'hsl(var(--err))' }}>
                      {t('rules.errorEmptyConditionInline', '请填写该条件的匹配值')}
                    </div>
                  )}
                  {formErrors.conditions[ct] === 'invalid' && ct === 'ruleSet' && (
                    <div className="rl-cc-hint" style={{ color: 'hsl(var(--err))' }}>
                      {t('rules.errorInvalidConditionInline', '该条件含无效值，请检查')}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {canAddCondition && (
              <button type="button" className="rl-cond-add rl-cond-add-full" onClick={addCondition}>
                <Plus size={15} />
                {t('rules.addCondition')}
              </button>
            )}
          </div>

          <div className="rl-zone">
            <div className="rl-zone-h">
              <div className="rl-zone-lbl">{t('rules.policy')}</div>
            </div>
            <div className="seg2 rl-strat">
              <button
                type="button"
                data-strat="proxy"
                className={action === 'proxy' ? 'on' : ''}
                onClick={() => setAction('proxy')}
              >
                {t('rules.policyProxy')}
              </button>
              <button
                type="button"
                data-strat="direct"
                className={action === 'direct' ? 'on' : ''}
                onClick={() => setAction('direct')}
              >
                {t('rules.policyDirect')}
              </button>
              <button
                type="button"
                data-strat="block"
                className={action === 'block' ? 'on' : ''}
                onClick={() => setAction('block')}
              >
                {t('rules.policyBlock')}
              </button>
            </div>

            {/* 目标节点（仅代理）：一步选下拉（`.npick`），跟随全局哨兵置顶 + 分组 + 延迟徽标。
                「是否展示目标节点」单一真值取自 showsTargetNode（与写入 gate 同源）。 */}
            {showsTargetNode(action) && (
              <div className="field rl-target">
                <div className="field-lbl">{t('rules.targetNode')}</div>
                <NodePicker
                  items={targetItems}
                  groups={targetGroups}
                  value={targetServerId}
                  onSelect={setTargetServerId}
                  placeholder={t('rules.defaultNodeTip')}
                  searchPlaceholder={t('common.search', '搜索')}
                  ariaLabel={t('rules.targetNode')}
                />
              </div>
            )}

            <div className="rl-optcard">
              <label className="rl-optrow">
                <div>
                  <div className="rl-row-t">{t('rules.enableRule')}</div>
                  <div className="rl-row-d">{t('rules.enableRuleTip')}</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={t('rules.enableRule')}
                  className={`swt${enabled ? ' on' : ''}`}
                  onClick={() => setEnabled((v) => !v)}
                />
              </label>
              {bypassApplicable && (
                <>
                  <div className="rl-optrow-hair" />
                  <label className={`rl-optrow rl-bypass${globalFakeIpEnabled ? '' : ' disabled'}`}>
                    <div>
                      <div className="rl-row-t">
                        {t('rules.bypassFakeIp')}{' '}
                        <span className="rl-tag">{t('rules.realDns')}</span>
                      </div>
                      <div className="rl-row-d">
                        {globalFakeIpEnabled
                          ? t('rules.bypassFakeIpTip')
                          : t('rules.bypassFakeIpDisabledTip')}
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={globalFakeIpEnabled && bypassFakeIP}
                      aria-label={t('rules.bypassFakeIp')}
                      disabled={!globalFakeIpEnabled}
                      className={`swt${globalFakeIpEnabled && bypassFakeIP ? ' on' : ''}`}
                      onClick={() => setBypassFakeIP((v) => !v)}
                    />
                  </label>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="rl-dlg-foot">
          <button
            type="button"
            className="btn ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t('servers.cancel')}
          </button>
          <button type="button" className="btn flow" onClick={onSubmit} disabled={submitting}>
            {submitting && <Loader2 className="animate-spin" size={15} />}
            {mode === 'add' ? t('rules.add') : t('rules.save')}
          </button>
        </div>

        <ProcessPickerDialog
          open={pickerType !== null}
          onOpenChange={(o) => !o && setPickerType(null)}
          mode={pickerType === 'processPath' ? 'path' : 'name'}
          initialSelected={pickerType ? parseLines(valuesOf(pickerType)) : []}
          onAdd={(picked) => {
            if (pickerType) handleProcessPicked(pickerType, picked);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
