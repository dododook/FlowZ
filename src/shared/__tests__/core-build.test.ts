/**
 * 内核构建来源判定（classifyCoreBuild）单测。
 * 检测口径为 runtime/外部二进制语义，须以「样本字符串 + 纯函数断言」固化（见 docs/design/nonofficial-core-update-guard.md §1）。
 * 样本：官方基线（1.13.13 实测）+ 官方预发布/dev + fork 后缀（reF1nd/nekolsd，源码确证）+ 边界（官方跨版本不误报）。
 */

import {
  classifyCoreBuild,
  comparableCoreVersion,
  decideCoreOverride,
  extractVersionToken,
  parseUploadedCoreVersion,
  reseedApplied,
  classifyReseedResult,
} from '../core-build';
import { compareSemver } from '../version';

describe('extractVersionToken', () => {
  it('从完整 version 行提取 token', () => {
    expect(extractVersionToken('sing-box version 1.13.13')).toBe('1.13.13');
    expect(extractVersionToken('sing-box version 1.13.13-reF1nd')).toBe('1.13.13-reF1nd');
  });
  it('裸 token / 前缀 v', () => {
    expect(extractVersionToken('1.13.13')).toBe('1.13.13');
    expect(extractVersionToken('v1.13.13')).toBe('1.13.13');
  });
  it('空/脏输入', () => {
    expect(extractVersionToken('')).toBe('');
    expect(extractVersionToken('   ')).toBe('');
    expect(extractVersionToken(undefined as any)).toBe('');
  });
});

describe('parseUploadedCoreVersion — 手动上传版本解析（完整后缀 + 形状校验，B-1）', () => {
  it('官方 release：完整 token + 原始首行', () => {
    expect(parseUploadedCoreVersion('sing-box version 1.14.0\nEnvironment: go1.25')).toEqual({
      version: '1.14.0',
      versionLine: 'sing-box version 1.14.0',
    });
  });
  it('官方 prerelease：保留 -alpha.N 后缀（B-1 病灶：旧正则会剥成 1.14.0）', () => {
    expect(parseUploadedCoreVersion('sing-box version 1.14.0-alpha.37').version).toBe(
      '1.14.0-alpha.37'
    );
  });
  it('官方 dev：保留 base + 短 commit hex 完整尾段', () => {
    expect(parseUploadedCoreVersion('sing-box version 1.14.0-alpha.37-abcdef1').version).toBe(
      '1.14.0-alpha.37-abcdef1'
    );
  });
  it('fork：保留完整复合后缀（供 classifyCoreBuild / B-3 识别）', () => {
    const r = parseUploadedCoreVersion('sing-box version 1.14.0-alpha.31-nekolsd-test');
    expect(r.version).toBe('1.14.0-alpha.31-nekolsd-test');
    expect(r.versionLine).toBe('sing-box version 1.14.0-alpha.31-nekolsd-test');
  });
  it('纯 int / 脏行 / 空：version=null 不谎报，versionLine 仍保留原始行', () => {
    expect(parseUploadedCoreVersion('sing-box version 20260101').version).toBeNull();
    expect(parseUploadedCoreVersion('garbage output')).toEqual({
      version: null,
      versionLine: 'garbage output',
    });
    expect(parseUploadedCoreVersion('')).toEqual({ version: null, versionLine: '' });
    expect(parseUploadedCoreVersion(undefined as any)).toEqual({
      version: null,
      versionLine: '',
    });
  });
  it('只取第一行（version 恒在首行，避免 Environment 行 go1.25.x 误匹配）', () => {
    expect(
      parseUploadedCoreVersion(
        'sing-box version 1.14.0-alpha.37\nEnvironment: go1.25.10 linux/amd64'
      ).version
    ).toBe('1.14.0-alpha.37');
  });
});

describe('comparableCoreVersion — 可比较版本规范化（与 getCoreVersion 截断同形，M-1 契约）', () => {
  it('截断 fork 尾段（第二个 - 起）', () => {
    expect(comparableCoreVersion('1.14.0-alpha.31-nekolsd-test')).toBe('1.14.0-alpha.31');
  });
  it('截断官方 dev 短 commit hex 尾段', () => {
    expect(comparableCoreVersion('1.14.0-alpha.31-abcdef1')).toBe('1.14.0-alpha.31');
  });
  it('保留官方 prerelease / release / 剥前缀 v', () => {
    expect(comparableCoreVersion('1.14.0-alpha.37')).toBe('1.14.0-alpha.37');
    expect(comparableCoreVersion('1.14.0')).toBe('1.14.0');
    expect(comparableCoreVersion('v1.13.13')).toBe('1.13.13');
  });
  it('非版本串（纯 int / 空）原样返回（unknown 核不参与 reseed 决策，无害）', () => {
    expect(comparableCoreVersion('20260101')).toBe('20260101');
    expect(comparableCoreVersion('')).toBe('');
  });

  // M-1 核心契约：完整后缀喂 compareSemver 会把尾段并入 prerelease 段污染比较（数字段 < 字母段），误判「更新」；
  // comparable 截断后正确判「更旧」——使 B-2 预判与 startInternal 实际 reseed（getCoreVersion 截断形）同向，
  // 消除官方 dev / fork 象限的空头支票。同一 quirk 也是「否决把 getCoreVersion 收敛到完整 token」的理由。
  it('M-1 契约：完整 dev/fork token 污染比较，comparable 修正为正确的「旧于基线」', () => {
    const bundled = '1.14.0-alpha.37';
    // 完整 dev token 的 -abcdef1 并入第二 prerelease 段 '31-abcdef1'（字母段）> '37'（数字段）→ 误判 +1（更新）
    expect(compareSemver('1.14.0-alpha.31-abcdef1', bundled)).toBe(1);
    // comparable 截断后 → 1.14.0-alpha.31 < 1.14.0-alpha.37 → 正确 -1（更旧，触发预判/reseed）
    expect(compareSemver(comparableCoreVersion('1.14.0-alpha.31-abcdef1'), bundled)).toBe(-1);
    // fork 同理（这正是若收敛 getCoreVersion 会让 fork warn: cmp<=0 失效的回归根因）
    expect(compareSemver('1.14.0-alpha.31-nekolsd-test', bundled)).toBe(1);
    expect(compareSemver(comparableCoreVersion('1.14.0-alpha.31-nekolsd-test'), bundled)).toBe(-1);
  });
});

describe('classifyCoreBuild — official', () => {
  it('纯 semver release（含官方基线 1.13.13）', () => {
    expect(classifyCoreBuild('sing-box version 1.13.13')).toBe('official');
    expect(classifyCoreBuild('1.13.13')).toBe('official');
    expect(classifyCoreBuild('1.12.8')).toBe('official');
  });
  it('官方预发布 -alpha/-beta/-rc.N', () => {
    expect(classifyCoreBuild('1.13.0-rc.5')).toBe('official');
    expect(classifyCoreBuild('1.12.0-beta.15')).toBe('official');
    expect(classifyCoreBuild('1.11.0-alpha.19')).toBe('official');
  });
  it('官方 dev 自建（base + 短 commit hex，不误判 fork；大小写均可）', () => {
    expect(classifyCoreBuild('1.13.13-78b2e12')).toBe('official');
    expect(classifyCoreBuild('1.13.13-78b2e12fbdd8')).toBe('official');
    expect(classifyCoreBuild('1.13.0-rc.5-abcdef1')).toBe('official');
    expect(classifyCoreBuild('1.13.13-78B2E12')).toBe('official'); // 大写 hex 不误判 fork
  });
  it('边界：手动上传的官方跨版本 → 官方，零误报', () => {
    expect(classifyCoreBuild('1.14.0')).toBe('official'); // 更新的官方
    expect(classifyCoreBuild('1.11.5')).toBe('official'); // 更旧的官方
    expect(classifyCoreBuild('2.0.0')).toBe('official');
    expect(classifyCoreBuild('v1.12.3')).toBe('official');
  });
});

describe('classifyCoreBuild — fork（非官方）', () => {
  it('reF1nd 后缀', () => {
    expect(classifyCoreBuild('1.13.13-reF1nd')).toBe('fork');
    expect(classifyCoreBuild('sing-box version 1.13.13-reF1nd')).toBe('fork');
    expect(classifyCoreBuild('1.14.0-alpha.29-reF1nd')).toBe('fork');
  });
  it('nekolsd 后缀（含次级 -test）', () => {
    expect(classifyCoreBuild('1.13.3-nekolsd')).toBe('fork');
    expect(classifyCoreBuild('1.14.0-alpha.31-nekolsd-test')).toBe('fork');
  });
});

describe('classifyCoreBuild — unknown（不硬判 fork）', () => {
  it('unknown / 空 / 脏输入', () => {
    expect(classifyCoreBuild('unknown')).toBe('unknown');
    expect(classifyCoreBuild('sing-box version unknown')).toBe('unknown');
    expect(classifyCoreBuild('')).toBe('unknown');
    expect(classifyCoreBuild('sing-box')).toBe('unknown');
    expect(classifyCoreBuild('garbage-output')).toBe('unknown');
  });
});

describe('decideCoreOverride — 核覆盖决策（官方/fork/unknown × </=/> 内置基线）', () => {
  const B = '1.14.0-alpha.32'; // 随包(内置)基线

  it('官方 < 内置 → 内置替换(reseed)，不警告', () => {
    expect(decideCoreOverride('official', '1.13.13', B)).toEqual({ reseed: true, warn: false });
    expect(decideCoreOverride('official', '1.14.0-alpha.30', B)).toEqual({
      reseed: true,
      warn: false,
    });
  });
  it('官方 == 内置 → 保持(不重播种)，不警告', () => {
    expect(decideCoreOverride('official', B, B)).toEqual({ reseed: false, warn: false });
  });
  it('官方 > 内置 → 保持(不降级)，不警告（release > 同版 prerelease / 更高版）', () => {
    expect(decideCoreOverride('official', '1.14.0', B)).toEqual({ reseed: false, warn: false });
    expect(decideCoreOverride('official', '1.15.0', B)).toEqual({ reseed: false, warn: false });
  });
  it('fork → 绝不重播种；≤ 内置 → 警告', () => {
    expect(decideCoreOverride('fork', '1.13.3', B)).toEqual({ reseed: false, warn: true });
    expect(decideCoreOverride('fork', '1.14.0-alpha.31', B)).toEqual({ reseed: false, warn: true });
  });
  it('fork > 内置 → 保持，不警告', () => {
    expect(decideCoreOverride('fork', '1.15.0', B)).toEqual({ reseed: false, warn: false });
  });
  it('unknown → 同 fork：绝不重播种；≤ 内置 → 警告', () => {
    expect(decideCoreOverride('unknown', '1.13.0', B)).toEqual({ reseed: false, warn: true });
    expect(decideCoreOverride('unknown', '1.15.0', B)).toEqual({ reseed: false, warn: false });
  });
});

describe('reseedApplied — reseed 是否真生效（诚实失败判据，issue #150）', () => {
  const B = '1.14.0-alpha.33'; // 随包(内置)基线

  it('换核失败：版本仍 < 基线（旧核被占用 ETXTBSY 未替换）→ 未生效', () => {
    // issue #150 实况：基线 1.14.0-alpha.33，活核仍 1.13.13 → 绝不能判成功
    expect(reseedApplied('1.13.13', B)).toBe(false);
    expect(reseedApplied('1.14.0-alpha.30', B)).toBe(false);
  });

  it('换核成功：版本 == 基线 → 生效', () => {
    expect(reseedApplied(B, B)).toBe(true);
  });

  it('版本 > 基线（已是更新核）→ 视为生效', () => {
    expect(reseedApplied('1.14.0', B)).toBe(true); // release > 同版 prerelease
    expect(reseedApplied('1.15.0', B)).toBe(true);
  });
});

describe('classifyReseedResult — reseed 校验（含 F1：探测失败不得伪装成功）', () => {
  const B = '1.14.0-alpha.33'; // 随包(内置)基线
  const BEFORE = '1.13.13'; // 换核前旧官方核

  it('F1 核心：换核后重读探测失败（lineAfter=空）→ 保守保留旧版本、判未生效', () => {
    // 绝不能因探测失败而回落基线 → 否则版本闸门误放行、带旧核硬跑退回死循环
    expect(classifyReseedResult('', BEFORE, B)).toEqual({ version: BEFORE, applied: false });
    expect(classifyReseedResult('   ', BEFORE, B)).toEqual({ version: BEFORE, applied: false });
    expect(classifyReseedResult('sing-box', BEFORE, B)).toEqual({
      version: BEFORE,
      applied: false,
    });
  });

  it('换核成功：lineAfter 报随包基线版本 → 判生效、记录新版本', () => {
    expect(classifyReseedResult('sing-box version 1.14.0-alpha.33 (go1.25)', BEFORE, B)).toEqual({
      version: '1.14.0-alpha.33',
      applied: true,
    });
  });

  it('换核未生效：旧核仍可跑、lineAfter 报旧版本 → 判未生效、记录旧版本（仍 < 基线）', () => {
    // issue #150 主路径：ETXTBSY 只阻写不阻执行，重读拿到真实旧 1.13.13
    expect(classifyReseedResult('sing-box version 1.13.13', BEFORE, B)).toEqual({
      version: BEFORE,
      applied: false,
    });
  });

  it('换核后已是更新官方核（> 基线）→ 判生效', () => {
    expect(classifyReseedResult('sing-box version 1.14.0', BEFORE, B)).toEqual({
      version: '1.14.0',
      applied: true,
    });
  });
});
