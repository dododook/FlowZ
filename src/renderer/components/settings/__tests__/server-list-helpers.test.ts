/**
 * tailscaleNeedsLogin 角标判定单测（Phase 1：真实登录态驱动，非静态 !authKey）。
 * 三档：有 authKey / 无 authKey 但已登录(loggedIn) / 都无；外加非 Tailscale 节点恒 false。
 */
import {
  tailscaleNeedsLogin,
  tailscaleLoginUiState,
  tailscaleStatusChecking,
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

describe('tailscaleStatusChecking（代理关时「检测中」中性态）', () => {
  // 签名：(server, loggedInKnown, proxyRunning, probing)
  it('代理关 + 探针在飞 + loggedIn 未知 + 无 authKey → 检测中（true）', () => {
    expect(tailscaleStatusChecking(ts(), false, false, true)).toBe(true);
    expect(tailscaleStatusChecking(ts({ tailscaleSettings: {} }), false, false, true)).toBe(true);
  });

  it('loggedIn 已知（某次 STATUS 已确定）→ 退出检测态（false）', () => {
    expect(tailscaleStatusChecking(ts(), true, false, true)).toBe(false);
  });

  it('代理在运行（主核 STATUS 已驱动真值）→ false', () => {
    expect(tailscaleStatusChecking(ts(), false, true, true)).toBe(false);
  });

  it('探针未在飞 → false（无探测进行中，不显检测中）', () => {
    expect(tailscaleStatusChecking(ts(), false, false, false)).toBe(false);
  });

  it('有 authKey（免交互登录、恒已登录态）→ 不参与检测（false）', () => {
    expect(
      tailscaleStatusChecking(ts({ tailscaleSettings: { authKey: 'tskey-x' } }), false, false, true)
    ).toBe(false);
    // 全空白 authKey 视同无 → 仍可检测中
    expect(
      tailscaleStatusChecking(ts({ tailscaleSettings: { authKey: '  ' } }), false, false, true)
    ).toBe(true);
  });

  it('非 Tailscale 节点 → 恒 false', () => {
    expect(tailscaleStatusChecking(ts({ protocol: 'wireguard' }), false, false, true)).toBe(false);
    expect(tailscaleStatusChecking(ts({ protocol: 'vless' }), false, false, true)).toBe(false);
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
