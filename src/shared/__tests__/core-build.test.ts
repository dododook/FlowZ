/**
 * 内核构建来源判定（classifyCoreBuild）单测。
 * 检测口径为 runtime/外部二进制语义，须以「样本字符串 + 纯函数断言」固化（见 docs/design/nonofficial-core-update-guard.md §1）。
 * 样本：官方基线（1.13.13 实测）+ 官方预发布/dev + fork 后缀（reF1nd/nekolsd，源码确证）+ 边界（官方跨版本不误报）。
 */

import {
  classifyCoreBuild,
  decideCoreOverride,
  extractVersionToken,
  reseedApplied,
  classifyReseedResult,
} from '../core-build';

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
