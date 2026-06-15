/**
 * 版本解析单一权威单测：encodeMajorMinor 基线矩阵 + sameMajorMinor 兼容带硬闸。
 * sameMajorMinor 是「内核自动更新跨 minor 绝不自动」的硬不变量基础 —— 必须 NaN 失败安全。
 */

import { encodeMajorMinor, sameMajorMinor, compareSemver } from '../version';

describe('encodeMajorMinor', () => {
  it('编码为 major*1000+minor', () => {
    expect(encodeMajorMinor('1.13.13')).toBe(1013);
    expect(encodeMajorMinor('1.20.3')).toBe(1020); // "1.20" 不被当 1.2
    expect(encodeMajorMinor('1.9.0')).toBe(1009);
    expect(encodeMajorMinor('2.0.0')).toBe(2000);
  });

  it('容忍前导 v 与任意后缀', () => {
    expect(encodeMajorMinor('v1.13.13')).toBe(1013);
    expect(encodeMajorMinor('1.13.13-beta')).toBe(1013);
    expect(encodeMajorMinor('1.13.13+naive')).toBe(1013);
    expect(encodeMajorMinor('v1.13')).toBe(1013);
  });

  it('无法解析返回 NaN', () => {
    expect(encodeMajorMinor('未知')).toBeNaN();
    expect(encodeMajorMinor('')).toBeNaN();
    expect(encodeMajorMinor('unknown')).toBeNaN();
    expect(encodeMajorMinor('v')).toBeNaN();
  });
});

describe('sameMajorMinor', () => {
  it('同 major.minor → true（仅 patch 不同）', () => {
    expect(sameMajorMinor('1.13.13', '1.13.14')).toBe(true);
    expect(sameMajorMinor('1.13.0', '1.13.99')).toBe(true);
    expect(sameMajorMinor('v1.13.13', '1.13.14-beta')).toBe(true); // 前导 v + 后缀混合
    expect(sameMajorMinor('1.13.5', '1.13.5')).toBe(true); // 完全相同
  });

  it('跨 minor → false（兼容带硬闸：绝不自动）', () => {
    expect(sameMajorMinor('1.13.13', '1.14.0')).toBe(false);
    expect(sameMajorMinor('1.13.13', '1.20.0')).toBe(false); // "1.20" 不误判同带
    expect(sameMajorMinor('1.13.13', '1.12.99')).toBe(false);
  });

  it('跨 major → false', () => {
    expect(sameMajorMinor('1.13.13', '2.13.13')).toBe(false);
    expect(sameMajorMinor('2.0.0', '1.0.0')).toBe(false);
  });

  it('任一无法解析（含"未知"）→ false（失败安全，宁可不更新）', () => {
    expect(sameMajorMinor('未知', '1.13.13')).toBe(false);
    expect(sameMajorMinor('1.13.13', '未知')).toBe(false);
    expect(sameMajorMinor('未知', '未知')).toBe(false);
    expect(sameMajorMinor('', '1.13.13')).toBe(false);
  });
});

describe('compareSemver', () => {
  it('逐段比较：a>b→1、a<b→-1、相等→0', () => {
    expect(compareSemver('1.2.4', '1.2.3')).toBe(1);
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1); // major 优先
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1); // "10" 不被当 "1.0"，数字段非字典序
  });

  it('容忍前导 v', () => {
    expect(compareSemver('v1.2.4', '1.2.3')).toBe(1);
    expect(compareSemver('1.2.3', 'v1.2.3')).toBe(0);
    expect(compareSemver('V2.0.0', 'v1.0.0')).toBe(1);
  });

  it('容忍 prerelease/build 后缀（核心修复点：原 split.map(Number) 会算成 NaN 误判）', () => {
    // 后缀在首个 -/+ 处截断后只比数字段
    expect(compareSemver('1.2.3-beta', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.3', '1.2.3-beta')).toBe(0);
    expect(compareSemver('1.2.4-beta', '1.2.3')).toBe(1); // 新版带后缀仍被识别为更新
    expect(compareSemver('1.2.3+naive', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.3-rc.1', '1.2.2')).toBe(1);
    expect(compareSemver('v1.13.14-beta', 'v1.13.13')).toBe(1);
  });

  it('不同段数：缺失段按 0 计', () => {
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
    expect(compareSemver('1.2.1', '1.2')).toBe(1);
    expect(compareSemver('1', '1.0.0')).toBe(0);
  });

  it('非数字段按 0（不抛，失败安全）', () => {
    expect(compareSemver('1.x.0', '1.0.0')).toBe(0); // x→0
    expect(compareSemver('', '')).toBe(0);
    expect(compareSemver('1.2.3', '')).toBe(1);
  });
});
