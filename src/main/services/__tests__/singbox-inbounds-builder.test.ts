/**
 * buildInbounds 单测 —— 原 ProxyManager.generateInbounds 无单测（仅 config-snapshot 集成锁字节）。
 * 锁：mixed inbound（listenAddr/端口/legacy sniff）/ probe inbound 注入 / TUN inbound（平台排除段/MTU/stack/
 * IPv6/macOS http_proxy platform）/ allowLan。Windows bypassLAN 排除段取 bypassLanCidrs(DEFAULT_BYPASS_LAN)。
 */
jest.mock('electron', () => ({
  app: { getPath: () => '/fake/userData', getAppPath: () => '/fake/app', isPackaged: false },
  net: {},
}));

import { buildInbounds, type InboundsDeps } from '../singbox-inbounds-builder';
import type { SingBoxInbound } from '../singbox-config-types';
import type { UserConfig } from '../../../shared/types';
import { withPlatform } from './platform-test-utils';

const deps = (over: Partial<InboundsDeps> = {}): InboundsDeps => ({
  probeDirectPort: null,
  probeProxyPort: null,
  updateInPort: null,
  ...over,
});

const cfg = (over: Partial<UserConfig>): UserConfig =>
  ({
    proxyModeType: 'systemProxy',
    servers: [],
    selectedServerId: 's1',
    ...over,
  }) as unknown as UserConfig;

/** 按 tag 取 inbound 并断言存在（消 strict undefined）。 */
function byTag(ibs: SingBoxInbound[], tag: string): SingBoxInbound {
  const ib = ibs.find((i) => i.tag === tag);
  expect(ib).toBeTruthy();
  return ib as SingBoxInbound;
}

describe('buildInbounds — mixed + probe', () => {
  it('systemProxy：恒含 mixed-in（listen 127.0.0.1）；1.13 不带 legacy sniff', () => {
    const ibs = withPlatform('linux', () => buildInbounds(cfg({}), undefined, deps()));
    const mixed = byTag(ibs, 'mixed-in');
    expect(mixed.listen).toBe('127.0.0.1');
    expect(mixed.sniff).toBeUndefined(); // 1.13 路由层 sniff
  });

  it('allowLan=true → mixed listen=::（监听全部接口）', () => {
    const ibs = withPlatform('linux', () =>
      buildInbounds(cfg({ allowLan: true }), undefined, deps())
    );
    expect(byTag(ibs, 'mixed-in').listen).toBe('::');
  });

  it('probe 端口注入 → 增 probe-direct-in/probe-proxy-in（对应端口）', () => {
    const ibs = withPlatform('linux', () =>
      buildInbounds(cfg({}), undefined, deps({ probeDirectPort: 21001, probeProxyPort: 21002 }))
    );
    expect(byTag(ibs, 'probe-direct-in').listen_port).toBe(21001);
    expect(byTag(ibs, 'probe-proxy-in').listen_port).toBe(21002);
  });

  it('probe 端口缺失（null）→ 不注入探针', () => {
    const ibs = withPlatform('linux', () => buildInbounds(cfg({}), undefined, deps()));
    expect(ibs.map((i) => i.tag)).not.toContain('probe-direct-in');
  });

  it('update-in 端口注入 → 增 update-in（socks，对应端口）', () => {
    const ibs = withPlatform('linux', () =>
      buildInbounds(cfg({}), undefined, deps({ updateInPort: 21003 }))
    );
    const updateIn = byTag(ibs, 'update-in');
    expect(updateIn.type).toBe('socks');
    expect(updateIn.listen).toBe('127.0.0.1');
    expect(updateIn.listen_port).toBe(21003);
  });

  it('update-in 端口缺失（null）→ 不注入', () => {
    const ibs = withPlatform('linux', () => buildInbounds(cfg({}), undefined, deps()));
    expect(ibs.map((i) => i.tag)).not.toContain('update-in');
  });
});

describe('buildInbounds — TUN', () => {
  it('TUN：增 tun-in；route_exclude_address 含回环；macOS gvisor 栈 + http_proxy platform', () => {
    const ibs = withPlatform('darwin', () =>
      buildInbounds(cfg({ proxyModeType: 'tun' }), undefined, deps())
    );
    const tun = byTag(ibs, 'tun-in');
    expect(tun.stack).toBe('gvisor'); // macOS auto/缺省 → 平台默认 gvisor（resolveTunStack）
    expect(tun.route_exclude_address).toContain('127.0.0.0/8');
    expect(tun.platform?.http_proxy?.enabled).toBe(true); // macOS http_proxy
  });

  it('mac 显式 stack=system 原样下发（全平台 honor，不砌墙；mac 默认仍 gvisor 见上 auto 用例）', () => {
    const ibs = withPlatform('darwin', () =>
      buildInbounds(
        cfg({
          proxyModeType: 'tun',
          tunConfig: { stack: 'system', mtu: 1500, autoRoute: true, strictRoute: true },
        }),
        undefined,
        deps()
      )
    );
    expect(byTag(ibs, 'tun-in').stack).toBe('system');
  });

  it('显式 stack=mixed 全平台原样下发（honor 用户选择）', () => {
    const ibs = withPlatform('win32', () =>
      buildInbounds(
        cfg({
          proxyModeType: 'tun',
          tunConfig: { stack: 'mixed', mtu: 1500, autoRoute: true, strictRoute: true },
        }),
        undefined,
        deps()
      )
    );
    expect(byTag(ibs, 'tun-in').stack).toBe('mixed');
  });

  it('Windows TUN + bypassLAN：排除段含私网 CIDR + 核心 DNS IP', () => {
    const ibs = withPlatform('win32', () =>
      buildInbounds(cfg({ proxyModeType: 'tun' }), undefined, deps())
    );
    const tun = byTag(ibs, 'tun-in');
    expect(tun.stack).toBe('system'); // Windows system 栈
    expect(tun.route_exclude_address).toContain('10.0.0.0/8'); // bypassLAN 默认 true
    expect(tun.route_exclude_address).toContain('223.5.5.5/32'); // 核心 DNS 防回流
  });

  it('Windows TUN：下发固定接口名 interface_name=flowz-tun0（缺省，issue #159 适配器释放门控锚点）', () => {
    const ibs = withPlatform('win32', () =>
      buildInbounds(cfg({ proxyModeType: 'tun' }), undefined, deps())
    );
    expect(byTag(ibs, 'tun-in').interface_name).toBe('flowz-tun0');
  });

  it('Windows TUN：尊重 tunConfig.interfaceName 覆盖', () => {
    const c = cfg({
      proxyModeType: 'tun',
      tunConfig: { interfaceName: 'my-tun' },
    } as unknown as Partial<UserConfig>);
    const ibs = withPlatform('win32', () => buildInbounds(c, undefined, deps()));
    expect(byTag(ibs, 'tun-in').interface_name).toBe('my-tun');
  });

  it('mac/Linux TUN：不下发 interface_name（utun 名内核分配 / 无释放竞态）', () => {
    for (const plat of ['darwin', 'linux'] as const) {
      const ibs = withPlatform(plat, () =>
        buildInbounds(cfg({ proxyModeType: 'tun' }), undefined, deps())
      );
      expect(byTag(ibs, 'tun-in').interface_name).toBeUndefined();
    }
  });

  it('选中节点为 IP 字面量 → 排除该节点 IP（防回流死循环）', () => {
    const c = cfg({
      proxyModeType: 'tun',
      servers: [{ id: 's1', address: '1.2.3.4', protocol: 'vless', port: 443 }],
      selectedServerId: 's1',
    } as unknown as Partial<UserConfig>);
    const ibs = withPlatform('linux', () => buildInbounds(c, undefined, deps()));
    expect(byTag(ibs, 'tun-in').route_exclude_address).toContain('1.2.3.4/32');
  });

  it('选中节点为裸 IPv6 字面量 → 排除 <addr>/128', () => {
    const c = cfg({
      proxyModeType: 'tun',
      servers: [{ id: 's1', address: '2001:db8::1', protocol: 'vless', port: 443 }],
      selectedServerId: 's1',
    } as unknown as Partial<UserConfig>);
    const ibs = withPlatform('linux', () => buildInbounds(c, undefined, deps()));
    expect(byTag(ibs, 'tun-in').route_exclude_address).toContain('2001:db8::1/128');
  });

  // R3-2：address 经 Clash YAML 导入 / 表单输入可能保留方括号；脱括号后才是合法 CIDR（'[::1]/128' 非法）。
  it('选中节点为带方括号 IPv6 → 脱方括号后 <addr>/128（不拼出 [::1]/128 非法 CIDR）', () => {
    const c = cfg({
      proxyModeType: 'tun',
      servers: [{ id: 's1', address: '[::1]', protocol: 'vless', port: 443 }],
      selectedServerId: 's1',
    } as unknown as Partial<UserConfig>);
    const ibs = withPlatform('linux', () => buildInbounds(c, undefined, deps()));
    const excl = byTag(ibs, 'tun-in').route_exclude_address as string[];
    expect(excl).toContain('::1/128');
    expect(excl).not.toContain('[::1]/128');
  });
});

// P6 LAN 网关：TUN include/exclude_mac_address（sing-box 1.14）。门控：仅 Linux + auto_route，且有合法 MAC，
// 满足时必发 auto_redirect:true（内核硬限界前置）+ include/exclude 之一（互斥）。
describe('buildInbounds — TUN MAC 过滤（P6 LAN 网关）', () => {
  const tunMac = (over: Partial<NonNullable<UserConfig['tunConfig']>>): Partial<UserConfig> => ({
    proxyModeType: 'tun',
    tunConfig: { mtu: 1350, stack: 'system', autoRoute: true, strictRoute: true, ...over } as any,
  });

  it('Linux + include + 合法 MAC → auto_redirect:true + include_mac_address（无 exclude）', () => {
    const ibs = withPlatform('linux', () =>
      buildInbounds(
        cfg(tunMac({ macFilterMode: 'include', macFilterList: ['00:11:22:33:44:55'] })),
        undefined,
        deps()
      )
    );
    const tun = byTag(ibs, 'tun-in');
    expect(tun.auto_redirect).toBe(true);
    expect(tun.include_mac_address).toEqual(['00:11:22:33:44:55']);
    expect(tun.exclude_mac_address).toBeUndefined();
  });

  it('Linux + exclude → exclude_mac_address（无 include），脏 MAC 剔除', () => {
    const ibs = withPlatform('linux', () =>
      buildInbounds(
        cfg(tunMac({ macFilterMode: 'exclude', macFilterList: ['aa-bb-cc-dd-ee-ff', 'bad'] })),
        undefined,
        deps()
      )
    );
    const tun = byTag(ibs, 'tun-in');
    expect(tun.exclude_mac_address).toEqual(['aa-bb-cc-dd-ee-ff']); // bad 剔除
    expect(tun.include_mac_address).toBeUndefined();
    expect(tun.auto_redirect).toBe(true);
  });

  it('非 Linux（macOS）→ 不发射 MAC 过滤 / auto_redirect（内核不支持）', () => {
    const ibs = withPlatform('darwin', () =>
      buildInbounds(
        cfg(tunMac({ macFilterMode: 'include', macFilterList: ['00:11:22:33:44:55'] })),
        undefined,
        deps()
      )
    );
    const tun = byTag(ibs, 'tun-in');
    expect(tun.include_mac_address).toBeUndefined();
    expect(tun.auto_redirect).toBeUndefined();
  });

  it('Linux + auto_route 关 → 不发射（auto_redirect 依赖 auto_route）', () => {
    const ibs = withPlatform('linux', () =>
      buildInbounds(
        cfg(
          tunMac({
            autoRoute: false,
            macFilterMode: 'include',
            macFilterList: ['00:11:22:33:44:55'],
          })
        ),
        undefined,
        deps()
      )
    );
    const tun = byTag(ibs, 'tun-in');
    expect(tun.include_mac_address).toBeUndefined();
    expect(tun.auto_redirect).toBeUndefined();
  });

  it('Linux + 全脏 MAC → 不发射（无合法值）', () => {
    const ibs = withPlatform('linux', () =>
      buildInbounds(
        cfg(tunMac({ macFilterMode: 'include', macFilterList: ['nope', '001122334455'] })),
        undefined,
        deps()
      )
    );
    const tun = byTag(ibs, 'tun-in');
    expect(tun.include_mac_address).toBeUndefined();
    expect(tun.auto_redirect).toBeUndefined();
  });

  it('未配 macFilterMode → 零变化（不发 auto_redirect）', () => {
    const ibs = withPlatform('linux', () => buildInbounds(cfg(tunMac({})), undefined, deps()));
    const tun = byTag(ibs, 'tun-in');
    expect(tun.auto_redirect).toBeUndefined();
    expect(tun.include_mac_address).toBeUndefined();
  });
});

describe('buildInbounds — TUN 连入来源排除 (inboundExcludeCidrs)', () => {
  it('Linux：用户段追加进 route_exclude_address，保留回环', () => {
    const ibs = withPlatform('linux', () =>
      buildInbounds(
        cfg({
          proxyModeType: 'tun',
          // 用文档保留段 203.0.113.0/24(TEST-NET-3)避免撞真机接口；10.147.x 模拟 ZeroTier 连入源
          tunConfig: { inboundExcludeCidrs: ['203.0.113.0/24', '10.147.0.0/16'] },
        } as Partial<UserConfig>),
        undefined,
        deps()
      )
    );
    const tun = byTag(ibs, 'tun-in');
    expect(tun.route_exclude_address).toContain('127.0.0.0/8');
    expect(tun.route_exclude_address).toContain('203.0.113.0/24');
    expect(tun.route_exclude_address).toContain('10.147.0.0/16');
  });

  it('与【生效】组网 force-route 段重叠的用户段被剔除（mesh 优先）+ 记 warn', () => {
    const warns: string[] = [];
    const ibs = withPlatform('linux', () =>
      buildInbounds(
        cfg({
          proxyModeType: 'tun',
          // 选中该 WG 节点 → engaged，其 force-route 段生效 → 与之重叠的用户段被剔除
          selectedServerId: 'wg1',
          tunConfig: { inboundExcludeCidrs: ['203.0.113.0/24', '192.168.50.0/24'] },
          servers: [
            {
              id: 'wg1',
              protocol: 'wireguard',
              wireguardSettings: { allowedIPs: ['192.168.50.0/24'] },
            },
          ],
        } as unknown as Partial<UserConfig>),
        undefined,
        deps({
          log: (lvl, msg) => {
            if (lvl === 'warn') warns.push(msg);
          },
        })
      )
    );
    const tun = byTag(ibs, 'tun-in');
    expect(tun.route_exclude_address).toContain('203.0.113.0/24'); // 非重叠段保留
    expect(tun.route_exclude_address).not.toContain('192.168.50.0/24'); // 与生效 mesh 段重叠 → 剔除
    expect(warns.some((w) => w.includes('组网') && w.includes('192.168.50.0/24'))).toBe(true);
  });

  it('未 engaged 的「仅出网」组网节点段不减（engaged-only）：alwaysRouteSubnets=false 且未选中时用户段保留', () => {
    const ibs = withPlatform('linux', () =>
      buildInbounds(
        cfg({
          proxyModeType: 'tun',
          selectedServerId: 'other', // WG 未选中、无规则指向
          tunConfig: { inboundExcludeCidrs: ['192.168.50.0/24'] },
          servers: [
            {
              id: 'wg1',
              protocol: 'wireguard',
              // alwaysRouteSubnets=false（「仅出网」语义）→ 段只在 engaged 时 force-route；未选中=不 engaged=不 force-route
              wireguardSettings: { allowedIPs: ['192.168.50.0/24'], alwaysRouteSubnets: false },
            },
          ],
        } as unknown as Partial<UserConfig>),
        undefined,
        deps()
      )
    );
    // 未 engaged 的段不实际 force-route，故不误剔用户段（避免假告警 + 静默架空合法段）——对比全量 servers 会误剔
    expect(byTag(ibs, 'tun-in').route_exclude_address).toContain('192.168.50.0/24');
  });

  it('无 inboundExcludeCidrs → route_exclude 仅回环（零变化）', () => {
    const ibs = withPlatform('linux', () =>
      buildInbounds(cfg({ proxyModeType: 'tun' }), undefined, deps())
    );
    const tun = byTag(ibs, 'tun-in');
    expect(tun.route_exclude_address).toEqual(['127.0.0.0/8', '::1/128']);
  });
});
