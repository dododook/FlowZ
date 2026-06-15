/**
 * 节点表单布局系统：把「布局 / 分区 / 响应式」收敛到单一真值，表单只声明字段 + 摆位（基础/高级）。
 * 设计见 docs/design/form-layout-system.md。各协议 form 用这三件套包裹共享字段组件，不再各自写 grid/space。
 *   FieldGrid   响应式多列栅格（短字段自动并排）
 *   FieldSpan   栅格内占满整行（私钥/长 base64/textarea 等）
 *   FormSection 分区：'基础' 常显 / '高级' 可折叠默认收起（自管 state，无新依赖）
 */
import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/** 响应式多列栅格：子项为字段单元（FormItem），cols=2 时窄屏单列、sm 起两列；cols=3 时 lg 起三列。 */
export function FieldGrid({
  cols = 2,
  className,
  children,
}: {
  cols?: 1 | 2 | 3;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'grid gap-4 grid-cols-1',
        cols >= 2 && 'sm:grid-cols-2',
        cols >= 3 && 'lg:grid-cols-3',
        className
      )}
    >
      {children}
    </div>
  );
}

/** 在栅格内占满整行（默认 full）。用于私钥/长串/textarea/整宽选择器等不宜并排的字段。 */
export function FieldSpan({ full = true, children }: { full?: boolean; children: ReactNode }) {
  return <div className={full ? 'col-span-full' : undefined}>{children}</div>;
}

/**
 * 表单分区。collapsible+defaultOpen=false → '高级' 默认折叠（渐进披露）。
 * 折叠用自管 useState（复用 server-select-groups 的手风琴交互，不引新依赖）。
 */
export function FormSection({
  title,
  collapsible = false,
  defaultOpen = true,
  children,
}: {
  title: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!collapsible) {
    return (
      <section className="space-y-4">
        <h4 className="text-sm font-semibold text-muted-foreground">{title}</h4>
        {children}
      </section>
    );
  }
  return (
    <section className="space-y-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-90')}
        />
        {title}
      </button>
      {open && <div className="space-y-4">{children}</div>}
    </section>
  );
}
