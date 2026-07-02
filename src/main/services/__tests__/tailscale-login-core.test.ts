/**
 * tailscale-login-core 单测（Phase 2 按需瞬态登录核的纯逻辑）：
 * - buildTailscaleLoginConfig：登录专用 config 生成（无 inbound、log.level=info+timestamp、state_directory 正确、
 *   auth_key 永不出现、controlUrl/hostname/ephemeral 透传）。
 * - tailscaleEndpointInRunningCore：双写防护判定（always-emit 后：核在运行 且 该 TS 节点在运行配置里 → true，
 *   不再看 selected/authKey/stateExists）。
 *
 * getUserDataPath 依赖 electron app → mock 成可控 tmp 根，使 tailscaleStateDir 落到该 tmp。
 */
import * as path from 'path';

const FAKE_USER_DATA = '/tmp/flowz-test-userdata';
jest.mock('../../utils/paths', () => ({
  getUserDataPath: () => FAKE_USER_DATA,
}));

import { buildTailscaleLoginConfig, tailscaleEndpointInRunningCore } from '../tailscale-login-core';
import type { ServerConfig, UserConfig } from '../../../shared/types';

function tsServer(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'srv-1',
    name: 'my-ts',
    protocol: 'tailscale',
    address: '',
    port: 0,
    tailscaleSettings: {},
    ...over,
  } as ServerConfig;
}

describe('buildTailscaleLoginConfig', () => {
  it('无 inbound：只含 log / endpoints / outbounds', () => {
    const cfg = buildTailscaleLoginConfig(tsServer());
    expect(Object.keys(cfg).sort()).toEqual(['endpoints', 'log', 'outbounds']);
    expect((cfg as unknown as Record<string, unknown>).inbounds).toBeUndefined();
    expect((cfg as unknown as Record<string, unknown>).route).toBeUndefined();
    expect((cfg as unknown as Record<string, unknown>).experimental).toBeUndefined();
  });

  it('log.level=info + timestamp:true（强制，不读用户 logLevel）', () => {
    const cfg = buildTailscaleLoginConfig(tsServer());
    expect(cfg.log).toEqual({ level: 'info', timestamp: true });
  });

  it('endpoint：type=tailscale、tag=server.name、state_directory=<userData>/tailscale/<id>', () => {
    const cfg = buildTailscaleLoginConfig(tsServer({ id: 'abc', name: 'node-x' }));
    expect(cfg.endpoints).toHaveLength(1);
    const ep = cfg.endpoints[0];
    expect(ep.type).toBe('tailscale');
    expect(ep.tag).toBe('node-x');
    expect(ep.state_directory).toBe(path.join(FAKE_USER_DATA, 'tailscale', 'abc'));
  });

  it('direct outbound', () => {
    const cfg = buildTailscaleLoginConfig(tsServer());
    expect(cfg.outbounds).toEqual([{ type: 'direct', tag: 'direct' }]);
  });

  it('auth_key 永不出现（即便 server 配了 authKey）', () => {
    const cfg = buildTailscaleLoginConfig(
      tsServer({ tailscaleSettings: { authKey: 'tskey-auth-secret' } })
    );
    const ep = cfg.endpoints[0];
    expect(ep.auth_key).toBeUndefined();
    expect(JSON.stringify(cfg)).not.toContain('tskey-auth-secret');
    expect(JSON.stringify(cfg)).not.toContain('auth_key');
  });

  it('透传 controlUrl / hostname / ephemeral（有值才带）', () => {
    const cfg = buildTailscaleLoginConfig(
      tsServer({
        tailscaleSettings: {
          controlUrl: 'https://headscale.example.com',
          hostname: 'my-device',
          ephemeral: true,
        },
      })
    );
    const ep = cfg.endpoints[0];
    expect(ep.control_url).toBe('https://headscale.example.com');
    expect(ep.hostname).toBe('my-device');
    expect(ep.ephemeral).toBe(true);
  });

  it('空/未填的可选字段不带（最小 config）', () => {
    const cfg = buildTailscaleLoginConfig(
      tsServer({ tailscaleSettings: { controlUrl: '  ', hostname: '' } })
    );
    const ep = cfg.endpoints[0];
    expect(ep.control_url).toBeUndefined();
    expect(ep.hostname).toBeUndefined();
    expect(ep.ephemeral).toBeUndefined();
    // 不带任何运行期路由/出口字段（瞬态核只为拿 URL + 落 state）
    expect(ep.exit_node).toBeUndefined();
    expect(ep.advertise_routes).toBeUndefined();
    expect(ep.system_interface).toBeUndefined();
  });

  it('不传 api 入参 → 无 services（退回纯 stdout AUTH_URL 路径）', () => {
    const cfg = buildTailscaleLoginConfig(tsServer());
    expect(cfg.services).toBeUndefined();
  });

  it('传 api 入参 → 注入 1.14 管理 api service（type=api、listen=127.0.0.1、独立端口 + 随机 secret）', () => {
    const cfg = buildTailscaleLoginConfig(tsServer(), { port: 54321, secret: 'rndsecret' });
    expect(cfg.services).toEqual([
      { type: 'api', listen: '127.0.0.1', listen_port: 54321, secret: 'rndsecret' },
    ]);
  });

  it('api 入参 secret 为空串 → secret 字段省略（退化免认证）', () => {
    const cfg = buildTailscaleLoginConfig(tsServer(), { port: 1234, secret: '' });
    expect(cfg.services?.[0]).toEqual({ type: 'api', listen: '127.0.0.1', listen_port: 1234 });
    expect(cfg.services?.[0].secret).toBeUndefined();
  });
});

describe('tailscaleEndpointInRunningCore（双写防护判定：always-emit）', () => {
  const runningCfg = (over: Partial<UserConfig> = {}): UserConfig =>
    ({
      servers: [],
      selectedServerId: null,
      ...over,
    }) as UserConfig;

  it('主核未运行 → false（可起瞬态核）', () => {
    expect(tailscaleEndpointInRunningCore('s1', false, runningCfg())).toBe(false);
  });

  it('运行配置为 null → false', () => {
    expect(tailscaleEndpointInRunningCore('s1', true, null)).toBe(false);
  });

  it('节点不在运行配置里 → false（主核没带它的 endpoint）', () => {
    const cfg = runningCfg({ servers: [tsServer({ id: 'other' })] });
    expect(tailscaleEndpointInRunningCore('s1', true, cfg)).toBe(false);
  });

  it('在配置里即 true（always-emit）——未选中、无 authKey、无 state 也 true', () => {
    const cfg = runningCfg({ servers: [tsServer({ id: 's1' })], selectedServerId: 'other' });
    expect(tailscaleEndpointInRunningCore('s1', true, cfg)).toBe(true);
  });

  it('被选中 → true', () => {
    const cfg = runningCfg({ servers: [tsServer({ id: 's1' })], selectedServerId: 's1' });
    expect(tailscaleEndpointInRunningCore('s1', true, cfg)).toBe(true);
  });

  it('有 authKey → true', () => {
    const cfg = runningCfg({
      servers: [tsServer({ id: 's1', tailscaleSettings: { authKey: 'k' } })],
      selectedServerId: 'other',
    });
    expect(tailscaleEndpointInRunningCore('s1', true, cfg)).toBe(true);
  });

  it('非 tailscale 协议的同 id 节点 → false（只防 tailscale 双写）', () => {
    const cfg = runningCfg({
      servers: [tsServer({ id: 's1', protocol: 'wireguard' })],
      selectedServerId: 's1',
    });
    expect(tailscaleEndpointInRunningCore('s1', true, cfg)).toBe(false);
  });
});

// 瞬态登录核的「成功轮询生命周期」(runLoginPollLifecycle/makeLoginPoll/pollTailscaleLoginSuccess) 及
// Phase1 主核 watchTailscaleLogin 已剥离（stateExists 误判未认证为已登录是 #132 根因）：登录成功改由 1.14
// api STATUS 流（backendState→Running）反映，相应纯逻辑测试一并移除。双写防护 tailscaleEndpointInRunningCore
// 保留（startTailscaleLogin/tailscaleLogout 仍用），其覆盖见上方 describe。
