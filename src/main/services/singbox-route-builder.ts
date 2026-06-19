/**
 * sing-box 路由配置生成 —— 从 ProxyManager.generateRouteConfig 抽出（SingBoxConfigBuilder 抽取 Phase 2 step 7）。
 *
 * route 子系统集成 hub：纯函数，只读 config/idToTagMap + 注入实例态依赖（coreVersion / probe 端口 /
 * lanResolverForDns / pendingEndpoints 值 + log·onDegraded 回调）。装配 sniff/探针/DNS 直连·劫持/节点排除/
 * 网银 U盾/endpoint 强制路由/私网直连/自定义规则(buildCustomRules)/应用分流/QUIC 阻断/geo rule_set/悬空剪枝。
 * config 字节等价由 config-snapshot 网验证（systemProxy/tun/global/customRules/appRules/WG/probe/blockQuic/
 * bypassLAN/win32 等矩阵）；启停/TUN 热切换真机另验。
 */

import * as path from 'path';
import type { UserConfig } from '../../shared/types';
import { coreVersionAtLeast } from '../../shared/version';
import { BOOTSTRAP_DIRECT_DNS_IPS } from '../../shared/dns';
import {
  endpointForcedRouteCidrs,
  meshForcedRouteCidrs,
  meshSelectedExitFallsBackToDirect,
  shouldForceRouteSubnets,
  collectRuleTargetedServerIds,
  meshForceRoutedServers,
} from '../../shared/endpoint-routes';
import { cidrOverlapsAny } from '../../shared/ip';
import { ruleIpCidrs } from '../../shared/rules';
import { getAppPreset } from '../../shared/app-rules-preset';
import { getRuleResourcesPath } from '../utils/paths';
import { usesFakeIp } from './custom-rule-files';
import { getRuleSetRuntimeDir as getRuntimeRulesDir, isValidSrsFile } from './builtin-geo-rulesets';
import type {
  SingBoxConfig,
  SingBoxRouteConfig,
  SingBoxRouteRule,
  SingBoxEndpoint,
} from './singbox-config-types';
import {
  isIpv4Host,
  isIpv6Host,
  DOMESTIC_BANK_AND_STOCK_DOMAINS,
  effectiveCustomRules,
  effectiveAppRules,
  getCustomDomesticDnsEndpoint,
  getLocalGeoRuleSets,
  getRequiredGeoCategories,
  applyRuleSetPrune,
} from './singbox-config-helpers';
import { buildCustomRules } from './singbox-custom-rules';
// 绕过局域网：TUN route 私网直连取 bypassLAN 完整清单的 CIDR 部分（域名在系统代理模式由 OS 忽略列表处理）。
import { bypassLanCidrs, effectiveBypassLan } from '../../shared/system-proxy-bypass';

/**
 * 浏览器隐私 DoH 泄漏域名（DoH-over-HTTPS / DoH-over-QUIC）。route reject 与 DNS 拦截须用同一份清单，
 * 避免某处漏掉某域名导致 DoH 绕过 hijack-dns / FakeIP 体系。改这一处即两处同步。
 */
const DOH_LEAK_DOMAIN_KEYWORDS = [
  'dns.google',
  'cloudflare-dns.com',
  'doh.opendns.com',
  'dns.quad9.net',
  'one.one.one.one',
];

/**
 * QUIC(UDP/443) reject 规则工厂：可选叠加域名/进程等匹配器。route 与各处 blockQuic 共用，
 * 保证 network/port/action 字面量始终一致（避免某处漏写 network 导致行为漂移）。
 */
const udp443RejectRule = (matcher: Record<string, unknown> = {}): SingBoxRouteRule => ({
  ...matcher,
  network: ['udp'],
  port: [443],
  action: 'reject',
});

/** 注入依赖：generateRouteConfig 原读的实例态（值 + 回调），抽出后由 generateSingBoxConfig 注入。 */
export interface RouteConfigDeps {
  coreVersion: string;
  probeDirectPort: number | null;
  probeProxyPort: number | null;
  lanResolverForDns: string | null;
  pendingEndpoints: SingBoxEndpoint[];
  log: (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', message: string) => void;
  onDegraded: () => void;
}

export function buildRouteConfig(
  config: UserConfig,
  idToTagMap: Map<string, string>,
  deps: RouteConfigDeps
): SingBoxRouteConfig {
  const rules: SingBoxRouteRule[] = [];
  const proxyMode = (config.proxyMode || 'smart').toLowerCase();

  // 组网 force-route 的「engaged」判定集（与块 0c shouldForceRouteSubnets 同口径，单一真值）：仅 enabled+action==='proxy'
  // 的自定义规则/应用分流 targetServerId 计入。下方重叠 warn 与块 0c 发射端共用，杜绝对「仅出网且未 engaged」节点虚报。
  const ruleTargetedServerIds = collectRuleTargetedServerIds([
    ...effectiveCustomRules(config),
    ...effectiveAppRules(config),
  ]);

  // mesh 重叠提醒（layer-2 兜底，非阻断）：优先级重排后用户自定义规则高于组网(WG/Tailscale) force-route，
  // 自定义规则 ip_cidr 与组网段重叠 → 该段被规则改道、可能不走组网节点（静默断 mesh）。检出即 warn（进诊断报告），
  // 覆盖订阅导入/旧配置迁移等非 UI 录入盲区（UI 录入另有内联 hint/角标提醒）。仅 smart 有自定义规则故天然限定。
  // 基准只取「本轮实际会发射 force-route」的节点（与块 0c 同 gate），不对未 engaged 的仅出网节点虚报覆盖。
  const meshCidrsForWarn = meshForcedRouteCidrs(
    meshForceRoutedServers(config.servers, config.selectedServerId, ruleTargetedServerIds)
  );
  if (meshCidrsForWarn.length > 0) {
    const overlapping = new Set<string>();
    for (const rule of effectiveCustomRules(config)) {
      if (!rule.enabled) continue;
      for (const c of ruleIpCidrs(rule)) {
        if (cidrOverlapsAny(c, meshCidrsForWarn)) overlapping.add(c);
      }
    }
    if (overlapping.size > 0) {
      const sample = Array.from(overlapping).slice(0, 5).join(', ');
      deps.log(
        'warn',
        `${overlapping.size} 个自定义规则网段（${sample}${overlapping.size > 5 ? '…' : ''}）与组网(WG/Tailscale)路由段重叠：按优先级将覆盖组网路由，该段可能不走组网节点。如非有意请调整规则或组网配置。`
      );
    }
  }

  // 主代理出站统一走 selector(proxy-selector)：clash_api 热切换即改 selector 指向、路由无需重生成。
  // 具体 targetServerId 的 app/custom 分流在各自逻辑里直指节点 tag，不经此变量。
  const selectedServerTag = 'proxy-selector';

  // D4/D7：主节点是「关外网组网节点」时，「→代理」的用户出口（smart 的 geosite-!cn/google + 两模式的 final）
  // 整体回退 direct（proxy-selector.default=该 off-mesh 节点，海外/非具体段流量进其用户态栈被丢弃→黑洞）。
  // 具体段仍由 force-route 经组网（排在这些规则之前）。global+smart 同此兜底；probe/rule-sel 仍用 selector。
  const exitFallback = meshSelectedExitFallsBackToDirect(config);
  const userExitTag = exitFallback ? 'direct' : selectedServerTag;
  if (exitFallback) {
    deps.log(
      'warn',
      '选中的组网节点已关闭外网访问：外网流量已回退直连（具体网段仍经组网节点），如需经此节点全隧道请开启该节点「允许访问外网」'
    );
  }

  // blockQuic（节点无关）：开启时对"将走代理"的 QUIC(UDP443) 执行 reject，逼浏览器回退 TCP。
  // 「禁 QUIC」即禁 QUIC，与选中节点的协议/中继能力无关，对所有节点一视同仁。两点实测保证安全：
  //   · 节点自身的 UDP 拨号(naive-h3/hy2/tuic dial server)无害——拨号是 sing-box 进程自有 socket，
  //     受 fwmark/auto_detect_interface 保护、绕过 route 规则；netns TUN 抓包实测：带 reject udp443
  //     时 hy2 拨号包仍正常逸出（证伪旧假设"reject 经 strict_route 回流误杀拨号"）。
  //   · 不下发"全 UDP reject"——只禁 QUIC(443)。非 QUIC 的代理向 UDP 若节点不能中继(naive/ssh/http)，
  //     由 sing-box 出站层自动拒绝（实测日志 "UDP is not supported by outbound"，不漏 direct、不黑洞），
  //     无需路由层按节点固化。这也使路由配置与选中节点解耦 → 支持 selector 跨协议无缝热切换。
  // 节点无关：只要开了 blockQuic 且存在代理路径（非 direct 模式、有节点）就拦——不依赖 selectedServer
  // 解析成功（避免 selectedServerId 失效但 selector default 仍出流量时 QUIC 漏过）。
  const blockProxyQuic =
    config.blockQuic === true && proxyMode !== 'direct' && config.servers.length > 0;

  // 给定域名匹配器，返回应配对的 udp443 reject 规则（smart 模式放在每条 →代理 规则之前），否则 null。
  const proxyUdpRejectFor = (matcher: Record<string, unknown>): SingBoxRouteRule | null =>
    blockProxyQuic ? udp443RejectRule(matcher) : null;

  // A. 嗅探规则（必须在前，用于识别域名）
  // 1.13+ 必须在路由层开启 sniff，替代已移除的 inbound 级别 sniff 字段。
  // 注意（旧注释「等效 sniff_override_destination」不准确）：sniff 只把嗅出的域名用于【路由匹配】这半边——
  // sniff_override_destination（改写 outbound 目标，让节点收到域名）在 1.13.0 已移除且无替代。
  // 故关 FakeIP 时节点仍收真实 IP，域名交付节点只能靠 FakeIP（见 generateDnsConfig / 设计 T1·T4）。
  if (coreVersionAtLeast(deps.coreVersion, 1, 13)) {
    rules.push({
      action: 'sniff',
    });
  }

  // A2. 出口 IP 探针钉死路由（必须紧随 sniff、先于一切分流/进程规则，确保短路不受分流策略影响）：
  //   probe-direct-in → direct（auto_detect_interface 绑物理网卡，TUN 模式下也是真直连出口）
  //   probe-proxy-in  → proxy-selector（现有 selector，clash_api 热切换节点后探针自动跟随）
  // 由此在「三种接管 × 三种分流」全矩阵下分别测出真实直连出口 IP 与代理出口 IP。
  if (deps.probeDirectPort && deps.probeProxyPort) {
    rules.push(
      { inbound: ['probe-direct-in'], action: 'route', outbound: 'direct' },
      { inbound: ['probe-proxy-in'], action: 'route', outbound: selectedServerTag }
    );
  }

  // 1. 强制放行 sing-box 核心进程：防止流量回流死循环
  // 必须放在最高优先级，确保核心组件的请求能直连物理网卡
  // 注意：不要把 FlowZ (主进程) 放在直连里，否则会干扰 FlowZ 自身的 GitHub 核心下载和测速。
  rules.push({
    process_name: ['sing-box', 'sing-box.exe'],
    action: 'route',
    outbound: 'direct',
  });

  // C. 强制引导核心 DNS 直连（必须在 hijack-dns 之前！）
  // 把已知 bootstrap DNS IP 放在 hijack-dns 之前，无论哪个进程发包都走直连，彻底断环。
  // 注意：这里只应该放国内的 DNS IP。如果放 8.8.8.8，会导致用户去 ping 8.8.8.8 时走直连被墙！
  const customDomesticDns = getCustomDomesticDnsEndpoint(config);
  rules.push({
    ip_cidr: [
      // bootstrap-direct 国内 DNS（含 1.12.12.12 DNSPod IP-DoH）：单一真值 shared/dns#BOOTSTRAP_DIRECT_DNS_IPS，
      // 与 SystemDnsManager 的受控 DNS IP 选择守卫共用（受控 IP 绝不能落此列表，否则逃逸 hijack）。
      ...BOOTSTRAP_DIRECT_DNS_IPS.map((ip) => `${ip}/32`),
      // 用户自定义的国内 DNS（IP 型）也须在 hijack-dns 之前直连放行，否则其 53 端口查询会被劫持成 FakeIP
      ...(customDomesticDns
        ? [`${customDomesticDns.ip}/${isIpv6Host(customDomesticDns.ip) ? 128 : 32}`]
        : []),
      // 方案B：DNS 接管的内网 LAN 解析器（dns-lan 指向它）必须在 hijack-dns 之前直连放行，否则其 :53 查询会被
      // hijack-dns 抢走 → 内网域名解析成环。私网 IPv4 /32（getLanResolverForDns 已保证私网，亦经下方私网直连可达）。
      ...(deps.lanResolverForDns ? [`${deps.lanResolverForDns}/32`] : []),
    ],
    port: Array.from(new Set([53, 443, ...(customDomesticDns ? [customDomesticDns.port] : [])])),
    action: 'route',
    outbound: 'direct',
  });

  // D. DNS 劫持（必须在引导 DNS IP 直连之后）
  // 劫持所有其余 port 53 流量（浏览器/系统 DNS），返回 FakeIP
  rules.push({
    port: [53],
    action: 'hijack-dns',
  });

  // F. 静默屏蔽 ICMP 流量（FakeIP 下常见，但代理节点通常不支持）
  // 放置在靠前位置，防止 ICMP 流量误入不支持的代理出站引发报错
  rules.push({
    protocol: 'icmp',
    action: 'reject',
  });

  rules.push({
    process_name: [
      'Surge',
      'Surge 4',
      'Surge 5',
      'Clash',
      'Clash for Windows',
      'ClashX',
      'ClashX Pro',
      'clash-meta',
      'Quantumult X',
      'sing-box',
      'sing-box.exe',
      'mDNSResponder',
      'apsd',
      'nsurlsessiond',
      'airportd',
      'syspolicyd',
      'trustd',
      'ocspd',
      'securityd',
      'taskgated',
      'findmydeviced',
      'cloudd',
    ],
    action: 'route',
    outbound: 'direct',
  });

  const routeConfig: SingBoxRouteConfig = {
    rules,
    // 核心修复：default_domain_resolver 使用 IP-based DoH 引导解析器 (dns-bootstrap)，
    // 既避免解析 doh.pub 域名时的死循环，又免疫 UDP 53 限速/劫持（dns-bootstrap 同为 IP-based）。
    default_domain_resolver: 'dns-bootstrap',
    auto_detect_interface: true,
    // 如果模式是全局代理 (global/proxy)，则最终出口是所选节点（经 proxy-selector）；direct 模式或 D4/D7 兜底→direct。
    final: proxyMode === 'direct' ? 'direct' : userExitTag,
  };

  // 【DNS 引导与辅助直连】：
  // 确保以下公共 DNS IP 不会被后面的 block 规则拦截，从而保证 DoH 握手和初次域名解析。
  // 海外 DNS 不应该强行直连（否则在国内会被黑洞）。移除原本强行直连 8.8.8.8 / 1.1.1.1 的设定。

  // 【终极绝杀隐私 DoH 泄漏】：
  // 现代浏览器会尝试通过常规 HTTPS 端口向特定域名发起 DoH 请求。
  // 这里 reject 这些 DoH 域名（发 RST，让浏览器立即回退，而非 block 静默丢包等 21s 重传超时），
  // 迫使浏览器退回系统标准 UDP 53，重新被 hijack-dns 捕获进入 DNS 分流/FakeIP 体系。
  // 与下方同组 DoH 域名的 QUIC/UDP-443 reject 规则保持行为一致。
  rules.push({
    domain_keyword: DOH_LEAK_DOMAIN_KEYWORDS,
    port: [443, 853],
    action: 'reject',
  });

  // 排除全部代理节点的域名/IP，确保到任一节点的连接走直连（防回流死循环 + 兼容无缝切换/代理链）。
  // CDN 安全：域名节点用纯域名规则(domain + domain_suffix，靠 sniff 出的 SNI 精确匹配节点域名)，
  //   不预解析为共享 CDN IP（共享 IP 加直连会误伤同 IP 的被墙站点、且抗不住 IP 轮换）；
  //   去掉过宽的 domain_keyword（会误匹配任意"含该域名串"的无关域名）。
  // 仅用户显式填的 IP-literal 节点用 ip_cidr 排除（专用 IP、非共享，安全）。
  // 扩展到全部节点(不止选中)：切节点 / detour 前置代理无需重生成配置即被豁免。
  // 必须放在其他规则之前，否则可能被 geosite-cn 匹配导致死循环。
  {
    const ipSet = new Set<string>();
    const domainSet = new Set<string>();
    for (const s of config.servers) {
      const hosts = [s.address, s.tlsSettings?.serverName].filter(
        (h): h is string => !!h && h.length > 0
      );
      for (const host of hosts) {
        if (isIpv4Host(host)) ipSet.add(`${host}/32`);
        else if (isIpv6Host(host)) ipSet.add(`${host}/128`);
        else domainSet.add(host);
      }
    }

    if (domainSet.size > 0) {
      const domains = Array.from(domainSet);
      rules.push({
        // domain(精确，= 节点 SNI) + domain_suffix(仅 .${d}，匹配子域)。不放裸 d 进 domain_suffix：
        // 那是 raw 后缀匹配，会把共享 apex 下别的真实站点也沉降到直连。
        domain: domains,
        domain_suffix: domains.map((d) => `.${d}`),
        action: 'route',
        outbound: 'direct',
      });
    }

    if (ipSet.size > 0) {
      rules.push({
        ip_cidr: Array.from(ipSet),
        action: 'route',
        outbound: 'direct',
      });
    }
  }

  // 0a. U盾/安全插件的本地伪域名 → 强制 127.0.0.1，完全跳过 DNS
  // windows10.microdone.cn 等域名是 U盾厂商注册在本地的专用域名，公网 DNS 中不存在。
  // 普通 direct outbound 会先做 DNS 解析 → NXDOMAIN → 连接失败。
  // 版本分支：
  //   1.12.x → 使用 direct-loopback outbound（outbound 层面 override_address）
  //   1.13+  → 使用路由规则层面的 override_address（outbound 层面已移除此功能）
  const UKEY_LOCAL_DOMAINS = ['.microdone.cn'];
  const otherBankDomains = DOMESTIC_BANK_AND_STOCK_DOMAINS.filter(
    (d) => !UKEY_LOCAL_DOMAINS.includes(d)
  );

  if (coreVersionAtLeast(deps.coreVersion, 1, 13)) {
    // 1.13+：路由规则支持 override_address
    rules.push({
      domain_suffix: UKEY_LOCAL_DOMAINS,
      action: 'route',
      outbound: 'direct',
      override_address: '127.0.0.1',
    });
  } else {
    // 1.12.x：使用专用的 direct-loopback outbound
    rules.push({
      domain_suffix: UKEY_LOCAL_DOMAINS,
      action: 'route',
      outbound: 'direct-loopback',
    });
  }

  // 0b. 其余银行/证券域名 → 普通 direct（正常 DNS 解析，这些域名在公网真实存在）
  if (otherBankDomains.length > 0) {
    rules.push({
      domain_suffix: otherBankDomains,
      action: 'route',
      outbound: 'direct',
    });
  }

  // 优先级重排：0c(wg/tailscale force-route) + 1(bypassLAN 私网直连) 已下移到「自定义规则 + 应用分流」之后
  //（用户自定义规则/应用分流最高优先，可覆盖 mesh force-route 与 LAN 直连，用户态选节点最灵活）。见下方同名块。

  // Bug 4 修复：删除此处重复的 QUIC 阻断规则
  // 第一条 QUIC reject 规则已在上方（生成 routeConfig 之前）添加，此处重复添加会造成规则冗余
  // reject 比 block 更合适（发 TCP RST 让浏览器立即回退到 TCP，而不是静默丢弃造成等待超时）

  // 3. 自定义规则 + 应用分流（用户路由）——**仅 smart 模式**：global=真·全局忽略用户分流（一律走选中节点，
  //    下方 smart geo 也不加、final=proxy），direct=全直连。功能性强制直连（防环/LAN/网银/节点排除）在本块之外、不受影响。
  if (proxyMode === 'smart') {
    const { rules: customRules, ruleSets: customRuleSets } = buildCustomRules(
      effectiveCustomRules(config),
      config.customRuleSets || [],
      config.selectedServerId || undefined,
      idToTagMap,
      selectedServerTag,
      config.ruleResources || [],
      usesFakeIp(config), // FakeIP 启用 → 注册外化 bypass 规则的 DNS rule_set 条目（供 generateDnsConfig 引用）
      {
        log: (level, message) => deps.log(level, message),
        onDegraded: () => {
          deps.onDegraded();
        },
      }
    );
    // 走代理的自定义规则同样要配对 udp443 reject（终止规则、在末尾兜底前命中）。逐条插入：
    // 代理向规则前先放一条同匹配器的 udp443 reject；direct/block 规则不配对。
    // udp443 reject matcher 提取：复制规则上除「动作/出站/目的端口/network」外的全部匹配字段，使 process/
    // regex/source_ip/source_port 等各类代理向规则同样配对（修原先仅覆盖 5 字段的缺口）。
    // 仅排除目的 port/port_range——它们与 udp443RejectRule 的 port:443 冲突；source_port 不冲突，可配对（修 P2-1）。
    // type/mode/rules 也排除：logical 规则单独走嵌套 AND 路径（见下），default 规则本就无这些字段（防御）。
    const UDP443_MATCHER_EXCLUDE = new Set([
      'action',
      'outbound',
      'network',
      'port',
      'port_range',
      'type',
      'mode',
      'rules',
    ]);
    for (const cr of customRules) {
      const isProxyOut =
        cr.action === 'route' &&
        !!cr.outbound &&
        cr.outbound !== 'direct' &&
        cr.outbound !== 'block';
      if (isProxyOut && blockProxyQuic) {
        if (cr.type === 'logical') {
          // logical 规则顶层不接受 network/port（sing-box 解码会 FATAL）→ 把原 logical matcher 与 udp443
          // 条件再套一层 AND logical（headless 子规则可带 network/port）：(原 logical 命中) ∧ (udp:443) → reject。
          rules.push({
            action: 'reject',
            type: 'logical',
            mode: 'and',
            rules: [
              { type: 'logical', mode: cr.mode, rules: cr.rules },
              { network: ['udp'], port: [443] },
            ],
          });
        } else {
          const matcher: Record<string, any> = {};
          for (const [k, v] of Object.entries(cr)) {
            if (!UDP443_MATCHER_EXCLUDE.has(k) && v != null) matcher[k] = v;
          }
          if (Object.keys(matcher).length > 0) {
            rules.push(udp443RejectRule(matcher));
          }
        }
      }
      rules.push(cr);
    }

    if (customRuleSets.length > 0) {
      if (!routeConfig.rule_set) {
        routeConfig.rule_set = [];
      }
      routeConfig.rule_set.push(...customRuleSets);
    }

    // 排除进程：兼容旧配置的兜底（新数据已由 ConfigManager 迁移为 customRules 的 processName+direct 规则）。
    // 位于自定义规则之后、应用分流之前；任意更早的自定义规则可覆盖它，并非"最高优先级"。
    if (config.bypassProcesses && config.bypassProcesses.length > 0) {
      rules.push({
        process_name: config.bypassProcesses,
        action: 'route',
        outbound: 'direct',
      });
    }

    // 应用分流规则（真·应用分流，基于进程名）
    // 优先级高于后续的智能分流/全局分流，确保特定应用的流量始终走用户指定的出口
    for (const appRule of effectiveAppRules(config)) {
      if (!appRule.enabled) continue;
      const preset = getAppPreset(appRule.appId, config.customAppPresets);
      if (!preset) continue;

      // 确定出站方式
      let outbound = 'direct';
      if (appRule.action === 'proxy') {
        // rule-sel-app 恒存在（generateRuleSelectors 为所有 proxy appRule 生成）：outbound 恒指
        // rule-sel-app-<appId>，「默认/跟全局」= default=proxy-selector（嵌套），「指定节点」= default=节点 tag。
        // 使「节点↔默认」= rule-sel-app default 变（PUT 热切换），非 outbound 结构变（重启）。
        outbound = `rule-sel-app-${appRule.appId}`;
      } else if (appRule.action === 'block') {
        outbound = 'block';
      }

      // 走代理的 app 分流也要配对 udp443 reject（这些是终止规则、在末尾兜底之前命中，否则 blockQuic
      // 对该应用的 QUIC 失效）。direct/block 不配对。
      const appOutIsProxy = outbound !== 'direct' && outbound !== 'block';

      // a. 基于进程名的规则（最精准，适用于 macOS/Windows TUN 模式）
      if (preset.processNames && preset.processNames.length > 0) {
        if (appOutIsProxy) {
          const r = proxyUdpRejectFor({ process_name: preset.processNames });
          if (r) rules.push(r);
        }
        rules.push({
          process_name: preset.processNames,
          action: 'route',
          outbound,
        });
      }

      // b. 基于原有 rule_set 的规则（兜底，基于域名/IP 识别）
      // tag 小写对齐 getRequiredGeoCategories（注入哪些 rule_set）+ 本地 .srs 文件名/资源 id，
      // 否则 customAppPresets 大写 tag → 引用 geosite-<Cap> 但本地仅 geosite-<cap>.srs → fail-closed 剪掉。
      const ruleSets = [
        ...preset.geositeTags.map((tag) => `geosite-${tag.toLowerCase()}`),
        ...(preset.geoipTags || []).map((tag) => `geoip-${tag.toLowerCase()}`),
      ];

      if (ruleSets.length > 0) {
        if (appOutIsProxy) {
          const r = proxyUdpRejectFor({ rule_set: ruleSets });
          if (r) rules.push(r);
        }
        rules.push({
          rule_set: ruleSets,
          action: 'route',
          outbound,
        });
      }
    }
  }

  // ===== 用户规则之后的功能性强制路由（reorder：原在用户规则之上，现下移，使用户自定义规则/应用分流可覆盖）=====
  // 0c. endpoint 节点（WireGuard/Tailscale）的「配置路由段」强制路由到**该节点自身 tag**——优先于下方私网直连、
  //     **独立于 bypass-LAN 开关、独立于全局选中**。单一真值：节点路由由其 allowedIPs(WG) / routes+tailnet(TS)
  //     决定（endpointForcedRouteCidrs）；指向节点自身 tag（非 selector）→ 该段恒走其 mesh 节点、与全局选中无关。
  //     **现位于用户自定义规则/应用分流之后**：用户可写规则覆盖 mesh 段（选节点更灵活），重叠时由调用方记 warn 提醒。
  //     **D-direct：direct 模式也生成**（直连上网 + 仍可达对端内网段，符合「无论代理模式都能访问已配置内网段」）。
  //     userspace 与 system 同此 force-route：system:true 的 egress 仍经 route.rules 导到 endpoint tag（其 OS 接口
  //     路由仅服务 ingress/反向可达，见设计 §11.8）。按 config.servers 顺序=隐式优先级；死引用由 fixRouteDeadReferences
  //     兜底改写 selector。裸块 `{}` 保 claimedCidrs/emittedEndpointTags 的块作用域。
  {
    // 仅对【本轮实际发射】的 endpoint 节点强制路由：未就绪/被跳过的 Tailscale 节点不进 pendingEndpoints，
    // 其 tag 若仍 force-route 会被末尾 fixRouteDeadReferences 改写成 selector → 该段误流向全局选中节点。
    // emitted 集合天然只含 endpoint 协议（仅 WG/TS 进 pendingEndpoints），故无需再按协议预判。
    const emittedEndpointTags = new Set(deps.pendingEndpoints.map((e) => e.tag));
    // 「仅出网」节点（alwaysRouteSubnets=false）的按需 force-route：仅在被选中或被规则/应用分流显式指向时发射其网段。
    // engaged 判定集 ruleTargetedServerIds 已在函数顶部汇集（与重叠 warn 共用，口径一致）。
    // 跨 endpoint 去重：同一 CIDR 被多个 endpoint 声明（如两个 Tailscale 节点都含 tailnet 100.64.0.0/10，
    // 或两个 WG 节点 allowedIPs 重叠），sing-box 路由首条命中 → 后者静默失效。按 config.servers 顺序，
    // 先声明者占有该段（隐式优先级），后者重复段跳过 + 累计告警，杜绝「无声误路由到另一节点」。
    const claimedCidrs = new Set<string>();
    let forceRouteConflicts = 0;
    for (const s of config.servers) {
      const tag = idToTagMap.get(s.id);
      if (!tag || !emittedEndpointTags.has(tag)) continue;
      // alwaysRouteSubnets=false 且未 engaged（未选中、无规则指向）→ 跳过其 force-route：纯作可选出口，
      // 网段不强加给全局。注意只 gate route.rules，peer.allowed_ips 不变 → 被选中时网段仍可达（engaged→此处放行）。
      if (!shouldForceRouteSubnets(s, config.selectedServerId, ruleTargetedServerIds)) continue;
      const cidrs = endpointForcedRouteCidrs(s).filter((c) => {
        if (claimedCidrs.has(c)) {
          forceRouteConflicts++;
          return false;
        }
        claimedCidrs.add(c);
        return true;
      });
      if (cidrs.length > 0) {
        rules.push({ ip_cidr: cidrs, action: 'route', outbound: tag });
      }
    }
    if (forceRouteConflicts > 0) {
      deps.log(
        'warn',
        `${forceRouteConflicts} 个 endpoint 路由段被多个节点重复声明，已按节点顺序去重（先声明者生效）`
      );
    }
  }

  // 1. 私有 IP 段直连（内网地址不应该经过代理）。仅当用户未关闭"绕过局域网"时添加。
  //    **现位于用户规则之后**：用户自定义规则（如「192.168.x.x → 代理」）优先级更高、可覆盖此 LAN 默认直连，
  //    故 bypassLAN 无需独立的「可编辑排除清单」（用规则覆盖即可）。
  if (config.bypassLAN !== false) {
    // 与 mesh force-route 块一致：空数组不发射规则（用户把 bypassLANList 编辑成只剩域名时 cidrs 为空，
    // 避免 `ip_cidr:[]` 空规则；域名直连仍由下方 geosite-private 兜底）。
    const bypassCidrs = bypassLanCidrs(effectiveBypassLan(config));
    if (bypassCidrs.length > 0) {
      rules.push({ ip_cidr: bypassCidrs, action: 'route', outbound: 'direct' });
    }
    // 私有/本地**域名**直连（geosite-private，补 ip_cidr 的域名盲区，如路由器后台域）。geosite-private 由
    // BUILTIN_GEO_RULESETS 随包 bundle + 自动更新 fswatch 热加载；仅在本地 .srs 有效时加规则，缺失则跳过
    // （不引用不存在的 rule_set，避免 FATAL）——与上面 getLocalGeoRuleSets 的缺失即跳过一致。
    if (isValidSrsFile(path.join(getRuntimeRulesDir(), 'geosite-private.srs'))) {
      rules.push({ rule_set: 'geosite-private', action: 'route', outbound: 'direct' });
    }
  }

  // 【QUIC 阻断】：放在自定义规则和应用分流之后，确保用户的 direct/proxy 规则优先级更高
  // 这样游戏设为直连时，进程名匹配在前，游戏的 UDP 流量不会被误拒。
  // 仅阻断浏览器的 DoH over QUIC，迫使浏览器回退到系统 UDP 53 + hijack-dns 体系。
  // 重要：不能全量 reject 所有 UDP 443，否则 Hysteria2/TUIC 等 QUIC 协议节点会被误伤。
  rules.push(udp443RejectRule({ domain_keyword: DOH_LEAK_DOMAIN_KEYWORDS }));

  // 【DNS 死循环防范】：sing-box 本地 DNS 解析器的请求必须强制直连，否则在全局代理模式下会产生死循环
  // 兼容 Windows 1.12.x 版本，不使用 DNS 配置里的 detour
  rules.push({
    protocol: 'dns',
    action: 'route',
    outbound: 'direct',
  });

  rules.push({
    // #57：1.12.12.12（DNSPod IP-DoH，节点域名解析器 DNSPod 档）与 223.5.5.5 同列直连放行
    ip_cidr: ['223.5.5.5/32', '1.12.12.12/32'],
    port: [53, 443],
    action: 'route',
    outbound: 'direct',
  });

  rules.push({
    domain_suffix: ['doh.pub'],
    action: 'route',
    outbound: 'direct',
  });

  // 【通用修复：Chrome/Edge 心跳 beacon 域名强制直连 —— global 和 smart 模式均生效】
  // gvt2.com / gvt1.com 是 Google CDN 心跳；clientservices / oauthaccountmanager /
  // optimizationguide-pa 是 Chrome 账号同步、FCM Push 和优化引导的后台服务。
  // 这些域名对代理节点出口通常限速或屏蔽（非浏览行为），一旦持续超时会耗尽连接池，
  // 导致所有正常网页也超时 —— 即"过一会就断网"现象。
  // 在 global 和 smart 两种模式下均强制直连，彻底消除对连接池的占用。
  if (proxyMode !== 'direct') {
    rules.push({
      domain_suffix: [
        // Google CDN 心跳
        'gvt2.com',
        'gvt1.com',
        // Chrome 账号同步 / FCM Push 后台
        'oauthaccountmanager.googleapis.com',
        'clientservices.googleapis.com',
        // Chrome 优化引导服务
        'optimizationguide-pa.googleapis.com',
        // Google FCM 推送 (port 5228)
        'mtalk.google.com',
        // Android 客户端服务
        'android.clients.google.com',
        // Chrome / GMS clients
        'clients1.google.com',
        'clients2.google.com',
        'clients3.google.com',
        'clients4.google.com',
        'clients5.google.com',
        'clients6.google.com',
        // 自动更新检查
        'update.googleapis.com',
      ],
      action: 'reject',
    });
  }

  // 智能分流规则（仅在智能分流模式下启用）
  if (proxyMode === 'smart') {
    // 已移除 ::/0 block，因为 block 是静默丢包，会导致 Chrome 等浏览器在发起 TCP SYN 包时陷入漫长的 21 秒重传等待（Happy Eyeballs 假死），
    // 从而让用户以为“所有的海外网站全都打不开了”。我们必须依靠浏览器的原生 fallback，或者直接让 Mac 本机关闭 IPv6 分配。

    // 针对 Google 核心服务（搜索/YouTube/Gmail 等）的关键词兜底规则（仅在未专门设置应用分流时作为备份）
    // 注意：这些规则在 AppRules 之后，所以不会覆盖用户手动指定的节点
    const googleKeywords = ['google', 'gmail', 'youtube', 'gstatic', 'googleapis', 'googlevideo'];

    // 代理向 UDP（smart）：在每条"→代理"规则之前配对一条 reject，使该走代理的 UDP 在被路由到代理
    // 前就 reject——不能中继的节点拦全部 UDP，能中继+blockQuic 仅拦 QUIC(UDP443)。下方 CN 直连规则
    // 不配对，故 CN/直连 UDP 不受影响（兜底见 generateRouteConfig 末尾）。
    // exitFallback 时这两条走 direct（非代理），不能在其前配对「代理向 UDP reject」（否则误拒直连 UDP/QUIC）。
    const googleUdpReject = exitFallback
      ? null
      : proxyUdpRejectFor({ domain_keyword: googleKeywords });
    if (googleUdpReject) rules.push(googleUdpReject);
    rules.push({
      domain_keyword: googleKeywords,
      action: 'route',
      outbound: userExitTag, // D7：off-mesh 主节点时回退 direct，避免海外黑洞
    });

    // 国外域名走代理
    const foreignUdpReject = exitFallback
      ? null
      : proxyUdpRejectFor({ rule_set: 'geosite-geolocation-!cn' });
    if (foreignUdpReject) rules.push(foreignUdpReject);
    rules.push({
      rule_set: 'geosite-geolocation-!cn',
      action: 'route',
      outbound: userExitTag, // D7：off-mesh 主节点时回退 direct，避免海外黑洞
    });
    // 中国域名直连
    rules.push({
      rule_set: 'geosite-cn',
      action: 'route',
      outbound: 'direct',
    });
    // 中国 IP 直连
    rules.push({
      rule_set: 'geoip-cn',
      action: 'route',
      outbound: 'direct',
    });
  }

  // 添加 rule_set（除非是直连模式）
  // 直连模式下不需要 rule_set，因为全部走 direct
  if (proxyMode !== 'direct') {
    if (!routeConfig.rule_set) {
      routeConfig.rule_set = [];
    }
    // 路径取自与 copyRuleSetsToUserData 同一真值表，杜绝目录/文件名漂移
    const runtimeDir = getRuntimeRulesDir();
    for (const rs of getLocalGeoRuleSets()) {
      const filePath = path.join(runtimeDir, rs.fileName);
      // 缺失/损坏即跳过：不引用不存在的本地文件（否则 sing-box `initialize rule-set` FATAL）。
      // fail-closed：缺失不再远程兜底——引用该 tag 的路由规则由 generateRouteConfig 末尾「悬空引用剪枝」剪掉，
      // 重新在「规则资源」页下载后定义恢复 → 规则自动恢复（应用分流仍按进程名生效）。
      if (!isValidSrsFile(filePath)) continue;
      routeConfig.rule_set.push({ tag: rs.tag, type: 'local', format: 'binary', path: filePath });
    }
  }

  // 添加自定义规则和应用分流所需的 Geosite/GeoIP rule_set
  const { geosite: customGeositeCategories, geoip: customGeoipCategories } =
    getRequiredGeoCategories(
      effectiveCustomRules(config),
      effectiveAppRules(config),
      config.customAppPresets || []
    );

  // fail-closed：自定义规则 / 应用分流引用的 geo（geosite-<cat>/geoip-<cat>）统一由「规则资源」管理——
  // 随包内置（上方已注入本地定义）或用户在规则资源页下载的本地 .srs；运行期零远程下载、缺失绝不远程兜底。
  // 缺失本地副本 → 不注入定义；末尾「悬空引用剪枝」剪掉引用该 tag 的规则（应用分流只掉 geo 半、进程名仍生效；
  // 自定义规则按 AND/OR 合理坍缩）。重新在规则资源页下载后定义恢复 → 规则自动恢复（download 触发 core reload）。
  if (
    proxyMode !== 'direct' &&
    (customGeositeCategories.size > 0 || customGeoipCategories.size > 0)
  ) {
    if (!routeConfig.rule_set) {
      routeConfig.rule_set = [];
    }
    // 已下载进规则资源的本地副本（id 形如 geosite-<cat>/geoip-<cat>）→ 注入 type:'local'；缺失/损坏返回 null。
    const localResPath = (tag: string): string | null => {
      const r = (config.ruleResources || []).find((x) => x.id === tag);
      if (!r) return null;
      const p = path.join(getRuleResourcesPath(), r.fileName);
      return isValidSrsFile(p) ? p : null;
    };
    // 已有本地定义（随包内置已在上方注入）→ 跳过；否则用规则资源页的本地副本；再否则缺失（不注入，末尾剪枝）。
    const definedTags = new Set(routeConfig.rule_set.map((rs) => rs.tag));
    const addLocalGeo = (tag: string): void => {
      if (definedTags.has(tag)) return;
      const local = localResPath(tag);
      if (local) {
        routeConfig.rule_set!.push({ tag, type: 'local', format: 'binary', path: local });
        definedTags.add(tag);
      }
      // 缺失：不注入、不远程兜底 → 交末尾悬空引用剪枝（fail-closed）。
    };
    for (const category of Array.from(customGeositeCategories)) addLocalGeo(`geosite-${category}`);
    for (const category of Array.from(customGeoipCategories)) addLocalGeo(`geoip-${category}`);
  }

  // 【代理向 QUIC 兜底】：放在所有直连/分流规则之后，拦截"会落到 final(代理)"的剩余 QUIC(udp443)。
  // global 模式拦全部代理向 QUIC；smart 模式拦未被上方 →代理 配对 reject 命中的（CN 已直连豁免）。
  // 只拦 QUIC——非 QUIC 的代理向 UDP 若节点不能中继，由 sing-box 出站层自动拒绝（见上方 blockProxyQuic）。
  // D7 注：exitFallback 时 final/外网规则已回退 direct，此兜底仍 RST 漏网 QUIC → 浏览器 TCP 回退后走 direct，
  // 即「强制 TCP」语义、不黑洞（blockProxyQuic 仅看 blockQuic/mode/节点数，与 exitFallback 正交，行为正确）。
  if (blockProxyQuic) {
    rules.push(udp443RejectRule());
  }

  // rule_set 按 tag 去重（保留首次=本地 .srs 优先于远程）：用户加 geosite/geoip cn 等规则时，其远程
  // rule_set tag 会与 getLocalGeoRuleSets 的本地 geosite-cn/geoip-cn 撞名 → sing-box 启动 FATAL
  // (duplicate rule-set tag)。去重后撞名项复用本地 .srs，行为更优（无需下载）。(修 review P0)
  if (routeConfig.rule_set && routeConfig.rule_set.length > 0) {
    const seenTags = new Set<string>();
    routeConfig.rule_set = routeConfig.rule_set.filter((rs) => {
      if (seenTags.has(rs.tag)) return false;
      seenTags.add(rs.tag);
      return true;
    });
  }

  // fail-closed 兜底：剪掉引用「未定义 rule_set tag」的路由规则——本地 geo 缺失/损坏未注入定义即成悬空引用，
  // 否则 sing-box `initialize rule-set` FATAL 崩整个代理。复用 applyRuleSetPrune 的三态递归剪枝（string/array/logical）：
  // smart geo 缺失→该方向规则 skip；app 规则只掉 geo 半（进程名规则独立保留）；自定义规则 AND/OR 合理坍缩。
  // 重下缺失资源后定义恢复 → 规则自动恢复（RuleResourceManager.download 触发 core reload）。
  {
    const definedTags = new Set((routeConfig.rule_set ?? []).map((rs) => rs.tag));
    const referenced = new Set<string>();
    const collectRefs = (rules: SingBoxRouteRule[]): void => {
      for (const rule of rules) {
        if (Array.isArray(rule.rules)) collectRefs(rule.rules);
        const rs = rule.rule_set;
        if (typeof rs === 'string') referenced.add(rs);
        else if (Array.isArray(rs)) for (const t of rs) referenced.add(t);
      }
    };
    collectRefs(routeConfig.rules);
    const dangling = new Set(Array.from(referenced).filter((t) => !definedTags.has(t)));
    if (dangling.size > 0) {
      applyRuleSetPrune({ route: routeConfig } as SingBoxConfig, dangling);
      deps.log(
        'warn',
        `规则资源：${Array.from(dangling).join(', ')} 缺少本地副本，已跳过引用它的规则以避免代理启动失败` +
          `（在「规则资源」页下载后自动恢复；应用分流仍按进程名生效）`
      );
    }
  }

  return routeConfig;
}
