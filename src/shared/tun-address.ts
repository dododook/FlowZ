/**
 * TUN 接口 IPv4 地址的冲突避让（issue #324）。
 *
 * 背景：FlowZ 的 TUN 地址长期硬编码 `172.19.0.1`（Windows /16、macOS /30），起核前不做任何冲突检测。
 * #324 报告者机器上有一张残留的 TAP-Windows 适配器（Disconnected）被人工配了 `172.19.0.1/29`，Windows
 * 要求单播地址在同一 network compartment 内唯一，sing-box 给自家虚拟网卡配同一地址时
 * `CreateUnicastIpAddressEntry` 返回 ERROR_OBJECT_ALREADY_EXISTS → TUN inbound 起不来 → 进程 FATAL 自杀
 * → 外层无限重试。用户没有任何自救手段（该地址当时不可配置）。
 *
 * 本模块是纯逻辑（探测经 deps 注入），选出本次起核实际下发的 TUN 地址。
 *
 * **fail-open 纪律**：探测链路不可用（杀软拦 PowerShell 等）时绝不阻断启动、也绝不乱换地址——沿用默认地址
 * 照常起核。换地址本身有代价（用户的自定义路由/防火墙规则可能钉着旧地址），只在**确证**冲突时才换。
 * 这与 #159 释放门控、#324 正向适配器门的 fail-open 同源。
 */
import { cidrOverlapsAny } from './ip';

/**
 * TUN IPv4 地址候选池（按序尝试）。
 *
 * 选段理由：
 * - `172.19.0.1` —— 历史默认，与 sing-box 上游默认同段，保持不变以免影响绝大多数正常机器。
 * - `172.20.0.1` / `172.31.0.1` —— 同在 RFC 1918 的 172.16/12 内，与家用 LAN 常用的 192.168/16、10/8
 *   不相交。172.16/12 段里 Docker Desktop 会占用 172.17–172.31 的一部分，故给两个候选而非一个；
 *   真撞上会被预检跳过（候选池的长度比单个候选的选择更重要）。
 * - `10.255.255.1` —— 最后兜底。10/8 与企业 LAN 撞车的先验最高，故排在最后。
 *
 * 候选池顺序在真实用户环境里的撞车概率未量化，后续可按反馈调整（设计 doc §8-6 已登记）。
 */
export const TUN_INET4_CANDIDATES = [
  '172.19.0.1',
  '172.20.0.1',
  '172.31.0.1',
  '10.255.255.1',
] as const;

/**
 * 某个 IPv4 地址在本机的占用状态。
 * - `in-use`：查询成功且该地址已存在于本机某个接口（含 Disconnected/隐藏接口）；
 * - `free`：查询成功且不存在（证明探测链路可用 → 可据此放心使用）；
 * - `unknown`：探测本身失败 → fail-open 信号，绝不据此换地址。
 */
export type AddressUsage = 'in-use' | 'free' | 'unknown';

/**
 * `os.networkInterfaces()` 的返回值里是否已存在该 IPv4。
 *
 * 抽成纯函数是因为 family 字段有版本漂移：Node ≥18 给 `'IPv4'` 字符串，更早给数字 `4`。只认一种，换运行时
 * 就会静默失效——探测恒返回「未占用」，冲突预检整个变成摆设而没有任何报错。
 *
 * 注意它只覆盖 **OperStatus=Up** 的接口（libuv 的 uv_interface_addresses 在 Windows 上跳过非 Up 适配器），
 * 故 Windows 必须走 Get-NetIPAddress，不能用它——#324 的冲突源正是一张 Disconnected 的适配器。
 */
export function ipv4InInterfaceMap(
  ip: string,
  ifaces: Record<string, Array<{ family: string | number; address: string }> | undefined>
): boolean {
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if ((a.family === 'IPv4' || a.family === 4) && a.address === ip) return true;
    }
  }
  return false;
}

/**
 * 从「本机接口网段」里剔除**自家 TUN** 的条目（issue #324 H1）。
 *
 * 判据：主机地址正好等于候选池里的某一个 —— 只有我们自己配的 TUN 会用这些地址。为什么必须剔：地址预检跑在
 * `startInternal`，**早于** #159 的适配器释放门（在 `startSingBoxProcess` 顶部），节点切换/崩溃重启时上一个核
 * 的 TUN 还挂着 `172.19.0.1` → own-lan 检查命中自家残留 → 换地址；下次重启它已释放 → 换回，地址在重启之间
 * 乒乓漂移，恰好造成避让机制声称要避免的代价。
 *
 * 真冲突方（如 #324 那张手工配了 172.19.0.1 的 TAP）也会被这条一并剔出 own-lan 清单，但它由 `probe` 的
 * `in-use` 判据抓住 —— 两道检查职责不同，不漏。
 */
export function excludeOwnTunCidrs(cidrs: string[], candidates: readonly string[]): string[] {
  return cidrs.filter((c) => !candidates.includes(c.split('/')[0]));
}

export interface TunAddressPickDeps {
  /** 探测某个裸 IPv4 是否已被本机占用。 */
  probe: (ip: string) => Promise<AddressUsage>;
  /** 本机各接口的网段（用于避开与物理 LAN 相交的候选）。 */
  ownLanCidrs: () => string[];
}

/**
 * 选择结果。
 * - `default`：默认候选探测为 free，正常放行。**也用于 carry-over**——调用方在「旧核仍在跑、跳过探测」时
 *   沿用上次已选定的地址（可能是备选段），复用本 reason 表示「这不是一次新的避让决策，只是延续既有选择」，
 *   使调用方零日志。故 `reason === 'default'` **不蕴含** `address === candidates[0]`；
 * - `default-unverified`：默认候选探测 unknown（探测链路不可用）→ fail-open 沿用默认；
 * - `fallback`：默认候选确证冲突，已换到备选；
 * - `exhausted`：所有候选都被排除 → 仍回落默认（绝不阻断启动，让核去报真实错误，由 P0-1 的 FATAL 解析上屏）。
 */
export interface TunAddressPick {
  /** 选定的裸 IPv4（不含掩码，掩码由调用方按平台拼）。 */
  address: string;
  reason: 'default' | 'default-unverified' | 'fallback' | 'exhausted';
  /**
   * 被跳过的候选及原因，供日志说明「为什么换了地址」。
   * `unverified` = 探测链路对该候选给不出结论（只可能出现在非首个候选上：首个候选 unknown 直接 fail-open 沿用）。
   * 记它是为了让 exhausted 日志能区分「确证冲突」与「探不了」——只说「全部不可用」会读成前者。
   */
  skipped: Array<{ address: string; cause: 'in-use' | 'own-lan' | 'unverified' }>;
}

/**
 * 按候选池顺序选出可用的 TUN IPv4 地址。
 *
 * 每个候选两道检查：
 *  1. 与本机接口网段相交 → 跳过（把 TUN 地址放进物理 LAN 段内会让该段的真实主机不可达）；
 *  2. probe 判 `in-use` → 跳过（这是 #324 的直接病因）。
 *
 * probe 返回 `unknown` 时的处理按候选位置分叉：**首个候选**（= 默认地址）unknown → 直接沿用（fail-open，
 * 不换地址）；**后续候选** unknown → 保守跳过（既然已经确证默认地址冲突、必须换，就只换到能确证可用的地址上，
 * 否则等于把一次已知冲突换成一次未知冲突）。
 */
export async function pickTunInet4Address(
  candidates: readonly string[],
  deps: TunAddressPickDeps
): Promise<TunAddressPick> {
  const fallbackAddress = candidates[0];
  const skipped: TunAddressPick['skipped'] = [];
  // 本模块跑在起核关键路径上：注入实现抛错绝不能阻断启动（那是拿一个诊断增强换掉整个代理可用性）。
  // 取不到本机网段 → 视作无约束，交由下面的占用探测把关。
  let lanCidrs: string[];
  try {
    lanCidrs = deps.ownLanCidrs();
  } catch {
    lanCidrs = [];
  }

  for (let i = 0; i < candidates.length; i++) {
    const ip = candidates[i];
    // /32 与本机接口网段做家族感知相交判定。
    if (cidrOverlapsAny(`${ip}/32`, lanCidrs)) {
      skipped.push({ address: ip, cause: 'own-lan' });
      continue;
    }
    // 同上：probe 抛错按 unknown 处理（fail-open），不让异常穿透到起核流程。
    const usage = await deps.probe(ip).catch((): AddressUsage => 'unknown');
    if (usage === 'free') {
      return { address: ip, reason: i === 0 ? 'default' : 'fallback', skipped };
    }
    if (usage === 'unknown') {
      // 首个候选探不了 → fail-open 用它；后续候选探不了 → 不冒险，继续往下找能确证的（并记原因）。
      if (i === 0) return { address: ip, reason: 'default-unverified', skipped };
      skipped.push({ address: ip, cause: 'unverified' });
      continue;
    }
    skipped.push({ address: ip, cause: 'in-use' });
  }

  return { address: fallbackAddress, reason: 'exhausted', skipped };
}
