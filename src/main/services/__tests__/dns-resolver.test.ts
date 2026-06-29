/**
 * #57 节点域名解析器 — 生成配置断言 + 错误归因镜像单测。
 * 本项目铁律：DNS runtime 改动 code review 判不准，须以生成物（generateSingBoxConfig 输出）验证。
 *
 * 覆盖：
 *  - 3 档（auto/dnspod/system）× 3 模式（TUN smart / TUN global / systemProxy）：
 *    ① 节点 outbound.domain_resolver == 期望 tag；② dns.servers 含 dns-node；
 *    ③ rule1 含全部节点域名、不含 IP 字面量、不含 domain_keyword；
 *    ④ rule1.server == 期望档（auto=dns-domestic 忠实回 doh.pub 现状；TUN+system=dns-node INV-1）；⑤ route 含 1.12.12.12/32 直连；
 *  - ⑥ auto 档生成配置与改前基线 byte-diff：deltas 严格限定于「rule1 全量化（去 domain_keyword）+ 恒加 dns-node server + route 加 1.12.12.12/32 直连」，
 *    rule1.server 仍为基线 dns-domestic（不在 delta 集），其余字节零变化。
 *  - translate/classify 同序镜像：lookup SERVFAIL(节点域名)→node 文案 + DNS_RESOLVE_FAILED；no such host(普通)→generic；i/o timeout→命中（先于通用 timeout）。
 */

// electron mock 必须在 import ProxyManager 之前
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-dns-test-'));
jest.mock('electron', () => ({
  app: {
    getPath: () => TMP,
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => TMP,
  },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { ProxyManager } from '../ProxyManager';
import { ProxyErrorCode } from '../../../shared/types';
import {
  buildFixtures,
  extractDnsRoute,
  EXPECTED_NODE_DOMAINS,
  NODE_A,
  NODE_B,
} from './dns-resolver-fixtures';
import { BUILTIN_GEO_RULESETS, getRuleSetRuntimeDir } from '../builtin-geo-rulesets';

// 测试环境补种 smart 模式 3 件套 geo 的本地 .srs（写 SRS 魔数即过 isValidSrsFile）——与生产一致：
// startInternal 先 copyRuleSetsToUserData(seed) 再 generateSingBoxConfig，故 smart 模式 geo 路由规则的 rule_set
// 定义恒存在、不被 generateRouteConfig 末尾「悬空引用剪枝」剪掉（fail-closed 仅在文件真缺失时触发）。
// 仅种这 3 个（不种 geosite-private 等）：byte-diff 基线为「geosite-private 文件缺失」状态，多种会引入基线外的
// geosite-private 直连规则、污染 #57 DNS delta 比对。
{
  const SMART_GEO_TAGS = new Set(['geosite-cn', 'geosite-geolocation-!cn', 'geoip-cn']);
  const geoDir = getRuleSetRuntimeDir();
  fs.mkdirSync(geoDir, { recursive: true });
  for (const b of BUILTIN_GEO_RULESETS) {
    if (SMART_GEO_TAGS.has(b.tag))
      fs.writeFileSync(path.join(geoDir, b.fileName), Buffer.from('SRS'));
  }
}

type AnyCfg = any;

function dnsRules(cfg: AnyCfg): AnyCfg[] {
  return cfg.dns.rules as AnyCfg[];
}
/** rule1 = 节点域名规则：含 domain_suffix 且不含 query_type/rule_set（区别于 fakeip/geosite 规则）。 */
function findNodeRule(cfg: AnyCfg): AnyCfg | undefined {
  return dnsRules(cfg).find(
    (r) =>
      Array.isArray(r.domain) && r.domain.includes(NODE_A.address) && !r.query_type && !r.rule_set
  );
}
function nodeOutbounds(cfg: AnyCfg): AnyCfg[] {
  return (cfg.outbounds as AnyCfg[]).filter(
    (o) => o.type !== 'selector' && o.type !== 'direct' && o.type !== 'block'
  );
}
function hasRouteDirect(cfg: AnyCfg, cidr: string): boolean {
  return (cfg.route?.rules as AnyCfg[]).some(
    (r) => Array.isArray(r.ip_cidr) && r.ip_cidr.includes(cidr) && r.outbound === 'direct'
  );
}

describe('#57 节点域名解析器：生成配置断言（3档×3模式）', () => {
  const pm = new ProxyManager();
  const fixtures = buildFixtures();

  for (const fx of fixtures) {
    describe(fx.name, () => {
      const cfg = pm.generateSingBoxConfig(fx.config) as AnyCfg;

      it('② dns.servers 恒含 dns-node（DNSPod IP-DoH 1.12.12.12）', () => {
        const node = (cfg.dns.servers as AnyCfg[]).find((s) => s.tag === 'dns-node');
        expect(node).toBeDefined();
        expect(node.type).toBe('https');
        expect(node.server).toBe('1.12.12.12');
        expect(node.server_port).toBe(443);
        expect(node.path).toBe('/dns-query');
      });

      it('① 节点 outbound.domain_resolver == 期望 tag', () => {
        const obs = nodeOutbounds(cfg);
        expect(obs.length).toBeGreaterThanOrEqual(3);
        for (const o of obs) expect(o.domain_resolver).toBe(fx.expectDialTag);
      });

      it('③ rule1 含全部节点域名、不含 IP 字面量、不含 domain_keyword', () => {
        const r = findNodeRule(cfg);
        expect(r).toBeDefined();
        expect(r.domain_keyword).toBeUndefined();
        for (const d of EXPECTED_NODE_DOMAINS) expect(r.domain).toContain(d);
        // 不含 IP 字面量节点地址
        expect(r.domain).not.toContain('203.0.113.7');
        // suffix 同步全覆盖
        expect(r.domain_suffix).toContain(NODE_B.address);
        expect(r.domain_suffix).toContain(`.${NODE_B.address}`);
      });

      it('④ rule1.server == 期望 tag（auto=dns-domestic 忠实回 doh.pub；INV-1：TUN+system → dns-node）', () => {
        const r = findNodeRule(cfg);
        expect(r.server).toBe(fx.expectRuleTag);
      });

      it('⑤ route 含 1.12.12.12/32 直连放行', () => {
        expect(hasRouteDirect(cfg, '1.12.12.12/32')).toBe(true);
        // 原有 223.5.5.5/32 直连不丢
        expect(hasRouteDirect(cfg, '223.5.5.5/32')).toBe(true);
      });

      it('default_domain_resolver 不动（恒 dns-bootstrap）', () => {
        expect(cfg.route?.default_domain_resolver).toBe('dns-bootstrap');
      });
    });
  }
});

// 平台限定：baseline 为 Linux 捕获，而生成 config 含平台相关字段（如 Windows TUN inbound 的 route_exclude_address
// 大列表防回流、macOS DNS strategy），在 macOS/Windows CI 上与单平台 baseline 必然不符。仅 Linux 跑此 byte-diff。
const byteDiffDescribe = process.platform === 'linux' ? describe : describe.skip;
byteDiffDescribe(
  '#57 ⑥ auto 档 byte-diff：仅限有意改动，其余零变化（平台相关 config，仅 Linux baseline）',
  () => {
    const pm = new ProxyManager();
    const baselinePath = path.join(__dirname, 'dns-resolver-baseline.json');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));

    // 基线键名（采集脚本用 buildFixtures 的 auto 缺字段 fixture）：tun-smart__auto / tun-global__auto / systemproxy__auto
    const fixtures = buildFixtures().filter((f) => f.resolver === undefined);

    for (const fx of fixtures) {
      it(`${fx.name}: 与基线 diff 仅 rule1 全量化(去keyword) + 恒加 dns-node server + 1.12.12.12 直连（rule1.server 仍 dns-domestic）`, () => {
        const cur = extractDnsRoute(pm.generateSingBoxConfig(fx.config));
        const base = baseline[fx.name];
        expect(base).toBeDefined();

        // --- A. dns.servers：当前 = 基线 + 仅多一个 dns-node，其余 server 逐字节相同、相对顺序不变 ---
        const baseServers = base.dns.servers as AnyCfg[];
        const curServers = cur.dns.servers as AnyCfg[];
        const curMinusNode = curServers.filter((s) => s.tag !== 'dns-node');
        expect(JSON.stringify(curMinusNode)).toBe(JSON.stringify(baseServers));
        expect(curServers.some((s) => s.tag === 'dns-node')).toBe(true);

        // --- B. dns.rules：除 rule1（节点域名规则）外逐字节相同；rule1 为有意全量化改动 ---
        const baseRules = base.dns.rules as AnyCfg[];
        // fake-ip-filter 默认清单（默认开，基线 frozen 在其之前的有意新增）：与 rule1 同理，从逐字节对比剥离、单独断言。
        // captive 探测 → dns-local；NTP/STUN/TURN → dns-domestic。FakeIP 档（含 fakeip server）注入 2 条，否则 0 条。
        const allCurRules = cur.dns.rules as AnyCfg[];
        const isFakeIpFilter = (r: AnyCfg) =>
          (r.server === 'dns-local' &&
            Array.isArray(r.domain) &&
            r.domain.includes('captive.apple.com')) ||
          (r.server === 'dns-domestic' &&
            Array.isArray(r.domain_keyword) &&
            (r.domain_keyword as string[]).includes('stun'));
        const curRules = allCurRules.filter((r) => !isFakeIpFilter(r));
        const hasFakeIp = (cur.dns.servers as AnyCfg[]).some((s) => s.tag === 'fakeip');
        expect(allCurRules.filter(isFakeIpFilter).length).toBe(hasFakeIp ? 2 : 0);
        expect(curRules.length).toBe(baseRules.length); // 规则条数不变（rule1 原位替换，filter 已剥离）
        // 基线 rule1：含 node-a 域名的那条
        const baseR1Idx = baseRules.findIndex(
          (r) =>
            Array.isArray(r.domain) &&
            r.domain.includes(NODE_A.address) &&
            !r.query_type &&
            !r.rule_set
        );
        const curR1Idx = curRules.findIndex(
          (r) =>
            Array.isArray(r.domain) &&
            r.domain.includes(NODE_A.address) &&
            !r.query_type &&
            !r.rule_set
        );
        expect(curR1Idx).toBe(baseR1Idx); // rule1 位置不变
        // 除 rule1 外的所有 DNS 规则逐字节相同
        const stripR1 = (rs: AnyCfg[], idx: number) => rs.filter((_, i) => i !== idx);
        expect(JSON.stringify(stripR1(curRules, curR1Idx))).toBe(
          JSON.stringify(stripR1(baseRules, baseR1Idx))
        );
        // rule1 自身的有意改动：基线含 domain_keyword/仅 selectedServer；当前去 keyword/全节点。
        // server 忠实回 dns-domestic（doh.pub，与基线一致，auto 档不与 dial 的 dns-bootstrap 统一）。
        expect(baseRules[baseR1Idx].domain_keyword).toBeDefined();
        expect(curRules[curR1Idx].domain_keyword).toBeUndefined();
        expect(curRules[curR1Idx].server).toBe('dns-domestic');
        expect(baseRules[baseR1Idx].server).toBe('dns-domestic'); // 与基线同档，server 非 delta

        // --- C. dns 顶层其余字段（final/strategy/fakeip）零变化 ---
        const topOnly = (d: AnyCfg) => ({ final: d.final, strategy: d.strategy, fakeip: d.fakeip });
        expect(JSON.stringify(topOnly(cur.dns))).toBe(JSON.stringify(topOnly(base.dns)));

        // --- D. route.rules：除「含 1.12.12.12/32 的直连规则」外逐字节相同 ---
        const stripNodeIp = (rules: AnyCfg[]) =>
          rules.map((r) =>
            Array.isArray(r.ip_cidr)
              ? { ...r, ip_cidr: r.ip_cidr.filter((c: string) => c !== '1.12.12.12/32') }
              : r
          );
        expect(JSON.stringify(stripNodeIp(cur.routeRules))).toBe(JSON.stringify(base.routeRules));

        // --- E. default_domain_resolver / inbounds(含 route_exclude_address) 零变化 ---
        //    (Linux 测试环境：Windows excludeAddr 分支不触发，故 inbounds 对本平台逐字节相同) ---
        expect(cur.routeDefaultDomainResolver).toBe(base.routeDefaultDomainResolver);
        expect(JSON.stringify(cur.inbounds)).toBe(JSON.stringify(base.inbounds));

        // --- F. 节点 outbound resolver 在 auto 档零变化（仍 dns-bootstrap） ---
        expect(JSON.stringify(cur.outboundResolvers)).toBe(JSON.stringify(base.outboundResolvers));
      });
    }
  }
);

describe('Q1 Windows takeover：消除 type:local 死循环（dns-local 改路由，生成物验证）', () => {
  const realPlatform = process.platform;
  const setPlatform = (p: string) =>
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  // 每个用例后即还原（不只 afterAll）：杜绝 platform mutation 泄漏到后续 describe（review LOW，隔离健壮性）。
  afterEach(() => setPlatform(realPlatform));
  afterAll(() => setPlatform(realPlatform));

  const tunFx = buildFixtures().find((f) => f.name === 'tun-smart__auto')!; // tun + 默认 takeover 开
  const ruleBy = (cfg: AnyCfg, pred: (r: AnyCfg) => boolean) => dnsRules(cfg).find(pred);
  const sfx = (r: AnyCfg) => (Array.isArray(r.domain_suffix) ? (r.domain_suffix as string[]) : []);
  const bankRule = (cfg: AnyCfg) => ruleBy(cfg, (r) => sfx(r).includes('.icbc.com.cn'));
  const lanRule = (cfg: AnyCfg) => ruleBy(cfg, (r) => sfx(r).includes('.lan'));
  const localRule = (cfg: AnyCfg) =>
    ruleBy(cfg, (r) => sfx(r).includes('.local') && !sfx(r).includes('.lan'));
  const captiveRule = (cfg: AnyCfg) =>
    ruleBy(cfg, (r) => Array.isArray(r.domain) && r.domain.includes('captive.apple.com'));

  it('Win+takeover+无 LAN 解析器：银行/内网/captive→dns-domestic（不落 type:local），.local 留 dns-local', () => {
    setPlatform('win32');
    const cfg = new ProxyManager().generateSingBoxConfig(tunFx.config) as AnyCfg;
    expect(bankRule(cfg)?.server).toBe('dns-domestic');
    expect(lanRule(cfg)?.server).toBe('dns-domestic');
    expect(captiveRule(cfg)?.server).toBe('dns-domestic');
    expect(localRule(cfg)?.server).toBe('dns-local');
    // 关键不变量：无任何把银行域名喂给 dns-local 的规则（否则 svchost→8.8.8.8→hijack→dns-local 死环）
    const bankToLocal = dnsRules(cfg).some(
      (r) => r.server === 'dns-local' && sfx(r).includes('.icbc.com.cn')
    );
    expect(bankToLocal).toBe(false);
  });

  it('Win+takeover+有 LAN 解析器：内网/captive→dns-lan，银行→dns-domestic，dns-lan(dhcp 动态)+ rule C 直连放行', () => {
    setPlatform('win32');
    const pm = new ProxyManager();
    (pm as any).lanResolverForDns = '192.168.5.1';
    const cfg = pm.generateSingBoxConfig(tunFx.config) as AnyCfg;
    expect(lanRule(cfg)?.server).toBe('dns-lan');
    expect(captiveRule(cfg)?.server).toBe('dns-lan');
    expect(bankRule(cfg)?.server).toBe('dns-domestic');
    // dns-lan 改 type:'dhcp'(动态跟随网关，不再硬编码 lanResolver IP)；lanResolver 仍决定是否建 dns-lan + rule C 放行
    expect(
      (cfg.dns.servers as AnyCfg[]).some((s) => s.tag === 'dns-lan' && s.type === 'dhcp')
    ).toBe(true);
    expect(hasRouteDirect(cfg, '192.168.5.1/32')).toBe(true);
  });

  it('macOS+takeover+无 LAN 解析器：保持原合并 dns-local 规则（mDNSResponder 直连不死环，byte 不漂移）', () => {
    setPlatform('darwin');
    const cfg = new ProxyManager().generateSingBoxConfig(tunFx.config) as AnyCfg;
    const merged = ruleBy(cfg, (r) => sfx(r).includes('.lan') && sfx(r).includes('.icbc.com.cn'));
    expect(merged?.server).toBe('dns-local');
  });

  it('Win+TUN+接管开关关(takeoverSystemDns:false)：T2 解耦后 winLoopRisk 恒=true → 银行/内网/captive→dns-domestic（死环与开关无关，不再合并 dns-local）', () => {
    setPlatform('win32');
    const offConfig = {
      ...tunFx.config,
      dnsConfig: { ...tunFx.config.dnsConfig, takeoverSystemDns: false },
    } as AnyCfg;
    const cfg = new ProxyManager().generateSingBoxConfig(offConfig) as AnyCfg;
    // T2：死环源于 Win strict_route+type:local 本身、与 takeoverSystemDns 无关 → 关接管也照防环（与 takeover 态一致）。
    expect(bankRule(cfg)?.server).toBe('dns-domestic');
    expect(lanRule(cfg)?.server).toBe('dns-domestic');
    expect(captiveRule(cfg)?.server).toBe('dns-domestic');
    expect(localRule(cfg)?.server).toBe('dns-local');
    // 不再有把银行域名喂 dns-local 的合并规则（svchost→8.8.8.8→hijack→dns-local 死环防护恒生效）
    const bankToLocal = dnsRules(cfg).some(
      (r) => r.server === 'dns-local' && sfx(r).includes('.icbc.com.cn')
    );
    expect(bankToLocal).toBe(false);
  });
});

describe('§B：enableIPv6 收敛 AAAA（IPv4-only 节点防 ERR_CONNECTION_CLOSED）', () => {
  const tunFx = buildFixtures().find((f) => f.name === 'tun-smart__auto')!; // FakeIP 开 + enableIPv6:false
  const fakeip = (cfg: AnyCfg) => (cfg.dns.servers as AnyCfg[]).find((s) => s.tag === 'fakeip');

  it('enableIPv6=false → strategy=ipv4_only + fakeip 无 inet6_range（抑制 AAAA，客户端只拿 A）', () => {
    const cfg = new ProxyManager().generateSingBoxConfig(tunFx.config) as AnyCfg;
    expect(cfg.dns.strategy).toBe('ipv4_only');
    expect(fakeip(cfg)?.inet4_range).toBe('198.18.0.0/15');
    expect(fakeip(cfg)?.inet6_range).toBeUndefined();
  });

  it('enableIPv6=true → strategy=prefer_ipv4 + fakeip 带 inet6_range=2001:db8::/32（公网文档段，避开 Chrome LNA）', () => {
    const v6cfg = { ...tunFx.config, enableIPv6: true } as AnyCfg;
    const cfg = new ProxyManager().generateSingBoxConfig(v6cfg) as AnyCfg;
    expect(cfg.dns.strategy).toBe('prefer_ipv4');
    // 公网文档段（非旧 ULA fc00::/18）：浏览器 Chrome Local Network Access 判 public、不拦 public 页面取该段子资源。
    expect(fakeip(cfg)?.inet6_range).toBe('2001:db8::/32');
  });
});

describe('#57 L2 集成：generateSingBoxConfig 把 ws path ?ed= 拆成内核早数据字段', () => {
  const baseCfg = buildFixtures().find((f) => f.name === 'tun-smart__auto')!.config as AnyCfg;
  const genWsTransport = (wsPath: string): AnyCfg => {
    const node: AnyCfg = {
      id: 'ws-ed',
      name: 'ws-ed',
      protocol: 'vless',
      address: '104.16.0.1',
      port: 443,
      uuid: '00000000-0000-0000-0000-0000000000ed',
      network: 'ws',
      wsSettings: { path: wsPath, headers: { Host: 'x.trycloudflare.com' } },
      security: 'tls',
      tlsSettings: { serverName: 'x.trycloudflare.com' },
    };
    const cfg = { ...baseCfg, servers: [node], selectedServerId: 'ws-ed' } as AnyCfg;
    const sb = new ProxyManager().generateSingBoxConfig(cfg) as AnyCfg;
    return nodeOutbounds(sb).find((o) => o.transport?.type === 'ws')?.transport;
  };

  it('?ed=2560 → path 去 ?ed + max_early_data + Sec-WebSocket-Protocol（杜绝 %3F 怪路径）', () => {
    const t = genWsTransport('/vless-argo?ed=2560');
    expect(t).toBeTruthy();
    expect(t.path).toBe('/vless-argo');
    expect(t.max_early_data).toBe(2560);
    expect(t.early_data_header_name).toBe('Sec-WebSocket-Protocol');
  });

  it('无 ?ed → path 原样、不强加早数据字段', () => {
    const t = genWsTransport('/plain');
    expect(t.path).toBe('/plain');
    expect(t.max_early_data).toBeUndefined();
  });
});

describe('#57 错误归因：translateErrorMessage / classifyCoreError 同序镜像', () => {
  const pm = new ProxyManager();
  // 注入 currentConfig，使节点域名集 = NODE_A/B 域名
  const fx = buildFixtures().find((f) => f.name === 'tun-smart__auto')!;
  (pm as any).currentConfig = fx.config;

  const translate = (m: string) => (pm as any).translateErrorMessage(m) as string;
  const classify = (m: string) => (pm as any).classifyCoreError(m) as ProxyErrorCode;

  it('节点域名 SERVFAIL → node 级文案（含切换指引）+ DNS_RESOLVE_FAILED', () => {
    const msg = 'lookup b.trycloudflare.com: SERVFAIL';
    expect(translate(msg)).toContain('节点域名解析失败');
    expect(translate(msg)).toContain('DNSPod');
    expect(classify(msg)).toBe(ProxyErrorCode.DNS_RESOLVE_FAILED);
  });

  it('普通域名 no such host → generic DNS 文案 + DNS_RESOLVE_FAILED', () => {
    const msg = 'lookup not-a-node.example.org: no such host';
    expect(translate(msg)).toContain('DNS 解析失败');
    expect(translate(msg)).not.toContain('节点域名解析失败');
    expect(classify(msg)).toBe(ProxyErrorCode.DNS_RESOLVE_FAILED);
  });

  it('lookup i/o timeout → 命中 DNS（先于通用 timeout，不归类为连接超时）', () => {
    const msg = 'lookup a.example-argo.com: i/o timeout';
    // 节点域名 → node 文案
    expect(translate(msg)).toContain('节点域名解析失败');
    expect(classify(msg)).toBe(ProxyErrorCode.DNS_RESOLVE_FAILED);
    expect(classify(msg)).not.toBe(ProxyErrorCode.CONNECTION_TIMEOUT);
  });

  it('普通连接超时（无 lookup）仍归 CONNECTION_TIMEOUT（不被新分支误吞）', () => {
    const msg = 'dial tcp 1.2.3.4:443: i/o timeout';
    expect(classify(msg)).toBe(ProxyErrorCode.CONNECTION_TIMEOUT);
  });

  it('connection refused 仍优先于 DNS 分支（同序镜像未破坏既有顺序）', () => {
    const msg = 'connect: connection refused';
    expect(classify(msg)).toBe(ProxyErrorCode.CONNECTION_REFUSED);
  });
});

/**
 * #57 DNS helper 独立单元（私有方法经 (pm as any) 直测；与 translate/classify 间接覆盖互补，定位更精确）。
 * 选用直测而非提为模块级 export：本文件既有 (pm as any).translateErrorMessage 同模式直测私有方法，
 * 直接复用零生产改动、零耦合迁移成本，优于「移动/导出」一档（见任务 P2#4 择优①）。
 */
describe('#57 collectNodeDomains（节点域名集提取）', () => {
  const pm = new ProxyManager();
  const fx = buildFixtures().find((f) => f.name === 'tun-smart__auto')!;
  (pm as any).currentConfig = fx.config; // servers = NODE_A / NODE_B / NODE_IP

  const collect = (): Set<string> => (pm as any).collectNodeDomains() as Set<string>;

  it('提取 address + serverName，全部小写', () => {
    const set = collect();
    expect(set.has(NODE_A.address)).toBe(true); // a.example-argo.com
    expect(set.has(NODE_A.tlsSettings!.serverName!)).toBe(true); // sni-a.example.net
    expect(set.has(NODE_B.address)).toBe(true); // b.trycloudflare.com
    for (const d of EXPECTED_NODE_DOMAINS) expect(set.has(d)).toBe(true);
  });

  it('IPv4 字面量节点地址被过滤（NODE_IP 203.0.113.7 不入集）', () => {
    expect(collect().has('203.0.113.7')).toBe(false);
  });

  it('IPv6 字面量地址被过滤', () => {
    (pm as any).currentConfig = {
      servers: [
        { id: 'v6', address: '2606:4700:4700::1111', tlsSettings: { serverName: 'x.test.com' } },
      ],
    };
    const set = collect();
    expect(set.has('2606:4700:4700::1111')).toBe(false);
    expect(set.has('x.test.com')).toBe(true);
    (pm as any).currentConfig = fx.config; // 复原
  });

  it('大写域名归一化为小写（错误日志域名为小写，须可比对命中）', () => {
    (pm as any).currentConfig = {
      servers: [
        {
          id: 'up',
          address: 'A.EXAMPLE-ARGO.COM',
          tlsSettings: { serverName: 'SNI-A.Example.NET' },
        },
      ],
    };
    const set = collect();
    expect(set.has('a.example-argo.com')).toBe(true);
    expect(set.has('sni-a.example.net')).toBe(true);
    (pm as any).currentConfig = fx.config; // 复原
  });

  it('去重：address == serverName 只计一次', () => {
    // NODE_B address == serverName == b.trycloudflare.com → Set 天然去重
    const set = collect();
    const occurrences = [...set].filter((d) => d === NODE_B.address).length;
    expect(occurrences).toBe(1);
  });

  it('currentConfig 缺失 / servers 空 → 空集（不抛）', () => {
    const bare = new ProxyManager();
    expect(((bare as any).collectNodeDomains() as Set<string>).size).toBe(0);
    (bare as any).currentConfig = { servers: [] };
    expect(((bare as any).collectNodeDomains() as Set<string>).size).toBe(0);
  });
});

describe('#57 matchDnsLookupFailure（三态：node / generic / null）', () => {
  const pm = new ProxyManager();
  const fx = buildFixtures().find((f) => f.name === 'tun-smart__auto')!;
  (pm as any).currentConfig = fx.config;

  // 函数签名要求传入已小写的 message（lowerMessage）。
  const match = (m: string) => (pm as any).matchDnsLookupFailure(m) as 'node' | 'generic' | null;

  it('无 "lookup " 前缀 → null（即便含 servfail）', () => {
    expect(match('some servfail without prefix')).toBeNull();
    expect(match('dial tcp 1.2.3.4:443: i/o timeout')).toBeNull(); // 无 lookup
  });

  it('有 "lookup " 但无 servfail/no such host/i\\o timeout → null', () => {
    expect(match('lookup a.example-argo.com: connection refused')).toBeNull();
  });

  it('lookup + servfail，域名 ∈ 节点集 → node', () => {
    expect(match('lookup b.trycloudflare.com: servfail')).toBe('node');
  });

  it('lookup + no such host，域名 ∉ 节点集 → generic', () => {
    expect(match('lookup not-a-node.example.org: no such host')).toBe('generic');
  });

  it('lookup + i/o timeout，节点域名（serverName）→ node', () => {
    expect(match('lookup sni-a.example.net: i/o timeout')).toBe('node');
  });

  it('lookup + i/o timeout，普通域名 → generic', () => {
    expect(match('lookup other.example.com: i/o timeout')).toBe('generic');
  });

  it('域名提取到首个空白/冒号止：lookup <域名>: ... 正确切出域名比对', () => {
    // 节点域名后紧跟冒号 → 提取 a.example-argo.com（不含冒号）→ 命中节点集
    expect(match('lookup a.example-argo.com: servfail')).toBe('node');
  });

  it('无法提取到域名（lookup 后即空）但含失败关键词 → generic（域名空，未命中节点集）', () => {
    expect(match('lookup : servfail')).toBe('generic');
  });
});
