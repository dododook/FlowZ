/**
 * mapElectronLocaleToDashboardLang 单测（纯函数）：Electron locale → 面板合法码（en/zh-Hans/zh-Hant/fa/ru）。
 * 重点护栏：zh-Hant 子串（hant/tw/hk/mo）必须先于泛 zh 命中，否则繁体地区被误判简体（表查找顺序回归）。
 */
import { mapElectronLocaleToDashboardLang } from '../dashboard-locale';

describe('mapElectronLocaleToDashboardLang', () => {
  it('繁体地区 → zh-Hant（hant/tw/hk/mo，先于泛 zh）', () => {
    expect(mapElectronLocaleToDashboardLang('zh-Hant')).toBe('zh-Hant');
    expect(mapElectronLocaleToDashboardLang('zh-TW')).toBe('zh-Hant');
    expect(mapElectronLocaleToDashboardLang('zh-HK')).toBe('zh-Hant');
    expect(mapElectronLocaleToDashboardLang('zh-MO')).toBe('zh-Hant');
    expect(mapElectronLocaleToDashboardLang('zh-Hant-TW')).toBe('zh-Hant');
  });

  it('其余 zh → zh-Hans', () => {
    expect(mapElectronLocaleToDashboardLang('zh')).toBe('zh-Hans');
    expect(mapElectronLocaleToDashboardLang('zh-CN')).toBe('zh-Hans');
    expect(mapElectronLocaleToDashboardLang('zh-Hans')).toBe('zh-Hans');
    expect(mapElectronLocaleToDashboardLang('zh-SG')).toBe('zh-Hans');
  });

  it('脚本优先：hans 脚本压过 tw/hk/mo 地区码，mo 裸子串不误判繁体', () => {
    // 澳门简体：显式 hans 脚本 → zh-Hans（不被地区码 mo 抢判繁体）。
    expect(mapElectronLocaleToDashboardLang('zh-Hans-MO')).toBe('zh-Hans');
    // 私有扩展 promo 含子串 mo，但非锚定地区段 + 有 hans 脚本 → zh-Hans。
    expect(mapElectronLocaleToDashboardLang('zh-hans-x-promo')).toBe('zh-Hans');
  });

  it('地区码锚定段边界判繁体：zh-MO/zh-TW → zh-Hant', () => {
    expect(mapElectronLocaleToDashboardLang('zh-Hant-TW')).toBe('zh-Hant');
    expect(mapElectronLocaleToDashboardLang('zh-MO')).toBe('zh-Hant');
    expect(mapElectronLocaleToDashboardLang('zh-TW')).toBe('zh-Hant');
  });

  it('fa → fa', () => {
    expect(mapElectronLocaleToDashboardLang('fa')).toBe('fa');
    expect(mapElectronLocaleToDashboardLang('fa-IR')).toBe('fa');
  });

  it('ru → ru', () => {
    expect(mapElectronLocaleToDashboardLang('ru')).toBe('ru');
    expect(mapElectronLocaleToDashboardLang('ru-RU')).toBe('ru');
  });

  it('大小写无关（内部 toLowerCase）', () => {
    expect(mapElectronLocaleToDashboardLang('ZH-HANT')).toBe('zh-Hant');
    expect(mapElectronLocaleToDashboardLang('FA-ir')).toBe('fa');
  });

  it('未命中 / 空 / 非字符串退化 → en', () => {
    expect(mapElectronLocaleToDashboardLang('en')).toBe('en');
    expect(mapElectronLocaleToDashboardLang('en-US')).toBe('en');
    expect(mapElectronLocaleToDashboardLang('ja')).toBe('en');
    expect(mapElectronLocaleToDashboardLang('')).toBe('en');
    expect(mapElectronLocaleToDashboardLang(undefined as unknown as string)).toBe('en');
  });
});
