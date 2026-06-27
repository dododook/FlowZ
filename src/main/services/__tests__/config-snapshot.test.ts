/**
 * generateSingBoxConfig 字节级 characterization 快照网 —— SingBoxConfigBuilder 抽取前锁基线（审计 §6 Tier-2）。
 * 「config 字节相同 = sing-box 行为相同」→ 抽取后快照不变即离线证等价（启停/热切换真机另验）。
 *
 * 确定性：app.getPath 固定假路径（非随机 temp）/ coreVersion 定值 / clashApiSecret 定值 / 无 Date·random；
 *   平台敏感分支（TUN inbound）按平台分别快照。捕获 config JSON + 两个「生成后被 hotSwitch/clash_api 回读」的
 *   载体 currentIdToTagMap / currentRuleTargetMap（不在 config JSON 内；pendingEndpoints 已含于 config.endpoints）。
 * 矩阵非冗余：每条覆盖一个不同维度（协议/模式/规则/应用分流/endpoint/DNS/版本带）。
 */
jest.mock('electron', () => ({
  app: {
    getPath: () => '/fake/userData',
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => '/fake/app',
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

// 测试环境无 .srs 文件 → isValidSrsFile 恒 false → applyRuleSetPrune 会把所有 geo rule_set 路由规则剪光，
// 快照只能锁到「剪空」结果。mock 为 true（其余 export 保真）→ 解封 geo rule_set 定义/装配/去重路径供快照锁住。
jest.mock('../builtin-geo-rulesets', () => ({
  ...jest.requireActual('../builtin-geo-rulesets'),
  isValidSrsFile: () => true,
}));

import { ProxyManager } from '../ProxyManager';
import { resourceManager } from '../ResourceManager';
import type { UserConfig, ServerConfig, Rule } from '../../../shared/types';
import { withPlatform } from './platform-test-utils';

function makeSvc(coreVersion = '1.13.0'): any {
  const svc: any = new ProxyManager(undefined, undefined, '/fake/cfg.json', '/fake/sing-box');
  svc.coreVersion = coreVersion;
  return svc;
}

function server(over: Partial<ServerConfig>): ServerConfig {
  return {
    id: 's1',
    name: 'HK',
    protocol: 'vless',
    address: 'a.example.com',
    port: 443,
    uuid: 'uuid-1',
    ...over,
  } as ServerConfig;
}

function cfg(over: Partial<UserConfig>): UserConfig {
  return {
    subscriptions: [],
    servers: [],
    selectedServerId: 's1',
    proxyMode: 'smart',
    proxyModeType: 'systemProxy',
    tunConfig: { mtu: 1350, stack: 'system', autoRoute: true, strictRoute: true },
    customRules: [],
    appRules: [],
    customAppPresets: [],
    autoStart: false,
    silentStart: false,
    autoConnect: false,
    minimizeToTray: false,
    socksPort: 1080,
    httpPort: 1087,
    mixedPort: 7890,
    logLevel: 'info',
    clashApiSecret: 'testsecret',
    ...over,
  } as unknown as UserConfig;
}

/**
 * 路径分隔符归一化（深度遍历，所有 string 值 '\' → '/'）。
 * config-gen 用 path.join 生成 cache.db / external_ui / rules/*.srs 等路径；path 模块的分隔符由**真实 host OS**
 * 决定，mock process.platform 改不到它 → 快照在 Linux 录（'/'），Windows CI host 上同一 config 出 '\' 必失败。
 * 归一化后快照与 host OS 无关：Linux 上是 no-op（本就 '/'），Windows 上转换即匹配。production 路径不受影响
 * （path.join 各平台本就该用对应分隔符，此处仅令快照可移植）。
 */
function normalizeSep<T>(v: T): T {
  if (typeof v === 'string') return v.replace(/\\/g, '/') as unknown as T;
  if (Array.isArray(v)) return v.map(normalizeSep) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      out[k] = normalizeSep((v as Record<string, unknown>)[k]);
    }
    return out as unknown as T;
  }
  return v;
}

/**
 * 生成 config + 捕获两个回写载体（hotSwitch/clash_api 生成后回读，不在 config JSON 内）。
 * platform 默认 'linux' 固定钉住——config-gen 平台相关（TUN 栈等），不钉则快照随运行机器漂移（Mac/Win 贡献者本地必失败）。
 */
function snap(
  config: UserConfig,
  coreVersion = '1.13.0',
  platform: NodeJS.Platform = 'linux',
  // 注入实例态（如 lanResolverForDns，运行时由 startInternal 写入；快照里手动设以锁相关 DNS 分支）。
  setup?: (svc: any) => void
) {
  return withPlatform(platform, () => {
    const svc = makeSvc(coreVersion);
    if (setup) setup(svc);
    const config_ = svc.generateSingBoxConfig(config);
    return normalizeSep({
      config: config_,
      idToTagMap: Object.fromEntries(svc.currentIdToTagMap ?? new Map()),
      ruleTargetMap: Object.fromEntries(svc.currentRuleTargetMap ?? new Map()),
    });
  });
}

describe('generateSingBoxConfig — characterization 快照（抽取前锁基线）', () => {
  it('systemProxy + smart + vless（基线）', () => {
    expect(snap(cfg({ servers: [server({})] }))).toMatchSnapshot();
  });

  // 地区分流（4.1.0）：非默认场景锁路由规则——本地/海外/final 按 region+reverse 翻转、未激活地区 geo 收窄注入。
  // 默认（CN 正向）由上方基线覆盖（应逐字节=今日）。
  it('地区分流 ir 正向（本地直连·海外代理；仅 ir geo 注入 rule_set）', () => {
    expect(
      snap(
        cfg({
          servers: [server({})],
          regionRouting: { enabled: true, region: 'ir', reverse: false },
        })
      )
    ).toMatchSnapshot();
  });
  it('地区分流 ru 正向', () => {
    expect(
      snap(
        cfg({
          servers: [server({})],
          regionRouting: { enabled: true, region: 'ru', reverse: false },
        })
      )
    ).toMatchSnapshot();
  });
  it('地区分流 cn 反向（回国：本地代理·海外直连·final=direct）', () => {
    expect(
      snap(
        cfg({
          servers: [server({})],
          regionRouting: { enabled: true, region: 'cn', reverse: true },
        })
      )
    ).toMatchSnapshot();
  });
  it('地区分流 关闭（无 geo 基线，仅自定义规则 + final 兜底）', () => {
    expect(
      snap(
        cfg({
          servers: [server({})],
          regionRouting: { enabled: false, region: 'cn', reverse: false },
        })
      )
    ).toMatchSnapshot();
  });

  it('TUN + trojan（平台敏感，分别锁 linux/darwin/win32）', () => {
    const c = cfg({
      proxyModeType: 'tun',
      servers: [server({ protocol: 'trojan', password: 'pw', uuid: undefined })],
    });
    for (const plat of ['linux', 'darwin', 'win32'] as const) {
      expect(snap(c, '1.13.0', plat)).toMatchSnapshot(`TUN-${plat}`);
    }
  });

  it('global 模式 + shadowsocks', () => {
    expect(
      snap(
        cfg({
          proxyMode: 'global',
          servers: [
            server({
              protocol: 'shadowsocks',
              uuid: undefined,
              shadowsocksSettings: { method: 'aes-256-gcm', password: 'sspw' },
            } as Partial<ServerConfig>),
          ],
        })
      )
    ).toMatchSnapshot();
  });

  it('smart + customRules（domainSuffix→proxy / geoip→direct / geosite→block）→ 锁 route 规则 + ruleTargetMap', () => {
    const customRules: Rule[] = [
      { id: 'r1', type: 'domainSuffix', values: ['example.com'], action: 'proxy', enabled: true },
      { id: 'r2', type: 'geoip', values: ['cn'], action: 'direct', enabled: true },
      { id: 'r3', type: 'geosite', values: ['category-ads-all'], action: 'block', enabled: true },
    ] as unknown as Rule[];
    expect(snap(cfg({ servers: [server({})], customRules }))).toMatchSnapshot();
  });

  it('smart + appRules + customAppPresets → 锁 rule-sel-app + ruleTargetMap', () => {
    expect(
      snap(
        cfg({
          servers: [server({})],
          customAppPresets: [
            {
              id: 'custom-app1',
              name: 'MyApp',
              emoji: '🌐',
              // 混合大小写：端到端锁 geosite tag 小写归一（getRequiredGeoCategories 收集 + route 发射端引用
              // 同步 toLowerCase）。snapshot 不变即证两端一致输出 geosite-youtube；回退任一端则 snapshot 漂移报警。
              geositeTags: ['YouTube'],
              geoipTags: [],
            },
          ],
          appRules: [{ appId: 'custom-app1', action: 'proxy', enabled: true }],
        } as unknown as Partial<UserConfig>)
      )
    ).toMatchSnapshot();
  });

  it('FakeIP 例外域名 用户编辑清单 → 内置 captive 走内网解析、其余 dns-domestic + ntp/stun 关键字兜底', () => {
    expect(
      snap(
        cfg({
          servers: [server({})],
          dnsConfig: { enableFakeIp: true },
          fakeIpFilterList: ['captive.apple.com', 'my-ntp.example.com'],
        } as unknown as Partial<UserConfig>)
      )
    ).toMatchSnapshot();
  });

  it('多节点 + 选中第二个 → 锁 idToTagMap 唯一化 + selector 成员', () => {
    expect(
      snap(
        cfg({
          servers: [server({ id: 's1', name: '香港' }), server({ id: 's2', name: '日本' })],
          selectedServerId: 's2',
        })
      )
    ).toMatchSnapshot();
  });

  it('WireGuard endpoint（mesh）→ 锁 endpoints[] + pendingEndpoints 载体', () => {
    expect(
      snap(
        cfg({
          servers: [
            server({
              name: 'WG-US',
              protocol: 'wireguard',
              uuid: undefined,
              wireguardSettings: {
                privateKey: 'cHJpdmtleQ==',
                peerPublicKey: 'cHVia2V5',
                localAddress: ['10.0.0.2/32'],
              },
            } as unknown as Partial<ServerConfig>),
          ],
        })
      )
    ).toMatchSnapshot();
  });

  it('多协议 outbound（hysteria2/tuic/vmess/anytls/socks/http）→ 锁各协议字段块', () => {
    expect(
      snap(
        cfg({
          servers: [
            server({
              id: 'h',
              name: 'HY2',
              protocol: 'hysteria2',
              uuid: undefined,
              password: 'p',
              hysteria2Settings: {
                upMbps: 100,
                downMbps: 500,
                obfs: { type: 'salamander', password: 'o' },
                network: 'udp',
              },
            } as unknown as Partial<ServerConfig>),
            server({
              id: 't',
              name: 'TUIC',
              protocol: 'tuic',
              password: 'p',
              tuicSettings: { congestionControl: 'bbr', udpRelayMode: 'native' },
            } as unknown as Partial<ServerConfig>),
            server({
              id: 'v',
              name: 'VMess',
              protocol: 'vmess',
              alterId: 0,
              vmessSecurity: 'auto',
            } as unknown as Partial<ServerConfig>),
            server({
              id: 'at',
              name: 'AnyTLS',
              protocol: 'anytls',
              uuid: undefined,
              password: 'p',
              anyTlsSettings: { idleSessionTimeout: '30s' },
            } as unknown as Partial<ServerConfig>),
            server({
              id: 'sk',
              name: 'SOCKS',
              protocol: 'socks',
              uuid: undefined,
              username: 'u',
              password: 'p',
            } as unknown as Partial<ServerConfig>),
            server({
              id: 'ht',
              name: 'HTTP',
              protocol: 'http',
              uuid: undefined,
              username: 'u',
              password: 'p',
            } as unknown as Partial<ServerConfig>),
          ],
          selectedServerId: 'h',
        })
      )
    ).toMatchSnapshot();
  });

  it('vless reality + shadowsocks shadow-tls → 锁 reality tls + stls 外层', () => {
    expect(
      snap(
        cfg({
          servers: [
            server({
              id: 'rl',
              name: 'Reality',
              protocol: 'vless',
              security: 'reality',
              tlsSettings: { serverName: 'apple.com', fingerprint: 'chrome' },
              realitySettings: { publicKey: 'PBK', shortId: 'sid' },
            } as unknown as Partial<ServerConfig>),
            server({
              id: 'st',
              name: 'ShadowTLS',
              protocol: 'shadowsocks',
              uuid: undefined,
              shadowsocksSettings: { method: 'aes-256-gcm', password: 'p' },
              shadowTlsSettings: {
                password: 'stp',
                sni: 'gateway.icloud.com',
                fingerprint: 'chrome',
                port: 443,
              },
            } as unknown as Partial<ServerConfig>),
          ],
          selectedServerId: 'rl',
        })
      )
    ).toMatchSnapshot();
  });

  it('transport ws + grpc → 锁 generateTransportConfig', () => {
    expect(
      snap(
        cfg({
          servers: [
            server({
              id: 'ws',
              name: 'WS',
              protocol: 'vless',
              network: 'ws',
              wsSettings: { path: '/p', headers: { Host: 'h.com' } },
            } as unknown as Partial<ServerConfig>),
            server({
              id: 'gr',
              name: 'GRPC',
              protocol: 'vmess',
              alterId: 0,
              network: 'grpc',
              grpcSettings: { serviceName: 'svc' },
            } as unknown as Partial<ServerConfig>),
          ],
          selectedServerId: 'ws',
        })
      )
    ).toMatchSnapshot();
  });

  it('FakeIP 关闭（dnsConfig.enableFakeIp=false）→ 锁 reverse_mapping + 无 fakeip 体系', () => {
    expect(
      snap(
        cfg({
          servers: [server({})],
          dnsConfig: { enableFakeIp: false },
        } as unknown as Partial<UserConfig>)
      )
    ).toMatchSnapshot();
  });

  // FakeIP 关 + 地区分流正向：DNS 国内/海外 resolver 划分须按 region（M1）——
  // 本地 geo（ir=geosite-category-ir）→ dns-domestic、其余 fallthrough dns-remote。锁住 dns.rules 里的
  // rule_set + server 选择（cn 正向已由「FakeIP 关闭」基线覆盖、逐字节不变；此处单测 ir 防回退到硬编码 geosite-cn）。
  it('FakeIP 关 + 地区分流 ir 正向 → 锁 DNS resolver 划分（geosite-category-ir→dns-domestic）', () => {
    expect(
      snap(
        cfg({
          servers: [server({})],
          dnsConfig: { enableFakeIp: false },
          regionRouting: { enabled: true, region: 'ir', reverse: false },
        } as unknown as Partial<UserConfig>)
      )
    ).toMatchSnapshot();
  });

  // #3 DNS reverse 翻转：FakeIP 关 + 地区分流反向（回国）→ DNS 侧镜像 route reverse——region-local（geosite-cn）
  //   域名 →dns-remote（经回国节点解析国内最优 IP）、其余 fallthrough →dns-domestic、dns.final 同步翻 dns-remote。
  //   与 route 侧 localOut/foreignOut/final 翻转一一对应；正向 fixture（上方 ir / 「FakeIP 关闭」基线）逐字节不受影响。
  it('FakeIP 关 + 地区分流 cn 反向 → 锁 DNS reverse 翻转（geosite-cn→dns-remote、fallthrough dns-domestic、final=dns-remote）', () => {
    expect(
      snap(
        cfg({
          servers: [server({})],
          dnsConfig: { enableFakeIp: false },
          regionRouting: { enabled: true, region: 'cn', reverse: true },
        } as unknown as Partial<UserConfig>)
      )
    ).toMatchSnapshot();
  });

  it('coreVersion 1.12（<1.13 sniff 分支）+ vless', () => {
    expect(snap(cfg({ servers: [server({})] }), '1.12.8')).toMatchSnapshot();
  });

  it('抗封增强（ECH + TLS fragment + multiplex）→ 锁 applyAntiCensorshipOptions', () => {
    expect(
      snap(
        cfg({
          servers: [
            server({
              name: 'AntiCensor',
              protocol: 'vless',
              security: 'tls',
              tlsSettings: {
                serverName: 'a.example.com',
                ech: true,
                echConfig: '-----BEGIN ECH CONFIG-----\nAAA\nBBB\n-----END ECH CONFIG-----',
                fragment: true,
              },
              multiplexSettings: {
                enabled: true,
                protocol: 'h2mux',
                maxConnections: 4,
                minStreams: 8,
                padding: true,
              },
            } as unknown as Partial<ServerConfig>),
          ],
        } as unknown as Partial<UserConfig>)
      )
    ).toMatchSnapshot();
  });

  it('httpupgrade 传输 → 锁 generateTransportConfig httpupgrade 分支', () => {
    expect(
      snap(
        cfg({
          servers: [
            server({
              name: 'HTTPUpgrade',
              protocol: 'vless',
              network: 'httpupgrade',
              wsSettings: { path: '/up', headers: { Host: 'edge.example.com' } },
            } as unknown as Partial<ServerConfig>),
          ],
        })
      )
    ).toMatchSnapshot();
  });

  it('naive outbound（mock libcronet 可用绕过 isNodeUsable 过滤）→ 锁 naive tls + quic 分支', () => {
    // 测试环境 getSingBoxPath=/fake → getCronetLibStatus='no-lib' → naive 被 isNodeUsable 过滤、无法经
    // generateSingBoxConfig 触达 buildProxyOutbound 的 naive 分支。spy hasCronetLib→true 解封该分支
    // （config-gen 纯净，cronet copy 在启动期非生成期，零磁盘副作用）。锁未来回归基线。
    const spy = jest.spyOn(resourceManager, 'hasCronetLib').mockReturnValue(true);
    try {
      expect(
        snap(
          cfg({
            servers: [
              server({
                name: 'Naive',
                protocol: 'naive',
                uuid: undefined,
                username: 'u',
                password: 'p',
                tlsSettings: { serverName: 'cdn.example.com' },
                naiveSettings: { useHttp3: true },
              } as unknown as Partial<ServerConfig>),
            ],
          })
        )
      ).toMatchSnapshot();
    } finally {
      spy.mockRestore();
    }
  });

  it('ssh outbound（独立返回路径，无 TLS/传输层）→ 锁 ssh 字段块', () => {
    expect(
      snap(
        cfg({
          servers: [
            server({
              name: 'SSH',
              protocol: 'ssh',
              uuid: undefined,
              port: 22,
              sshSettings: {
                user: 'root',
                password: 'pw',
                privateKey: 'KEY',
                privateKeyPassphrase: 'pp',
                hostKey: ['ssh-ed25519 AAA'],
                hostKeyAlgorithms: ['ssh-ed25519'],
                clientVersion: 'SSH-2.0-FlowZ',
              },
            } as unknown as Partial<ServerConfig>),
          ],
        })
      )
    ).toMatchSnapshot();
  });

  // ---- DNS 进阶分支（generateDnsConfig 抽取前锁基线）----

  it('DNS 自定义上游（domestic DoT + foreign 自定义 DoH）+ nodeDomainResolver=dnspod → 锁 buildUserDns + rule1 server=dns-node', () => {
    expect(
      snap(
        cfg({
          servers: [server({})],
          dnsConfig: {
            domesticDns: 'tls://223.6.6.6',
            foreignDns: 'https://cloudflare-dns.com/dns-query',
            nodeDomainResolver: 'dnspod',
          },
        } as unknown as Partial<UserConfig>)
      )
    ).toMatchSnapshot();
  });

  it('DNS enableIPv6=true + TUN（FakeIP 开）→ 锁 fakeip.inet6_range + strategy=prefer_ipv4', () => {
    expect(
      snap(
        cfg({
          proxyModeType: 'tun',
          enableIPv6: true,
          servers: [server({})],
        } as unknown as Partial<UserConfig>)
      )
    ).toMatchSnapshot();
  });

  it('DNS bypassFakeIP 自定义规则（TUN/FakeIP 开，文件缺失走 inline 提取）→ 锁 bypass DNS 规则', () => {
    const customRules: Rule[] = [
      {
        id: 'bp1',
        type: 'domainSuffix',
        values: ['bank.example.com', '*.direct.example'],
        action: 'proxy',
        enabled: true,
        bypassFakeIP: true,
      },
      {
        id: 'bp2',
        type: 'domainKeyword',
        values: ['steam'],
        action: 'proxy',
        enabled: true,
        bypassFakeIP: true,
      },
    ] as unknown as Rule[];
    expect(
      snap(cfg({ proxyModeType: 'tun', servers: [server({})], customRules }))
    ).toMatchSnapshot();
  });

  it('DNS lanResolverForDns 注入（systemProxy）→ 锁 dns-lan(type:dhcp 动态) + internalResolverTag=dns-lan 三路拆分', () => {
    expect(
      snap(cfg({ servers: [server({})] }), '1.13.0', 'linux', (svc) => {
        svc.lanResolverForDns = '192.168.1.1';
      })
    ).toMatchSnapshot();
  });

  it('DNS win32 + TUN + takeover（无 LAN 解析器）→ 锁 winLoopRisk：bank/internal 落 dns-domestic 避死环', () => {
    expect(
      snap(
        cfg({
          proxyModeType: 'tun',
          servers: [server({})],
          dnsConfig: { takeoverSystemDns: true },
        } as unknown as Partial<UserConfig>),
        '1.13.0',
        'win32'
      )
    ).toMatchSnapshot();
  });

  // ---- route 进阶分支（generateRouteConfig 抽取前锁基线 + 验注入态 wiring）----

  it('probe 端口注入（probeDirectPort/probeProxyPort）→ 锁出口探针钉死路由 probe-direct-in/probe-proxy-in', () => {
    expect(
      snap(cfg({ servers: [server({})] }), '1.13.0', 'linux', (svc) => {
        svc.probeDirectPort = 21001;
        svc.probeProxyPort = 21002;
      })
    ).toMatchSnapshot();
  });

  it('blockQuic=true（smart）→ 锁代理向 udp443 reject 配对 + 末尾兜底 udp443RejectRule()', () => {
    const customRules: Rule[] = [
      {
        id: 'q1',
        type: 'domainSuffix',
        values: ['proxied.example'],
        action: 'proxy',
        enabled: true,
      },
    ] as unknown as Rule[];
    expect(snap(cfg({ servers: [server({})], blockQuic: true, customRules }))).toMatchSnapshot();
  });

  it('webrtcLeakProtection=proxy（TUN + smart）→ 锁显式 stun sniffer + protocol:stun route 到 proxy-selector', () => {
    expect(
      snap(
        cfg({
          proxyModeType: 'tun',
          servers: [server({})],
          webrtcLeakProtection: 'proxy',
        } as unknown as Partial<UserConfig>)
      )
    ).toMatchSnapshot();
  });

  it('webrtcLeakProtection=block（TUN + smart）→ 锁显式 stun sniffer + protocol:stun reject', () => {
    expect(
      snap(
        cfg({
          proxyModeType: 'tun',
          servers: [server({})],
          webrtcLeakProtection: 'block',
        } as unknown as Partial<UserConfig>)
      )
    ).toMatchSnapshot();
  });

  it('bypassLAN=false → 锁跳过私网直连 route 规则（bypassLAN ip_cidr / geosite-private 路由规则不注入；geosite-private 定义作为内置 geo 仍在）', () => {
    expect(
      snap(cfg({ servers: [server({})], bypassLAN: false } as unknown as Partial<UserConfig>))
    ).toMatchSnapshot();
  });
});
