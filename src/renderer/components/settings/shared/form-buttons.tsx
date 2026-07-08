import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * 协议表单统一的「保存 / 重置」按钮区（Conduit `.btn` 版）。收口各 *-form.tsx 中逐字节相同的按钮块
 * （主色提交 `.btn flow` + isSubmitting 时 Loader2 旋转，`.btn ghost` 重置）。
 * 注：提交仍走各表单内 RHF `type="submit"`（保存 gate 不外移），故按钮留在表单底部而非 dialog foot。
 */
export function FormButtons({
  isSubmitting,
  onReset,
}: {
  isSubmitting: boolean;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-end gap-2 pt-1">
      <button type="button" className="btn ghost sm" onClick={onReset} disabled={isSubmitting}>
        {t('common.reset')}
      </button>
      <button type="submit" className="btn flow sm" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="animate-spin" size={14} />}
        {t('common.save')}
      </button>
    </div>
  );
}
