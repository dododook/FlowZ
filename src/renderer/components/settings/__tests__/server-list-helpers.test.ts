/**
 * tailscaleNeedsLogin 角标判定单测（Phase 1：真实登录态驱动，非静态 !authKey）。
 * 三档：有 authKey / 无 authKey 但已登录(loggedIn) / 都无；外加非 Tailscale 节点恒 false。
 */
import {
  tailscaleNeedsLogin,
  tailscaleLoggingIn,
  tailscaleLoginUiState,
  sortServers,
  meshIsExitCapable,
  meshInternetOff,
  flagAsset,
  getCountryCode,
} from '../server-list-helpers';
import { countryCodeToFlagAsset } from '../flag-assets';
import { FLAG_BODIES } from '../flag-assets.generated';
import regions from '../flag-regions.json';

// 仅取 tailscaleNeedsLogin 用到的字段，避免引 @/bridge/types（jest 无 @ 别名）。
const ts = (over: Record<string, unknown> = {}) =>
  ({ id: 'n1', name: 'ts', protocol: 'tailscale', ...over }) as any;

describe('tailscaleNeedsLogin', () => {
  it('有 authKey → 不需登录（false），与 loggedIn 无关', () => {
    expect(tailscaleNeedsLogin(ts({ tailscaleSettings: { authKey: 'tskey-abc' } }))).toBe(false);
    expect(tailscaleNeedsLogin(ts({ tailscaleSettings: { authKey: 'tskey-abc' } }), false)).toBe(
      false
    );
  });

  it('authKey 全空白 → 视同无（按 loggedIn 判）', () => {
    expect(tailscaleNeedsLogin(ts({ tailscaleSettings: { authKey: '   ' } }))).toBe(true);
    expect(tailscaleNeedsLogin(ts({ tailscaleSettings: { authKey: '   ' } }), true)).toBe(false);
  });

  it('无 authKey 但 loggedIn=true（state 已落盘）→ 不需登录（false）', () => {
    expect(tailscaleNeedsLogin(ts(), true)).toBe(false);
    expect(tailscaleNeedsLogin(ts({ tailscaleSettings: {} }), true)).toBe(false);
  });

  it('无 authKey 且 loggedIn=false（缺省）→ 需登录（true）', () => {
    expect(tailscaleNeedsLogin(ts())).toBe(true);
    expect(tailscaleNeedsLogin(ts(), false)).toBe(true);
    expect(tailscaleNeedsLogin(ts({ tailscaleSettings: {} }))).toBe(true);
  });

  it('非 Tailscale 节点 → 恒 false（即使 loggedIn 缺省）', () => {
    expect(tailscaleNeedsLogin(ts({ protocol: 'vless' }))).toBe(false);
    expect(tailscaleNeedsLogin(ts({ protocol: 'wireguard' }), false)).toBe(false);
  });
});

describe('flagAsset（节点名地区 → 本地 SVG 国旗资源）', () => {
  it('识别到地区时返回本地 SVG data URI，不依赖系统 emoji 字体', () => {
    const flag = flagAsset('HK-01');
    expect(flag).toMatchObject({ code: 'hk', label: 'Hong Kong' });
    expect(flag?.src).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(flag!.src)).toContain('<svg');
  });

  it('识别不到地区 → null（调用方省略国旗）', () => {
    expect(flagAsset('unknown-node')).toBeNull();
  });
});

type Region = {
  code: string;
  label: string;
  zh: string[];
  en: string[];
  noAlpha2?: boolean;
  patterns?: string[];
};
const REGIONS = regions as Region[];

describe('国旗全球化 · manifest ↔ FLAG_BODIES 1:1', () => {
  it('区域数 = 74（覆盖清单 §2）', () => {
    expect(REGIONS.length).toBe(74);
    expect(Object.keys(FLAG_BODIES).length).toBe(74);
  });

  it('manifest 每个 code 都有对应旗面，且无孤儿旗面（双向 1:1）', () => {
    const manifestCodes = REGIONS.map((r) => r.code).sort();
    const bodyCodes = Object.keys(FLAG_BODIES).sort();
    expect(bodyCodes).toEqual(manifestCodes);
    for (const r of REGIONS) expect(typeof FLAG_BODIES[r.code]).toBe('string');
  });

  it('每面旗均携带原库 3:2 viewBox 的嵌套 <svg>（30×20 外框，零裁切）', () => {
    for (const r of REGIONS) {
      expect(FLAG_BODIES[r.code]).toMatch(/^<svg viewBox="[^"]+" width="30" height="20">/);
      expect(FLAG_BODIES[r.code]).not.toContain('xmlns'); // strip 掉（父级 flagSvg 已有）
    }
  });

  it('token 归一化后跨区域唯一（无 manifest 重复 → 无 code 覆盖）', () => {
    const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
    const seen = new Map<string, string>();
    for (const r of REGIONS) {
      const keys = [...r.zh, ...r.en];
      if (!r.noAlpha2) keys.push(r.code);
      for (const k of keys) {
        const nk = norm(k);
        const prev = seen.get(nk);
        if (prev && prev !== r.code) throw new Error(`token "${k}" 冲突：${prev} vs ${r.code}`);
        seen.set(nk, r.code);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });
});

describe('国旗全球化 · 每 asset 波浪包装外壳继承', () => {
  it('每个 code 的 src decode 后含 viewBox="0 0 30 20" 外壳与 clip-path（flagSvg 单一真值）', () => {
    for (const r of REGIONS) {
      const asset = countryCodeToFlagAsset(r.code);
      expect(asset).not.toBeNull();
      expect(asset!.code).toBe(r.code);
      expect(asset!.label).toBe(r.label); // label 查 manifest
      const decoded = decodeURIComponent(asset!.src);
      expect(decoded).toContain('viewBox="0 0 30 20"');
      expect(decoded).toContain('clip-path');
    }
  });
});

describe('getCountryCode · emoji 区域指示符通用解码（零表覆盖全 ISO）', () => {
  it('🇩🇰 节点 → dk（旧 23 表外国家，证明零表扩展）', () => {
    expect(getCountryCode('🇩🇰 节点')).toBe('dk');
  });

  it('🇭🇰 香港 → hk；🇺🇸 → us（emoji 优先于 token）', () => {
    expect(getCountryCode('🇭🇰 香港')).toBe('hk');
    expect(getCountryCode('🇺🇸')).toBe('us');
  });

  it('emoji 解码结果不在 74 集合内（如 🇱🇰 斯里兰卡）→ 回落 token → null', () => {
    expect(getCountryCode('🇱🇰 srilanka')).toBeNull();
  });
});

describe('getCountryCode · §3 陷阱表逐条', () => {
  const cases: Array<[string, string | null]> = [
    ['russia', 'ru'], // 含 us：边界 + 更长 token
    ['north', null], // 含 th：边界，不误判
    ['berlin', 'de'], // 含 in：边界 + city token
    ['madrid', 'es'], // 含 id：边界 + city token
    ['montreal', 'ca'], // 含 tr：边界 + city token
    ['sweden', 'se'], // 含 de：边界 + 更长 token
    ['印度尼西亚', 'id'], // 含 印度：全局最长优先（修现状 bug）
    ['印度', 'in'], // 印度本身仍 → in
    ['罗马尼亚', 'ro'], // 含 罗马(it 城市)：全局最长优先
    ['US CN2 GIA', 'us'], // cn 线路标签：最早位置 + cn (?!2)
    ['No.1 香港', 'hk'], // no=挪威：no 行 noAlpha2
    ['Powered by X', null], // by=白俄：by 行 noAlpha2
    ['XX Co. 节点', null], // co=哥伦比亚：co 行 noAlpha2
    ['unknown-node', null], // no/de 子串：noAlpha2(no)+边界(de 前是 o)
    ['US Georgia Atlanta', 'us'], // georgia=格鲁吉亚：us 位置更早（残余歧义接受）
  ];
  it.each(cases)('getCountryCode(%p) → %p', (input: string, expected: string | null) => {
    expect(getCountryCode(input)).toBe(expected);
  });
});

describe('getCountryCode · 新增区域正/负样本（数据驱动扩展证明）', () => {
  it('城市/别名命中新覆盖国家', () => {
    expect(getCountryCode('Frankfurt 节点')).toBe('de');
    expect(getCountryCode('hongkong')).toBe('hk'); // 无分隔符多词 token 归一
    expect(getCountryCode('Ho Chi Minh 01')).toBe('vn');
    expect(getCountryCode('Warsaw-PL')).toBe('pl');
    expect(getCountryCode('Sao Paulo')).toBe('br');
  });

  it('CN2 线路不误判为 cn；纯 cn 命中', () => {
    expect(getCountryCode('US CN2 广州')).toBe('us'); // 最早位置 us
    expect(getCountryCode('CN 上海')).toBe('cn');
    expect(getCountryCode('香港 CN2 中转')).toBe('hk'); // 最早位置 香港
  });
});

describe('统一节点卡 · TS 登录三态→角标映射（批3b：退役单例卡后 ServerCard 承载状态显示）', () => {
  // 复刻 ServerCard 的角标优先级：loggingIn 优先，needs-login 仅在 !loggingIn 时显示。
  // 三态 = 交互登录型（无 authKey）的 needs-login / logging-in / connected → 卡片有效角标。
  const badge = (hasAuthUrl: boolean, loggedIn: boolean): 'logging-in' | 'needs-login' | 'none' => {
    const s = ts();
    if (tailscaleLoggingIn(s, hasAuthUrl, loggedIn)) return 'logging-in';
    if (tailscaleNeedsLogin(s, loggedIn)) return 'needs-login';
    return 'none';
  };

  it('needs-login（未登录 · 无 authUrl）→ 卡片显「Log in」角标', () => {
    expect(badge(false, false)).toBe('needs-login');
  });

  it('logging-in（未登录 · 有 authUrl）→ 卡片显「登录中」角标（优先于 needs-login）', () => {
    expect(badge(true, false)).toBe('logging-in');
    // 优先级证据：此态下 needsLogin 谓词本身仍为真，但 loggingIn 抢先。
    expect(tailscaleNeedsLogin(ts(), false)).toBe(true);
    expect(tailscaleLoggingIn(ts(), true, false)).toBe(true);
  });

  it('connected（loggedIn=true）→ 常规卡，无登录角标（不论 authUrl 残留）', () => {
    expect(badge(false, true)).toBe('none');
    expect(badge(true, true)).toBe('none');
  });

  it('authKey 静态形态（key-ready）→ 无登录角标（既不 needs-login 也不 logging-in）', () => {
    const keyed = ts({ tailscaleSettings: { authKey: 'tskey-x' } });
    expect(tailscaleNeedsLogin(keyed, false)).toBe(false);
    expect(tailscaleLoggingIn(keyed, true, false)).toBe(false);
  });
});

describe('tailscaleLoginUiState（表单登录区三态）', () => {
  it('新建态（无 id）→ none，与 loggedIn/authKey 无关', () => {
    expect(tailscaleLoginUiState(false, false, false)).toBe('none');
    expect(tailscaleLoginUiState(false, true, false)).toBe('none');
    expect(tailscaleLoginUiState(false, false, true)).toBe('none');
  });

  it('已登录 → loggedIn（优先于 authKey）', () => {
    expect(tailscaleLoginUiState(true, true, false)).toBe('loggedIn');
    expect(tailscaleLoginUiState(true, true, true)).toBe('loggedIn');
  });

  it('有 id、未登录、未填 authKey → needsLogin', () => {
    expect(tailscaleLoginUiState(true, false, false)).toBe('needsLogin');
  });

  it('有 id、未登录、已填 authKey（pre-auth）→ none（不显交互登录区）', () => {
    expect(tailscaleLoginUiState(true, false, true)).toBe('none');
  });
});

describe('meshIsExitCapable（组网节点「出口」能力 chip 判定）', () => {
  const node = (over: Record<string, unknown> = {}) =>
    ({ id: 'n1', name: 'm', protocol: 'wireguard', ...over }) as any;

  it('WireGuard 默认（未显式关外网）→ 可作出口（true）', () => {
    expect(meshIsExitCapable(node())).toBe(true);
    expect(meshIsExitCapable(node({ wireguardSettings: { allowInternet: true } }))).toBe(true);
  });

  it('WireGuard 显式关外网（allowInternet=false）→ 仅内网、不可作出口（false）', () => {
    expect(meshIsExitCapable(node({ wireguardSettings: { allowInternet: false } }))).toBe(false);
  });

  it('Tailscale 配了出口设备（exitNode）→ 可作出口（true）；未配 → false', () => {
    expect(
      meshIsExitCapable(node({ protocol: 'tailscale', tailscaleSettings: { exitNode: 'peer-1' } }))
    ).toBe(true);
    expect(meshIsExitCapable(node({ protocol: 'tailscale', tailscaleSettings: {} }))).toBe(false);
    expect(
      meshIsExitCapable(node({ protocol: 'tailscale', tailscaleSettings: { exitNode: '  ' } }))
    ).toBe(false);
  });

  it('非组网协议（vless/trojan）→ 恒 false（出口能力由协议隐含，不标注）', () => {
    expect(meshIsExitCapable(node({ protocol: 'vless' }))).toBe(false);
    expect(meshIsExitCapable(node({ protocol: 'trojan' }))).toBe(false);
  });

  it('与 meshInternetOff 对 endpoint 节点互斥（恰一为真）', () => {
    const full = node({ wireguardSettings: { allowInternet: true } });
    const lanOnly = node({ wireguardSettings: { allowInternet: false } });
    expect(meshIsExitCapable(full)).toBe(true);
    expect(meshInternetOff(full)).toBe(false);
    expect(meshIsExitCapable(lanOnly)).toBe(false);
    expect(meshInternetOff(lanOnly)).toBe(true);
  });
});

describe('sortServers（含测速空结果优雅降级）', () => {
  const srv = (id: string, name: string, protocol = 'vless', address = '') =>
    ({ id, name, protocol, address }) as any;
  const ids = (list: any[]) => list.map((s) => s.id);

  it('name 升/降序', () => {
    const list = [srv('1', 'C'), srv('2', 'A'), srv('3', 'B')];
    expect(ids(sortServers(list, 'name', 'asc', {}))).toEqual(['2', '3', '1']);
    expect(ids(sortServers(list, 'name', 'desc', {}))).toEqual(['1', '3', '2']);
  });

  it('latency 全无结果（latencyMap 空）→ 退化为名称升序（空测速=稳定默认序，非原始插入序）', () => {
    const list = [srv('1', 'C'), srv('2', 'A'), srv('3', 'B')];
    expect(ids(sortServers(list, 'latency', 'asc', {}))).toEqual(['2', '3', '1']);
    // desc 下「全空」仍按名称升序（无结果不随 order 翻转，保证稳定）
    expect(ids(sortServers(list, 'latency', 'desc', {}))).toEqual(['2', '3', '1']);
  });

  it('latency 部分有结果 → 已测按延迟在前，未测沉底且按名称', () => {
    const list = [srv('1', 'Z'), srv('2', 'A'), srv('3', 'M'), srv('4', 'B')];
    // 1=80ms, 3=20ms 已测（按延迟在前）；2(A)、4(B) 未测沉底、按名称升序
    const lat = { '1': 80, '3': 20 };
    expect(ids(sortServers(list, 'latency', 'asc', lat))).toEqual(['3', '1', '2', '4']);
  });

  it('latency 失败(-1) 视同无结果沉底（不当作 0/最快）', () => {
    const list = [srv('1', 'A'), srv('2', 'B')];
    expect(ids(sortServers(list, 'latency', 'asc', { '1': -1, '2': 50 }))).toEqual(['2', '1']);
  });

  it('latency 全有结果 → 纯延迟序（asc 快在前 / desc 慢在前）', () => {
    const list = [srv('1', 'A'), srv('2', 'B'), srv('3', 'C')];
    const lat = { '1': 90, '2': 30, '3': 60 };
    expect(ids(sortServers(list, 'latency', 'asc', lat))).toEqual(['2', '3', '1']);
    expect(ids(sortServers(list, 'latency', 'desc', lat))).toEqual(['1', '3', '2']);
  });

  it('不修改入参数组（返回新数组）', () => {
    const list = [srv('1', 'B'), srv('2', 'A')];
    const out = sortServers(list, 'name', 'asc', {});
    expect(out).not.toBe(list);
    expect(ids(list)).toEqual(['1', '2']); // 原数组次序不变
  });
});
