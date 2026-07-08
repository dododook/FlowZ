import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Server, Network, Rss, ListFilter, Shield, SlidersHorizontal } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
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

/** 选择性导入导出的类别勾选对话框（Conduit `.bk-dialog` 结构；默认全选 + 全选框含半选态）。 */
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
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[420px]">
        <div className="bk-h">
          <span className="bk-ico">
            {isExport ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
                <path
                  d="M12 15V3M8 7l4-4 4 4M5 21h14"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
                <path
                  d="M12 3v12M8 11l4 4 4-4M5 21h14"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </span>
          <DialogTitle asChild>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 680 }}>
              {t(
                isExport
                  ? 'settings.advanced.backup.selectExportTitle'
                  : 'settings.advanced.backup.selectImportTitle'
              )}
            </h3>
          </DialogTitle>
        </div>

        <div className="bk-body">
          <DialogDescription asChild>
            <div className={cn('bk-note', !isExport && 'warn')}>
              {t(
                isExport
                  ? 'settings.advanced.backup.selectExportDesc'
                  : 'settings.advanced.backup.selectImportDesc'
              )}
              {/* 高危覆盖操作：恢复模式追加破坏性警示（比 desc 小字辨识度高）。 */}
              {!isExport && (
                <>
                  {' '}
                  <b>{t('settings.advanced.backup.importWarning')}</b>
                </>
              )}
            </div>
          </DialogDescription>

          <div className="bk-cats">
            {/* 全选（含半选态 indeterminate） */}
            <label className="bk-cat">
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = someChecked;
                }}
                onChange={toggleAll}
              />
              <span className="bk-cat-tx">
                <b>{t('settings.advanced.backup.selectAll')}</b>
              </span>
            </label>

            {ordered.map((c) => {
              const meta = CATEGORY_META[c];
              const Icon = meta.icon;
              return (
                <label key={c} className="bk-cat">
                  <input type="checkbox" checked={selected.has(c)} onChange={() => toggle(c)} />
                  <Icon className="h-4 w-4 shrink-0" style={{ color: 'hsl(var(--fg-faint))' }} />
                  <span className="bk-cat-tx">
                    <b>{t(meta.i18nKey)}</b>
                  </span>
                  {meta.countable && <span className="bk-cat-n mono tnum">{counts[c] ?? 0}</span>}
                </label>
              );
            })}
          </div>
        </div>

        <div className="bk-foot">
          <button
            type="button"
            className="btn ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={cn('btn', isExport ? 'flow' : 'danger')}
            disabled={selCount === 0 || busy}
            onClick={() => onConfirm(ordered.filter((c) => selected.has(c)))}
          >
            {t(
              isExport
                ? 'settings.advanced.backup.exportSelected'
                : 'settings.advanced.backup.importSelected',
              { count: selCount }
            )}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
