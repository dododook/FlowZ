/**
 * 内核构建来源判定（classifyCoreBuild）单测。
 * 检测口径为 runtime/外部二进制语义，须以「样本字符串 + 纯函数断言」固化（见 docs/design/nonofficial-core-update-guard.md §1）。
 * 样本：官方基线（1.13.13 实测）+ 官方预发布/dev + fork 后缀（reF1nd/nekolsd，源码确证）+ 边界（官方跨版本不误报）。
 */

import { classifyCoreBuild, decideCoreOverride, extractVersionToken } from '../core-build';

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
