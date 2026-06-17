import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SettingsCollapsibleProps {
  /** 折叠组标题（与 SettingsRow heading 同字重，作为卡内二级分组）。 */
  label: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}

/**
 * 卡内可折叠分组：默认收起低频设置项，降低单卡扫读成本（C4/H3）。
 * 置于 `divide-y` 的 CardContent 内作为一个直接子节点；展开后子行自带分隔。
 */
export function SettingsCollapsible({
  label,
  children,
  defaultOpen = false,
}: SettingsCollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 pb-1 pt-3 text-sm font-semibold"
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 text-muted-foreground transition-transform',
            open && 'rotate-90'
          )}
        />
        {label}
      </button>
      {/* border-t：使「折叠触发 → 首行」与「标题 → 首行」分隔节奏一致（UI 风格统一） */}
      {open && (
        <div className="divide-y divide-border/60 border-t border-border/60">{children}</div>
      )}
    </div>
  );
}
