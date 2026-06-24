/**
 * Tailscale 单例连接卡状态派生单测：认证形态分流（authKey 静态 vs 交互登录）+ 五态全覆盖 + 优先级。
 */
import { deriveTsCardState } from '../tailscale-conn-state';
import type { ServerConfig } from '../types';

function tsNode(authKey?: string): ServerConfig {
  return {
    id: 'ts1',
    name: 'Tailscale',
    protocol: 'tailscale',
    address: '',
    port: 0,
    tailscaleSettings: authKey ? { authKey } : {},
  } as ServerConfig;
}

describe('deriveTsCardState', () => {
  it('无 TS 节点 → no-node', () => {
    expect(deriveTsCardState(undefined, undefined, false)).toBe('no-node');
    expect(deriveTsCardState(undefined, true, true)).toBe('no-node');
  });

  it('有 authKey → key-ready（静态形态，不论登录态/authUrl）', () => {
    expect(deriveTsCardState(tsNode('k'), undefined, false)).toBe('key-ready');
    expect(deriveTsCardState(tsNode('k'), false, true)).toBe('key-ready');
    expect(deriveTsCardState(tsNode('k'), true, false)).toBe('key-ready');
  });

  it('authKey 空白串视作无 key（不当静态形态）', () => {
    expect(deriveTsCardState(tsNode('   '), undefined, false)).toBe('needs-login');
  });

  it('交互型：有 authUrl 且未登录 → logging-in', () => {
    expect(deriveTsCardState(tsNode(), undefined, true)).toBe('logging-in');
    expect(deriveTsCardState(tsNode(), false, true)).toBe('logging-in');
  });

  it('交互型：loggedIn=true → connected（即使仍有 authUrl，登录成功优先）', () => {
    expect(deriveTsCardState(tsNode(), true, false)).toBe('connected');
    expect(deriveTsCardState(tsNode(), true, true)).toBe('connected');
  });

  it('交互型：无 loggedIn 无 authUrl → needs-login', () => {
    expect(deriveTsCardState(tsNode(), undefined, false)).toBe('needs-login');
    expect(deriveTsCardState(tsNode(), false, false)).toBe('needs-login');
  });
});
