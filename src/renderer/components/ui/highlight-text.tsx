import * as React from 'react';

import { cn } from '@/lib/utils';
import { splitByQuery } from './highlight-text-utils';

interface HighlightTextProps {
  /** 待渲染文本。 */
  text: string;
  /** 高亮关键词（大小写不敏感）。空/无命中时 text 原样返回。 */
  query: string;
  /** 透传给 <mark> 的额外类名（覆盖/补充默认品牌淡底样式）。 */
  className?: string;
}

/**
 * 把 text 中所有命中 query 的子串（大小写不敏感）包进 <mark> 高亮，其余文本原样。
 * 切分逻辑见 splitByQuery（query 先正则转义按字面量匹配）；空 query 或无命中时
 * 直接返回 text，不引入额外节点。样式用品牌 accent 淡底（bg-primary/15），
 * 双主题自适应，禁黄色/裸 hex。
 */
export function HighlightText({ text, query, className }: HighlightTextProps) {
  const segments = splitByQuery(text, query);

  // 无命中（单段且未命中）→ 原样返回，不包额外节点。
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
