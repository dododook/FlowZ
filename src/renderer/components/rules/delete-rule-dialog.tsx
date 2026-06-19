import { useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, AlertTriangle } from 'lucide-react';
import { useAppStore } from '@/store/app-store';
import { useTranslation } from 'react-i18next';
import type { Rule } from '@/bridge/types';
import {
  TYPE_TO_CATEGORY,
  CATEGORY_BADGE_CLASS,
  RULE_TYPE_NAME,
} from '@/components/rules/rule-type-meta';

interface DeleteRuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule: Rule;
}

export function DeleteRuleDialog({ open, onOpenChange, rule }: DeleteRuleDialogProps) {
  const { t } = useTranslation();
  const deleteCustomRule = useAppStore((state) => state.deleteCustomRule);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    if (!rule.id) {
      toast.error(t('rules.deleteFailed', '删除失败'), {
        description: t('rules.invalidRuleId', '规则 ID 无效'),
      });
      return;
    }

    setIsDeleting(true);
    try {
      await deleteCustomRule(rule.id);
      toast.success(t('rules.ruleDeleted', '规则已删除'));
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to delete rule:', error);
      toast.error(t('rules.deleteFailed', '删除失败'), {
        description:
          error instanceof Error ? error.message : t('rules.deleteErrorDesc', '删除规则时发生错误'),
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const actionLabel =
    rule.action === 'proxy'
      ? t('rules.policyProxy', '代理')
      : rule.action === 'direct'
        ? t('rules.policyDirect', '直连')
        : t('rules.policyBlock', '阻断');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            {t('rules.deleteRule', '删除规则')}
          </DialogTitle>
          <DialogDescription>
            {t('rules.deleteConfirm', '此操作无法撤销。确定要删除此规则吗？')}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <div className="space-y-2 rounded-lg border p-4 bg-muted/50">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t('rules.typeColumn', '类型')}</span>
              <Badge
                variant="outline"
                className={CATEGORY_BADGE_CLASS[TYPE_TO_CATEGORY[rule.type]]}
              >
                {t(`rules.types.${rule.type}.name`, RULE_TYPE_NAME[rule.type])}
              </Badge>
            </div>
            <div className="text-sm">
              <span className="text-muted-foreground">{t('rules.valueLabel', '匹配值')}</span>
              <div className="font-mono font-medium mt-1 max-h-[120px] overflow-y-auto">
                {rule.values.map((value, index) => (
                  <div key={index}>{value}</div>
                ))}
              </div>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{t('rules.policy', '策略')}</span>
              <span className="font-medium">{actionLabel}</span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isDeleting}
          >
            {t('servers.cancel', '取消')}
          </Button>
          <Button type="button" variant="destructive" onClick={handleDelete} disabled={isDeleting}>
            {isDeleting && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t('rules.delete', '删除')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
