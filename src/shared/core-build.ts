/**
 * sing-box 内核「官方 vs 第三方 fork」判定（纯函数，可单测；main/renderer 共用单一真值）。
 *
 * 唯一可靠强信号 = `sing-box version` 第一行的版本字符串后缀：fork 刻意在 git tag 打标识
 * （-reF1nd / -nekolsd / -nekolsd-test）。Tags 行不可靠（reF1nd 的 Tags 与官方同构、snell 无条件
 * 编入不产生 with_snell tag），Revision 离线无法比对。判定细节与边界见
 * docs/design/nonofficial-core-update-guard.md §1。
 */

import { compareSemver } from './version';

export type CoreBuildKind = 'official' | 'fork' | 'unknown';

// 官方所有合法 version 形态（read_tag 产出：release 剥 v 的纯 semver；dev = base + '-' + 短 commit hex）。
const OFFICIAL_RELEASE = /^\d+\.\d+\.\d+$/;
const OFFICIAL_PRERELEASE = /^\d+\.\d+\.\d+-(alpha|beta|rc)\.\d+$/;
// 短 commit hex 大小写不敏感（个别构建工具链会大写 hash）：避免官方 dev 构建被误判 fork。
const OFFICIAL_DEV = /^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?-[0-9a-fA-F]{7,}$/;

/** 从 `sing-box version` 第一行（或裸 token）提取版本 token（剥前缀 v，到空白为止）。 */
export function extractVersionToken(versionLine: string): string {
  if (!versionLine || typeof versionLine !== 'string') return '';
  const s = versionLine.trim();
  if (!s) return '';
  // "sing-box version <token>" → token；否则取首个空白分隔 token。
  const m = s.match(/version\s+(\S+)/i);
  const tok = m ? m[1] : s.split(/\s+/)[0];
  return (tok || '').replace(/^v/i, '').trim();
}

/**
 * 判定内核构建来源。
 *  - official：纯 semver / 官方预发布(-alpha|beta|rc.N) / 官方 dev(base + '-' + 7+hex 短 commit)。
 *    手动上传的官方跨版本（任意 X.Y.Z）零误报——规则不依赖具体版本号。
 *  - unknown：token 为 'unknown' 或无法解析为 X.Y.Z 开头（go install / 源码自建——官方也会 unknown，不硬判 fork）。
 *  - fork：以 X.Y.Z 开头但带非官方后缀（含非 hex 字母词，如 -reF1nd / -nekolsd）。
 */
export function classifyCoreBuild(versionLine: string): CoreBuildKind {
  const tok = extractVersionToken(versionLine);
  if (!tok || tok.toLowerCase() === 'unknown') return 'unknown';
  if (OFFICIAL_RELEASE.test(tok) || OFFICIAL_PRERELEASE.test(tok) || OFFICIAL_DEV.test(tok)) {
    return 'official';
  }
  // 非 X.Y.Z 开头 = 脏输入/无法解析 → unknown（不误判 fork）。
  if (!/^\d+\.\d+\.\d+/.test(tok)) return 'unknown';
  return 'fork';
}

/**
 * 核覆盖决策（纯函数）：启动时是否用随包(内置)核替换本机正在使用的【非内置】核。
 * 内置核本身是种子（强制落位），不经此决策；此处只判用户单独装的核。基线 = 随包(内置)版本。
 *  - official + 本机 ≤ 内置 → reseed（内置替换：随包核更新或同版，统一到随包基线）
 *  - official + 本机 > 内置 → keep（不降级用户装的更新官方核）
 *  - fork / unknown        → keep（绝不覆盖用户的 fork/自建核）；本机 ≤ 内置 → warn（基线兼容提醒）
 * @param kind            classifyCoreBuild(版本行) 结果
 * @param coreVersion     本机在用核版本（X.Y.Z[-suffix]）
 * @param bundledVersion  随包(内置)核版本 = 基线
 */
export function decideCoreOverride(
  kind: CoreBuildKind,
  coreVersion: string,
  bundledVersion: string
): { reseed: boolean; warn: boolean } {
  const cmp = compareSemver(coreVersion, bundledVersion);
  if (kind === 'official') {
    // 官方非内置核：严格旧于内置 → 内置替换（取更新的随包核）；同版/更新 → 保持
    //（同版不重播种，避免每次启动徒劳换核——seed 后受保护核==内置是常态；更新不降级用户装的官方核）。
    return { reseed: cmp < 0, warn: false };
  }
  // fork / unknown：尊重用户选择，绝不覆盖；≤ 基线时提醒兼容风险（含同版 fork——后缀分支可能缺新特性）。
  return { reseed: false, warn: cmp <= 0 };
}
