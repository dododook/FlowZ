/**
 * 行内说明 ⓘ：把常驻副文案收进悬浮卡（密度瘦身）。基于既有 hover-card（@radix-ui/react-hover-card 已在
 * deps，无新依赖），lucide Info 作触发器。供 SwitchField / 表单字段 label 旁复用。
 */
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';
import { cn } from '@/lib/utils';

export function InfoTooltip({ content, className }: { content: ReactNode; className?: string }) {
  const { t } = useTranslation();
  // 键盘可聚焦 + 具名（a11y）：radix HoverCard 对触发器 focus 同样开卡，故 ⓘ 可 tab 聚焦后弹出说明；
  // icon-only 按钮需 aria-label 供屏幕阅读器朗读（不再 tabIndex=-1/aria-hidden 把它藏掉）。
  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={t('common.moreInfo')}
          className={cn(
            'inline-flex shrink-0 items-center text-muted-foreground/70 hover:text-foreground',
            className
          )}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="text-xs leading-relaxed text-muted-foreground">
        {content}
      </HoverCardContent>
    </HoverCard>
  );
}
