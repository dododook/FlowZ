/**
 * macOS `route -n monitor` 输出行解析（纯函数，无副作用）。
 *
 * 用途：DnsInterfaceWatcher 长驻 `route -n monitor`，逐行喂本函数判定「是否值得触发一次 DNS reconcile 的网络变更」。
 * 命中 → 去抖后调 SystemDnsManager.reconcileDns()，把启动后新出现/换网后未受控的网络服务也接管为受控 DNS。
 *
 * route monitor 的每条消息块以 `got message of size N on <ts>` 起头，后跟一行 `RTM_<TYPE>: <描述>`，再跟若干
 * 缩进的地址/标志明细行。我们只在「接口状态变化 / 地址增删 / 默认路由变化」上触发——这些才意味着链路/解析器可能
 * 已变（插坞站、切 Wi-Fi、VPN 起落）。纯统计行（"got message of size"）与其它噪音/明细行返回 false。
 *
 * 不变量：① 纯函数、无副作用、不抛（畸形/空行/非字符串 → false）；② 只看类型，不解析地址（解析地址非本判定所需，
 * 且各平台/本地化输出差异大，徒增误判面）。设计见 docs/design/dns-takeover-dynamic-interface.md §四 4.2。
 */

/**
 * route monitor 中「值得触发 reconcile」的消息类型：
 * - RTM_IFINFO：接口 up/down（插拔网卡、Wi-Fi 开关、坞站以太网上下线）。
 * - RTM_NEWADDR / RTM_DELADDR：接口地址增删（DHCP 续约换 IP、IPv6 SLAAC 增删、VPN 虚拟地址起落）。
 * - RTM_ADD / RTM_DELETE：路由增删（尤其默认路由切换 = 出口/解析器可能整体易主）。
 *
 * 注：RTM_IFINFO2 / RTM_NEWADDR2 等带数字后缀的变体也命中（前缀匹配），覆盖 macOS 不同版本的 sysctl 风格变体。
 */
const TRIGGER_RTM_TYPES = [
  'RTM_IFINFO',
  'RTM_NEWADDR',
  'RTM_DELADDR',
  'RTM_ADD',
  'RTM_DELETE',
] as const;

/**
 * 判定单行 `route -n monitor` 输出是否表示「值得触发 DNS reconcile 的网络变更」。
 *
 * 命中：行内出现上述 RTM_ 触发类型（位于行首或紧跟空白后，形如 `RTM_IFINFO: ...`）。
 * 不命中：纯统计行（"got message of size ..."）、地址/标志明细行、空行、畸形行、非字符串。
 *
 * @param line route monitor 的单行文本（可含前后空白）。
 * @returns true=值得 reconcile；false=噪音/无关/非法。永不抛。
 */
export function isDnsReconcileTriggerLine(line: string): boolean {
  if (typeof line !== 'string') return false;
  const trimmed = line.trim();
  if (!trimmed) return false;

  // "got message of size N on <ts>" 是每条消息块的统计头 —— 高频噪音，显式排除（防 RTM_ 前缀误判时的兜底）。
  if (trimmed.startsWith('got message of size')) return false;

  // 取首 token（RTM 类型行形如 `RTM_IFINFO: <flags>`；冒号/空白分隔）。明细行首 token 是地址族/标志名，不会以 RTM_ 起。
  const firstToken = trimmed.split(/[\s:]/, 1)[0];
  // 前缀匹配：覆盖 RTM_IFINFO2 / RTM_NEWADDR2 等带数字后缀的版本变体；非触发类型（RTM_GET/RTM_LOSING/RTM_MISS 等）不命中。
  return TRIGGER_RTM_TYPES.some((t) => firstToken === t || firstToken.startsWith(t));
}

/**
 * 判定单行 Linux `ip -o monitor link addr route` 输出是否表示链路变化（issue #368）。
 *
 * **有意不做类型过滤**，非空行即命中。理由：
 *  - 我们只订阅了 `link addr route` 三类对象，内核在这三类上推送的每一条都确实是链路/地址/路由变化，
 *    没有 macOS `route -n monitor` 那种「统计头 + 明细行」的噪音结构需要剔除；
 *  - iproute2 的输出格式随版本漂移（有无 `[LINK]` 标签、`Deleted ` 前缀、`-o` 折行），写正则去认类型
 *    是把一个会腐坏的判据放进热路径。实测（iproute2 单接口 up/down/addr 增删/默认路由增删）一次接口
 *    变化会推送 10+ 行（含 local/broadcast/multicast/fe80 自动路由），**靠去抖合并 burst、靠调用方的
 *    最小间隔限频，比靠正则挑行更健壮**；
 *  - 判据宽于意图的代价在这里是「多刷一次缓存」，而刷缓存本身幂等且廉价；判据窄于意图的代价是漏刷，
 *    正是 issue #368 要修的东西。两侧代价不对称，故取宽。
 *
 * @param line `ip -o monitor` 的单行文本。
 * @returns true=值得触发；false=空行/非字符串。永不抛。
 */
export function isLinuxLinkChangeLine(line: string): boolean {
  if (typeof line !== 'string') return false;
  return line.trim().length > 0;
}

/** 平台对应的链路事件源规格（ProxyManager 薄接线层消费；抽成纯函数以便单测覆盖三平台分流）。 */
export interface LinkMonitorSpec {
  /** 长驻监听命令。null = 该平台无可用事件源，只能靠轮询（Windows）。 */
  command: { file: string; args: string[] } | null;
  /** 单行输出 → 是否算一次「值得去看一眼」的信号。command 为 null 时不会被调用。 */
  isTriggerLine: (line: string) => boolean;
  /** 指纹轮询间隔（ms）。0 = 不轮询（有事件源的平台）。 */
  pollIntervalMs: number;
  /**
   * 事件源**进程死亡后**降级启用的轮询间隔（ms）。0/缺省 = 不降级。
   * 长驻监听进程被 OOM / 误杀 / 自身崩溃后，该平台的链路变化就再也探不到，且此前无任何自曝手段——
   * 「没执行」必须自曝，故死亡即降级到轮询并留一条 warn。
   */
  fallbackPollIntervalMs?: number;
}

/** 事件源死亡后的降级轮询间隔。取 60s：与 link-change 限频同量级，降级态不该比正常态更吵。 */
export const FALLBACK_POLL_INTERVAL_MS = 60_000;

/**
 * 按平台解析链路事件源（issue #368）。
 *
 * - darwin：`route -n monitor`，挑 RTM_ 类型行。
 * - linux：`ip -o monitor link addr route`，`-o` 保证每条消息单行（免跨 chunk 折行拼接的误判面）。
 *   `ip` 在部分发行版（Fedora < 42 等）位于 `/usr/sbin` 而桌面会话 PATH 未必包含它——本仓
 *   PlatformPrivilegeService 对 `setcap` 已承认并处理过同一个坑，故此处同样优先绝对路径。
 * - win32：**无等价的链路事件源**。退化为指纹轮询——powerMonitor 的 resume 只覆盖睡眠唤醒，
 *   换网/插拔在 Windows 上不发 resume，只靠它会让 issue #368 在该平台形同未修。
 * - 其余平台：null（既无事件源也无轮询价值）。
 *
 * @param platform process.platform
 * @param fileExists 绝对路径存在性判定（注入便于单测；真实实现 = fs.existsSync）
 */
export function resolveLinkMonitorSpec(
  platform: NodeJS.Platform,
  fileExists: (p: string) => boolean
): LinkMonitorSpec | null {
  if (platform === 'darwin') {
    return {
      command: { file: 'route', args: ['-n', 'monitor'] },
      isTriggerLine: isDnsReconcileTriggerLine,
      pollIntervalMs: 0,
      fallbackPollIntervalMs: FALLBACK_POLL_INTERVAL_MS,
    };
  }
  if (platform === 'linux') {
    return {
      command: {
        file: fileExists('/usr/sbin/ip') ? '/usr/sbin/ip' : 'ip',
        args: ['-o', 'monitor', 'link', 'addr', 'route'],
      },
      isTriggerLine: isLinuxLinkChangeLine,
      pollIntervalMs: 0,
      fallbackPollIntervalMs: FALLBACK_POLL_INTERVAL_MS,
    };
  }
  if (platform === 'win32') {
    // 30s：换网后用户等半分钟内恢复可接受，而指纹计算是纯用户态的 os.networkInterfaces()，开销可忽略。
    return { command: null, isTriggerLine: () => false, pollIntervalMs: 30_000 };
  }
  return null;
}
