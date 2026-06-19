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
  });

  describe('meshNodeCarriesFullTunnel（= 允许外网 且非 system）', () => {
    it('on + 非 system → true', () => expect(meshNodeCarriesFullTunnel(wg([], true))).toBe(true));
    it('on + system → false（结论A：system 恒 specific-only，不承载 0/0）', () =>
      expect(meshNodeCarriesFullTunnel(wg([], true, true))).toBe(false));
    it('off + 非 system → false', () =>
      expect(meshNodeCarriesFullTunnel(wg([], false))).toBe(false));
    it('off + system → false', () =>
      expect(meshNodeCarriesFullTunnel(wg([], false, true))).toBe(false));
    it('TS on + system → false', () =>
      expect(meshNodeCarriesFullTunnel(ts([], true, true))).toBe(false));
  });

  describe('wireguardPeerAllowedIps（system → specific-only，恒去 0/0）', () => {
    it('system + 具体段（即便 on）→ 仅具体段，不注入 0/0', () => {
      expect(wireguardPeerAllowedIps(wg(['10.8.0.0/24'], true, true))).toEqual(['10.8.0.0/24']);
    });
    it('system + 具体段 + off → 仅具体段', () => {
      expect(wireguardPeerAllowedIps(wg(['10.8.0.0/24'], false, true))).toEqual(['10.8.0.0/24']);
    });
    it('system + 含 catch-all 的列表 → 剥离 0/0 仅留具体段', () => {
      expect(wireguardPeerAllowedIps(wg(['0.0.0.0/0', '::/0', '10.8.0.0/24'], true, true))).toEqual(
        ['10.8.0.0/24']
      );
    });
    it('system + 无具体段 → null（同 off+空，空 allowed_ips=FATAL 不可发射）', () => {
      expect(wireguardPeerAllowedIps(wg([], true, true))).toBeNull();
    });
  });

  describe('isMeshNodeUnroutable（system + 无具体段）', () => {
    it('WG system + 无具体段 → true（不可发射）', () => {
      expect(isMeshNodeUnroutable(wg([], true, true))).toBe(true);
    });
    it('WG system + 有具体段 → false', () => {
      expect(isMeshNodeUnroutable(wg(['10.8.0.0/24'], true, true))).toBe(false);
    });
  });

  describe('meshSelectedExitFallsBackToDirect（system 节点选中为主 → 兜底，即便 allowInternet=on）', () => {
    const cfg = (server: ServerConfig, proxyMode: string): UserConfig =>
      ({ proxyMode, servers: [server], selectedServerId: server.id }) as any;
    it('smart + 选中 system WG(on+具体段) → true（system 不承载 0/0，海外须回退避黑洞）', () => {
      expect(meshSelectedExitFallsBackToDirect(cfg(wg(['10.8.0.0/24'], true, true), 'smart'))).toBe(
        true
      );
    });
    it('global + 选中 system TS(on) → true', () => {
      expect(
        meshSelectedExitFallsBackToDirect(cfg(ts(['192.168.9.0/24'], true, true), 'global'))
      ).toBe(true);
    });
    it('smart + 选中 非 system on WG → false（仍承载 0/0，不回退）', () => {
      expect(meshSelectedExitFallsBackToDirect(cfg(wg([], true), 'smart'))).toBe(false);
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
