/**
 * 数据驱动的节点名 → 国家/地区 alpha-2 检测器（单一真值，server-list-helpers 再导出）。
 *
 * 取代旧「一国一条 if 正则」的 23 分支硬编码：manifest（flag-regions.json）驱动，模块 init 时
 * 编译成「单条合并 regex」，每次调用只跑一趟 exec。两级优先：
 *   1. emoji 区域指示符通用解码（U+1F1E6..1F1FF → alpha-2），零表覆盖全 ISO——运营者显式标注置信度最高；
 *   2. token 合并 regex：最早出现位置优先（JS exec 语义），同位置按 alternation 顺序 = 全局最长优先。
 *
 * 边界规则：拉丁 token 两侧不得紧邻 [a-z]（允许数字/分隔符），故 russia 含 us / berlin 含 in /
 * montreal 含 tr / sweden 含 de / madrid 含 id 皆不误判；US01 / HK-02 仍命中。CJK/城市名足够独特按子串匹配。
 */
import regions from './flag-regions.json';
import { FLAG_BODIES } from './flag-assets.generated';

interface Region {
  code: string;
  label: string;
  zh: string[];
  en: string[];
  noAlpha2?: boolean;
  patterns?: string[];
}

const REGIONS = regions as Region[];

/** 转义 regex 元字符（空格/连字符不在其列，保留给 sep/边界处理）。 */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 多词拉丁 token 内的空格 → [\s_-]*（零或多）：hong kong ≙ hongkong ≙ hong-kong ≙ hong_kong。 */
const sep = (s: string): string => s.replace(/ /g, '[\\s_-]*');

/**
 * 归一化「命中子串 / token 文本」为稳定 Map key：小写 + 去掉全部 [\s_-]。
 * sep 允许零分隔符，故 key 必须无分隔符，才能让 "hongkong"（无空格命中）与 manifest 的 "hong kong" 对齐。
 */
const normalize = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, '');

interface Token {
  text?: string; // 文本 token（zh 子串 / en 拉丁 / 自动 alpha-2）
  raw?: string; // 特例原生 regex（逃生舱，当前仅 cn）
  code: string;
  latin: boolean;
  sortLen: number; // 参与「全局最长优先」排序的有效命中长度
}

const tokens: Token[] = [];
for (const r of REGIONS) {
  for (const t of r.zh) tokens.push({ text: t, code: r.code, latin: false, sortLen: t.length });
  for (const t of r.en) tokens.push({ text: t, code: r.code, latin: true, sortLen: t.length });
  if (!r.noAlpha2) {
    tokens.push({ text: r.code, code: r.code, latin: true, sortLen: r.code.length });
  }
  for (const p of r.patterns ?? []) {
    // 原生 pattern 的消耗文本长度未知；以 code 长度近似（cn 消耗 "cn"，长度一致）。
    tokens.push({ raw: p, code: r.code, latin: true, sortLen: r.code.length });
  }
}

// 全局最长优先：长 token 排在合并 regex 前面，同起点时优先命中（印度尼西亚→id 而非 印度→in）。
const sorted = [...tokens].sort((a, b) => b.sortLen - a.sortLen);
const alt = sorted
  .map((t) =>
    t.raw
      ? t.raw
      : t.latin
        ? `(?<![a-z])${sep(esc(t.text as string))}(?![a-z])`
        : esc(t.text as string)
  )
  .join('|');
const MATCHER = new RegExp(alt);

// 命中文本（归一化后）→ code。原生 pattern 以 code 归一化建 key（cn pattern 消耗 "cn"）。
const TOKEN2CODE = new Map<string, string>();
for (const t of tokens) {
  TOKEN2CODE.set(normalize(t.raw ? t.code : (t.text as string)), t.code);
}

/**
 * 节点名 → 国家/地区 alpha-2（覆盖 flag-regions.json 的 74 区域）；识别不到 → null。
 * 仅在 emoji 解码结果 / token 命中落在 FLAG_BODIES 内时返回，保证与已生成旗面严格一致。
 */
export const getCountryCode = (name: string): string | null => {
  const lower = name.toLowerCase();

  // 优先级 1：emoji 国旗通用解码（两枚区域指示符 → alpha-2 字母对，算术还原，零表覆盖全 ISO）。
  const flag = lower.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u);
  if (flag) {
    const a = (flag[0].codePointAt(0) as number) - 0x1f1e6 + 0x61;
    const b = (flag[0].codePointAt(2) as number) - 0x1f1e6 + 0x61;
    const code = String.fromCharCode(a, b);
    if (FLAG_BODIES[code] !== undefined) return code;
  }

  // 优先级 2：合并 token regex（最早位置 + 同位置最长优先）。
  const hit = MATCHER.exec(lower);
  return hit ? (TOKEN2CODE.get(normalize(hit[0])) ?? null) : null;
};
