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
} from '../server-list-helpers';

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
