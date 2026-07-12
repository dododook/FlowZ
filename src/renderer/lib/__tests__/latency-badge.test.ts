/**
 * 延迟徽标状态机单测：优先级 出口无效 > 未登录 > 超时/值 > N/A > 未测，覆盖设计 §9.5 矩阵 A 关键行
 * （A10/A12/A14-A20）+ 陈旧判定 + TS authKey 形态豁免 + exit-invalid 的选中/running 前提。纯函数、注入 now/态。
 */
import { deriveLatencyBadge, STALE_MS, type LatencyBadgeInput } from '../latency-badge';
import type { ServerConfig } from '../../../shared/types';

const NOW = 1_000_000;

function srv(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'n1',
    name: 'Node 1',
    protocol: 'vless',
    address: '1.2.3.4',
    port: 443,
    ...over,
  } as ServerConfig;
}
const tsInteractive = srv({ id: 'ts1', name: 'TS', protocol: 'tailscale', tailscaleSettings: {} });
const tsKey = srv({
  id: 'ts2',
  name: 'TS-key',
  protocol: 'tailscale',
  tailscaleSettings: { authKey: 'tskey-abc' },
});

function input(over: Partial<LatencyBadgeInput> = {}): LatencyBadgeInput {
  return {
    server: srv(),
    latency: undefined,
    testedAt: undefined,
    now: NOW,
    tsLoggedIn: undefined,
    isSelectedExit: false,
    proxyRunning: false,
    proxyBlocked: undefined,
    speedTestAttempted: false,
    ...over,
  };
}

describe('deriveLatencyBadge', () => {
  it('普通 IP + 有值 → value（新鲜）', () => {
    expect(deriveLatencyBadge(input({ latency: 50, testedAt: NOW }))).toEqual({
      kind: 'value',
      latency: 50,
      stale: false,
    });
  });

  it('普通 IP + -1 → timeout', () => {
    expect(deriveLatencyBadge(input({ latency: -1, testedAt: NOW }))).toEqual({
      kind: 'timeout',
      stale: false,
    });
  });

  it('普通 IP + 无值（可测）→ untested', () => {
    expect(deriveLatencyBadge(input())).toEqual({ kind: 'untested' });
  });

  it('陈旧：testedAt 超 STALE_MS → value.stale=true', () => {
    const badge = deriveLatencyBadge(input({ latency: 80, testedAt: NOW - STALE_MS - 1 }));
    expect(badge).toEqual({ kind: 'value', latency: 80, stale: true });
  });

  it('A10 TS(authKey 形态) 有伴测值 → value（不进登录态，等同 WG）', () => {
    expect(deriveLatencyBadge(input({ server: tsKey, latency: 66, testedAt: NOW }))).toEqual({
      kind: 'value',
      latency: 66,
      stale: false,
    });
  });

  it('A11 TS(authKey) 无值非选中 + 点过测速 → na', () => {
    expect(deriveLatencyBadge(input({ server: tsKey, speedTestAttempted: true }))).toEqual({
      kind: 'na',
    });
  });

  it('Q3 不可测节点未点过测速 → untested（「—」同未测，非「不支持测速」）', () => {
    expect(deriveLatencyBadge(input({ server: tsKey, speedTestAttempted: false }))).toEqual({
      kind: 'untested',
    });
  });

  it('A12 TS 交互未登录（tsLoggedIn=false）→ not-logged-in（无值）', () => {
    expect(deriveLatencyBadge(input({ server: tsInteractive, tsLoggedIn: false }))).toEqual({
      kind: 'not-logged-in',
    });
  });

  it('A12 TS 交互未登录（tsLoggedIn=undefined）→ not-logged-in', () => {
    expect(deriveLatencyBadge(input({ server: tsInteractive }))).toEqual({
      kind: 'not-logged-in',
    });
  });

  it('P2>P3：未登录压过残留旧值（旧延迟属上一有效期，不显）', () => {
    expect(
      deriveLatencyBadge(
        input({ server: tsInteractive, tsLoggedIn: false, latency: 42, testedAt: NOW })
      )
    ).toEqual({ kind: 'not-logged-in' });
  });

  it('A14-16 TS 已登录 + 选中 + running + 出口无效 → exit-invalid（携 reason）', () => {
    expect(
      deriveLatencyBadge(
        input({
          server: tsInteractive,
          tsLoggedIn: true,
          isSelectedExit: true,
          proxyRunning: true,
          proxyBlocked: 'ts-exit-not-advertised',
        })
      )
    ).toEqual({ kind: 'exit-invalid', reason: 'ts-exit-not-advertised' });
  });

  it('P1>P3：出口无效压过已有旧值', () => {
    const badge = deriveLatencyBadge(
      input({
        server: tsInteractive,
        tsLoggedIn: true,
        isSelectedExit: true,
        proxyRunning: true,
        proxyBlocked: 'ts-exit-device-offline',
        latency: 30,
        testedAt: NOW,
      })
    );
    expect(badge).toEqual({ kind: 'exit-invalid', reason: 'ts-exit-device-offline' });
  });

  it('P1>P2：exit-invalid 抢占（纵深防御，即便未登录标记也先判无效）', () => {
    const badge = deriveLatencyBadge(
      input({
        server: tsInteractive,
        tsLoggedIn: false,
        isSelectedExit: true,
        proxyRunning: true,
        proxyBlocked: 'ts-no-exit-device',
      })
    );
    expect(badge).toEqual({ kind: 'exit-invalid', reason: 'ts-no-exit-device' });
  });

  it('A17 TS 已登录 + 选中 + running + 出口有效 + 伴测值 → value（用户诉求核心）', () => {
    expect(
      deriveLatencyBadge(
        input({
          server: tsInteractive,
          tsLoggedIn: true,
          isSelectedExit: true,
          proxyRunning: true,
          latency: 77,
          testedAt: NOW,
        })
      )
    ).toEqual({ kind: 'value', latency: 77, stale: false });
  });

  it('A19 TS 已登录非选中 无值 + 点过测速 → na（无 per-node 出口态，不伪造）', () => {
    expect(
      deriveLatencyBadge(
        input({
          server: tsInteractive,
          tsLoggedIn: true,
          isSelectedExit: false,
          speedTestAttempted: true,
        })
      )
    ).toEqual({ kind: 'na' });
  });

  it('exit-invalid 需选中：proxyBlocked 置起但非选中 → 不判无效（落 na，点过测速）', () => {
    expect(
      deriveLatencyBadge(
        input({
          server: tsInteractive,
          tsLoggedIn: true,
          isSelectedExit: false,
          proxyRunning: true,
          proxyBlocked: 'ts-no-exit-device',
          speedTestAttempted: true,
        })
      )
    ).toEqual({ kind: 'na' });
  });

  it('A20 exit-invalid 需 running：proxy off → 不判无效（有旧值显旧值）', () => {
    expect(
      deriveLatencyBadge(
        input({
          server: tsInteractive,
          tsLoggedIn: true,
          isSelectedExit: true,
          proxyRunning: false,
          proxyBlocked: 'ts-exit-device-offline',
          latency: 90,
          testedAt: NOW,
        })
      )
    ).toEqual({ kind: 'value', latency: 90, stale: false });
  });

  it('authKey 纯空白 → 仍算交互式 TS（trim 后空）→ 未登录', () => {
    const tsBlank = srv({ id: 'ts3', protocol: 'tailscale', tailscaleSettings: { authKey: '  ' } });
    expect(deriveLatencyBadge(input({ server: tsBlank, tsLoggedIn: false }))).toEqual({
      kind: 'not-logged-in',
    });
  });

  it('非 TS 节点即便 proxyBlocked 置起也不判 exit-invalid（isTs 守卫）', () => {
    // proxyBlocked 结构上仅 TS 出口置起；显式守卫防未来对非 TS 出口误置时错标。
    expect(
      deriveLatencyBadge(
        input({
          server: srv({ protocol: 'vless' }),
          isSelectedExit: true,
          proxyRunning: true,
          proxyBlocked: 'ts-no-exit-device',
        })
      )
    ).toEqual({ kind: 'untested' });
  });

  it('timeout + 陈旧 → timeout.stale=true', () => {
    expect(deriveLatencyBadge(input({ latency: -1, testedAt: NOW - STALE_MS - 1 }))).toEqual({
      kind: 'timeout',
      stale: true,
    });
  });

  it('custom endpoint（非 TS 不可测）无值 + 点过测速 → na', () => {
    const ep = srv({
      id: 'ep',
      protocol: 'custom',
      customSettings: { isEndpoint: true, outbound: { type: 'wireguard' } },
    });
    expect(deriveLatencyBadge(input({ server: ep, speedTestAttempted: true }))).toEqual({
      kind: 'na',
    });
  });
});

describe('deriveLatencyBadge §16 reason（path-aware / not-in-pool）', () => {
  const tsExit = srv({
    id: 'tse',
    name: 'TS-exit',
    protocol: 'tailscale',
    tailscaleSettings: { exitNode: '100.64.0.1' },
  });
  const tsMesh = srv({
    id: 'tsm',
    name: 'TS-mesh',
    protocol: 'tailscale',
    tailscaleSettings: {},
  });

  it('TS-exit + 代理关 + 已登录 + 点过测速 → na reason=ts-needs-core', () => {
    expect(
      deriveLatencyBadge(
        input({ server: tsExit, tsLoggedIn: true, proxyRunning: false, speedTestAttempted: true })
      )
    ).toEqual({ kind: 'na', reason: 'ts-needs-core' });
  });

  it('TS-exit + 代理开 + 已登录 + 无值 → untested（可测、待测，非 na）', () => {
    expect(
      deriveLatencyBadge(input({ server: tsExit, tsLoggedIn: true, proxyRunning: true }))
    ).toEqual({ kind: 'untested' });
  });

  it('TS-mesh-only（无 exitNode）+ 已登录 + 点过测速 → 平凡 na（恒不可测，无 reason）', () => {
    expect(
      deriveLatencyBadge(
        input({ server: tsMesh, tsLoggedIn: true, proxyRunning: true, speedTestAttempted: true })
      )
    ).toEqual({ kind: 'na' });
  });

  it('普通节点 + notInPool + 无值 → untested reason=not-in-pool', () => {
    expect(deriveLatencyBadge(input({ notInPool: true }))).toEqual({
      kind: 'untested',
      reason: 'not-in-pool',
    });
  });

  it('普通节点 + notInPool + 有值 → value（拿到真值即不再标 not-in-pool）', () => {
    expect(
      deriveLatencyBadge(input({ notInPool: true, latency: 42, testedAt: NOW }))
    ).toEqual({ kind: 'value', latency: 42, stale: false });
  });
});
