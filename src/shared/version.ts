/**
 * sing-box 版本解析的单一权威。
 *
 * 历史问题：配置生成层（ProxyManager）曾用 `parseFloat("1." + minor)` 判断版本带，
 * 这会把 minor 当小数 —— "1.9" → 1.9 被误判为 > 1.13，"1.20" → 1.2 被误判为 < 1.13。
 * 核心更新层（CoreUpdateService）则早已用整数编码避开该坑。此模块把两边统一到整数编码。
 */

/**
 * 把版本字符串编码为可比较整数 major*1000+minor。
 *   "1.20.3" → 1020、"v1.13.13" → 1013、"1.9.0" → 1009
 * 无法解析返回 NaN。容忍前导 `v` 与任意后缀（"-beta"/"+naive" 等）。
 */
export function encodeMajorMinor(version: string): number {
  const m = version.match(/^v?(\d+)\.(\d+)/);
  return m ? parseInt(m[1], 10) * 1000 + parseInt(m[2], 10) : NaN;
}

/**
 * 两版本是否同 major.minor（兼容版本带内）。
 *   "1.13.13" vs "1.13.14" → true；"1.13.x" vs "1.14.x" → false；"1.x" vs "2.x" → false。
 * 任一无法解析（含 "未知"）→ NaN → false（失败安全：内核自动更新跨带硬闸宁可不更，绝不误判同带跨 minor 落位）。
 */
export function sameMajorMinor(a: string, b: string): boolean {
  const ea = encodeMajorMinor(a);
  const eb = encodeMajorMinor(b);
  return !isNaN(ea) && !isNaN(eb) && ea === eb;
}

/**
 * 判断核心版本是否 ≥ major.minor。
 * @param fallback 无法解析时的返回值。默认 true —— 打包核心恒 ≥1.13.13、
 *   且 getCoreVersion 解析失败也兜底返回 "1.13.0"，故"未知"按现代版本处理最安全。
 */
export function coreVersionAtLeast(
  version: string,
  major: number,
  minor: number,
  fallback = true
): boolean {
  const v = encodeMajorMinor(version);
  if (isNaN(v)) return fallback;
  return v >= major * 1000 + minor;
}

/**
 * 健壮三段（及以上）语义版本比较的单一权威：a>b→1、a<b→-1、相等→0。
 *   容忍前导 `v`（"v1.13.13"）与 prerelease/build 后缀（"1.2.3-beta"、"1.2.3+naive"）——
 *   后缀在首个 `-`/`+` 处截断后仅比较数字段，避免 `split('.').map(Number)` 把 "3-beta" 算成 NaN
 *   而误判相等/倒序。每段缺失或非数字按 0 计；不比较 prerelease 优先级（够内核/App 更新判定用）。
 */
export function compareSemver(a: string, b: string): number {
  const norm = (v: string): number[] =>
    (v || '')
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((p) => parseInt(p, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}
