/**
 * 首页状态栏纯逻辑单测：出口按连接分态（连→代理出口 / 未连→本地出口）+ 状态点色档映射。
 */
import { pickStatusBarExit, statusDotTone } from '../status-bar-state';
import type { StatusInfo } from '../connection-status';

const direct = { ip: '124.90.1.1', countryCode: 'CN' };
const proxy = { ip: '203.0.113.42', countryCode: 'HK' };

describe('pickStatusBarExit（出口按连接分态 + invalid/detecting/failed）', () => {
  it('已连 → 代理出口（有值 invalid/detecting/failed 均 false）', () => {
    expect(pickStatusBarExit(true, { direct, proxy })).toEqual({
      info: proxy,
      isProxy: true,
      invalid: false,
      detecting: false,
      failed: false,
    });
  });
  it('未连 → 本地出口', () => {
    expect(pickStatusBarExit(false, { direct, proxy })).toEqual({
      info: direct,
      isProxy: false,
      invalid: false,
      detecting: false,
      failed: false,
    });
  });
  it('已连、代理缺值、loading → detecting', () => {
    expect(pickStatusBarExit(true, { proxy: null, loading: true })).toEqual({
      info: null,
      isProxy: true,
      invalid: false,
      detecting: true,
      failed: false,
    });
  });
  it('被动刷新：已连、代理已有 IP + loading → 显旧 IP 不显「检测中」（loading 不掩盖已有 info）', () => {
    // 锚死【被动路径】不变量：TTL/后台刷新置 loading=true 但保留旧 info → 状态栏全程显旧 IP、探到新值才静默换，不闪。
    // 可见手动重探（§9）不走此：主进程 doRefresh 头部清 info=null → 落入下方「代理缺值+loading → detecting」用例、显检测中。
    // picker 纯函数零改动——detecting 与否只由数据（info 有无）驱动。
    expect(pickStatusBarExit(true, { proxy, loading: true })).toEqual({
      info: proxy,
      isProxy: true,
      invalid: false,
      detecting: false,
      failed: false,
    });
  });
  it('未连、本地已有 IP + loading（proxy off 手刷重探 direct 进行中）→ 显旧 direct IP 不显「检测中」', () => {
    expect(pickStatusBarExit(false, { direct, loading: true })).toEqual({
      info: direct,
      isProxy: false,
      invalid: false,
      detecting: false,
      failed: false,
    });
  });
  it('已连、代理缺值、探测完成(updatedAt>0)非 loading → failed（超时/广播失效）', () => {
    expect(pickStatusBarExit(true, { proxy: null, loading: false, updatedAt: 123 })).toEqual({
      info: null,
      isProxy: true,
      invalid: false,
      detecting: false,
      failed: true,
    });
  });
  it('启动相位 connecting=true：无 proxy IP + 旧 updatedAt 强制 detecting、压掉 failed（消启动闪「检测超时」）', () => {
    // 同 line 38 的 failed 输入，仅 connecting=true → 归 detecting，不再闪超时
    expect(pickStatusBarExit(true, { proxy: null, loading: false, updatedAt: 123 }, true)).toEqual({
      info: null,
      isProxy: true,
      invalid: false,
      detecting: true,
      failed: false,
    });
  });
  it('connecting=true 但真直判无效：invalid 仍抢占（启动中照显「出口无效」，不被 detecting 掩盖）', () => {
    expect(
      pickStatusBarExit(true, { proxy: null, proxyBlocked: 'ts-no-exit-device' }, true)
    ).toEqual({ info: null, isProxy: true, invalid: true, detecting: false, failed: false });
  });
  it('ipInfo 缺失 → null 兜底，invalid/detecting/failed 均 false', () => {
    expect(pickStatusBarExit(false, null)).toEqual({
      info: null,
      isProxy: false,
      invalid: false,
      detecting: false,
      failed: false,
    });
    expect(pickStatusBarExit(true, undefined)).toEqual({
      info: null,
      isProxy: true,
      invalid: false,
      detecting: false,
      failed: false,
    });
  });
});

describe('pickStatusBarExit（TS 出口无效直判 invalid 态 + 优先级）', () => {
  it('已连、代理缺值、proxyBlocked（直判无效终态：loading=false + updatedAt>0）→ invalid，detecting/failed 抢占为 false', () => {
    expect(
      pickStatusBarExit(true, {
        proxy: null,
        loading: false,
        updatedAt: 456,
        proxyBlocked: 'ts-no-exit-device',
      })
    ).toEqual({ info: null, isProxy: true, invalid: true, detecting: false, failed: false });
  });
  it('invalid 优先于 detecting：proxyBlocked + loading=true 仍判 invalid（不显「检测中」）', () => {
    expect(
      pickStatusBarExit(true, {
        proxy: null,
        loading: true,
        proxyBlocked: 'ts-exit-device-offline',
      })
    ).toEqual({ info: null, isProxy: true, invalid: true, detecting: false, failed: false });
  });
  it('info 优先于 invalid：探到代理出口即显 IP，即便 proxyBlocked 残留也不判 invalid', () => {
    expect(pickStatusBarExit(true, { proxy, proxyBlocked: 'ts-no-exit-device' })).toEqual({
      info: proxy,
      isProxy: true,
      invalid: false,
      detecting: false,
      failed: false,
    });
  });
  it('未连（running=false）：proxyBlocked 不触发 invalid（状态栏取本地出口，与代理出口无关）', () => {
    expect(pickStatusBarExit(false, { direct, proxyBlocked: 'ts-no-exit-device' })).toEqual({
      info: direct,
      isProxy: false,
      invalid: false,
      detecting: false,
      failed: false,
    });
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
