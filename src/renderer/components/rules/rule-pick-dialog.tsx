/**
 * RulePickDialog —— 「把这个域名加进**哪一条**已有规则」的选择器（issue #336）。
 *
 * 皮肤复用 `process-picker-dialog` 那一套（Dialog + 搜索框 + ScrollArea 行列表，零新增布局）。
 * 与它的差别只有一处：**单击即选**而不是多选批量提交 —— 一次点击写一条规则，没有「凑够几条再提交」
 * 的语义，摆一个底部「添加 N 项」是给一个不存在的批量动作造按钮。
 *
 * 本组件**只负责选**，写入在调用方（`connection-topology`）里。判据全部在 `rule-append.ts`
 * （node 环境可直测，有门），本文件只做渲染与检索。
 *
 * # 列**全部**规则，不能追加的置灰并说明原因
 *
 * 只列「已含域名族条件」的规则是不行的：用户的规则若多是 `ruleSet` / `geosite` / `processName`，
 * 那样一条候选都没有，用户看到的是「这个功能坏了」，而不是「我的规则不合适」。现在每条规则至少一行：
 * 能追加的可点，不能的置灰并在第二行**逐条给原因与出路**（原因分类与判据在 `rule-append.ts` 的 `AppendBlock`）。
 * 置灰项同样参与检索 —— 搜得到规则名却搜不到规则，用户会以为规则不存在。
 *
 * 一条规则有多个域名族条件 ⇒ 列成多项，每项显式标出**条件类型**：往 `domainKeyword` 里追加一个
 * 完整主机名是**更窄**的匹配（子串语义），不标类型用户不知道自己拿到了什么。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Rule } from '../../../shared/types';
import { RULE_TYPE_NAME } from './rule-type-meta';
import {
  analyzeDomainCoverage,
  isShadowedTarget,
  matchAppendTargets,
  ruleAppendTargets,
  sortAppendTargets,
  type RuleAppendTarget,
} from './rule-append';

interface RulePickDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 要加进规则的主机名。 */
  domain: string;
  /** 候选规则（= 当前 config.customRules，顺序即优先级）。 */
  rules: readonly Rule[];
  onPick: (target: RuleAppendTarget) => void;
}

export function RulePickDialog({ open, onOpenChange, domain, rules, onPick }: RulePickDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const typeName = (type: RuleAppendTarget['type']) =>
    t(`rules.types.${type}.name`, RULE_TYPE_NAME[type]);

  const targets = useMemo(
    () => sortAppendTargets(ruleAppendTargets(rules, domain)),
    [rules, domain]
  );
  const coverage = useMemo(() => analyzeDomainCoverage(rules, domain), [rules, domain]);
  const shown = useMemo(() => matchAppendTargets(targets, query), [targets, query]);

  const pick = (target: RuleAppendTarget) => {
    if (target.block !== null) return;
    onPick(target);
    onOpenChange(false);
  };

  /** 置灰行第二行的原因文案 —— 每条都带出路，不用笼统的「不可追加」。 */
  const whyText = (target: RuleAppendTarget): string | null => {
    switch (target.block) {
      case 'andMode':
        return t('rules.pickWhyAnd');
      case 'valueUnfit':
        return t('rules.pickWhyUnfit', { domain });
      default:
        return null;
    }
  };

  return (
    // 检索词无需在开窗时清：调用方按 `pickDomain !== null` 条件挂载本组件 ⇒ 每次打开都是新实例。
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('rules.pickTitle')}</DialogTitle>
          <DialogDescription>{t('rules.pickHint', { domain })}</DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3">
          <div className="relative">
            <Search className="absolute start-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('rules.pickSearchPh')}
              aria-label={t('rules.pickSearchPh')}
              className="ps-8"
            />
          </div>

          <ScrollArea className="h-72 rounded-md border">
            {targets.length === 0 ? (
              <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
                {t('rules.pickEmpty')}
              </div>
            ) : shown.length === 0 ? (
              <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
                {t('rules.pickNoMatch')}
              </div>
            ) : (
              <div className="divide-y divide-border/60">
                {shown.map((target) => {
                  const ruleTypeName = typeName(target.ruleType);
                  /* 无备注时的行名：有目标条件的行靠第二行「类型: 值」认规则，第一行给类型名就够；
                     没有目标条件的行（新开腿 / 置灰行）第二行放的是说明或原因，规则身份必须挪到第一行来，
                     否则一屏几条无备注的 geosite 规则长得一模一样。 */
                  const identity =
                    target.condIndex < 0 && target.ruleValues.length > 0
                      ? `${ruleTypeName}: ${target.ruleValues.join(', ')}`
                      : ruleTypeName;
                  // 遮蔽提示只对**可追加**的项有意义：置灰项本来就点不下去，再挂一个「前面可能先命中」是噪音。
                  const shadowed = target.block === null && isShadowedTarget(coverage, target);
                  const why = whyText(target);
                  const disabled = target.block !== null;
                  return (
                    <button
                      key={`${target.ruleId}#${target.condIndex}`}
                      type="button"
                      disabled={disabled}
                      onClick={() => pick(target)}
                      className={`flex w-full items-center gap-3 px-3 py-2 text-start ${
                        disabled ? 'opacity-40' : 'cursor-pointer hover:bg-muted/50'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {target.remarks || identity}
                        </div>
                        <div className="break-all line-clamp-2 text-xs text-muted-foreground">
                          {why ??
                            (target.condIndex < 0
                              ? t('rules.pickNewCond', { type: typeName(target.type) })
                              : target.values.length > 0
                                ? `${typeName(target.type)}: ${target.values.join(', ')}`
                                : typeName(target.type))}
                        </div>
                      </div>
                      {target.block === 'contains' && (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {t('home.domainAlreadyInRule', { domain })}
                        </span>
                      )}
                      {!target.enabled && (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {t('rules.pickDisabledTag')}
                        </span>
                      )}
                      {/* 优先级提示：**只是提示**。判据是渲染端启发式（权威匹配在内核，且 geo/进程类条件
                          这里根本判不了），故文案说「可能」，且不据此禁用本项 —— 用户完全可以就是想把值
                          加进后面那条。 */}
                      {shadowed && (
                        <span
                          className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning"
                          title={t('rules.pickShadowTip', { domain })}
                        >
                          {t('rules.pickShadowTag')}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('servers.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
