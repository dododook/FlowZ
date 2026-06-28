import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SettingsRow } from '@/components/settings/settings-row';
import { Loader2, ListPlus, Plus, X } from 'lucide-react';
import { ServerSelectGroups } from '@/components/settings/server-select-groups';
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
  BYPASS_FAKEIP_TYPES,
} from './rule-type-meta';
import { ProcessPickerDialog } from './process-picker-dialog';
import { ResourcePicker } from './resource-picker';

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
  const [targetServerId, setTargetServerId] = useState('default');
  const [remarks, setRemarks] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // 进程选择器/聚焦态按「类型」定位（多块共存）：pickerType 标记哪个块的选择器打开，focusedType 标记哪个块输入中。
  const [pickerType, setPickerType] = useState<RuleType | null>(null);
  const [focusedType, setFocusedType] = useState<RuleType | null>(null);

  useEffect(() => {
    if (!open) return;
    setFocusedType(null);
    setPickerType(null);
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
      setTargetServerId(rule.targetServerId || 'default');
      setRemarks(rule.remarks || '');
    } else {
      setConditionTypes([DEFAULT_TYPE]);
      setValuesByType({});
      setCombineMode('or');
      setAction('proxy');
      setEnabled(true);
      setBypassFakeIP(false);
      setTargetServerId('default');
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
  const bypassApplicable = conditionTypes.some((ct) => BYPASS_FAKEIP_TYPES.includes(ct));

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

  // 函数式更新：从 prev 桶读最新值再回写，避免 render 捕获值的陈旧读。
  const handleProcessPicked = (ct: RuleType, picked: string[]) => {
    setValuesByType((prev) => {
      const lines = parseLines(prev[ct] ?? '');
      const existing = new Set(lines);
      const merged = [...lines];
      for (const p of picked) {
        if (!existing.has(p)) {
          merged.push(p);
          existing.add(p);
        }
      }
      return { ...prev, [ct]: merged.join('\n') };
    });
  };

  // 点击常用标签：已存在则移除该行，否则追加
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
    // 收集每个条件块（按 conditionTypes 顺序）的非空值
    const conds: RuleCondition[] = [];
    for (const ct of conditionTypes) {
      const values = parseLines(valuesOf(ct));
      if (values.length === 0) {
        toast.error(
          t('rules.errorEmptyCondition', { type: t(`rules.types.${ct}.name`, RULE_TYPE_NAME[ct]) })
        );
        return;
      }
      const invalid = values.filter((v) => !validateRuleValue(ct, v));
      if (invalid.length > 0) {
        toast.error(t('rules.invalidValue'), {
          description: `${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? ' …' : ''}`,
        });
        return;
      }
      conds.push({ type: ct, values });
    }
    if (conds.length === 0) {
      toast.error(t('rules.errorEmpty'));
      return;
    }
    // 备注名强制必填（列表只显示备注名，空备注会让规则不可辨识）
    if (!remarks.trim()) {
      toast.error(t('rules.errorRemarksRequired', '请填写备注名'));
      return;
    }

    const tid = targetServerId === 'default' ? undefined : targetServerId;
    // L2：持久化对齐 UI 的 checked（globalFakeIpEnabled && bypassFakeIP）——全局 FakeIP 关时该字段天然 no-op，
    // 避免 UI 显 unchecked 却写入无效的 bypassFakeIP:true（数据卫生）。
    const bypass = bypassApplicable ? globalFakeIpEnabled && bypassFakeIP : undefined;
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

  // 单个条件块的「匹配值」编辑器（ruleSet→资源选择器；其余→Textarea + 常用标签 / 进程选择器）。
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
        <Textarea
          value={text}
          onChange={(e) => setValuesOf(ct, e.target.value)}
          onFocus={() => setFocusedType(ct)}
          onBlur={() => setFocusedType((prev) => (prev === ct ? null : prev))}
          placeholder={t(`rules.types.${ct}.placeholder`, RULE_TYPE_PLACEHOLDER[ct])}
          className={`${SHORT_VALUE_TYPES.includes(ct) ? 'min-h-[60px]' : 'min-h-[100px]'} font-mono text-sm ${
            invalid.length > 0 ? 'border-destructive/60 focus-visible:ring-destructive/40' : ''
          }`}
        />
        <p className="text-xs text-muted-foreground">
          {t(`rules.typeHints.${ct}`, RULE_TYPE_HINT[ct])}
          {PROCESS_TYPES.includes(ct) && ` · ${t('rules.processHint')}`}
        </p>
        {invalid.length > 0 && (
          <p className="text-xs text-destructive">
            {t('rules.invalidInline', {
              values: `${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? ' …' : ''}`,
            })}
          </p>
        )}
        {meshOverlap.length > 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {t('rules.meshOverlapHint', {
              values: `${meshOverlap.slice(0, 3).join(', ')}${meshOverlap.length > 3 ? ' …' : ''}`,
              defaultValue:
                '网段 {{values}} 与组网(WG/Tailscale)路由段重叠：本规则优先级更高、将覆盖组网路由，该段可能不走组网节点。如非有意请调整。',
            })}
          </p>
        )}
        {GEO_SUGGEST[ct] && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            <span className="text-xs text-muted-foreground">{t('rules.commonTags')}</span>
            {GEO_SUGGEST[ct]!.map((tag) => {
              const active = parsed.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleValue(ct, tag)}
                  className={`rounded-md border px-2 py-0.5 text-xs ${
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'bg-muted hover:bg-muted/70'
                  }`}
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
      <DialogContent className="sm:max-w-[560px] max-h-[95vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === 'add' ? t('rules.addRule') : t('rules.editRule')}</DialogTitle>
          <DialogDescription>{t('rules.ruleDialogDesc')}</DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-5">
          {/* 匹配条件（1..N）：每块 = 类型 Select + 值编辑器 + 删除 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">{t('rules.matchConditions')}</label>
              {multiCondition && (
                <SegmentedControl<'and' | 'or'>
                  value={combineMode}
                  onChange={setCombineMode}
                  options={[
                    { value: 'or', label: t('rules.combineOr') },
                    { value: 'and', label: t('rules.combineAnd') },
                  ]}
                />
              )}
            </div>

            {conditionTypes.map((ct, index) => (
              <div key={ct} className="rounded-lg border p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Select
                    value={ct}
                    onValueChange={(v) => changeConditionType(index, v as RuleType)}
                  >
                    <SelectTrigger className="flex-1">
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
                  {PROCESS_TYPES.includes(ct) && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 shrink-0"
                      onClick={() => setPickerType(ct)}
                    >
                      <ListPlus className="me-1 h-3.5 w-3.5" />
                      {t('rules.pickProcess')}
                    </Button>
                  )}
                  {multiCondition && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0 text-muted-foreground"
                      onClick={() => removeCondition(ct)}
                      aria-label={t('rules.removeCondition')}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(`rules.types.${ct}.desc`, RULE_TYPE_DESC[ct])}
                </p>
                {renderValueEditor(ct)}
              </div>
            ))}

            {canAddCondition && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={addCondition}
              >
                <Plus className="me-1 h-3.5 w-3.5" />
                {t('rules.addCondition')}
              </Button>
            )}
          </div>

          {/* 备注（必填：规则列表只显示备注名） */}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t('rules.remarksLabel')}
              <span className="ms-0.5 text-destructive">*</span>
            </label>
            <Input
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder={t('rules.remarksPlaceholder')}
              maxLength={100}
            />
          </div>

          {/* 策略 */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('rules.policy')}</label>
            <SegmentedControl<RuleAction>
              value={action}
              onChange={setAction}
              options={[
                { value: 'proxy', label: t('rules.policyProxy') },
                { value: 'direct', label: t('rules.policyDirect') },
                { value: 'block', label: t('rules.policyBlock') },
              ]}
            />
          </div>

          {/* 目标节点（仅代理） */}
          {action === 'proxy' && (
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('rules.targetNode')}</label>
              <Select value={targetServerId} onValueChange={setTargetServerId}>
                <SelectTrigger>
                  <SelectValue placeholder={t('rules.defaultNodeTip')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{t('rules.defaultNodeTip')}</SelectItem>
                  <ServerSelectGroups servers={servers} selectedId={targetServerId} />
                </SelectContent>
              </Select>
            </div>
          )}

          {/* 开关区 */}
          <div className="rounded-lg border divide-y divide-border/60 px-3">
            <SettingsRow label={t('rules.enableRule')} description={t('rules.enableRuleTip')}>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </SettingsRow>
            {bypassApplicable && (
              <SettingsRow
                label={t('rules.bypassFakeIp')}
                description={
                  globalFakeIpEnabled
                    ? t('rules.bypassFakeIpTip')
                    : t('rules.bypassFakeIpDisabledTip')
                }
              >
                <Switch
                  checked={globalFakeIpEnabled && bypassFakeIP}
                  disabled={!globalFakeIpEnabled}
                  onCheckedChange={setBypassFakeIP}
                />
              </SettingsRow>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t('servers.cancel')}
          </Button>
          <Button type="button" onClick={onSubmit} disabled={submitting}>
            {submitting && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {mode === 'add' ? t('rules.add') : t('rules.save')}
          </Button>
        </DialogFooter>

        <ProcessPickerDialog
          open={pickerType !== null}
          onOpenChange={(o) => !o && setPickerType(null)}
          mode={pickerType === 'processPath' ? 'path' : 'name'}
          onAdd={(picked) => {
            if (pickerType) handleProcessPicked(pickerType, picked);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
