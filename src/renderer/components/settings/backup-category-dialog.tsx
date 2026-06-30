import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Server,
  Network,
  Rss,
  ListFilter,
  Shield,
  SlidersHorizontal,
  AlertTriangle,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { BACKUP_CATEGORIES, type BackupCategory } from '../../../shared/backup-categories';

/** 类别 → 图标 + i18n key（节点/订阅/规则复用现有 backup.* 文案，通用设置新增）。 */
export const CATEGORY_META: Record<
  BackupCategory,
  { icon: typeof Server; i18nKey: string; countable: boolean }
> = {
  manualNodes: { icon: Server, i18nKey: 'settings.advanced.backup.manualNodes', countable: true },
  meshNodes: { icon: Network, i18nKey: 'settings.advanced.backup.meshNodes', countable: true },
  subscriptions: { icon: Rss, i18nKey: 'settings.advanced.backup.subscriptions', countable: true },
  customRules: { icon: ListFilter, i18nKey: 'settings.advanced.backup.rules', countable: true },
  appRules: { icon: Shield, i18nKey: 'settings.advanced.backup.appRules', countable: true },
  generalSettings: {
    icon: SlidersHorizontal,
    i18nKey: 'settings.advanced.backup.generalSettings',
    countable: false, // 设置是整组、不计数
  },
};

interface BackupCategoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'export' | 'import';
  /** 可选类别（导出=全部 6；导入=备份实际含的类）。 */
  categories: BackupCategory[];
  counts: Partial<Record<BackupCategory, number>>;
  busy?: boolean;
  onConfirm: (selected: BackupCategory[]) => void;
}

/** 选择性导入导出的类别勾选对话框（默认全选 + 全选框含半选态）。 */
export function BackupCategoryDialog({
  open,
  onOpenChange,
  mode,
  categories,
  counts,
  busy,
  onConfirm,
}: BackupCategoryDialogProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<BackupCategory>>(new Set());

  // 打开 / 可选类别变化 → 默认全选
  useEffect(() => {
    if (open) setSelected(new Set(categories));
  }, [open, categories]);

  const ordered = BACKUP_CATEGORIES.filter((c) => categories.includes(c));
  const selCount = ordered.filter((c) => selected.has(c)).length;
  const allChecked = ordered.length > 0 && selCount === ordered.length;
  const someChecked = selCount > 0 && !allChecked;

  const toggle = (c: BackupCategory) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(ordered));

  const isExport = mode === 'export';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t(
              isExport
                ? 'settings.advanced.backup.selectExportTitle'
                : 'settings.advanced.backup.selectImportTitle'
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              isExport
                ? 'settings.advanced.backup.selectExportDesc'
                : 'settings.advanced.backup.selectImportDesc'
            )}
          </DialogDescription>
        </DialogHeader>

        {/* 高危覆盖操作：恢复模式醒目警示条（破坏性视觉，比 desc 小字辨识度高）。 */}
        {!isExport && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span className="text-xs">{t('settings.advanced.backup.importWarning')}</span>
          </div>
        )}

        <div className="space-y-0.5">
          {/* 全选 */}
          <label className="flex items-center gap-2.5 px-2 py-2 mb-1 rounded-md border-b hover:bg-muted/50 cursor-pointer">
            <Checkbox
              checked={allChecked ? true : someChecked ? 'indeterminate' : false}
              onCheckedChange={toggleAll}
            />
            <span className="text-sm font-medium">{t('settings.advanced.backup.selectAll')}</span>
          </label>

          {ordered.map((c) => {
            const meta = CATEGORY_META[c];
            const Icon = meta.icon;
            return (
              <label
                key={c}
                className="flex items-center gap-2.5 px-2 py-2 rounded-md hover:bg-muted/50 cursor-pointer"
              >
                <Checkbox checked={selected.has(c)} onCheckedChange={() => toggle(c)} />
                <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm flex-1">{t(meta.i18nKey)}</span>
                {meta.countable && (
                  <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                    {counts[c] ?? 0}
                  </Badge>
                )}
              </label>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={isExport ? 'default' : 'destructive'}
            disabled={selCount === 0 || busy}
            onClick={() => onConfirm(ordered.filter((c) => selected.has(c)))}
          >
            {t(
              isExport
                ? 'settings.advanced.backup.exportSelected'
                : 'settings.advanced.backup.importSelected',
              { count: selCount }
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
