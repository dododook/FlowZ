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
 * @param fallback 无法解析时的返回值。默认 true —— 打包核心恒 ≥1.14（出厂版本见 core-manifest.json
 *   bundledCoreVersion，随打包升级；勿在此硬编码具体 alpha 号以免漂移），且 getCoreVersion 解析失败也兜底
 *   返回现代版本，故"未知"按现代版本处理最安全。
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
 *   容忍前导 `v`（"v1.13.13"）与 build 后缀（`+naive`，比较时忽略）。
 *   **支持 semver prerelease 优先级**（1.14 迁移 §6.5 核心改动②，让"预览版→正式版"可被判出）：
 *     · 主版本号（major.minor.patch…）数字段优先逐段比较；
 *     · 主版本相同时「有 prerelease」< 「无 prerelease」（`1.14.0-alpha.32 < 1.14.0`）；
 *     · 两者都有 prerelease 时逐段比 prerelease 标识符——纯数字段按数字、含字母段按 ASCII 字典序、
 *       数字段 < 字母段；段数不同时较长者更大（`alpha < alpha.1`）。
 *     · 由此 `alpha.32 < alpha.33 < beta.1 < rc.1 < 1.14.0 < 1.14.1` 全链成立。
 *   单一真值（CoreUpdateService.compareVersions + UpdateService.isNewerVersion 共用）。
 *   每段缺失或非数字主版本段按 0 计；build（`+`）后缀不参与比较（semver 规范）。
 */
export function compareSemver(a: string, b: string): number {
  // 拆出主版本段数组与 prerelease 段数组（build `+...` 直接丢弃，不参与比较）。
  const parse = (v: string): { main: number[]; pre: string[] } => {
    const stripped = (v || '').replace(/^v/i, '').split('+')[0];
    const dash = stripped.indexOf('-');
    const mainStr = dash === -1 ? stripped : stripped.slice(0, dash);
    const preStr = dash === -1 ? '' : stripped.slice(dash + 1);
    const main = mainStr.split('.').map((p) => parseInt(p, 10) || 0);
    const pre = preStr === '' ? [] : preStr.split('.');
    return { main, pre };
  };
  const pa = parse(a);
  const pb = parse(b);

  // 1) 主版本段逐段比较
  for (let i = 0; i < Math.max(pa.main.length, pb.main.length); i++) {
    const na = pa.main[i] || 0;
    const nb = pb.main[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }

  // 2) 主版本相同：有 prerelease < 无 prerelease
  const aHasPre = pa.pre.length > 0;
  const bHasPre = pb.pre.length > 0;
  if (!aHasPre && !bHasPre) return 0;
  if (!aHasPre) return 1; // a 是正式版、b 是预览版 → a 更大
  if (!bHasPre) return -1;

  // 3) 两者都有 prerelease：逐段比较标识符（semver 规则）
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    // 段数不同：较短者更小（"1.0.0-alpha" < "1.0.0-alpha.1"）
    if (i >= pa.pre.length) return -1;
    if (i >= pb.pre.length) return 1;
    const sa = pa.pre[i];
    const sb = pb.pre[i];
    const isNumA = /^\d+$/.test(sa);
    const isNumB = /^\d+$/.test(sb);
    if (isNumA && isNumB) {
      const na = parseInt(sa, 10);
      const nb = parseInt(sb, 10);
      if (na > nb) return 1;
      if (na < nb) return -1;
    } else if (isNumA) {
      return -1; // 数字段 < 字母段
    } else if (isNumB) {
      return 1;
    } else {
      if (sa > sb) return 1; // ASCII 字典序：alpha < beta < rc
      if (sa < sb) return -1;
    }
  }
  return 0;
}
