import {
  endpointForcedRouteCidrs,
  TAILNET_CGNAT,
  meshAllowsInternet,
  meshUsesSystemInterface,
  meshNodeCarriesFullTunnel,
  wireguardPeerAllowedIps,
  isMeshNodeUnroutable,
  meshSelectedExitFallsBackToDirect,
  meshShadowedCidrs,
  meshAlwaysRoutesSubnets,
  shouldForceRouteSubnets,
  collectRuleTargetedServerIds,
  meshForceRoutedServers,
  isSpeedTestable,
  tailscaleSlotTaken,
} from '../endpoint-routes';
import type { ServerConfig, UserConfig } from '../types';

const wg = (allowedIPs?: string[], allowInternet?: boolean, reverseMesh?: boolean): ServerConfig =>
  ({
    id: 'w',
    name: 'w',
    protocol: 'wireguard',
    address: '1.2.3.4',
    port: 51820,
    wireguardSettings: {
      privateKey: 'k',
      peerPublicKey: 'p',
      localAddress: ['10.0.0.2/32'],
      allowedIPs,
      ...(allowInternet === undefined ? {} : { allowInternet }),
      ...(reverseMesh === undefined ? {} : { reverseMesh }),
    },
  }) as any;

const ts = (routes?: string[], allowInternet?: boolean, reverseMesh?: boolean): ServerConfig =>
  ({
    id: 't',
    name: 't',
    protocol: 'tailscale',
    tailscaleSettings: {
      routes,
      ...(allowInternet === undefined ? {} : { allowInternet }),
      ...(reverseMesh === undefined ? {} : { reverseMesh }),
    },
  }) as any;

describe('endpointForcedRouteCidrs', () => {
  it('WG: 去掉 catch-all(0/0,::/0)，保留具体段', () => {
    expect(endpointForcedRouteCidrs(wg(['0.0.0.0/0', '::/0', '10.10.10.0/24']))).toEqual([
      '10.10.10.0/24',
    ]);
  });
  it('WG: 仅 0/0 → 空（全量代理由 selector/final 接管，不进 force-route）', () => {
    expect(endpointForcedRouteCidrs(wg(['0.0.0.0/0', '::/0']))).toEqual([]);
  });
  it('WG: 空 allowedIPs → 空', () => {
    expect(endpointForcedRouteCidrs(wg())).toEqual([]);
  });
  it('TS: 自动含 tailnet 段 + routes', () => {
    expect(endpointForcedRouteCidrs(ts(['192.168.50.0/24']))).toEqual([
      TAILNET_CGNAT,
      '192.168.50.0/24',
    ]);
  });
  it('TS: 无 routes → 仅 tailnet 段（达 tailnet peer 的必需路由）', () => {
    expect(endpointForcedRouteCidrs(ts())).toEqual([TAILNET_CGNAT]);
  });
  it('TS: routes 含 catch-all(0/0) → 被剥、tailnet 保留（与 WG 对齐）', () => {
    expect(endpointForcedRouteCidrs(ts(['0.0.0.0/0', '::/0', '192.168.50.0/24']))).toEqual([
      TAILNET_CGNAT,
      '192.168.50.0/24',
    ]);
  });
  it('TS: routes 仅 catch-all → 仅 tailnet 段（0/0 全剥）', () => {
    expect(endpointForcedRouteCidrs(ts(['0.0.0.0/0', '::/0']))).toEqual([TAILNET_CGNAT]);
  });
  it('trim/去空/去重', () => {
    expect(endpointForcedRouteCidrs(wg([' 10.10.10.0/24 ', '10.10.10.0/24', '', '  ']))).toEqual([
      '10.10.10.0/24',
    ]);
  });
  it('非 endpoint 协议 → 空', () => {
    expect(endpointForcedRouteCidrs({ protocol: 'vless' } as any)).toEqual([]);
  });
});

describe('meshAllowsInternet（allowInternet 缺省 true，向后兼容）', () => {
  it('WG 缺字段 → true', () => expect(meshAllowsInternet(wg())).toBe(true));
  it('WG allowInternet=true → true', () => expect(meshAllowsInternet(wg([], true))).toBe(true));
  it('WG allowInternet=false → false', () => expect(meshAllowsInternet(wg([], false))).toBe(false));
  it('TS 缺字段 → true', () => expect(meshAllowsInternet(ts())).toBe(true));
  it('TS allowInternet=false → false', () => expect(meshAllowsInternet(ts([], false))).toBe(false));
  it('非组网协议 → 恒 true', () =>
    expect(meshAllowsInternet({ protocol: 'vless' } as any)).toBe(true));
});

describe('wireguardPeerAllowedIps（Layer A）', () => {
  it('on(缺省) + 空 → 仅全网段两族', () => {
    expect(wireguardPeerAllowedIps(wg())).toEqual(['0.0.0.0/0', '::/0']);
  });
  it('on + 具体段 → 具体段 ∪ 全网段（两族全给，不裁剪）', () => {
    expect(wireguardPeerAllowedIps(wg(['10.8.0.0/24']))).toEqual([
      '10.8.0.0/24',
      '0.0.0.0/0',
      '::/0',
    ]);
  });
  it('on + 具体段已含 catch-all → 去重不重复 0/0', () => {
    expect(wireguardPeerAllowedIps(wg(['10.8.0.0/24', '0.0.0.0/0', '::/0']))).toEqual([
      '10.8.0.0/24',
      '0.0.0.0/0',
      '::/0',
    ]);
  });
  it('off + 具体段 → 仅具体段', () => {
    expect(wireguardPeerAllowedIps(wg(['10.8.0.0/24'], false))).toEqual(['10.8.0.0/24']);
  });
  it('off + 仅 catch-all → null（空 allowed_ips=FATAL，不可发射）', () => {
    expect(wireguardPeerAllowedIps(wg(['0.0.0.0/0', '::/0'], false))).toBeNull();
  });
  it('off + 空 → null', () => {
    expect(wireguardPeerAllowedIps(wg([], false))).toBeNull();
  });
});

describe('isMeshNodeUnroutable', () => {
  it('WG off + 无具体段 → true（不可发射）', () => {
    expect(isMeshNodeUnroutable(wg([], false))).toBe(true);
  });
  it('WG off + 有具体段 → false', () => {
    expect(isMeshNodeUnroutable(wg(['10.8.0.0/24'], false))).toBe(false);
  });
  it('WG on → false', () => expect(isMeshNodeUnroutable(wg([], true))).toBe(false));
  it('TS off + 无 routes → false（仍达 tailnet，恒可发射）', () => {
    expect(isMeshNodeUnroutable(ts([], false))).toBe(false);
  });
});

describe('meshSelectedExitFallsBackToDirect（D4/D7：global+smart 同兜底）', () => {
  const cfg = (server: ServerConfig, proxyMode: string): UserConfig =>
    ({ proxyMode, servers: [server], selectedServerId: server.id }) as any;
  it('global + 选中 off WG → true', () => {
    expect(meshSelectedExitFallsBackToDirect(cfg(wg([], false), 'global'))).toBe(true);
  });
  it('global + 选中 off TS → true', () => {
    expect(meshSelectedExitFallsBackToDirect(cfg(ts([], false), 'global'))).toBe(true);
  });
  it('global + 选中 on WG → false', () => {
    expect(meshSelectedExitFallsBackToDirect(cfg(wg([], true), 'global'))).toBe(false);
  });
  // D7 修复：smart 现也兜底（原 false 留下海外黑洞）
  it('smart + 选中 off WG → true（D7：smart 同兜底）', () => {
    expect(meshSelectedExitFallsBackToDirect(cfg(wg([], false), 'smart'))).toBe(true);
  });
  it('smart + 选中 off+具体段 WG → true（off 即兜底，与有无 specific 无关）', () => {
    expect(meshSelectedExitFallsBackToDirect(cfg(wg(['10.8.0.0/24'], false), 'smart'))).toBe(true);
  });
  it('smart + 选中 on WG → false', () => {
    expect(meshSelectedExitFallsBackToDirect(cfg(wg([], true), 'smart'))).toBe(false);
  });
  it('direct + 选中 off WG → false（direct 本就 final=direct，不适用）', () => {
    expect(meshSelectedExitFallsBackToDirect(cfg(wg([], false), 'direct'))).toBe(false);
  });
  it('选中非组网节点 → false', () => {
    const v = { id: 'v', protocol: 'vless' } as any;
    expect(meshSelectedExitFallsBackToDirect(cfg(v, 'global'))).toBe(false);
    expect(meshSelectedExitFallsBackToDirect(cfg(v, 'smart'))).toBe(false);
  });
});

// #9：ICMP 兜底 outbound 类型的单一真值（route-builder 发射 + ProxyManager 热切换跨边界判定共用）。
describe('meshShadowedCidrs（同网段首声明者占有）', () => {
  const wgNode = (id: string, allowedIPs: string[]): ServerConfig =>
    ({
      id,
      name: id,
      protocol: 'wireguard',
      address: '1.2.3.4',
      port: 51820,
      wireguardSettings: {
        privateKey: 'k',
        peerPublicKey: 'p',
        localAddress: ['10.0.0.2/32'],
        allowedIPs,
      },
    }) as any;

  it('两节点同段 → 后者该段被覆盖', () => {
    const a = wgNode('a', ['10.8.0.0/24']);
    const b = wgNode('b', ['10.8.0.0/24', '192.168.9.0/24']);
    const m = meshShadowedCidrs([a, b]);
    expect(m.has('a')).toBe(false); // 首声明者不被覆盖
    expect(m.get('b')).toEqual(['10.8.0.0/24']); // 仅重复段被覆盖，独有段不计
  });

  it('无重叠 → 空 map', () => {
    const a = wgNode('a', ['10.8.0.0/24']);
    const b = wgNode('b', ['192.168.9.0/24']);
    expect(meshShadowedCidrs([a, b]).size).toBe(0);
  });

  it('catch-all 不参与（force-route 已剔）', () => {
    const a = wgNode('a', ['0.0.0.0/0', '::/0']);
    const b = wgNode('b', ['0.0.0.0/0', '::/0']);
    expect(meshShadowedCidrs([a, b]).size).toBe(0);
  });

  it('顺序决定归属：调换则被覆盖方互换', () => {
    const a = wgNode('a', ['10.8.0.0/24']);
    const b = wgNode('b', ['10.8.0.0/24']);
    expect(meshShadowedCidrs([a, b]).get('b')).toEqual(['10.8.0.0/24']);
    expect(meshShadowedCidrs([b, a]).get('a')).toEqual(['10.8.0.0/24']);
  });
});

describe('Phase 2: system 内核接口（reverseMesh）', () => {
  describe('meshUsesSystemInterface', () => {
    it('WG reverseMesh=true → true', () =>
      expect(meshUsesSystemInterface(wg([], true, true))).toBe(true));
    it('WG 缺字段 → false（缺省 userspace）', () =>
      expect(meshUsesSystemInterface(wg())).toBe(false));
    it('WG reverseMesh=false → false', () =>
      expect(meshUsesSystemInterface(wg([], true, false))).toBe(false));
    it('TS reverseMesh=true → true', () =>
      expect(meshUsesSystemInterface(ts([], true, true))).toBe(true));
    it('TS 缺字段 → false', () => expect(meshUsesSystemInterface(ts())).toBe(false));
    it('非组网协议 → false', () =>
      expect(meshUsesSystemInterface({ protocol: 'vless' } as any)).toBe(false));
    it('WARP（warpDevice）即便 reverseMesh=true 也 → false（anycast 出口恒 gVisor，防 Connect: resource busy FATAL）', () => {
      const warp = wg([], true, true);
      warp.wireguardSettings = {
        ...(warp.wireguardSettings as any),
        warpDevice: { deviceId: 'd', token: 't' },
      };
      expect(meshUsesSystemInterface(warp)).toBe(false);
    });
    it('旧 WARP（无 warpDevice，端点 *.cloudflareclient.com）即便 reverseMesh=true 也 → false（按端点域名鲁棒兜底）', () => {
      const warp = wg([], true, true);
      warp.address = 'engage.cloudflareclient.com';
      expect(meshUsesSystemInterface(warp)).toBe(false);
    });
  });

  describe('meshNodeCarriesFullTunnel（= 允许外网，与接入模式正交；system WG 经预折半 catch-all 承载全隧道）', () => {
    it('WG on + 非 system(gVisor) → true', () =>
      expect(meshNodeCarriesFullTunnel(wg([], true))).toBe(true));
    it('WG on + system → true（system WG 也承载：catch-all 用预折半 0/1+128/1，不删全局 default）', () =>
      expect(meshNodeCarriesFullTunnel(wg([], true, true))).toBe(true));
    it('WG off + 非 system → false', () =>
      expect(meshNodeCarriesFullTunnel(wg([], false))).toBe(false));
    it('WG off + system → false', () =>
      expect(meshNodeCarriesFullTunnel(wg([], false, true))).toBe(false));
    it('TS on + system → true（exit_node 经 MeshExitRouteManager ifscope 托管，不碰全局 default）', () =>
      expect(meshNodeCarriesFullTunnel(ts([], true, true))).toBe(true));
    it('TS on + 非 system → true', () =>
      expect(meshNodeCarriesFullTunnel(ts([], true))).toBe(true));
    it('TS off + system → false（关外网=不承载，与模式无关）', () =>
      expect(meshNodeCarriesFullTunnel(ts([], false, true))).toBe(false));
    it('TS off + 非 system → false', () =>
      expect(meshNodeCarriesFullTunnel(ts([], false))).toBe(false));
  });

  describe('wireguardPeerAllowedIps（全隧道注入裸 0/0；system WG 同样——预折半证伪，断网由安全网兜）', () => {
    it('system + 具体段 + on → 具体段 ∪ 全网段', () => {
      expect(wireguardPeerAllowedIps(wg(['10.8.0.0/24'], true, true))).toEqual([
        '10.8.0.0/24',
        '0.0.0.0/0',
        '::/0',
      ]);
    });
    it('system + 具体段 + off → 仅具体段', () => {
      expect(wireguardPeerAllowedIps(wg(['10.8.0.0/24'], false, true))).toEqual(['10.8.0.0/24']);
    });
    it('system + 含 catch-all 的列表 + on → 去重后具体段 ∪ 全网段', () => {
      expect(wireguardPeerAllowedIps(wg(['0.0.0.0/0', '::/0', '10.8.0.0/24'], true, true))).toEqual(
        ['10.8.0.0/24', '0.0.0.0/0', '::/0']
      );
    });
    it('system + 无具体段 + on → 仅全网段（承载全隧道、可发射）', () => {
      expect(wireguardPeerAllowedIps(wg([], true, true))).toEqual(['0.0.0.0/0', '::/0']);
    });
    it('gVisor + 无具体段 + on → 全网段', () => {
      expect(wireguardPeerAllowedIps(wg([], true))).toEqual(['0.0.0.0/0', '::/0']);
    });
  });

  describe('isMeshNodeUnroutable（system WG 全隧道有预折半 → 可发射）', () => {
    it('WG system + 无具体段 + on → false（预折半即非空 allowed_ips，承载全隧道、可发射）', () => {
      expect(isMeshNodeUnroutable(wg([], true, true))).toBe(false);
    });
    it('WG system + 有具体段 → false（子网段可发射）', () => {
      expect(isMeshNodeUnroutable(wg(['10.8.0.0/24'], true, true))).toBe(false);
    });
    it('WG system + off + 无具体段 → true（不可发射）', () => {
      expect(isMeshNodeUnroutable(wg([], false, true))).toBe(true);
    });
    it('gVisor + on + 无具体段 → false（承载 0/0，可发射）', () => {
      expect(isMeshNodeUnroutable(wg([], true))).toBe(false);
    });
  });

  describe('meshSelectedExitFallsBackToDirect（system WG 经预折半承载全隧道→不回退；off 才回退）', () => {
    const cfg = (server: ServerConfig, proxyMode: string): UserConfig =>
      ({ proxyMode, servers: [server], selectedServerId: server.id }) as any;
    it('smart + 选中 system WG(on+具体段) → false（system WG 经预折半承载全隧道，不回退）', () => {
      expect(meshSelectedExitFallsBackToDirect(cfg(wg(['10.8.0.0/24'], true, true), 'smart'))).toBe(
        false
      );
    });
    it('smart + 选中 gVisor WG(on) → false（gVisor 承载全隧道，不回退）', () => {
      expect(meshSelectedExitFallsBackToDirect(cfg(wg([], true), 'smart'))).toBe(false);
    });
    it('global + 选中 system TS(on) → false（exit_node 承载全隧道，不回退）', () => {
      expect(
        meshSelectedExitFallsBackToDirect(cfg(ts(['192.168.9.0/24'], true, true), 'global'))
      ).toBe(false);
    });
    it('global + 选中 system WG(off) → true（关外网=不承载，回退避黑洞）', () => {
      expect(meshSelectedExitFallsBackToDirect(cfg(wg([], false, true), 'global'))).toBe(true);
    });
  });
});

// ---- alwaysRouteSubnets：始终路由内网段(组网) vs 仅出网 ----
const wgSub = (alwaysRouteSubnets?: boolean): ServerConfig =>
  ({
    id: 'w',
    name: 'w',
    protocol: 'wireguard',
    address: '1.2.3.4',
    port: 51820,
    wireguardSettings: {
      privateKey: 'k',
      peerPublicKey: 'p',
      localAddress: ['10.0.0.2/32'],
      allowedIPs: ['10.8.0.0/24'],
      ...(alwaysRouteSubnets === undefined ? {} : { alwaysRouteSubnets }),
    },
  }) as any;

describe('meshAlwaysRoutesSubnets', () => {
  it('缺省（undefined）→ true（向后兼容，网段恒可达）', () =>
    expect(meshAlwaysRoutesSubnets(wgSub())).toBe(true));
  it('显式 true → true', () => expect(meshAlwaysRoutesSubnets(wgSub(true))).toBe(true));
  it('显式 false → false（仅出网）', () =>
    expect(meshAlwaysRoutesSubnets(wgSub(false))).toBe(false));
  it('Tailscale 缺省 → true', () =>
    expect(meshAlwaysRoutesSubnets(ts(['192.168.9.0/24']))).toBe(true));
  it('Tailscale 显式 false → false', () => {
    const node = ts(['192.168.9.0/24']) as any;
    node.tailscaleSettings = { ...node.tailscaleSettings, alwaysRouteSubnets: false };
    expect(meshAlwaysRoutesSubnets(node)).toBe(false);
  });
  it('非组网协议 → true（语义不适用）', () =>
    expect(meshAlwaysRoutesSubnets({ protocol: 'vless' } as any)).toBe(true));
});

describe('shouldForceRouteSubnets（块 0c 的 gate 谓词）', () => {
  const NONE = new Set<string>();
  it('ON（缺省/显式）→ 恒发射，无视选中/指向', () => {
    expect(shouldForceRouteSubnets(wgSub(true), null, NONE)).toBe(true);
    expect(shouldForceRouteSubnets(wgSub(undefined), 'other', NONE)).toBe(true);
  });
  it('OFF + 未选中 + 未被指向 → 不发射（仅作可选出口）', () =>
    expect(shouldForceRouteSubnets(wgSub(false), 'other', NONE)).toBe(false));
  it('OFF + 被选中为主出口 → 发射（网段随之可达）', () =>
    expect(shouldForceRouteSubnets(wgSub(false), 'w', NONE)).toBe(true));
  it('OFF + 被规则/应用分流显式指向 → 发射', () =>
    expect(shouldForceRouteSubnets(wgSub(false), 'other', new Set(['w']))).toBe(true));
});

describe('collectRuleTargetedServerIds（仅 enabled + action===proxy + targetServerId）', () => {
  it('proxy + enabled + targetServerId → 计入', () =>
    expect([
      ...collectRuleTargetedServerIds([{ enabled: true, action: 'proxy', targetServerId: 'w' }]),
    ]).toEqual(['w']));
  it('direct/block 即便带 targetServerId → 不计入（F1：陈旧目标不误判 engaged）', () =>
    expect(
      collectRuleTargetedServerIds([
        { enabled: true, action: 'direct', targetServerId: 'w' },
        { enabled: true, action: 'block', targetServerId: 'x' },
      ]).size
    ).toBe(0));
  it('disabled → 不计入', () =>
    expect(
      collectRuleTargetedServerIds([{ enabled: false, action: 'proxy', targetServerId: 'w' }]).size
    ).toBe(0));
  it('proxy 但无 targetServerId（跟全局）→ 不计入', () =>
    expect(collectRuleTargetedServerIds([{ enabled: true, action: 'proxy' }]).size).toBe(0));
  it('undefined/空 → 空集', () => {
    expect(collectRuleTargetedServerIds(undefined).size).toBe(0);
    expect(collectRuleTargetedServerIds([]).size).toBe(0);
  });
});

describe('meshForceRoutedServers（warn/shadow 与块 0c 同 gate 的预过滤）', () => {
  it('ON 保留 / OFF 未 engaged 剔除 / OFF 但被选中或被指向保留', () => {
    const on = wgSub(true);
    const off = { ...wgSub(false), id: 'off' } as any;
    const offSel = { ...wgSub(false), id: 'sel' } as any;
    const offTgt = { ...wgSub(false), id: 'tgt' } as any;
    const out = meshForceRoutedServers([on, off, offSel, offTgt], 'sel', new Set(['tgt']));
    expect(out.map((s) => s.id)).toEqual(['w', 'sel', 'tgt']); // off（OFF+未engaged）被剔
  });
  it('非组网协议恒保留（对 cidr/shadow 计算无副作用）', () =>
    expect(
      meshForceRoutedServers([{ id: 'v', protocol: 'vless' } as any], null, new Set()).map(
        (s) => s.id
      )
    ).toEqual(['v']));
});

describe('isSpeedTestable（不可测节点单一真值：tailscale / 自定义 endpoint / reverseMesh）', () => {
  it('tailscale → false（账号制，非即起即测临时隧道）', () => {
    expect(isSpeedTestable(ts())).toBe(false);
  });
  it('custom + isEndpoint → false（type 分流 endpoints[] 会错放）', () => {
    expect(
      isSpeedTestable({ id: 'c', protocol: 'custom', customSettings: { isEndpoint: true } } as any)
    ).toBe(false);
  });
  it('reverseMesh WireGuard(system 内核接口) → false（需提权，拖垮整批测速）', () => {
    expect(isSpeedTestable(wg(['10.0.0.0/24'], undefined, true))).toBe(false);
  });
  it('reverseMesh Tailscale(system 内核接口) → false', () => {
    expect(isSpeedTestable(ts(undefined, undefined, true))).toBe(false);
  });
  it('普通 WireGuard（非 reverseMesh）→ true（WG 仍可测）', () => {
    expect(isSpeedTestable(wg(['10.0.0.0/24']))).toBe(true);
  });
  it('vless → true（普通代理节点正常测速）', () => {
    expect(isSpeedTestable({ id: 'v', protocol: 'vless' } as any)).toBe(true);
  });
});

describe('tailscaleSlotTaken（Tailscale 单节点硬限：纯函数，UI 拦截 + ConfigManager 兜底共用）', () => {
  // 带任意 id/protocol 的最小节点（绕过 ts/wg 工厂的固定 id，便于测 editingId 排除自身）
  const node = (id: string, protocol: string): ServerConfig => ({ id, name: id, protocol }) as any;

  it('无 TS 节点时加 TS → 放行（slot 空）', () => {
    const servers = [node('a', 'vless'), node('b', 'wireguard')];
    expect(tailscaleSlotTaken(servers)).toBe(false);
  });

  it('已有 1 个 TS 节点再加第二个 TS → 拦下（slot 被占）', () => {
    const servers = [node('t1', 'tailscale')];
    expect(tailscaleSlotTaken(servers)).toBe(true);
  });

  it('已有 1 个 TS 节点，编辑该 TS（传 editingId=自身）→ 放行（排除自身）', () => {
    const servers = [node('t1', 'tailscale')];
    expect(tailscaleSlotTaken(servers, 't1')).toBe(false);
  });

  it('已有 1 个 TS 节点，editingId 指向另一个节点 → 仍拦下（编辑的不是那个 TS）', () => {
    const servers = [node('t1', 'tailscale'), node('v', 'vless')];
    expect(tailscaleSlotTaken(servers, 'v')).toBe(true);
  });

  it('已有 1 个 TS 节点，加 WARP/WG/其它协议 → 不受限（仅限 tailscale）', () => {
    // tailscaleSlotTaken 只看「是否已有 TS」；新增的 WG/WARP/vless 不是 TS，调用方据 serverData.protocol 不进闸门。
    // 此处直接验：传 editingId=undefined（新增），已有 1 TS → slot 确占用，但调用侧仅对 protocol==='tailscale' 才查此函数。
    const servers = [node('t1', 'tailscale')];
    // 加 WG：调用方不会调用本函数（protocol!==tailscale）；函数本身对「已有 TS」恒返回 true，故由调用侧分流保证放行。
    expect(tailscaleSlotTaken(servers)).toBe(true); // slot 占用为真，但仅 TS 新增才会被拦
  });

  it('协议大小写不敏感（Tailscale / TAILSCALE 均识别）', () => {
    expect(tailscaleSlotTaken([node('t1', 'Tailscale')])).toBe(true);
    expect(tailscaleSlotTaken([node('t1', 'TAILSCALE')], 't1')).toBe(false);
  });

  it('已有 2 个 WARP/WG 再加 WARP/WG → 不受限（WG 多节点合法，非 TS）', () => {
    const servers = [node('w1', 'wireguard'), node('w2', 'wireguard')];
    expect(tailscaleSlotTaken(servers)).toBe(false);
  });
});
