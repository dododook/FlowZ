/**
 * tailscaleNeedsLogin 角标判定单测（Phase 1：真实登录态驱动，非静态 !authKey）。
 * 三档：有 authKey / 无 authKey 但已登录(loggedIn) / 都无；外加非 Tailscale 节点恒 false。
 */
import { tailscaleNeedsLogin } from '../server-list-helpers';

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
