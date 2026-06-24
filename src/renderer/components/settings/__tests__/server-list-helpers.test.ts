/**
 * tailscaleNeedsLogin 角标判定单测（Phase 1：真实登录态驱动，非静态 !authKey）。
 * 三档：有 authKey / 无 authKey 但已登录(loggedIn) / 都无；外加非 Tailscale 节点恒 false。
 */
import { tailscaleNeedsLogin, tailscaleLoginUiState, sortServers } from '../server-list-helpers';

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
