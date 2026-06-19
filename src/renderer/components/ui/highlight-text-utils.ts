/**
 * highlight-text 的纯逻辑（与 React 无关，便于在 node/.ts jest 下单测）。
 * 把文本按 query（大小写不敏感、字面量）切分为命中/非命中片段，渲染层据此包 <mark>。
 */

/** 正则元字符转义：query 原样作字面量匹配，避免用户输入的 . * ( ) 等被当模式解释。 */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 切分后的单个片段：text=原文子串，match=是否命中关键词（命中者高亮）。 */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * 按 query（trim 后，大小写不敏感）把 text 切成交替片段。
 * 空 query 或无命中 → 单个 { text, match:false }，渲染层原样输出不引入额外节点。
 * 保留原文大小写：命中片段用 text 中的实际子串，不替换为 query。
 */
export function splitByQuery(text: string, query: string): HighlightSegment[] {
  const q = query.trim();
  if (!q) return [{ text, match: false }];

  // 捕获组 → split 结果交替为 [非命中, 命中, 非命中, 命中, ...]
  const parts = text.split(new RegExp(`(${escapeRegExp(q)})`, 'gi'));
  if (parts.length === 1) return [{ text, match: false }]; // 无命中

  const lowerQ = q.toLowerCase();
  return parts
    .filter((p) => p !== '') // split 在相邻命中处会插入空串，过滤避免空节点
    .map((p) => ({ text: p, match: p.toLowerCase() === lowerQ }));
}
