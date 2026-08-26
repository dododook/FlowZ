/**
 * 系统 DNS 接管（TUN 模式）纯逻辑——命令参数构造 / 平台输出解析 / 防自指原始值计算。
 * 可单测、无 electron/node-fs 依赖；副作用（exec / marker IO）在 main/services/SystemDnsManager.ts。
 * 设计见 docs/design/dns-ipv6-takeover.md。
 */

import { CONTROLLED_TUN_DNS_IP, isBootstrapDirectDnsIp } from './dns';
import { dedupe } from './collections';

/**
 * 系统 DNS marker：记录「DNS 由 FlowZ 接管」+ 接管前每个网络服务/接口的原始 DNS（[] = DHCP/自动）。
 * 与系统代理 marker 不同：DNS 还原需精确恢复原值，故 original 也落 marker（崩溃/强杀后下次启动据此精确还原）。
 */
export interface SystemDnsMarker {
  controlledIp: string;
  original: Record<string, string[]>;
  at: number;
  /**
   * Linux 专用：接管时 TUN 链路的 IPv4 地址。**跨会话还原必须靠它**——marker 只记接口名的话，
   * 崩溃后新实例拿不到地址，还原就会退化成「按名字 revert tun0」，而那个名字此刻可能属于 OpenVPN。
   * 旧 marker 无此字段 → 读为 undefined → Linux 侧按「无法核验身份」处理（只清 marker，不动系统）。
   */
  tunInet4Address?: string;
}

/** 受控 DNS IP（封装常量，便于单测护栏断言其不在 bootstrap-direct 列表）。 */
export function controlledTunDnsIp(): string {
  return CONTROLLED_TUN_DNS_IP;
}

/** 受控 DNS IP 是否合法（不在 bootstrap-direct 列表——否则其 :53 查询被直连规则放行、逃逸 hijack 接管失效）。 */
export function isControlledDnsIpValid(ip: string = CONTROLLED_TUN_DNS_IP): boolean {
  return !isBootstrapDirectDnsIp(ip);
}

/**
 * 解析 macOS `networksetup -getdnsservers "<svc>"` 输出 → IP 列表。
 * 未设置时输出 "There aren't any DNS Servers set on <svc>." → 返回 []（= DHCP/自动）。
 */
export function parseMacGetDnsServers(stdout: string): string[] {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  if (lines.some((l) => /aren't any DNS Servers|There aren't any/i.test(l))) return [];
  // 每行一个 IP（v4 或 v6）；过滤掉非 IP 行（防 networksetup 偶发提示混入）
  return lines.filter((l) => /^[0-9a-fA-F:.]+$/.test(l) && (l.includes('.') || l.includes(':')));
}

/**
 * macOS 设置 DNS 的 networksetup 参数（用 execFile 传 argv，服务名含空格也安全）。
 * ips 为空 → ['Empty'] 还原为 DHCP/自动获取。
 */
export function macSetDnsArgs(service: string, ips: string[]): string[] {
  return ['-setdnsservers', service, ...(ips.length ? ips : ['Empty'])];
}

/**
 * Windows netsh：设置/还原某接口 IPv4 DNS 的命令串序列。
 * ips 为空 → source=dhcp（还原自动获取）；非空 → 首个 static primary，其余 add。
 * validate=no 避免 netsh 同步探测网关导致阻塞/失败。
 */
export function winSetDnsCommands(netshExe: string, iface: string, ips: string[]): string[] {
  if (ips.length === 0) {
    return [`"${netshExe}" interface ipv4 set dnsservers name="${iface}" source=dhcp`];
  }
  const cmds = [
    `"${netshExe}" interface ipv4 set dnsservers name="${iface}" static ${ips[0]} primary validate=no`,
  ];
  for (let i = 1; i < ips.length; i++) {
    cmds.push(
      `"${netshExe}" interface ipv4 add dnsservers name="${iface}" address=${ips[i]} index=${i + 1} validate=no`
    );
  }
  return cmds;
}

/**
 * 解析 `netsh interface ipv4 show dnsservers name="<iface>"` 输出 → 静态 DNS IP 列表。
 * 「DHCP/自动」配置 → []（原始即自动获取，还原走 source=dhcp）。仅在出现「Statically Configured」时取 IP。
 * 注：netsh 输出随系统语言本地化，非英文环境解析可能失准 → Windows 真机待验。
 */
export function parseWinShowDnsServers(stdout: string): string[] {
  if (!/Statically Configured DNS Servers|静态配置的 DNS 服务器/i.test(stdout)) return [];
  const ips = stdout.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
  return dedupe(ips);
}

/**
 * 解析 `netsh interface ipv4 show interfaces` 输出 → 已连接、非 loopback 的接口名列表。
 * 注：netsh 输出本地化 → Windows 真机待验（"connected" 状态串、loopback 名称随语言变化）。
 */
export function parseWinInterfaces(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*\d+\s+\d+\s+\d+\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const state = m[1].toLowerCase();
    const name = m[2].trim();
    if (state !== 'connected') continue;
    if (/loopback/i.test(name)) continue;
    out.push(name);
  }
  return out;
}

/** 私网 IPv4（10/8、172.16/12、192.168/16）——LAN 解析器候选过滤用（私网 IP 经 route 私网直连可达 + 能解内网域名）。 */
export function isPrivateIpv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([m[1], m[2], m[3], m[4]].some((p) => Number(p) > 255)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * 解析 macOS `scutil --dns` 输出里的全部 `nameserver[N] : <ip>`，按出现顺序去重返回。
 * scutil 反映**生效解析器**（含 DHCP 下发的，networksetup -getdnsservers 对 DHCP 返空拿不到）→ 方案B 用它取 LAN 解析器。
 */
export function parseScutilNameservers(stdout: string): string[] {
  const out: string[] = [];
  const re = /nameserver\[\d+\]\s*:\s*(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    const ip = m[1].trim();
    if (ip && !out.includes(ip)) out.push(ip);
  }
  return out;
}

/** 从一段文本里按出现顺序去重提取 IPv4 字面量（Windows `netsh ... show dnsservers` 取生效 DNS 用，含 static/dhcp 行）。 */
export function extractIpv4s(stdout: string): string[] {
  const out: string[] = [];
  const re = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/**
 * 从候选解析器 IP 里挑「可用于内网域名解析的 LAN 解析器」：私网 IPv4 + 排除受控 IP（避免接管残留时挑到 8.8.8.8）。
 * 仅取私网 IPv4——它经 route 私网直连规则可达、能解内网/captive，且供 rule C 直连放行（/32）绕过 hijack 防环。
 * 公网/ISP 解析器、IPv6、link-local 一律不取（off-link 经 TUN 易环、且不一定能解内网）→ 返回 null，调用方退回 dns-local。
 */
export function pickLanResolverIp(
  candidates: string[],
  controlledIp: string = CONTROLLED_TUN_DNS_IP
): string | null {
  for (const raw of candidates) {
    const ip = raw.trim();
    if (ip === controlledIp) continue;
    if (isPrivateIpv4(ip)) return ip;
  }
  return null;
}

/**
 * 防自指：计算「接管前应保存的原始 DNS」。
 *  - 首次接管（无既有 marker）：当前值即原始（即便恰为受控 IP——可能是用户自己就用 8.8.8.8，尊重之）。
 *  - 再次接管（有既有 marker，说明上次未还原/崩溃残留）：若某服务当前 DNS 恰为「仅受控 IP」=我们设的，
 *    回退到既有 marker 里捕获的真实原始值（或 []），杜绝把受控 IP 误存成原始 → 永远还原到受控 IP。
 */
export function computeOriginalToSave(
  current: Record<string, string[]>,
  controlledIp: string,
  existingMarkerOriginal?: Record<string, string[]>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [svc, ips] of Object.entries(current)) {
    const isOurs =
      !!existingMarkerOriginal && ips.length > 0 && ips.every((ip) => ip === controlledIp);
    out[svc] = isOurs ? (existingMarkerOriginal[svc] ?? []) : ips;
  }
  return out;
}

// ─── Linux / systemd-resolved（P2：Linux 侧真正接管链路 DNS）────────────────────────────────

/** `resolvectl dns` / `resolvectl domain` 的单行形态：`Link 5 (tun0): 8.8.8.8 1.1.1.1`（冒号后可为空）。 */
const RESOLVECTL_LINK_LINE = /^Link\s+(\d+)\s+\(([^)]+)\):\s*(.*)$/;

/** 一条链路的 resolvectl 记录。 */
export interface ResolvectlLink {
  ifindex: number;
  name: string;
  /** 冒号后的值按空白切分（DNS 场景是 IP 列表，domain 场景是域名列表）；无值 → []。 */
  values: string[];
}

/**
 * 解析 `resolvectl dns` / `resolvectl domain` 的输出（全量或单链路皆可）。
 * `Global:` 行不产出条目——全局配置不是任何一条链路的属性，混进来会让「按接口取原始值」错位。
 */
export function parseResolvectlLinks(stdout: string): ResolvectlLink[] {
  const out: ResolvectlLink[] = [];
  for (const raw of stdout.split('\n')) {
    const m = RESOLVECTL_LINK_LINE.exec(raw.trim());
    if (!m) continue;
    out.push({
      ifindex: Number(m[1]),
      name: m[2],
      values: m[3].split(/\s+/).filter(Boolean),
    });
  }
  return out;
}

/** 取某条链路的值（找不到 → []，与「该链路无显式配置」同解——两者对接管决策等价）。 */
export function resolvectlLinkValues(stdout: string, iface: string): string[] {
  return parseResolvectlLinks(stdout).find((l) => l.name === iface)?.values ?? [];
}

/**
 * 从 `os.networkInterfaces()` 里按**地址**认出 FlowZ 自己的 TUN 接口。
 *
 * 不按名字认（`tun0` / `utun*`）：Linux 上 `tun0` 可能属于 OpenVPN、WireGuard 或另一个代理客户端，
 * 认错就是把别人的链路 DNS 改掉——这是不可接受的越权，而按地址认是唯一的确定判据（该地址由 FlowZ
 * 自己下发给内核）。地址缺省/找不到 → null，调用方 fail-closed 不接管。
 *
 * @param ifaces `os.networkInterfaces()` 的返回值
 * @param inet4Address TUN 的 IPv4 地址，允许带 CIDR 后缀（`172.19.0.1/16` 与 `172.19.0.1` 同解）
 */
export function pickTunInterfaceByAddress(
  ifaces: Record<string, { address: string; family: string; internal: boolean }[] | undefined>,
  inet4Address: string | null | undefined
): string | null {
  if (!inet4Address) return null;
  const want = inet4Address.split('/')[0].trim();
  if (!want) return null;
  const hits: string[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.internal) continue;
      if (a.family === 'IPv4' && a.address === want) {
        hits.push(name);
        break;
      }
    }
  }
  // 多个接口同址 → 无法确定哪个是自己的（Linux 内核允许同址；另一个 sing-box 系客户端用同一默认网段就会撞）。
  // 此时 fail-closed：宁可不接管，也不能把 DNS 打到别人的链路上。
  return hits.length === 1 ? hits[0] : null;
}

/** `resolvectl dns <iface> <ip...>`。ips 为空 → 调用方应改用 revert，不要下发空 dns。 */
export function resolvectlDnsArgs(iface: string, ips: string[]): string[] {
  return ['dns', iface, ...ips];
}

/**
 * `resolvectl domain <iface> ~.`：把该链路设为**全域路由域**。
 *
 * 没有它，接管只完成一半：resolved 按域名把查询分派到各链路的 scope，未匹配任何搜索域的查询仍会走
 * 原来的链路及其上游。设 `~.` 后所有查询优先走本链路 → 目的地是受控 IP → 经 TUN 被 hijack。
 */
export function resolvectlDomainArgs(iface: string): string[] {
  return ['domain', iface, '~.'];
}

/** `resolvectl revert <iface>`：清掉本链路上的一切人工配置，回到系统（DHCP/NetworkManager）下发值。 */
export function resolvectlRevertArgs(iface: string): string[] {
  return ['revert', iface];
}
