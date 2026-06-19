/**
 * tailscale-login-core 单测（Phase 2 按需瞬态登录核的纯逻辑）：
 * - buildTailscaleLoginConfig：登录专用 config 生成（无 inbound、log.level=info+timestamp、state_directory 正确、
 *   auth_key 永不出现、controlUrl/hostname/ephemeral 透传）。
 * - tailscaleEndpointInRunningCore：双写防护判定（节点在运行主核中→true，按 buildOutbounds 发射门控
 *   「选中 OR 就绪(authKey||state)」逐档覆盖）。
 *
 * getUserDataPath 依赖 electron app → mock 成可控 tmp 根，使 tailscaleStateDir 落到该 tmp。
 */
import * as path from 'path';

const FAKE_USER_DATA = '/tmp/flowz-test-userdata';
jest.mock('../../utils/paths', () => ({
  getUserDataPath: () => FAKE_USER_DATA,
}));

import {
  buildTailscaleLoginConfig,
  tailscaleEndpointInRunningCore,
  runLoginPollLifecycle,
  makeLoginPoll,
} from '../tailscale-login-core';
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
});

describe('tailscaleEndpointInRunningCore（双写防护判定）', () => {
  const runningCfg = (over: Partial<UserConfig> = {}): UserConfig =>
    ({
      servers: [],
      selectedServerId: null,
      ...over,
    }) as UserConfig;

  it('主核未运行 → false（可起瞬态核）', () => {
    expect(tailscaleEndpointInRunningCore('s1', false, runningCfg(), false)).toBe(false);
  });

  it('运行配置为 null → false', () => {
    expect(tailscaleEndpointInRunningCore('s1', true, null, false)).toBe(false);
  });

  it('节点不在运行配置里 → false（主核没带它的 endpoint）', () => {
    const cfg = runningCfg({ servers: [tsServer({ id: 'other' })] });
    expect(tailscaleEndpointInRunningCore('s1', true, cfg, false)).toBe(false);
  });

  it('在配置里但既未选中也未就绪（无 authKey、无 state）→ false（主核就绪门控未发射）', () => {
    const cfg = runningCfg({ servers: [tsServer({ id: 's1' })], selectedServerId: 'other' });
    expect(tailscaleEndpointInRunningCore('s1', true, cfg, false)).toBe(false);
  });

  it('被选中 → true（选中即发射，主核已带 endpoint）', () => {
    const cfg = runningCfg({ servers: [tsServer({ id: 's1' })], selectedServerId: 's1' });
    expect(tailscaleEndpointInRunningCore('s1', true, cfg, false)).toBe(true);
  });

  it('就绪：有 authKey → true', () => {
    const cfg = runningCfg({
      servers: [tsServer({ id: 's1', tailscaleSettings: { authKey: 'k' } })],
      selectedServerId: 'other',
    });
    expect(tailscaleEndpointInRunningCore('s1', true, cfg, false)).toBe(true);
  });

  it('就绪：state 目录存在（stateExists=true）→ true', () => {
    const cfg = runningCfg({ servers: [tsServer({ id: 's1' })], selectedServerId: 'other' });
    expect(tailscaleEndpointInRunningCore('s1', true, cfg, true)).toBe(true);
  });

  it('非 tailscale 协议的同 id 节点 → false（只防 tailscale 双写）', () => {
    const cfg = runningCfg({
      servers: [tsServer({ id: 's1', protocol: 'wireguard' })],
      selectedServerId: 's1',
    });
    expect(tailscaleEndpointInRunningCore('s1', true, cfg, true)).toBe(false);
  });
});

describe('runLoginPollLifecycle（瞬态登录生命周期：成功/超时/取消都杀核）', () => {
  it('success → 发 onSuccess + 杀核', async () => {
    const onSuccess = jest.fn();
    const kill = jest.fn();
    const result = await runLoginPollLifecycle({
      poll: async () => 'success',
      onSuccess,
      kill,
    });
    expect(result).toBe('success');
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('timeout → 不发 onSuccess，仍杀核', async () => {
    const onSuccess = jest.fn();
    const kill = jest.fn();
    const result = await runLoginPollLifecycle({
      poll: async () => 'timeout',
      onSuccess,
      kill,
    });
    expect(result).toBe('timeout');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('cancelled → 不发 onSuccess，仍杀核', async () => {
    const onSuccess = jest.fn();
    const kill = jest.fn();
    const result = await runLoginPollLifecycle({
      poll: async () => 'cancelled',
      onSuccess,
      kill,
    });
    expect(result).toBe('cancelled');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('poll 抛错也兜底杀核（防 unhandled rejection 后残留进程）', async () => {
    const onSuccess = jest.fn();
    const kill = jest.fn();
    await expect(
      runLoginPollLifecycle({
        poll: async () => {
          throw new Error('boom');
        },
        onSuccess,
        kill,
      })
    ).rejects.toThrow('boom');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledTimes(1);
  });
});

describe('makeLoginPoll（isCancelled 透传：瞬态核自死即收敛，不空转到超时）', () => {
  // 进程自行崩溃/退出时 ProxyManager 的 finalize 置 handle.cancelled=true → 此 isCancelled 翻 true →
  // makeLoginPoll 产出的 poll 立即返回 cancelled（不等满 2min 超时）。回归防护：守住 HIGH-2 修复。
  it('isCancelled 一开始即 true（进程已死）→ cancelled，stateExists 不被调用（零等待收敛）', async () => {
    const stateExists = jest.fn(() => false);
    const poll = makeLoginPoll(stateExists, () => true);
    await expect(poll()).resolves.toBe('cancelled');
    expect(stateExists).not.toHaveBeenCalled();
  });

  it('登录成功（stateExists 先 true）→ success（cancelled 优先级低于已落盘的 state）', async () => {
    const poll = makeLoginPoll(
      () => true,
      () => false
    );
    await expect(poll()).resolves.toBe('success');
  });
});
