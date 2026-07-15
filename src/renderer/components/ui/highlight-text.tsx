import * as React from 'react';

import { cn } from '@/lib/utils';
import { splitByQuery } from './highlight-text-utils';

interface HighlightTextProps {
  text: string;
  query: string;
  /** 透传给 <mark> 的额外类名（覆盖/补充默认品牌淡底样式）。 */
  className?: string;
}

/**
 * 空 query（trim 后）或无命中时直接返回 text，不引入额外节点（切分逻辑见 splitByQuery，
 * 大小写不敏感、query 先正则转义按字面量匹配）。样式固定用品牌 accent 淡底（bg-primary/15），
 * 双主题自适应，禁黄色/裸 hex。
 */
export function HighlightText({ text, query, className }: HighlightTextProps) {
  const segments = splitByQuery(text, query);

  if (segments.length === 1 && !segments[0].match) return <>{text}</>;

  return (
    <>
      {segments.map((seg, i) =>
        seg.match ? (
          <mark
            key={i}
            className={cn('rounded-sm bg-primary/15 px-0.5 text-foreground', className)}
          >
            {seg.text}
          </mark>
        ) : (
          <React.Fragment key={i}>{seg.text}</React.Fragment>
        )
      )}
    </>
  );
}
