/**
 * buildOutbounds 单测 —— 原 ProxyManager.generateOutbounds 无单测（仅 config-snapshot 集成锁字节）。
 * 锁：节点出站 + proxy-selector + rule-sel（含 anti-drift default）+ direct/block + 两载体返回
 * （pendingEndpoints / pendingRuleSelectors）+ WG endpoint 收集 + naive 缺库跳过。
 */
jest.mock('electron', () => ({
  app: { getPath: () => '/fake/userData', getAppPath: () => '/fake/app', isPackaged: false },
  net: {},
}));

import { buildOutbounds, type OutboundsDeps } from '../singbox-outbound-builder';
import type { ServerConfig, UserConfig, InvalidNodeInfo } from '../../../shared/types';

const deps = (over: Partial<OutboundsDeps> = {}): OutboundsDeps => ({
  gateInvalidNodes: new Map<string, InvalidNodeInfo>(),
  log: () => {},
  ...over,
});

const vless = (id: string, name: string): ServerConfig =>
  ({
    id,
    name,
    protocol: 'vless',
    address: `${id}.example.com`,
    port: 443,
    uuid: 'u',
  }) as unknown as ServerConfig;

const cfg = (servers: ServerConfig[], over: Partial<UserConfig> = {}): UserConfig =>
  ({
    proxyMode: 'smart',
    servers,
    selectedServerId: servers[0]?.id,
    customRules: [],
    appRules: [],
    ...over,
  }) as unknown as UserConfig;

const idMap = (servers: ServerConfig[]): Map<string, string> =>
  new Map(servers.map((s) => [s.id, s.name]));

describe('buildOutbounds — 基础装配 + 载体', () => {
  it('单节点：节点出站 + proxy-selector(default=节点) + direct + block；载体空', () => {
    const servers = [vless('s1', '香港')];
    const r = buildOutbounds(servers[0], cfg(servers), idMap(servers), deps());
    const tags = r.outbounds.map((o) => o.tag);
    expect(tags).toContain('香港');
    expect(tags).toContain('proxy-selector');
    expect(tags).toContain('direct');
    expect(tags).toContain('block');
    const sel = r.outbounds.find((o) => o.tag === 'proxy-selector')!;
    expect(sel.type).toBe('selector');
    expect(sel.outbounds).toEqual(['香港', 'direct']);
    expect(sel.default).toBe('香港');
    expect(r.pendingEndpoints).toEqual([]);
    expect(r.pendingRuleSelectors).toEqual([]);
  });

  it('多节点 + 选中第二个 → proxy-selector.default=第二节点，members 含全部', () => {
    const servers = [vless('s1', '香港'), vless('s2', '日本')];
    const r = buildOutbounds(
      servers[1],
      cfg(servers, { selectedServerId: 's2' }),
      idMap(servers),
      deps()
    );
    const sel = r.outbounds.find((o) => o.tag === 'proxy-selector')!;
    expect(sel.outbounds).toEqual(['香港', '日本', 'direct']);
    expect(sel.default).toBe('日本');
  });

  it('全局直连哨兵 → proxy-selector 含 direct 成员、default=direct（#73）', () => {
    const servers = [vless('s1', '香港')];
    const r = buildOutbounds(
      null,
      cfg(servers, { selectedServerId: '__direct__' }),
      idMap(servers),
      deps()
    );
    const sel = r.outbounds.find((o) => o.tag === 'proxy-selector')!;
    expect(sel.outbounds).toEqual(['香港', 'direct']);
    expect(sel.default).toBe('direct');
  });

  it('全局直连 + 0 节点 → 不抛；proxy-selector=[direct]、default=direct', () => {
    const r = buildOutbounds(null, cfg([], { selectedServerId: '__direct__' }), new Map(), deps());
    const sel = r.outbounds.find((o) => o.tag === 'proxy-selector')!;
    expect(sel.outbounds).toEqual(['direct']);
    expect(sel.default).toBe('direct');
  });
});

describe('buildOutbounds — rule-sel 载体（smart）', () => {
  it('proxy 自定义规则(指定目标) → rule-sel-<id> default=目标；pendingRuleSelectors 收集', () => {
    const servers = [vless('s1', '香港'), vless('s2', '日本')];
    const c = cfg(servers, {
      customRules: [
        {
          id: 'r1',
          type: 'domain',
          values: ['x.com'],
          action: 'proxy',
          enabled: true,
          targetServerId: 's2',
        },
      ] as any,
    });
    const r = buildOutbounds(servers[0], c, idMap(servers), deps());
    const ruleSel = r.outbounds.find((o) => o.tag === 'rule-sel-r1')!;
    expect(ruleSel.type).toBe('selector');
    expect(ruleSel.default).toBe('日本'); // anti-drift：指定目标
    expect(ruleSel.outbounds).toContain('proxy-selector'); // 嵌套全局
    expect(r.pendingRuleSelectors).toEqual([
      { ruleKey: 'custom:r1', selectorTag: 'rule-sel-r1', memberTag: '日本', targetServerId: 's2' },
    ]);
  });

  it('global 模式 → 不生成 rule-sel（用户分流被忽略）', () => {
    const servers = [vless('s1', 'HK')];
    const c = cfg(servers, {
      proxyMode: 'global',
      customRules: [
        { id: 'r1', type: 'domain', values: ['x'], action: 'proxy', enabled: true },
      ] as any,
    });
    const r = buildOutbounds(servers[0], c, idMap(servers), deps());
    expect(r.outbounds.some((o) => o.tag?.startsWith('rule-sel'))).toBe(false);
    expect(r.pendingRuleSelectors).toEqual([]);
  });
});

describe('buildOutbounds — endpoint + 门控', () => {
  it('WireGuard → 进 pendingEndpoints（非 outbounds），tag 入 selector', () => {
    const wg = {
      id: 'w1',
      name: 'WG',
      protocol: 'wireguard',
      address: 'wg.example.com',
      port: 51820,
      wireguardSettings: { privateKey: 'pk', peerPublicKey: 'pub', localAddress: ['10.0.0.2/32'] },
    } as unknown as ServerConfig;
    const r = buildOutbounds(wg, cfg([wg]), idMap([wg]), deps());
    expect(r.pendingEndpoints.map((e) => e.tag)).toEqual(['WG']);
    expect(r.outbounds.find((o) => o.tag === 'proxy-selector')!.outbounds).toContain('WG');
  });

  it('WireGuard 关外网且无可路由网段 → 不发射 endpoint，tag 不入 selector（D2 防空 allowed_ips FATAL）', () => {
    const wgOff = {
      id: 'w1',
      name: 'WG-off',
      protocol: 'wireguard',
      address: 'wg.example.com',
      port: 51820,
      wireguardSettings: {
        privateKey: 'pk',
        peerPublicKey: 'pub',
        localAddress: ['10.0.0.2/32'],
        allowedIPs: ['0.0.0.0/0', '::/0'],
        allowInternet: false,
      },
    } as unknown as ServerConfig;
    const node = vless('s1', '香港'); // 另备一个可用节点，避免「全部不可用」抛错
    const r = buildOutbounds(node, cfg([node, wgOff]), idMap([node, wgOff]), deps());
    expect(r.pendingEndpoints.map((e) => e.tag)).not.toContain('WG-off');
    expect(r.outbounds.find((o) => o.tag === 'proxy-selector')!.outbounds).not.toContain('WG-off');
  });

  it('WireGuard 关外网但有具体段 → 发射 endpoint（仅承载具体段）', () => {
    const wgOff = {
      id: 'w1',
      name: 'WG-lan',
      protocol: 'wireguard',
      address: 'wg.example.com',
      port: 51820,
      wireguardSettings: {
        privateKey: 'pk',
        peerPublicKey: 'pub',
        localAddress: ['10.0.0.2/32'],
        allowedIPs: ['10.8.0.0/24'],
        allowInternet: false,
      },
    } as unknown as ServerConfig;
    const r = buildOutbounds(wgOff, cfg([wgOff]), idMap([wgOff]), deps());
    const ep = r.pendingEndpoints.find((e) => e.tag === 'WG-lan');
    expect(ep).toBeDefined();
    expect(ep!.peers![0].allowed_ips).toEqual(['10.8.0.0/24']);
  });

  it('Phase2 WG reverseMesh=true → endpoint.system=true + allowed_ips 仅具体段', () => {
    const wgSys = {
      id: 'w1',
      name: 'WG-sys',
      protocol: 'wireguard',
      address: 'wg.example.com',
      port: 51820,
      wireguardSettings: {
        privateKey: 'pk',
        peerPublicKey: 'pub',
        localAddress: ['10.0.0.2/32'],
        allowedIPs: ['10.8.0.0/24'],
        reverseMesh: true,
      },
    } as unknown as ServerConfig;
    const r = buildOutbounds(
      wgSys,
      cfg([wgSys]),
      idMap([wgSys]),
      deps({ systemInterfaceAvailable: true })
    );
    const ep = r.pendingEndpoints.find((e) => e.tag === 'WG-sys')!;
    expect(ep.system).toBe(true);
    expect(ep.peers![0].allowed_ips).toEqual(['10.8.0.0/24']);
  });

  it('Phase2 Tailscale reverseMesh=true → endpoint.system_interface=true + exit_node 丢弃（结论A）', () => {
    const tsSys = {
      id: 't1',
      name: 'TS-sys',
      protocol: 'tailscale',
      tailscaleSettings: {
        authKey: 'tskey-abc',
        exitNode: 'exit-node-1',
        routes: ['192.168.9.0/24'],
        reverseMesh: true,
      },
    } as unknown as ServerConfig;
    const r = buildOutbounds(
      tsSys,
      cfg([tsSys], { selectedServerId: 't1' }),
      idMap([tsSys]),
      deps({ systemInterfaceAvailable: true })
    );
    const ep = r.pendingEndpoints.find((e) => e.tag === 'TS-sys')!;
    expect(ep.type).toBe('tailscale');
    expect(ep.system_interface).toBe(true);
    expect(ep.exit_node).toBeUndefined();
  });

  it('Phase2 Tailscale 非 system(缺省) + on + exitNode → 下发 exit_node、无 system_interface', () => {
    const tsNorm = {
      id: 't1',
      name: 'TS',
      protocol: 'tailscale',
      tailscaleSettings: { authKey: 'tskey-abc', exitNode: 'exit-node-1' },
    } as unknown as ServerConfig;
    const r = buildOutbounds(
      tsNorm,
      cfg([tsNorm], { selectedServerId: 't1' }),
      idMap([tsNorm]),
      deps()
    );
    const ep = r.pendingEndpoints.find((e) => e.tag === 'TS')!;
    expect(ep.system_interface).toBeUndefined();
    expect(ep.exit_node).toBe('exit-node-1');
  });

  it('Phase2 B 门控：reverseMesh 节点 + 非提权(systemInterfaceAvailable 缺省 false) → 跳过不发射', () => {
    const wgSys = {
      id: 'w1',
      name: 'WG-sys',
      protocol: 'wireguard',
      address: 'wg.example.com',
      port: 51820,
      wireguardSettings: {
        privateKey: 'pk',
        peerPublicKey: 'pub',
        localAddress: ['10.0.0.2/32'],
        allowedIPs: ['10.8.0.0/24'],
        reverseMesh: true,
      },
    } as unknown as ServerConfig;
    const node = vless('s1', '香港'); // 备一可用节点，避免「全部不可用」抛错
    const r = buildOutbounds(node, cfg([node, wgSys]), idMap([node, wgSys]), deps());
    expect(r.pendingEndpoints.map((e) => e.tag)).not.toContain('WG-sys');
    expect(r.outbounds.find((o) => o.tag === 'proxy-selector')!.outbounds).not.toContain('WG-sys');
  });

  it('gateInvalidNodes 命中 → 跳过该节点出站', () => {
    const servers = [vless('s1', '香港'), vless('s2', '日本')];
    const gate = new Map<string, InvalidNodeInfo>([
      ['s1', { id: 's1', tag: '香港', reason: 'x' } as InvalidNodeInfo],
    ]);
    const r = buildOutbounds(
      servers[1],
      cfg(servers, { selectedServerId: 's2' }),
      idMap(servers),
      deps({ gateInvalidNodes: gate })
    );
    expect(r.outbounds.map((o) => o.tag)).not.toContain('香港');
    expect(r.outbounds.find((o) => o.tag === 'proxy-selector')!.outbounds).toEqual([
      '日本',
      'direct',
    ]);
  });

  it('所有节点不可用 → 抛错', () => {
    const servers = [vless('s1', 'HK')];
    const gate = new Map<string, InvalidNodeInfo>([
      ['s1', { id: 's1', tag: 'HK', reason: 'x' } as InvalidNodeInfo],
    ]);
    expect(() =>
      buildOutbounds(servers[0], cfg(servers), idMap(servers), deps({ gateInvalidNodes: gate }))
    ).toThrow();
  });
});
