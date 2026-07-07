/**
 * 首页状态栏纯逻辑单测：出口按连接分态（连→代理出口 / 未连→本地出口）+ 状态点色档映射。
 */
import { pickStatusBarExit, statusDotTone } from '../status-bar-state';
import type { StatusInfo } from '../connection-status';

const direct = { ip: '124.90.1.1', countryCode: 'CN' };
const proxy = { ip: '203.0.113.42', countryCode: 'HK' };

describe('pickStatusBarExit（出口按连接分态）', () => {
  it('已连 → 代理出口', () => {
    expect(pickStatusBarExit(true, { direct, proxy })).toEqual({ info: proxy, isProxy: true });
  });
  it('未连 → 本地出口', () => {
    expect(pickStatusBarExit(false, { direct, proxy })).toEqual({ info: direct, isProxy: false });
  });
  it('已连但代理出口缺值 → info=null（isProxy 仍 true）', () => {
    expect(pickStatusBarExit(true, { direct, proxy: null })).toEqual({ info: null, isProxy: true });
  });
  it('ipInfo 缺失 → null 兜底', () => {
    expect(pickStatusBarExit(false, null)).toEqual({ info: null, isProxy: false });
    expect(pickStatusBarExit(true, undefined)).toEqual({ info: null, isProxy: true });
  });
});

describe('statusDotTone', () => {
  const cases: Array<[StatusInfo['variant'], string]> = [
    ['default', 'ok'],
    ['secondary', 'warn'],
    ['destructive', 'err'],
    ['outline', 'idle'],
  ];
  it.each(cases)('variant %s → %s', (variant, tone) => {
    expect(statusDotTone(variant)).toBe(tone);
  });
});
