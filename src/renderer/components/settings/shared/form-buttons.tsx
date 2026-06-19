import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * 协议表单统一的「保存 / 重置」按钮区。收口各 *-form.tsx 中逐字节相同的按钮块
 * （主色提交 + isSubmitting 时 Loader2 旋转，outline 重置）。
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
    <div className="flex gap-4">
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
        {t('common.save')}
      </Button>
      <Button type="button" variant="outline" onClick={onReset} disabled={isSubmitting}>
        {t('common.reset')}
      </Button>
    </div>
  );
}
