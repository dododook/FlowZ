/**
 * buildInbounds 单测 —— 原 ProxyManager.generateInbounds 无单测（仅 config-snapshot 集成锁字节）。
 * 锁：mixed inbound（listenAddr/端口/legacy sniff）/ probe inbound 注入 / TUN inbound（平台排除段/MTU/stack/
 * IPv6/macOS http_proxy platform）/ allowLan。Windows bypassLAN 排除段取 bypassLanCidrs(DEFAULT_BYPASS_LAN)。
 */
jest.mock('electron', () => ({
  app: { getPath: () => '/fake/userData', getAppPath: () => '/fake/app', isPackaged: false },
  net: {},
}));
// os.networkInterfaces 属性不可 spyOn 重定义 → 用 module mock；缺省返回空接口（getOwnLanCidrs 得 []），
// Windows carve 用例在 beforeEach 覆盖为固定接口，避免真机接口与测试 mesh 段偶然重叠致 own-LAN guard flaky。
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  networkInterfaces: jest.fn(() => ({})),
}));

import { buildInbounds, type InboundsDeps } from '../singbox-inbounds-builder';
import type { SingBoxInbound } from '../singbox-config-types';
import type { UserConfig } from '../../../shared/types';
import { withPlatform } from './platform-test-utils';
import { cidrOverlapsAny } from '../../../shared/ip';
import { BOOTSTRAP_DIRECT_DNS_IPS, CONTROLLED_TUN_DNS_IP } from '../../../shared/dns';
import * as os from 'os';

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

describe('buildInbounds — TUN 地址（issue #324 冲突避让）', () => {
  it('未预检（deps 缺省）→ 平台默认地址，字节与历史一致', () => {
    expect(
      byTag(
        withPlatform('win32', () =>
          buildInbounds(cfg({ proxyModeType: 'tun' }), undefined, deps())
        ),
        'tun-in'
      ).address
    ).toEqual(['172.19.0.1/16']);
    expect(
      byTag(
        withPlatform('darwin', () =>
          buildInbounds(cfg({ proxyModeType: 'tun' }), undefined, deps())
        ),
        'tun-in'
      ).address
    ).toEqual(['172.19.0.1/30']);
  });

  it('预检选出备选地址 → 主机地址替换，掩码仍按平台取', () => {
    // 变异守卫：掩码跟着候选一起漂（如恒用 /16）→ macOS 断言失败。前缀长度是平台调优结论，与冲突无关。
    const d = deps({ tunInet4Address: '172.20.0.1' });
    expect(
      byTag(
        withPlatform('win32', () => buildInbounds(cfg({ proxyModeType: 'tun' }), undefined, d)),
        'tun-in'
      ).address
    ).toEqual(['172.20.0.1/16']);
    expect(
      byTag(
        withPlatform('darwin', () => buildInbounds(cfg({ proxyModeType: 'tun' }), undefined, d)),
        'tun-in'
      ).address
    ).toEqual(['172.20.0.1/30']);
  });

  it('用户显式配置的 inet4Address 优先于预检结果（用户显式约束不被「更优解」覆盖）', () => {
    const ibs = withPlatform('win32', () =>
      buildInbounds(
        cfg({
          proxyModeType: 'tun',
          tunConfig: {
            mtu: 9000,
            stack: 'auto',
            autoRoute: true,
            strictRoute: true,
            inet4Address: '10.7.7.1/24',
          },
        }),
        undefined,
        deps({ tunInet4Address: '172.20.0.1' })
      )
    );
    expect(byTag(ibs, 'tun-in').address).toEqual(['10.7.7.1/24']);
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

  it('Windows TUN：核心 DNS 排除表 ⊇ 派生集（BOOTSTRAP_DIRECT_DNS_IPS + 受控 TUN DNS IP，各 /32），不含 SoT 外杂项 1.1.1.1', () => {
    const excl = byTag(
      withPlatform('win32', () => buildInbounds(cfg({ proxyModeType: 'tun' }), undefined, deps())),
      'tun-in'
    ).route_exclude_address as string[];
    // 派生集：单一真值 BOOTSTRAP_DIRECT_DNS_IPS（route-builder 引导直连同源）+ CONTROLLED_TUN_DNS_IP（受控接管 IP）。
    const derived = [...BOOTSTRAP_DIRECT_DNS_IPS, CONTROLLED_TUN_DNS_IP].map((ip) => `${ip}/32`);
    for (const cidr of derived) expect(excl).toContain(cidr);
    // 8.8.8.8（受控 TUN DNS IP）随派生集在内；SoT 外杂项 1.1.1.1 已移除（核心从不据此直连）。
    expect(excl).toContain(`${CONTROLLED_TUN_DNS_IP}/32`);
    expect(excl).not.toContain('1.1.1.1/32');
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
    const ibs = withPlatform('darwin', () => buildInbounds(c, undefined, deps()));
    expect(byTag(ibs, 'tun-in').route_exclude_address).toContain('1.2.3.4/32');
  });

  it('选中节点为裸 IPv6 字面量 → 排除 <addr>/128', () => {
    const c = cfg({
      proxyModeType: 'tun',
      servers: [{ id: 's1', address: '2001:db8::1', protocol: 'vless', port: 443 }],
      selectedServerId: 's1',
    } as unknown as Partial<UserConfig>);
    const ibs = withPlatform('darwin', () => buildInbounds(c, undefined, deps()));
    expect(byTag(ibs, 'tun-in').route_exclude_address).toContain('2001:db8::1/128');
  });

  // R3-2：address 经 Clash YAML 导入 / 表单输入可能保留方括号；脱括号后才是合法 CIDR（'[::1]/128' 非法）。
  it('选中节点为带方括号 IPv6 → 脱方括号后 <addr>/128（不拼出 [::1]/128 非法 CIDR）', () => {
    const c = cfg({
      proxyModeType: 'tun',
      servers: [{ id: 's1', address: '[::1]', protocol: 'vless', port: 443 }],
      selectedServerId: 's1',
    } as unknown as Partial<UserConfig>);
    const ibs = withPlatform('darwin', () => buildInbounds(c, undefined, deps()));
    const excl = byTag(ibs, 'tun-in').route_exclude_address as string[];
    expect(excl).toContain('::1/128');
    expect(excl).not.toContain('[::1]/128');
  });

  // ── Linux 加法翻转（§12/§12.7，VM185 实测坐实）：route_exclude 恒空、节点 IP 不排除、连入来源排除忽略 ──
  it('Linux TUN 加法态：route_exclude_address 字段省略（v4+v6 全清）', () => {
    const ibs = withPlatform('linux', () =>
      buildInbounds(cfg({ proxyModeType: 'tun' }), undefined, deps())
    );
    expect(byTag(ibs, 'tun-in').route_exclude_address).toBeUndefined();
  });

  it('Linux TUN：选中 IP 节点也不进 route_exclude（加法态跳过节点排除块，拨号回环靠 auto_detect_interface）', () => {
    const c = cfg({
      proxyModeType: 'tun',
      servers: [{ id: 's1', address: '1.2.3.4', protocol: 'vless', port: 443 }],
      selectedServerId: 's1',
    } as unknown as Partial<UserConfig>);
    const ibs = withPlatform('linux', () => buildInbounds(c, undefined, deps()));
    expect(byTag(ibs, 'tun-in').route_exclude_address).toBeUndefined();
  });

  it('Linux TUN：inboundExcludeCidrs 忽略+warn（加法态毒丸，不进排除）', () => {
    const log = jest.fn();
    const c = cfg({
      proxyModeType: 'tun',
      tunConfig: { inboundExcludeCidrs: ['10.99.0.0/16'] },
    } as unknown as Partial<UserConfig>);
    const ibs = withPlatform('linux', () => buildInbounds(c, undefined, deps({ log })));
    expect(byTag(ibs, 'tun-in').route_exclude_address).toBeUndefined();
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('连入来源排除'));
  });

  it('darwin/win32 未被 Linux 翻转影响：route_exclude 仍含回环/私网（零回归）', () => {
    const dar = withPlatform('darwin', () =>
      buildInbounds(cfg({ proxyModeType: 'tun' }), undefined, deps())
    );
    expect(byTag(dar, 'tun-in').route_exclude_address).toContain('127.0.0.0/8');
    const win = withPlatform('win32', () =>
      buildInbounds(cfg({ proxyModeType: 'tun' }), undefined, deps())
    );
    expect(byTag(win, 'tun-in').route_exclude_address).toContain('10.0.0.0/8');
  });

  it('Linux TUN：engaged 组网段与本机接口网段重叠 → warn（mesh∩ownLan，加法态告知本地按直连）', () => {
    (os.networkInterfaces as jest.Mock).mockReturnValue({
      eth0: [{ internal: false, cidr: '192.168.50.5/24' }],
    });
    const log = jest.fn();
    const c = cfg({
      proxyModeType: 'tun',
      selectedServerId: 'wg1',
      servers: [
        {
          id: 'wg1',
          protocol: 'wireguard',
          wireguardSettings: { allowedIPs: ['192.168.50.0/24'] },
        },
      ],
    } as unknown as Partial<UserConfig>);
    withPlatform('linux', () => buildInbounds(c, undefined, deps({ log })));
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('192.168.50.0/24'));
    (os.networkInterfaces as jest.Mock).mockReturnValue({}); // 复原，防污染后续
  });

  it('Linux TUN：engaged 组网段与本机接口不重叠 → 不 warn', () => {
    (os.networkInterfaces as jest.Mock).mockReturnValue({
      eth0: [{ internal: false, cidr: '10.0.0.5/24' }],
    });
    const log = jest.fn();
    const c = cfg({
      proxyModeType: 'tun',
      selectedServerId: 'wg1',
      servers: [
        {
          id: 'wg1',
          protocol: 'wireguard',
          wireguardSettings: { allowedIPs: ['192.168.50.0/24'] },
        },
      ],
    } as unknown as Partial<UserConfig>);
    withPlatform('linux', () => buildInbounds(c, undefined, deps({ log })));
    expect(log).not.toHaveBeenCalledWith('warn', expect.stringContaining('接口网段重叠'));
    (os.networkInterfaces as jest.Mock).mockReturnValue({});
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
  it('用户段追加进 route_exclude_address，保留回环（darwin——inboundExcludeCidrs 现 mac/win-only，linux 忽略）', () => {
    const ibs = withPlatform('darwin', () =>
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

  it('与【生效】组网 force-route 段重叠的用户段被剔除（mesh 优先）+ 记 warn（darwin）', () => {
    const warns: string[] = [];
    const ibs = withPlatform('darwin', () =>
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

  it('未 engaged 的「仅出网」组网节点段不减（engaged-only）：alwaysRouteSubnets=false 且未选中时用户段保留（darwin）', () => {
    const ibs = withPlatform('darwin', () =>
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

  it('无 inboundExcludeCidrs → route_exclude 仅回环（零变化，darwin）', () => {
    const ibs = withPlatform('darwin', () =>
      buildInbounds(cfg({ proxyModeType: 'tun' }), undefined, deps())
    );
    const tun = byTag(ibs, 'tun-in');
    expect(tun.route_exclude_address).toEqual(['127.0.0.0/8', '::1/128']);
  });
});

// gap #1 修复：Windows bypassLAN 宽私网段整体排除会架空落在其中的 engaged 组网 force-route 段
// （tailnet 100.64/10 / WG allowedIPs 私网段）→ 组网整体不可达。修法：对 engaged mesh 段算术差集 carve 开洞。
describe('buildInbounds — Windows bypassLAN engaged-mesh carve (gap #1)', () => {
  beforeEach(() => {
    // 固定本机接口为 192.168.99.0/24：与测试 mesh 段（100.64/10、10.20/16）不重叠 → carve 正常；
    // own-LAN guard 用例故意用 192.168.99.0/24 mesh 段命中它。
    (os.networkInterfaces as jest.Mock).mockReturnValue({
      eth0: [{ internal: false, cidr: '192.168.99.5/24' }],
    });
  });
  afterEach(() => (os.networkInterfaces as jest.Mock).mockReturnValue({}));

  it('Tailscale 节点选中 → 两族 tailnet（v4 100.64/10 + v6 fd7a::/48）carve 开洞，其余 bypass 仍排除', () => {
    const c = cfg({
      proxyModeType: 'tun',
      selectedServerId: 'ts1',
      servers: [{ id: 'ts1', protocol: 'tailscale', tailscaleSettings: {} }],
    } as unknown as Partial<UserConfig>);
    const excl = byTag(
      withPlatform('win32', () => buildInbounds(c, undefined, deps())),
      'tun-in'
    ).route_exclude_address as string[];
    expect(excl).not.toContain('100.64.0.0/10'); // v4 tailnet 进 TUN → 组网可达（修零门槛不可达缺口）
    expect(cidrOverlapsAny('100.64.1.2/32', excl)).toBe(false);
    // v6 tailnet fd7a::/48 从 bypassLAN 的 fc00::/7 carve 开洞 → 进 TUN（否则 enableIPv6 开启时 v6 tailnet 去 exit）
    expect(cidrOverlapsAny('fd7a:115c:a1e0::1/128', excl)).toBe(false);
    expect(excl).not.toContain('fc00::/7'); // fc00::/7 被挖洞、不再整段排除
    expect(cidrOverlapsAny('fc01::1/128', excl)).toBe(true); // fc00::/7 其余（非 fd7a）仍排除
    expect(excl).toContain('10.0.0.0/8'); // 其余 bypass 仍排除
    expect(excl).toContain('223.5.5.5/32'); // DNS 回流兜底仍在
  });

  it('WG 节点选中，allowedIPs 私网段 carve 开洞，其余 10/8 仍排除（含网关）', () => {
    const c = cfg({
      proxyModeType: 'tun',
      selectedServerId: 'wg1',
      servers: [
        { id: 'wg1', protocol: 'wireguard', wireguardSettings: { allowedIPs: ['10.20.0.0/16'] } },
      ],
    } as unknown as Partial<UserConfig>);
    const excl = byTag(
      withPlatform('win32', () => buildInbounds(c, undefined, deps())),
      'tun-in'
    ).route_exclude_address as string[];
    expect(cidrOverlapsAny('10.20.5.5/32', excl)).toBe(false); // mesh 段进 TUN
    expect(cidrOverlapsAny('10.21.5.5/32', excl)).toBe(true); // 其余 10/8 仍排除
  });

  it('own-LAN guard：mesh 段与本机物理子网重叠 → 不 carve（保网关排除）+ warn', () => {
    const warns: string[] = [];
    const c = cfg({
      proxyModeType: 'tun',
      selectedServerId: 'wg1',
      servers: [
        {
          id: 'wg1',
          protocol: 'wireguard',
          wireguardSettings: { allowedIPs: ['192.168.99.0/24'] },
        },
      ],
    } as unknown as Partial<UserConfig>);
    const excl = byTag(
      withPlatform('win32', () =>
        buildInbounds(
          c,
          undefined,
          deps({
            log: (l, m) => {
              if (l === 'warn') warns.push(m);
            },
          })
        )
      ),
      'tun-in'
    ).route_exclude_address as string[];
    expect(cidrOverlapsAny('192.168.99.5/32', excl)).toBe(true); // 仍被排除（含在 192.168.0.0/16，网关保护优先）
    expect(warns.some((w) => w.includes('物理子网') && w.includes('192.168.99.0/24'))).toBe(true);
  });

  it('无组网节点 → bypassLAN 排除表与旧行为字节等价（tailnet 100.64/10 仍排除）', () => {
    const excl = byTag(
      withPlatform('win32', () => buildInbounds(cfg({ proxyModeType: 'tun' }), undefined, deps())),
      'tun-in'
    ).route_exclude_address as string[];
    expect(excl).toContain('100.64.0.0/10'); // 无组网 → 不 carve，现状不变
    expect(excl).toContain('10.0.0.0/8');
  });

  it('W2：bypassLAN 段与「走代理」自定义规则重叠 → warn（Windows 内核排除架空规则）', () => {
    const warns: string[] = [];
    const c = cfg({
      proxyModeType: 'tun',
      customRules: [
        { id: 'r1', enabled: true, action: 'proxy', type: 'ipCidr', values: ['192.168.5.0/24'] },
      ],
    } as unknown as Partial<UserConfig>);
    withPlatform('win32', () =>
      buildInbounds(
        c,
        undefined,
        deps({
          log: (l, m) => {
            if (l === 'warn') warns.push(m);
          },
        })
      )
    );
    // 告警列出被排除的 bypass 段（192.168.0.0/16 ⊃ 规则 192.168.5.0/24）——即用户应从「绕过局域网」清单移除的那条。
    expect(warns.some((w) => w.includes('绕过局域网') && w.includes('192.168.0.0/16'))).toBe(true);
  });

  it('W2/M1：carve 生效时告警列出【原始清单条目】而非 carve 合成片段（可操作）', () => {
    const warns: string[] = [];
    const c = cfg({
      proxyModeType: 'tun',
      selectedServerId: 'wg1', // WG engaged → 其 10.20.0.0/16 把 bypass 的 10.0.0.0/8 carve 成片段
      servers: [
        { id: 'wg1', protocol: 'wireguard', wireguardSettings: { allowedIPs: ['10.20.0.0/16'] } },
      ],
      // proxy 规则命中 carve 洞外、仍被排除的 10.99.0.0/16 → 应告警，且列出用户清单里的 10.0.0.0/8
      customRules: [
        { id: 'r1', enabled: true, action: 'proxy', type: 'ipCidr', values: ['10.99.0.0/16'] },
      ],
    } as unknown as Partial<UserConfig>);
    withPlatform('win32', () =>
      buildInbounds(
        c,
        undefined,
        deps({
          log: (l, m) => {
            if (l === 'warn') warns.push(m);
          },
        })
      )
    );
    // 报原始条目 10.0.0.0/8（carve 前 win.exclude 不含它、只含片段 → 若报片段则不会出现 10.0.0.0/8，此断言唯一验证 M1 修复）
    expect(warns.some((w) => w.includes('绕过局域网') && w.includes('10.0.0.0/8'))).toBe(true);
  });

  it('W2/N-1：清单含嵌套条目（/16+其内 /24）时只报真正阻断的宽条目，不误列被包含的子条目', () => {
    const warns: string[] = [];
    const c = cfg({
      proxyModeType: 'tun',
      // 用户保留默认 /16 又冗余添加自己子网 /24（常见）；无组网 → 无 carve，两条都在排除表
      bypassLANList: ['192.168.0.0/16', '192.168.50.0/24'],
      // 规则命中 /16 内、/24 外 → 只有 /16 真正阻断它（移除 /24 是 no-op）
      customRules: [
        { id: 'r1', enabled: true, action: 'proxy', type: 'ipCidr', values: ['192.168.80.0/24'] },
      ],
    } as unknown as Partial<UserConfig>);
    withPlatform('win32', () =>
      buildInbounds(
        c,
        undefined,
        deps({
          log: (l, m) => {
            if (l === 'warn') warns.push(m);
          },
        })
      )
    );
    const w2 = warns.find((w) => w.includes('绕过局域网') && w.includes('自定义规则'));
    expect(w2).toBeTruthy();
    expect(w2).toContain('192.168.0.0/16'); // 真正阻断的宽条目
    expect(w2).not.toContain('192.168.50.0/24'); // 被 /16 包含的子条目：移除它 no-op，不误列
  });
});

describe('buildInbounds — §15 主核测速探测池', () => {
  it('probePoolPorts=[a,b,c] → 注入 3 个 probe-in-k http 入站（端口按 k 1:1）', () => {
    const ibs = withPlatform('linux', () =>
      buildInbounds(cfg({}), undefined, deps({ probePoolPorts: [30000, 30001, 30002] }))
    );
    for (let k = 0; k < 3; k++) {
      const ib = byTag(ibs, `probe-in-${k}`);
      expect(ib.type).toBe('http');
      expect(ib.listen).toBe('127.0.0.1');
      expect(ib.listen_port).toBe(30000 + k);
    }
    expect(ibs.find((i) => i.tag === 'probe-in-3')).toBeUndefined();
  });

  it('无 probePoolPorts → 零 probe-in-k 注入（回退临时核，字节不变）', () => {
    const ibs = withPlatform('linux', () => buildInbounds(cfg({}), undefined, deps()));
    expect(ibs.some((i) => i.tag?.startsWith('probe-in-'))).toBe(false);
  });
});
