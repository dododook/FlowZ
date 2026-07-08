/**
 * deriveTsExitWarning 纯谓词单测（§H.2 全矩阵：协议 × proxyMode × loggedIn × exitNode × running × peer 三态）。
 */
import { deriveTsExitWarning } from '../tailscale-exit-warning';
import type { TsExitWarningInput } from '../tailscale-exit-warning';
import { meshSelectedExitFallsBackToDirect } from '../endpoint-routes';
import type { ServerConfig, UserConfig } from '../types';
import type { TailscaleStatusPeer } from '../tailscale-status';

function tsNode(exitNode?: string): ServerConfig {
  return {
    id: 'ts1',
    name: 'Tailscale',
    protocol: 'tailscale',
    address: '',
    port: 0,
    tailscaleSettings: exitNode === undefined ? {} : { exitNode },
  } as ServerConfig;
}
function peer(over: Partial<TailscaleStatusPeer>): TailscaleStatusPeer {
  return {
    hostName: 'dev',
    ip: '100.1.1.1',
    online: true,
    exitNode: false,
    exitNodeOption: true,
    active: false,
    ...over,
  };
}

/** 基线：选中 TS 出口、已登录、非 direct、代理运行、无 exit_node → no-exit-device。 */
function base(over: Partial<TsExitWarningInput> = {}): TsExitWarningInput {
  return {
    selectedServer: tsNode(),
    loggedIn: true,
    proxyModeDirect: false,
    proxyRunning: true,
    peers: undefined,
    ...over,
  };
}

describe('deriveTsExitWarning', () => {
  it('选中 TS + 登录 + 无 exit_node → no-exit-device（核心态，断开也成立）', () => {
    expect(deriveTsExitWarning(base())).toBe('no-exit-device');
    expect(deriveTsExitWarning(base({ proxyRunning: false }))).toBe('no-exit-device'); // 断开态也提示
  });

  it('[S-b] allowInternet=true 但无 exit_node → no-exit-device（按 exit_node 判、不信 allowInternet）', () => {
    const s = { ...tsNode(), tailscaleSettings: { allowInternet: true } } as ServerConfig;
    expect(deriveTsExitWarning(base({ selectedServer: s }))).toBe('no-exit-device');
  });

  it('未选中 TS（选中普通节点/直连哨兵/无）→ none', () => {
    expect(deriveTsExitWarning(base({ selectedServer: undefined }))).toBe('none');
    expect(
      deriveTsExitWarning(base({ selectedServer: { protocol: 'vless' } as ServerConfig }))
    ).toBe('none');
  });

  it('未登录 → none（登录/让位 UI own）', () => {
    expect(deriveTsExitWarning(base({ loggedIn: false }))).toBe('none');
  });

  it('direct 模式 → none', () => {
    expect(deriveTsExitWarning(base({ proxyModeDirect: true }))).toBe('none');
  });

  it('有 exit_node + 该设备 peer online → none', () => {
    expect(
      deriveTsExitWarning(
        base({ selectedServer: tsNode('100.1.1.1'), peers: [peer({ online: true })] })
      )
    ).toBe('none');
  });

  it('有 exit_node + 该设备 peer offline + 代理运行 → exit-device-offline', () => {
    expect(
      deriveTsExitWarning(
        base({
          selectedServer: tsNode('100.1.1.1'),
          peers: [peer({ ip: '100.1.1.1', online: false })],
        })
      )
    ).toBe('exit-device-offline');
  });

  it('有 exit_node + peer offline 但代理未运行 → none（陈旧 snapshot 不误报 offline）', () => {
    expect(
      deriveTsExitWarning(
        base({
          selectedServer: tsNode('100.1.1.1'),
          proxyRunning: false,
          peers: [peer({ ip: '100.1.1.1', online: false })],
        })
      )
    ).toBe('none');
  });

  it('有 exit_node 但值不匹配任何 peer（自定义值）→ none（无法判定不误报）', () => {
    expect(
      deriveTsExitWarning(base({ selectedServer: tsNode('custom-host'), peers: [peer({})] }))
    ).toBe('none');
  });

  it('exit_node 按 hostName 匹配 offline → exit-device-offline', () => {
    expect(
      deriveTsExitWarning(
        base({
          selectedServer: tsNode('mybox'),
          peers: [peer({ hostName: 'mybox', online: false })],
        })
      )
    ).toBe('exit-device-offline');
  });

  it('有 exit_node + peer online 但未广告出口(exitNodeOption=false)+ 运行 → exit-device-not-advertised（修空转检测）', () => {
    expect(
      deriveTsExitWarning(
        base({
          selectedServer: tsNode('100.1.1.1'),
          peers: [peer({ ip: '100.1.1.1', online: true, exitNodeOption: false })],
        })
      )
    ).toBe('exit-device-not-advertised');
  });

  it('未广告 + 代理未运行 → none（陈旧 snapshot 不误报，与 offline 同新鲜度守卫）', () => {
    expect(
      deriveTsExitWarning(
        base({
          selectedServer: tsNode('100.1.1.1'),
          proxyRunning: false,
          peers: [peer({ ip: '100.1.1.1', online: true, exitNodeOption: false })],
        })
      )
    ).toBe('none');
  });

  it('peer 同时离线且未广告 → 离线优先（exit-device-offline，离线态 exitNodeOption 可能陈旧）', () => {
    expect(
      deriveTsExitWarning(
        base({
          selectedServer: tsNode('100.1.1.1'),
          peers: [peer({ ip: '100.1.1.1', online: false, exitNodeOption: false })],
        })
      )
    ).toBe('exit-device-offline');
  });

  it('exit_node 按 hostName 匹配 + online 未广告 → exit-device-not-advertised', () => {
    expect(
      deriveTsExitWarning(
        base({
          selectedServer: tsNode('mybox'),
          peers: [peer({ hostName: 'mybox', online: true, exitNodeOption: false })],
        })
      )
    ).toBe('exit-device-not-advertised');
  });

  // §H.5 F2：警示与路由严格镜像——`no-exit-device ⟺ meshSelectedExitFallsBackToDirect=true`（选中 TS、非 direct）。
  // 两侧同源 `!exitNode` 派生，此跨谓词测试防将来单侧改口径而漂移。
  describe('警示 ⟺ 路由回退 镜像（防漂移）', () => {
    const cfg = (server: ServerConfig): UserConfig =>
      ({
        servers: [server],
        selectedServerId: 'ts1',
        proxyMode: 'global',
      }) as unknown as UserConfig;
    it('无 exit_node：警示=no-exit-device 且 路由 fallsBackToDirect=true', () => {
      const s = tsNode(); // 无 exitNode
      expect(deriveTsExitWarning(base({ selectedServer: s }))).toBe('no-exit-device');
      expect(meshSelectedExitFallsBackToDirect(cfg(s))).toBe(true);
    });
    it('[S-b] allowInternet:true 但无 exit_node：两侧同判（警示 no-exit-device / 路由回退 direct）', () => {
      const s = { ...tsNode(), tailscaleSettings: { allowInternet: true } } as ServerConfig;
      expect(deriveTsExitWarning(base({ selectedServer: s }))).toBe('no-exit-device');
      expect(meshSelectedExitFallsBackToDirect(cfg(s))).toBe(true);
    });
    it('有 exit_node：警示≠no-exit-device 且 路由 fallsBackToDirect=false', () => {
      const s = tsNode('100.1.1.1');
      expect(
        deriveTsExitWarning(base({ selectedServer: s, peers: [peer({ online: true })] }))
      ).toBe('none');
      expect(meshSelectedExitFallsBackToDirect(cfg(s))).toBe(false);
    });
  });
});
