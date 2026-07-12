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

// CI 决定性（gate≠CI 的 host-OS 依赖）：WG/TS endpoint 的固定接口名（name / system_interface_name）**仅在非 macOS
// 下发**（macOS utun 名动态、刻意不设，builder 平台门控本身正确）。Linux/Win CI 是非 darwin 故 name 断言过，macOS CI
// 是 darwin 则 name=undefined → 断言挂。本文件无 darwin 专属断言，强制非 darwin 让接口名断言跨 CI host 确定。
const __realPlatform = process.platform;
beforeEach(() =>
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
);
afterEach(() =>
  Object.defineProperty(process, 'platform', { value: __realPlatform, configurable: true })
);

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

  // R4（§14.4，回退 E2）：WG endpoint 的 domain_resolver 回 getNodeResolverTag(config,'dial')（race 多上游，仅 peer 解析）。
  it('R4：域名-peer WG endpoint → domain_resolver=dns-node-race（race 默认；仅 peer 解析用）', () => {
    const wg = {
      id: 'w1',
      name: 'WG-peerdomain',
      protocol: 'wireguard',
      address: 'wg.example.com', // 域名 peer → needsResolver
      port: 51820,
      wireguardSettings: { privateKey: 'pk', peerPublicKey: 'pub', localAddress: ['10.0.0.2/32'] },
    } as unknown as ServerConfig;
    const r = buildOutbounds(wg, cfg([wg]), idMap([wg]), deps());
    const ep = r.pendingEndpoints.find((e) => e.tag === 'WG-peerdomain')!;
    expect(ep.domain_resolver).toBe('dns-node-race'); // race on 缺省
  });

  it('R4：IP-peer WG → needsResolver=false → 无 domain_resolver', () => {
    const wgIp = {
      id: 'w1',
      name: 'WG-ip',
      protocol: 'wireguard',
      address: '203.0.113.9',
      port: 51820,
      wireguardSettings: { privateKey: 'pk', peerPublicKey: 'pub', localAddress: ['10.0.0.2/32'] },
    } as unknown as ServerConfig;
    const r = buildOutbounds(wgIp, cfg([wgIp]), idMap([wgIp]), deps());
    const ep = r.pendingEndpoints.find((e) => e.tag === 'WG-ip')!;
    expect(ep.domain_resolver).toBeUndefined();
  });

  it('Phase2 WG reverseMesh=true(全隧道) → endpoint.system=true + 固定名 + allowed_ips 含 0/0', () => {
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
    expect(ep.name).toBe('flowz-wg'); // 固定名供出口托管定位（sing-box 1.14 WG endpoint 字段=`name`）
    // system WG 全隧道用裸 0/0（cryptokey 需要；预折半已证伪：sing-tun 落内核前把 0/1+128/1 合并回裸 0/0）→ 撞 en0
    // default 的 EEXIST、被 setRoutes 善后删掉、停核 unsetRoutes 不回填 → 断网，由 ProxyManager 的「全局 default 存/
    // 停核补回」安全网兜底。
    expect(ep.peers![0].allowed_ips).toEqual(['10.8.0.0/24', '0.0.0.0/0', '::/0']);
  });

  it('多个 System WG → 内核接口名唯一（首个 flowz-wg，其余 flowz-wg-N，防两张内核接口撞名致核 FATAL）', () => {
    const mkWg = (id: string, name: string): ServerConfig =>
      ({
        id,
        name,
        protocol: 'wireguard',
        address: `${id}.example.com`,
        port: 51820,
        wireguardSettings: {
          privateKey: 'pk',
          peerPublicKey: 'pub',
          localAddress: ['10.0.0.2/32'],
          reverseMesh: true,
        },
      }) as unknown as ServerConfig;
    const a = mkWg('wa', 'WG-A');
    const b = mkWg('wb', 'WG-B');
    const r = buildOutbounds(
      a,
      cfg([a, b]),
      idMap([a, b]),
      deps({ systemInterfaceAvailable: true })
    );
    const epA = r.pendingEndpoints.find((e) => e.tag === 'WG-A')!;
    const epB = r.pendingEndpoints.find((e) => e.tag === 'WG-B')!;
    expect(epA.name).toBe('flowz-wg'); // 首个保留默认名（常见单节点不变）
    expect(epB.name).toBe('flowz-wg-1'); // 次个唯一化
    expect(epA.name).not.toBe(epB.name);
  });

  it('Phase2 Tailscale reverseMesh=true + exitNode → system_interface=true + 固定名 + exit_node 下发（出口路由由 MeshExitRouteManager 托管）', () => {
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
    expect(ep.system_interface_name).toBe('flowz-ts'); // 固定名供出口托管定位
    expect(ep.exit_node).toBe('exit-node-1'); // exit_node 下发;出口拆半默认路由由 MeshExitRouteManager 装到 flowz-ts
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

  // 旧配置防御：allowInternet=true（旧字段显式存）但 exitNode 空——新表单不再产此组合（allowInternet 由
  // exitNode 派生），但存量配置可达。carriesFullTunnel=true，但 builder L653 `if (exitNode)` 守护 → 绝不下发
  // 空 exit_node（'' 非法）；节点退化为黑洞但配置合法不崩。锁定此边界，防未来误改成 ep.exit_node=''。
  it('旧配置 Tailscale allowInternet=true 但 exitNode 空 → 不下发 exit_node（不发空串、不崩）', () => {
    const tsLegacy = {
      id: 't1',
      name: 'TS-legacy',
      protocol: 'tailscale',
      tailscaleSettings: { authKey: 'tskey-abc', allowInternet: true, exitNode: '' },
    } as unknown as ServerConfig;
    const r = buildOutbounds(
      tsLegacy,
      cfg([tsLegacy], { selectedServerId: 't1' }),
      idMap([tsLegacy]),
      deps()
    );
    const ep = r.pendingEndpoints.find((e) => e.tag === 'TS-legacy')!;
    expect(ep.type).toBe('tailscale');
    expect(ep.exit_node).toBeUndefined();
  });

  it('Phase2 非提权(systemInterfaceAvailable 缺省 false)：reverseMesh 节点**降级 gVisor 发射**(system:false)、仍可用', () => {
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
    // 非 TUN：不再跳过,降级 gVisor 发射 → 系统代理下该节点仍可用(与 UI 显示 gVisor 一致)。
    const ep = r.pendingEndpoints.find((e) => e.tag === 'WG-sys');
    expect(ep).toBeDefined();
    expect(ep!.system).toBe(false); // system:true 仅 TUN+helper;非提权降级 gVisor
    expect(ep!.name).toBeUndefined(); // gVisor 无内核接口名（WG endpoint 字段=`name`）
    expect(r.outbounds.find((o) => o.tag === 'proxy-selector')!.outbounds).toContain('WG-sys');
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

describe('buildOutbounds — §15 主核测速探测池', () => {
  it('probePoolPorts → K 个 probe-selector-k（成员=全量 nodeTags+direct，default=direct，interrupt=true）', () => {
    const servers = [vless('s1', 'HK'), vless('s2', 'JP')];
    const r = buildOutbounds(
      servers[0],
      cfg(servers),
      idMap(servers),
      deps({ probePoolPorts: [1, 2] })
    );
    for (let k = 0; k < 2; k++) {
      const sel = r.outbounds.find((o) => o.tag === `probe-selector-${k}`);
      expect(sel).toBeTruthy();
      expect(sel!.type).toBe('selector');
      expect(sel!.default).toBe('direct');
      expect(sel!.interrupt_exist_connections).toBe(true);
      // 成员 = proxy-selector 同款（全量 nodeTags + direct）；default ∈ 成员（sing-box 硬要求）
      expect(sel!.outbounds).toEqual(['HK', 'JP', 'direct']);
      expect(sel!.outbounds).toContain(sel!.default);
    }
    expect(r.outbounds.find((o) => o.tag === 'probe-selector-2')).toBeUndefined();
  });

  it('无 probePoolPorts → 零 probe-selector-k（回退临时核）', () => {
    const servers = [vless('s1', 'HK')];
    const r = buildOutbounds(servers[0], cfg(servers), idMap(servers), deps());
    expect(r.outbounds.some((o) => o.tag?.startsWith('probe-selector-'))).toBe(false);
  });

  it('§15.11-F4：probe-selector-k 门控仅取 probePoolPorts（config falsy 的 fallback 分支也发射，防悬空引用）', () => {
    const sel = vless('s1', 'HK');
    // config=null → 命中 else if(selectedServer) fallback 分支；池端口存在时 probe-selector-k 仍须发射，
    // 与 probe-in-k/route/dns-probe-exit-k 三 builder 门控一致（否则 probe-in-k→probe-selector-k 悬空 FATAL）。
    const r = buildOutbounds(sel, null as unknown as UserConfig, idMap([sel]), deps({ probePoolPorts: [1, 2] }));
    for (let k = 0; k < 2; k++) {
      const s = r.outbounds.find((o) => o.tag === `probe-selector-${k}`);
      expect(s).toBeTruthy();
      expect(s!.default).toBe('direct');
      expect(s!.outbounds).toContain('direct'); // fallback 下 nodeTags 空 → 成员=[direct]（default 合法）
    }
  });
});
