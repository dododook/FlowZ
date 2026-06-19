/**
 * sing-box Inbound 配置生成 —— 从 ProxyManager.generateInbounds 抽出（SingBoxConfigBuilder 抽取 Phase 2 step 8）。
 *
 * 纯函数：只读 config/resolvedIps + 注入实例态（coreVersion / probeDirectPort / probeProxyPort 值）。
 * 装配 mixed inbound（HTTP+SOCKS 同口）+ 出口探针 inbound（probe-direct/proxy-in）+ TUN inbound（平台相关
 * 排除段/MTU/stack/IPv6/macOS http_proxy platform）。config 字节等价由 config-snapshot 网验证。
 */

import type { UserConfig } from '../../shared/types';
import { coreVersionAtLeast } from '../../shared/version';
import { localProxyPort } from '../../shared/proxy-ports';
import type { SingBoxInbound } from './singbox-config-types';
import {
  isIpv4Host,
  isIpv6Host,
  effectiveAppRules,
  getCustomDomesticDnsEndpoint,
} from './singbox-config-helpers';
import { bypassLanCidrs, effectiveBypassLan } from '../../shared/system-proxy-bypass';
import { partitionCidrsByOverlap } from '../../shared/ip';
import { FAKEIP_INET4_RANGE, FAKEIP_INET6_RANGE } from '../../shared/fakeip-filter';
import { usesFakeIp } from './custom-rule-files';

/** 注入依赖：generateInbounds 原读的实例态。 */
export interface InboundsDeps {
  coreVersion: string;
  probeDirectPort: number | null;
  probeProxyPort: number | null;
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
  // 版本兼容：
  //   1.12.x → sniff/sniff_override_destination 是 inbound 级别字段
  //   1.13.x → 这两个字段均已移除。sniff（嗅出域名用于路由匹配）由路由层只 push {action:'sniff'} 替代；
  //            sniff_override_destination（改写 outbound 目标让节点收到域名）在 1.13.0 已移除且无替代
  //            （详见 generateRouteConfig A. 嗅探规则段注释）。
  const useLegacySniff = !coreVersionAtLeast(deps.coreVersion, 1, 13);

  // mixed-only：单个 mixed inbound 同口服务 HTTP + SOCKS（取代原 http-in + socks-in + 可选 mixed-in）。
  // 要 SOCKS 的 app 指同一端口即可。端口取单一真值 localProxyPort（mixedPort，旧配置回退 httpPort）。
  const mixedInbound: SingBoxInbound = {
    type: 'mixed',
    tag: 'mixed-in',
    listen: listenAddr,
    listen_port: localProxyPort(config),
  };
  if (useLegacySniff) {
    mixedInbound.sniff = true;
    mixedInbound.sniff_override_destination = true;
  }
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

  // TUN 模式额外添加 TUN inbound
  if (modeType === 'tun') {
    const shouldBypassLAN = config.bypassLAN !== false; // 默认为 true
    // 恢复 3.3.18 能完美工作的排除列表。
    // 注意：macOS 下绝对不能在底层排除物理局域网段，否则 macOS NetworkExtension 的路由逆向拦截机制会导致从 TUN (172.19.0.1) 发回 192.168.x.x 的 TCP 回执包被当作非法源 IP 丢弃，导致网页无限 HANG。
    // 但是在 Windows 下，Wintun 如果不排除局域网物理网关，发往本地路由器的 DHCP/网关查询会被死循环拦截，导致全局断网。
    // FakeIP 护栏：Win TUN 排除清单同样剔除与 fakeip 段相交的条目，否则假 IP 被排除出 TUN→sing-box 收不到→断（同 route 侧）。
    const winFakeipRanges = usesFakeIp(config)
      ? [FAKEIP_INET4_RANGE, ...(config.enableIPv6 ? [FAKEIP_INET6_RANGE] : [])]
      : [];
    const excludeAddr =
      process.platform === 'win32' && shouldBypassLAN
        ? partitionCidrsByOverlap(bypassLanCidrs(effectiveBypassLan(config)), winFakeipRanges).disjoint
        : ['127.0.0.0/8', '::1/128'];
    // 【已知限制 / Windows 真机待验】Windows+bypassLAN 下这里用宽私网段(10/8、192.168/16 等)整体排除出 TUN，
    // 会顺带把落在私网段内的 endpoint(WG/Tailscale) force-route 段(如 mesh 192.168.50.0/24)也排除 → 该段到不了
    // 组网节点（走物理 LAN/直连）。mac/Linux 不排除私网（gvisor/系统栈走路由规则），force-route 正常生效。
    // 旧版曾用 route_address 把 mesh 段以更具体前缀抢回 TUN，但该机制本身从未在 Windows 真机验证（且 sing-box
    // route_address 非空即替换默认 0/0，处置不当会反而破坏 Windows 全局代理）→ 故此处不再投机重加，留待 Windows
    // 真机抓包定论后于专项分支处理（tailnet 100.64.0.0/10 不在私网排除表，Windows 下本就可达，不受此限制影响）。

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
        excludeAddr.push(`${customDns.ip}/${isIpv6Host(customDns.ip) ? 128 : 32}`);
      }
    }

    // 绝杀级修复（多服务器版本）：如果在 应用分流 (App Policy) 中选择了其他节点，那么这些节点的 IP 也必须被排除。
    // 否则，FlowZ 去连接这些次选节点的流量也会回流进入 TUN 产生死循环。
    const allServerIds = new Set([
      config.selectedServerId as string,
      ...effectiveAppRules(config).map((r) => r.targetServerId),
    ]);

    // 去除会导致 macOS 崩溃的 shouldBypassLAN 全局排除逻辑，回到 3.3.18 时代的精简状态
    for (const serverId of allServerIds) {
      if (!serverId) continue;
      const server = config.servers.find((s) => s.id === serverId);
      if (server?.address) {
        if (isIpv4Host(server.address)) {
          excludeAddr.push(`${server.address}/32`);
        } else if (isIpv6Host(server.address)) {
          excludeAddr.push(`${server.address}/128`);
        } else if (resolvedIps && resolvedIps[serverId]) {
          // 使用预解析的 IP
          const addr = resolvedIps[serverId];
          excludeAddr.push(isIpv6Host(addr) ? `${addr}/128` : `${addr}/32`);
        }
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

    // macOS 必须 gvisor 栈(3.3.18)；'system' 是历史默认值（UI 不暴露 stack 设置项），在 macOS 上
    // 等同"未自定义"，必须回退到 gvisor，否则同 MTU 一样平台判定成永不生效的死代码。Win/Linux 保持 system。
    const platformDefaultStack = process.platform === 'darwin' ? 'gvisor' : 'system';
    const userStack = config.tunConfig?.stack;
    const effectiveStack =
      !userStack || (process.platform === 'darwin' && userStack === 'system')
        ? platformDefaultStack
        : userStack;

    const tunInbound: SingBoxInbound = {
      type: 'tun',
      tag: 'tun-in',
      address: tunAddress,
      mtu: effectiveMtu,
      auto_route: config.tunConfig?.autoRoute ?? true,
      strict_route: config.tunConfig?.strictRoute ?? true,
      // macOS 必须使用 gvisor 栈(3.3.18)。Windows 下 system 栈配合 Wintun 性能最强且稳定(3.4.0)。
      stack: effectiveStack,
      route_exclude_address: excludeAddr,
    };

    // 兼容 sing-box 1.12.x 版本（打包核心现已全部 ≥1.13.13，此分支仅为向后兼容旧 userData 核心保留），必须在 inbound 定义 sniff 否则无法域名分流。
    // 对于 1.13.0+，嗅探逻辑已经统一由后方 route.rules 承担，但在入站开启会报错，因此需精准版本判断。
    if (!coreVersionAtLeast(deps.coreVersion, 1, 13)) {
      (tunInbound as any).sniff = true;
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
