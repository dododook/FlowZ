/**
 * sing-box Inbound 配置生成 —— 从 ProxyManager.generateInbounds 抽出（SingBoxConfigBuilder 抽取 Phase 2 step 8）。
 *
 * 纯函数：只读 config/resolvedIps + 注入实例态（probeDirectPort / probeProxyPort 值）。
 * 装配 mixed inbound（HTTP+SOCKS 同口）+ 出口探针 inbound（probe-direct/proxy-in）+ TUN inbound（平台相关
 * 排除段/MTU/stack/IPv6/macOS http_proxy platform）。config 字节等价由 config-snapshot 网验证。
 */

import type { UserConfig } from '../../shared/types';
import { localProxyPort } from '../../shared/proxy-ports';
import { resolveWinTunInterfaceName } from '../../shared/tun-interface';
import { resolveTunStack } from '../../shared/tun-stack';
import type { SingBoxInbound } from './singbox-config-types';
import {
  isIpv4Host,
  isIpv6Host,
  hostToExcludeCidr,
  effectiveAppRules,
  effectiveCustomRules,
  getCustomDomesticDnsEndpoint,
} from './singbox-config-helpers';
import { bypassLanCidrs, effectiveBypassLan } from '../../shared/system-proxy-bypass';
import { cidrOverlapsAny, cidrContains } from '../../shared/ip';
import { ruleIpCidrs } from '../../shared/rules';
import { FAKEIP_INET4_RANGE, FAKEIP_INET6_RANGE } from '../../shared/fakeip-filter';
import { usesFakeIp } from './custom-rule-files';
import { isValidMacAddress, isTunMacFilterSupported } from '../../shared/neighbor';
import { computeUserTunExclude, computeWinBypassExclude } from '../../shared/tun-route-exclude';
import {
  meshForcedRouteCidrs,
  meshForceRoutedServers,
  collectRuleTargetedServerIds,
} from '../../shared/endpoint-routes';
import { dedupe } from '../../shared/collections';
import * as os from 'os';

/** 注入依赖：generateInbounds 原读的实例态。 */
export interface InboundsDeps {
  probeDirectPort: number | null;
  probeProxyPort: number | null;
  updateInPort: number | null;
  /** 可选日志回调（记「连入来源排除」的 mesh/fakeip/物理 LAN 剔除告警）。缺省（单测）不记。 */
  log?: (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', message: string) => void;
}

/**
 * 本机**所有非回环接口**（物理/VPN/overlay/TUN 自身）的连接网段（CIDR）——macOS「连入来源排除」的反向路由 guard 用。
 * os.networkInterfaces() 的 `.cidr`（如 '192.168.10.5/24'）含主机位，overlap 判定时 parseIpv4Cidr 会掩到网络地址，故直接用。
 * 不精确区分"物理 LAN"是刻意的过度包含：多含无害（不排除 = 绝不触发 NE 反向路由 drop，宁可漏排也不误破）。
 * 已知 efficacy 代价（可接受）：连入源经本机也接着的 overlay 接口（如本机也在同一 ZeroTier）到达时，其段与该接口段
 * 相交 → 被 guard 剔除 → 该段的排除 no-op；但此时连入源已是"经 overlay 的同段"、多半本就被 sing-tun 最长前缀保护，剔除无害。
 * 快照语义：在 buildInbounds 运行时读一次；换网络后由重生成刷新（M6 真机复核）。best-effort，取不到接口返空。
 */
function getOwnLanCidrs(): string[] {
  const out: string[] = [];
  try {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (!a.internal && a.cidr) out.push(a.cidr);
      }
    }
  } catch {
    /* 取不到接口 → 空（macOS guard 退化为不额外剔除，交真机验证兜底） */
  }
  return dedupe(out);
}

export function buildInbounds(
  config: UserConfig,
  resolvedIps: Record<string, string> | undefined,
  deps: InboundsDeps
): SingBoxInbound[] {
  const inbounds: SingBoxInbound[] = [];

  // 使用小写比较，兼容 SystemProxy/systemProxy 和 Tun/tun
  const modeType = (config.proxyModeType || 'systemProxy').toLowerCase();

  const listenAddr = config.allowLan ? '::' : '127.0.0.1';

  // 无论哪种模式，都添加 HTTP + SOCKS inbound
  // 这样用户在终端配置的代理环境变量在切换模式后仍然可用
  //
  // 关键修复：必须启用流量嗅探（sniff），否则 sing-box 无法从 TLS ClientHello 中
  // 提取域名（SNI），导致路由引擎只看到 IP 地址，无法匹配 geosite 规则正确分流。
  // 症状：Instagram 消息中心无网络、WhatsApp 二维码无法扫码等 WebSocket 类应用异常。
  // NekoBox 等 sing-box 客户端默认开启 sniff，FlowZ 之前遗漏了。
  //
  // sing-box 1.14：sniff/sniff_override_destination inbound 级字段已移除。嗅出域名用于路由匹配由路由层
  // push {action:'sniff'} 承担（详见 generateRouteConfig 嗅探规则段）；sniff_override_destination 无替代。

  // mixed-only：单个 mixed inbound 同口服务 HTTP + SOCKS（取代原 http-in + socks-in + 可选 mixed-in）。
  // 要 SOCKS 的 app 指同一端口即可。端口取单一真值 localProxyPort（mixedPort，旧配置回退 httpPort）。
  const mixedInbound: SingBoxInbound = {
    type: 'mixed',
    tag: 'mixed-in',
    listen: listenAddr,
    listen_port: localProxyPort(config),
  };
  inbounds.push(mixedInbound);

  // 出口 IP 探针 inbound（仅本地回环，端口动态分配）：经 probe-direct-in 的请求由 route.rules 头部
  // 钉死走 direct 出站、经 probe-proxy-in 钉死走 proxy-selector，从而无论接管/分流模式都能测出真实出口
  // IP。loopback 不进 TUN，无回环风险。分配失败（probe*Port 为 null）则不注入，IP 卡显示「获取失败」。
  if (deps.probeDirectPort && deps.probeProxyPort) {
    inbounds.push(
      {
        type: 'http',
        tag: 'probe-direct-in',
        listen: '127.0.0.1',
        listen_port: deps.probeDirectPort,
      },
      {
        type: 'http',
        tag: 'probe-proxy-in',
        listen: '127.0.0.1',
        listen_port: deps.probeProxyPort,
      }
    );
  }

  // 更新链路统一 inbound（socks，Phase 2）：FlowZ 应用更新检查/下载（UpdateService）+ 规则资源下载
  // （RuleResourceManager）+ 订阅（SubscriptionService）流量 pin 到此口（核心链路待后续接入），route 头部钉死按 proxyMode 决策
  // （不限 domain：归属 100% 确定不误伤，且覆盖任意订阅 URL）。用 socks（非 http）——net.request 经 socks
  // 入站不挂死（Phase 0 V2 实证）+ socks 锚点跨平台一致。loopback 不进 TUN。分配失败则不注入。
  if (deps.updateInPort) {
    inbounds.push({
      type: 'socks',
      tag: 'update-in',
      listen: '127.0.0.1',
      listen_port: deps.updateInPort,
    });
  }

  // TUN 模式额外添加 TUN inbound
  if (modeType === 'tun') {
    const shouldBypassLAN = config.bypassLAN !== false; // 默认为 true
    // 恢复 3.3.18 能完美工作的排除列表。
    // 注意：macOS 下绝对不能在底层排除物理局域网段，否则 macOS NetworkExtension 的路由逆向拦截机制会导致从 TUN (172.19.0.1) 发回 192.168.x.x 的 TCP 回执包被当作非法源 IP 丢弃，导致网页无限 HANG。
    // 但是在 Windows 下，Wintun 如果不排除局域网物理网关，发往本地路由器的 DHCP/网关查询会被死循环拦截，导致全局断网。
    // FakeIP 护栏：Win TUN 排除清单同样剔除与 fakeip 段相交的条目，否则假 IP 被排除出 TUN→sing-box 收不到→断（同 route 侧）。
    // fakeipRanges 仅供 Windows carve（computeWinBypassExclude）与 inboundExclude 的 computeUserTunExclude（mac/win）
    // 消费——Linux 加法态两者都不走（excludeAddr 恒空、inboundExclude 忽略+warn 短路），故加 linux 守卫避免死计算（复审 NIT-1）。
    const fakeipRanges =
      usesFakeIp(config) && process.platform !== 'linux'
        ? [FAKEIP_INET4_RANGE, ...(config.enableIPv6 ? [FAKEIP_INET6_RANGE] : [])]
        : [];
    // engaged（生效）组网 force-route 段——Windows bypassLAN carve 与下方「连入来源排除」共用单一真值（口径同
    // route-builder 块 0c shouldForceRouteSubnets：alwaysRouteSubnets ON / 被选中 / 被 enabled 规则显式指向）。
    const engagedMeshCidrs = meshForcedRouteCidrs(
      meshForceRoutedServers(
        config.servers,
        config.selectedServerId,
        collectRuleTargetedServerIds([
          ...effectiveCustomRules(config),
          ...effectiveAppRules(config),
        ])
      )
    );
    // Windows+bypassLAN：宽私网段(10/8、192.168/16 等)整体排除出 TUN 保护 WinTun（不排 LAN 网关→DHCP/网关查询
    // 死循环全局断网）；但**必须对 engaged 组网段 carve 开洞**——否则落在私网段内的 endpoint(WG/Tailscale)
    // force-route 段（含 tailnet 100.64.0.0/10、WG allowedIPs 私网段）被内核排除、接不到 route.rules 块 0c 的
    // ip_cidr→endpoint → 组网整体架空（Win 强制 gVisor，该段必须进 TUN 才能被组网用户态栈接走）。carve=算术差集
    // 只挖 mesh 段、保网关子网仍排除（见 computeWinBypassExclude；与保护段=物理子网/回环/链路本地/多播重叠的 mesh 段不 carve+告警）。
    // mac/Linux 不排私网（gvisor/系统栈走 route.rules），force-route 天然生效，故仅回环排除。
    // 注：不复活旧的 route_address 抢回（sing-box route_address 非空即替换默认 0/0、从未 Win 真机验、易破坏全局代理）。
    let excludeAddr: string[];
    if (process.platform === 'win32' && shouldBypassLAN) {
      const bypassCidrs = bypassLanCidrs(effectiveBypassLan(config));
      const win = computeWinBypassExclude({
        bypassCidrs,
        engagedMeshCidrs,
        ownLanCidrs: getOwnLanCidrs(),
        fakeipRanges,
      });
      excludeAddr = win.exclude;
      if (win.carvedMeshCidrs.length > 0) {
        deps.log?.(
          'info',
          `Windows bypassLAN 排除表已为 ${win.carvedMeshCidrs.length} 个生效组网段开洞（进 TUN 走组网，防架空）：${win.carvedMeshCidrs.join(', ')}`
        );
      }
      if (win.meshSkippedOwnLan.length > 0) {
        deps.log?.(
          'warn',
          `Windows：${win.meshSkippedOwnLan.length} 个组网段与保护段（本机物理子网/回环/链路本地/多播）重叠，为保护它未开洞（仍绕过 TUN；本地访问不依赖 TUN，但该段经组网的远端对等将不可达）：${win.meshSkippedOwnLan.join(', ')}`
        );
      }
      // W2（gap 1c）：Windows bypassLAN 段是内核层排除，落在其中的「非直连(走代理/拦截)」自定义规则会被静默架空
      // （规则永远看不到包）——mac/Linux 因 bypassLAN 在 route.rules 之下、规则可覆盖，无此问题。告警不减法：让用户
      // 显式让位（从「绕过局域网」清单移除该条目），对齐「连入来源排除」重叠告警风格 + UI 文案已按 Windows/TUN 平台化。
      // 只对【carve 后仍被排除】的规则段报（被 carve 开洞的段规则已生效、不虚报），但**列出用户清单里的原始条目**
      // （非 carve 合成片段——否则「移除 10.64.0.0/10」在只填了 10.0.0.0/8 的清单里不可执行）。
      const overridableRuleCidrs = effectiveCustomRules(config)
        .filter((r) => r.enabled && r.action !== 'direct')
        .flatMap((r) => ruleIpCidrs(r));
      const stillExcludedRuleCidrs = overridableRuleCidrs.filter((rc) =>
        cidrOverlapsAny(rc, win.exclude)
      );
      if (stillExcludedRuleCidrs.length > 0) {
        // 映射回【用户清单原始条目】，但只报 carve 后【自有残余片段仍被规则命中】的条目——全被 carve 挖空/被
        // fakeip 剔除的条目已不阻断规则，报「移除它」是 no-op（见二轮 N-1）。用 cidrContains(b,f) 取 b 的**自有**残余
        // （f ⊆ b），而非双向相交——否则更宽兄弟条目的片段会把被其包含的子条目误列（三轮 N-1，如 /16+/24 同列时误列 /24）。
        const conflict = bypassCidrs.filter((b) =>
          win.exclude.some((f) => cidrContains(b, f) && cidrOverlapsAny(f, stillExcludedRuleCidrs))
        );
        if (conflict.length > 0) {
          deps.log?.(
            'warn',
            `Windows：${conflict.length} 段「绕过局域网」清单条目与非直连（走代理/拦截）自定义规则段重叠——该段在内核层被排除、自定义规则不生效；如需生效请从「绕过局域网」清单移除该条目：${conflict.join(', ')}`
          );
        }
      }
    } else if (process.platform === 'linux') {
      // Linux 加法翻转（§12/§12.7，VM185 实测坐实）：route_exclude 恒空。sing-tun 的 Linux 策略路由本就是精确捕获
      // 系统——表 2022 空时单条 0/0、9001 恒被 suppress、9002 main 具体路由优先（内核级 same-subnet 直连）、9003
      // 只捕获「源未绑定的本机新建连接」；服务端回包（源=物理地址）不匹配捕获规则，fall-through 走物理网卡。而
      // route_exclude 非空即触发表 2022 两族分解 → 9001 全抓 → same/off-subnet 服务端连入 + allowLan 回包全断
      // （v4 A 相 33/33、v6 X6 相 0/54 实测；#242 断连根因是我们的排除清单本身）。回环无需排除（`0: from all
      // lookup local` 恒先于 9000 处理 127/8+::1，两条回环排除唯一实效就是触发分解）。清空后连入/组网/私网天然治愈。
      excludeAddr = [];
    } else {
      excludeAddr = ['127.0.0.0/8', '::1/128'];
    }

    // Windows 下额外排除核心 DNS IP，防止 WFP 进程匹配失效时产生回流死循环
    if (process.platform === 'win32') {
      excludeAddr.push(
        '223.5.5.5/32',
        '223.6.6.6/32',
        '1.12.12.12/32', // #57 DNSPod IP-DoH（节点域名解析器 DNSPod 档）：同 223.5.5.5 须排除防回流死循环
        '119.29.29.29/32',
        '119.28.28.28/32',
        '114.114.114.114/32',
        '8.8.8.8/32',
        '1.1.1.1/32'
      );
      // 用户自定义的国内 DNS（IP 型）一并排除，防 WFP 进程匹配失效时回流死循环
      const customDns = getCustomDomesticDnsEndpoint(config);
      if (customDns) {
        const cidr = hostToExcludeCidr(customDns.ip);
        if (cidr) excludeAddr.push(cidr);
      }
    }

    // 节点 IP 排除（防 FlowZ 连节点的流量回流进 TUN 死循环）：Linux 加法态跳过整块（§12）——节点 /32(/128) 进
    // route_exclude 同样触发表分解害连入；拨号回环由 auto_detect_interface bind/oif 逸出 TUN 防（v6 侧 Y6 相
    // EGRESS6 已佐证 direct 重拨经 oif 逸出，v4 侧真实节点走 L-B2 裁决）。darwin/win32 维持双保险。
    if (process.platform !== 'linux') {
      // 绝杀级修复（多服务器版本）：应用分流选中的其它节点 IP 也必须排除，否则连它们的流量回流进 TUN 死循环。
      const allServerIds = new Set([
        config.selectedServerId as string,
        ...effectiveAppRules(config).map((r) => r.targetServerId),
      ]);
      for (const serverId of allServerIds) {
        if (!serverId) continue;
        const server = config.servers.find((s) => s.id === serverId);
        if (server?.address) {
          if (isIpv4Host(server.address) || isIpv6Host(server.address)) {
            const cidr = hostToExcludeCidr(server.address);
            if (cidr) excludeAddr.push(cidr);
          } else if (resolvedIps && resolvedIps[serverId]) {
            // 使用预解析的 IP（域名节点）
            const cidr = hostToExcludeCidr(resolvedIps[serverId]);
            if (cidr) excludeAddr.push(cidr);
          }
        }
      }
    }

    // 「连入来源排除」（本机作服务端被 off-subnet 私网连入 → 回包被 TUN 用户态栈误劫持的治本项，见
    // docs/design/flowz-tun-lan-exclusion-scenarios.md）：把用户声明的来源网段追加进 route_exclude_address，
    // 使该段（出/入双向）绕过 TUN、走物理网卡。减【生效】组网 force-route 段（mesh 优先，否则误伤组网）/ fakeip 段；
    // macOS 额外减本机物理 LAN 段（排除物理 LAN 会触发 NE 反向路由丢 TUN 回包，见本函数顶部 line ~130 注释）。
    // 仅在用户声明了段时才进入本块（空/未设 → 跳过 getOwnLanCidrs 接口枚举 + computeUserTunExclude）。
    // 注：engagedMeshCidrs 已 hoist 到 TUN 块顶层恒算（Windows carve 与本块共用），非本块条件计算。
    const userInboundCidrs = config.tunConfig?.inboundExcludeCidrs;
    if (userInboundCidrs && userInboundCidrs.length > 0 && process.platform === 'linux') {
      // Linux 加法态：「连入来源排除」是毒丸（VM185 Z6 相实证——填任何段即 route_exclude 非空 → v4/v6 表分解 → 修
      // 声明段的同时杀掉所有其它 same-subnet 服务端连入）。Linux 服务端回包已由内核策略路由天然保护，此项不生效且
      // 会重新引入回归。忽略 + warn（§12/§12.7）；UI 已按平台提示。
      deps.log?.(
        'warn',
        `Linux：服务端回包已由内核策略路由天然保护，「连入来源排除」不生效且会重新触发路由表分解引入回归，已忽略 ${userInboundCidrs.length} 条声明段。`
      );
    } else if (userInboundCidrs && userInboundCidrs.length > 0) {
      // 只减【engaged】组网段（复用上方 hoisted engagedMeshCidrs，与 route-builder 块 0c / Windows bypassLAN carve
      // 同口径）。用全量 servers 会把休眠组网节点的段（及每个 Tailscale 无条件贡献的 100.64/10）也误剔 → 合法用户段
      // 被静默架空 + 假告警；切节点/改规则会触发重生成，engaged 集随之更新。
      const userExclude = computeUserTunExclude({
        platform: process.platform,
        userCidrs: userInboundCidrs,
        meshCidrs: engagedMeshCidrs,
        fakeipRanges, // 仅 usesFakeIp 时非空，平台无关
        ownLanCidrs: process.platform === 'darwin' ? getOwnLanCidrs() : [],
      });
      excludeAddr.push(...userExclude.extra);
      if (userExclude.droppedInvalid > 0) {
        deps.log?.(
          'warn',
          `「连入来源排除」剔除 ${userExclude.droppedInvalid} 条非法/过宽网段（须合法 CIDR、不含 0.0.0.0/0 等过宽段）。`
        );
      }
      if (userExclude.droppedMeshOverlap.length > 0) {
        deps.log?.(
          'warn',
          `「连入来源排除」${userExclude.droppedMeshOverlap.length} 段与生效组网(WG/Tailscale)路由段重叠，已跳过排除（该段经组网节点）：${userExclude.droppedMeshOverlap.join(', ')}`
        );
      }
      if (userExclude.droppedOwnLanMac.length > 0) {
        deps.log?.(
          'warn',
          `macOS：「连入来源排除」${userExclude.droppedOwnLanMac.length} 段与本机物理 LAN 相交，已跳过（排除物理 LAN 会触发 NetworkExtension 反向路由丢包）：${userExclude.droppedOwnLanMac.join(', ')}`
        );
      }
      // 与非直连（走代理/拦截）自定义规则段重叠告警（双向语义副作用）：被排除的段出/入均绕过 TUN，若某 enabled 的
      // 非直连（proxy/block）custom rule 想把该段走代理/拦截，会被静默架空。刻意**不减**（排除=用户显式声明的"我的
      // 连入/远程管理路径"意图更明确，且对私网连入源通常正是想直连），仅告警让用户知晓冲突（对齐 route-builder 的 mesh 重叠提醒风格）。
      const overridableRuleCidrs = effectiveCustomRules(config)
        .filter((r) => r.enabled && r.action !== 'direct')
        .flatMap((r) => ruleIpCidrs(r));
      if (overridableRuleCidrs.length > 0) {
        const conflict = userExclude.extra.filter((c) => cidrOverlapsAny(c, overridableRuleCidrs));
        if (conflict.length > 0) {
          deps.log?.(
            'warn',
            `「连入来源排除」${conflict.length} 段与非直连（走代理/拦截）自定义规则段重叠：排除使其出/入均绕过 TUN 走直连，该自定义规则对这些段将不生效：${conflict.join(', ')}`
          );
        }
      }
      // droppedFakeipOverlap 不单独告警：与 Windows 宽排除的 fakeip 护栏同「静默剔除」语义，且极少见。
    }

    // Linux 加法态：组网段与本机接口网段（getOwnLanCidrs=所有非回环接口，含物理/overlay/TUN，刻意过包含）重叠告警
    // （对齐 Windows meshSkippedOwnLan 文案风格；两族——cidrOverlapsAny 家族感知 v4/v6）。加法态下本机接口网段内的
    // 目的地走内核 main 表直连、优先于组网 force-route，此告警提示用户该段本地侧按直连（远端组网对等仍经组网可达）。
    if (process.platform === 'linux' && engagedMeshCidrs.length > 0) {
      const meshOwnLanOverlap = engagedMeshCidrs.filter((m) =>
        cidrOverlapsAny(m, getOwnLanCidrs())
      );
      if (meshOwnLanOverlap.length > 0) {
        deps.log?.(
          'warn',
          `Linux：${meshOwnLanOverlap.length} 个组网段与本机接口网段重叠，本机侧按直连优先（远端组网对等仍经组网可达）：${meshOwnLanOverlap.join(', ')}`
        );
      }
    }

    // 恢复至对应平台最稳定的网段。Windows 在 v3.4.0 使用 /16 时非常完美；Mac 在 v3.3.18 使用 /30 时最完美。
    const tunAddress = [
      config.tunConfig?.inet4Address ||
        (process.platform === 'darwin' ? '172.19.0.1/30' : '172.19.0.1/16'),
    ];
    // macOS 默认分配 IPv6 以提高与本地网络服务的兼容性，与 3.3.18 保持一致
    // （此前 darwin / 非 darwin 两分支逻辑完全相同，已合并消重）
    if (config.enableIPv6) {
      tunAddress.push(config.tunConfig?.inet6Address || 'fdfe:dcba:9876::1/126');
    }

    // macOS (3.3.18) 最稳定 MTU 为 1400。Windows (3.4.0) 下 MTU=1350 最完美。
    // 9000 为历史默认值（UI 不暴露 MTU 设置项），等同"未自定义"，必须回退到平台最优值，
    // 否则巨型 MTU 会让上面精心调优的平台值成为永不生效的死代码。
    const platformDefaultMtu = process.platform === 'darwin' ? 1400 : 1350;
    const userMtu = config.tunConfig?.mtu;
    const effectiveMtu = !userMtu || userMtu === 9000 ? platformDefaultMtu : userMtu;

    // TUN 网络栈：经 resolveTunStack 把用户选择（含 'auto' 默认档）解析成下发给核的【具体】栈。FlowZ 始终显式
    // pin，绝不吃 sing-box build-tag 默认（编进 gvisor→默认漂成 mixed）。'auto'/缺省→平台默认（mac gvisor /
    // Win·Linux system）；显式 system/gvisor/mixed 原样下发（honor 用户选择，零强制回退——旧 darwin&&system→gvisor
    // 强制回退已移除，它把"用户选 system"与"未设置"混为一谈）。依据/置信度见 docs/design/tun-stack-option.md。
    const effectiveStack = resolveTunStack(config.tunConfig?.stack, process.platform);

    const autoRoute = config.tunConfig?.autoRoute ?? true;
    // 刻意不设 sing-box 1.14 inbound 的 dns_mode → 内核取默认 `hijack`（= native + 端口 53 拦截）。不显式 pin 的理由：
    //  · macOS 命令行/独立二进制形态下 `native` 是 no-op（sing-tun darwin TUN 不设系统 per-interface DNS；上游 #4183
    //    以 not_planned 关闭、明确不为 CLI 实现——见 docs/design/dns-native-p2a.md NO-GO 评估）。真正的 :53 捕获靠
    //    route 层 {port:53→hijack-dns} 规则（singbox-route-builder），macOS 系统 DNS 由 SystemDnsManager 指向 off-link
    //    8.8.8.8 使其进 TUN 被捕获——故 inbound dns_mode 对 macOS 冗余、对 Win/Linux 与默认 hijack 一致。
    //  · 不 pin "hijack" 字面量避免 alpha 枚举/默认演进时漂移成 check FATAL（route 层 hijack-dns 才是捕获的单一真值）。
    //    升核时复核 sing-tun tun_darwin.go 是否新增 darwin native DNS（grep networksetup|scutil|SetDNS|DNSMode）。
    const tunInbound: SingBoxInbound = {
      type: 'tun',
      tag: 'tun-in',
      address: tunAddress,
      mtu: effectiveMtu,
      auto_route: autoRoute,
      strict_route: config.tunConfig?.strictRoute ?? true,
      // 具体栈由 resolveTunStack 解析（Auto→平台默认 / 显式选择 verbatim），恒 system|gvisor|mixed，永不省略。
      stack: effectiveStack,
      // 空数组省略字段（Linux 加法态恒空）——与 sing-box 上游默认字节一致，避免下发 `route_exclude_address: []`。
      ...(excludeAddr.length > 0 ? { route_exclude_address: excludeAddr } : {}),
    };

    // Windows：下发固定可辨的接口名（wintun 适配器名），使 issue #159 的「起核前等本名网卡释放」门控能按名锚定，
    // 杜绝与外部 sing-box 默认 tun0 / 其它 VPN 网卡混淆。mac(utun 名内核分配)/Linux(无释放竞态) 不设、保持现状。
    if (process.platform === 'win32') {
      tunInbound.interface_name = resolveWinTunInterfaceName(config);
    }

    // P6 局域网网关：按 MAC 限/排设备进 TUN（sing-box 1.14 include/exclude_mac_address）。
    // 内核硬限界（实证 alpha.32）：**仅 Linux + auto_route + auto_redirect**，脏 MAC → check/启动 FATAL，
    // include/exclude 互斥。四重门控（任一不满足即整组不发射，保持零变化、防 FATAL）：
    //   1. 平台=Linux（isTunMacFilterSupported）；2. auto_route 开；3. 有合法 MAC（脏值剔除后非空）。
    // 满足时：发射 auto_redirect:true（必需前置）+ 仅 include/exclude 之一（按 macFilterMode）。
    const macMode = config.tunConfig?.macFilterMode;
    if (macMode && isTunMacFilterSupported(process.platform) && autoRoute) {
      const macs = (config.tunConfig?.macFilterList || [])
        .map((m) => m.trim())
        .filter(isValidMacAddress);
      if (macs.length > 0) {
        tunInbound.auto_redirect = true;
        if (macMode === 'exclude') tunInbound.exclude_mac_address = macs;
        else tunInbound.include_mac_address = macs;
      }
    }

    // macOS 平台特定配置
    if (process.platform === 'darwin') {
      tunInbound.platform = {
        http_proxy: {
          enabled: true,
          server: '127.0.0.1',
          server_port: localProxyPort(config), // mixed-only：指向本地 mixed 端口
        },
      };
    }

    inbounds.push(tunInbound);
  }

  return inbounds;
}
