/**
 * 节点表单布局系统（Conduit `.nd-*` 版）：把「布局 / 分区 / 响应式」收敛到单一真值，表单只声明字段 + 摆位。
 * 各协议 form 用这三件套包裹共享字段组件，不再各自写 grid/space。移植自 Conduit 原型 `.nd-grid2`/`.nd-fset`/`.nd-adv`。
 *   FieldGrid   响应式栅格（cols=2 → `.nd-grid2` 两列；cols=3 → 三列；cols=1 → 单列堆叠）
 *   FieldSpan   栅格内占满整行（私钥/长 base64/textarea 等）
 *   FormSection 分区：非折叠 → `.nd-fset` 具名分组；折叠（高级）→ 原生 `<details class="nd-adv">` 渐进披露
 */
import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/** 响应式栅格：cols=2 → Conduit `.nd-grid2`（窄屏单列自适应由 CSS 处理）；cols=3 → 三列；cols=1 → 单列堆叠。 */
export function FieldGrid({
  cols = 2,
  className,
  children,
}: {
  cols?: 1 | 2 | 3;
  className?: string;
  children: ReactNode;
}) {
  if (cols === 3) {
    return (
      <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3', className)}>
        {children}
      </div>
    );
  }
  if (cols === 1) {
    return <div className={cn('flex flex-col gap-[13px]', className)}>{children}</div>;
  }
  return <div className={cn('nd-grid2', className)}>{children}</div>;
}

/** 在栅格内占满整行（默认 full）。用于私钥/长串/textarea/整宽选择器等不宜并排的字段。 */
export function FieldSpan({ full = true, children }: { full?: boolean; children: ReactNode }) {
  return <div className={full ? 'col-span-full' : undefined}>{children}</div>;
}

/**
 * - 非折叠 → `.nd-fset` 具名分组（hairline 框 + 淡衬 + 大写小标题）。
 * - collapsible → 原生 `<details class="nd-adv">`（受控 open + onToggle 同步，用户可自由展开/收起）。
 */
export function FormSection({
  title,
  collapsible = false,
  defaultOpen = true,
  children,
}: {
  title: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (!collapsible) {
    return (
      <section className="nd-fset">
        <div className="nd-fset-h">{title}</div>
        {children}
      </section>
    );
  }
  return (
    <details
      className="nd-adv"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        {title}
        <ChevronRight className="nd-adv-chev" />
      </summary>
      <div className="nd-adv-body">{children}</div>
    </details>
  );
}
