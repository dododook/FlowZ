import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { parseLines } from '../../../shared/parse-lines';

interface ExceptionListProps {
  /** 当前清单：undefined=用 defaults（未编辑） */
  value?: string[];
  /** 默认 seed / 恢复默认源 */
  defaults: readonly string[];
  /** 提交回调（onBlur / 恢复默认） */
  onChange?: (values: string[]) => void;
  placeholder?: string;
  /** 一句辅助说明 */
  hint?: string;
  /** hint 配色：muted=次要灰（默认）；warning=琥珀提醒（与网关提示一致，强调优先级语义） */
  hintTone?: 'muted' | 'warning';
}

/**
 * 设置项「例外清单」统一展开式编辑器（Conduit `.excl`）：textarea 每行一条、onBlur 提交、恢复默认。
 * FakeIP 例外域名 / 绕过局域网 / TUN 连入排除 / 邻居后缀 / MAC 过滤共用。
 */
export function ExceptionList({
  value,
  defaults,
  onChange,
  placeholder,
  hint,
  hintTone = 'muted',
}: ExceptionListProps) {
  const { t } = useTranslation();
  const [text, setText] = useState((value ?? defaults).join('\n'));
  // defaults 为模块常量（引用稳定）；value 变化时同步 textarea。
  useEffect(() => setText((value ?? defaults).join('\n')), [value, defaults]);

  const isModified = value !== undefined;
  return (
    <div className="excl">
      <textarea
        className="ta"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange?.(parseLines(text))}
        rows={4}
        spellCheck={false}
        placeholder={placeholder}
      />
      <div className="excl-foot">
        {hint ? (
          <span className={cn('ng-hint min-w-0', hintTone === 'warning' && 'ng-warn')}>{hint}</span>
        ) : (
          <span />
        )}
        <button
          type="button"
          className="btn ghost sm shrink-0 whitespace-nowrap"
          disabled={!isModified}
          style={!isModified ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
          onClick={() => onChange?.([...defaults])}
        >
          {t('common.restoreDefault', '恢复默认')}
        </button>
      </div>
    </div>
  );
}
