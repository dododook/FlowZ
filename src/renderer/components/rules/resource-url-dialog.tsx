import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { deriveResourceMeta } from '../../../shared/rule-resource-catalog';
import type { RuleResourceDownloadItem } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

interface ResourceUrlDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDownload: (items: RuleResourceDownloadItem[]) => void;
}

export function ResourceUrlDialog({ open, onOpenChange, onDownload }: ResourceUrlDialogProps) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  // 字段级校验错误内联展示（URL 非法就地红框 + 红字，不走 toast 通知流）。
  const [urlError, setUrlError] = useState('');

  useEffect(() => {
    if (open) {
      setUrl('');
      setName('');
      setUrlError('');
    }
  }, [open]);

  const derivedName = url.trim() ? deriveResourceMeta(url.trim()).name : '';

  const handleAdd = () => {
    const u = url.trim();
    if (!/^https:\/\/.+\.srs$/i.test(u)) {
      setUrlError(t('ruleResources.urlInvalid', '请输入以 .srs 结尾的 https 链接'));
      return;
    }
    onDownload([{ url: u, name: name.trim() || undefined }]);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 复用 radix Dialog（焦点陷阱/Esc/portal），置零内边距后套 Conduit .rsc-dialog 内部结构；
          [&>button]:hidden 隐藏自带右上角关闭钮（改用头部 .rsc-x）。 */}
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[440px] [&>button]:hidden">
        <DialogDescription className="sr-only">
          {t(
            'ruleResources.urlHint',
            '输入 .srs 规则集链接；raw.githubusercontent.com 链接会自动应用加速'
          )}
        </DialogDescription>

        <div className="rsc-dialog-h">
          <DialogTitle>{t('ruleResources.manualUrl', 'URL 下载')}</DialogTitle>
          <button
            className="rsc-x"
            aria-label={t('servers.cancel', '取消')}
            onClick={() => onOpenChange(false)}
          >
            ✕
          </button>
        </div>

        <div className="rsc-dialog-b">
          <div className="rsc-form-field">
            <label className="field-lbl">
              {t('ruleResources.urlLabel', '链接')}{' '}
              <small className="rsc-req">{t('ruleResources.urlRequired', '必填')}</small>
            </label>
            <input
              className={cn('input mono', urlError && 'err')}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (urlError) setUrlError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd();
              }}
              placeholder="https://example.com/rule.srs"
              spellCheck={false}
              aria-invalid={!!urlError}
            />
            {urlError && (
              <p className="rsc-hint" style={{ color: 'hsl(var(--err))' }}>
                {urlError}
              </p>
            )}
          </div>

          <div className="rsc-form-field">
            <label className="field-lbl">{t('ruleResources.nameLabel', '名称 (可选)')}</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={derivedName || t('ruleResources.namePlaceholder', '留空自动命名')}
            />
          </div>

          <p className="rsc-hint">
            <span className="dot idle" />
            {t(
              'ruleResources.urlHint',
              '输入 .srs 规则集链接；raw.githubusercontent.com 链接会自动应用加速'
            )}
          </p>
        </div>

        <div className="rsc-dialog-f">
          <button className="btn ghost" onClick={() => onOpenChange(false)}>
            {t('servers.cancel', '取消')}
          </button>
          <button className="btn flow" onClick={handleAdd} disabled={!url.trim()}>
            {t('ruleResources.download', '下载')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
