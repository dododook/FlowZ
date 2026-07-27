/**
 * Windows TUN（wintun）适配器释放探测与门控（issue #159）。
 *
 * 根因：服务模式 CTRL_BREAK 恒 no-op → 旧 sing-box 被硬杀、不自拆 wintun → 适配器滞留；新核撞同名网卡
 * `open interface take too much time` 而退。修复=起核前等本名（flowz-tun0）网卡真消失再放行。
 *
 * 设计要点：
 *  - 设备级、按名匹配（非按地址）：杜绝与外部 sing-box / 用户手动核 / 自家孤儿核的同址网卡混淆。
 *  - 零提权：Get-NetAdapter 普通用户即可查。
 *  - fail-open：探测失败 / 超时仍在 → 放行启动（绝不卡死代理），残留由启动 retry 兜底。
 *  - 纯逻辑 waitForAdapterReleased 注入 probe/sleep，便于无真实计时器/无真实网卡的单测。
 */
import { execFile } from 'child_process';
import { powershellPath } from '../utils/win-system32';
import type { AddressUsage } from '../../shared/tun-address';

/** 哨兵首行：脚本跑到这一行 == 探测链路可用（cmdlet 存在、模块加载成功、PS 未被拦）。 */
const PROBE_SENTINEL = 'PROBE_OK';

/** runPsProbe 结果。`ok=false` 表示探测链路本身不可用（调用方一律落 unknown / fail-open）。 */
interface PsProbeResult {
  /** 拿到哨兵 == 查询确实执行了；据此可把「查询成功且为空」与「查不了」区分开。 */
  ok: boolean;
  /** 哨兵之后的输出行（已 trim、已去空行）。 */
  lines: string[];
}

/**
 * 跑一段 PowerShell 探测管道，把「探测链路可用」与「查询结果为空」区分开。
 *
 * **为什么不能直接 `-Command <cmdlet ... -ErrorAction SilentlyContinue>`**（原实现，issue #324 真机实测推翻）：
 * `-ErrorAction SilentlyContinue` 只抑制错误的**显示**，不改 `$?`——查不到对象时 `powershell.exe` 退出码仍是 **1**。
 * Node `execFile` 据此把 `err` 置非 null，于是「查询成功且结果为空」（= absent / free，本模块最需要的那个结论）
 * 被整片吞成 `unknown`。真机实测（Windows 11 26200）：
 *   `Get-NetIPAddress -IPAddress <空闲地址>` → exit=1 stdout 空；`Get-NetAdapter -Name <不存在>` → exit=1 stdout 空。
 * 后果是三条门在真实 Windows 上全部恒 fail-open：#159 释放门恒放行、#324 正向就绪门 `sawAbsent` 恒 false、
 * #324 地址冲突预检永远返不出 `free`（候选池逐个落 unverified → `exhausted` → 退回被占用的首选地址，避让完全失效）。
 * 单测把 `execFile` 整个替换成桩，从未验过这条真实契约，故 4 轮 review + 38 条变异全绿仍漏。
 *
 * 现在：脚本自己 `exit 0`，把「探测链路可用」用哨兵首行显式表达，结论完全由 stdout 承载；退出码只用来兜
 * **真正的**执行失败（PS 缺失 / 被杀软拦 / 超时）。终止性错误（模块加载失败、cmdlet 不存在）落 catch → 无哨兵 → 同样 unknown。
 *
 * **哨兵不能无条件发**——这是第二个真机实测才看清的坑。`-ErrorAction SilentlyContinue` 吞掉的是**非终止性**错误，
 * 它们不进 catch，管道照样空。若此时照发哨兵，「目标确实不存在」与「查询根本没跑通」就被合并成同一个结论 `absent`/`free`，
 * 后果比原缺陷更糟：CIM/WMI 被 EDR 拦住的**健康**机器会被判成「TUN 网卡从未创建」→ `absent-timeout` → 硬闸 stopCore
 * → 三腿耗尽 → `CoreStartTunPersistentError` 永久拒连。旧实现靠退出码 1 把这两类一起归进 `unknown`（fail-open，
 * 安全但门失效），两者都不对。真机实测（`$Error` 的 CategoryInfo）显示这两类明确可分：
 *   地址空闲 / 网卡不存在 → `ObjectNotFound`（`CmdletizationQuery_NotFound_*`）；CIM 会话不可用 → `ResourceUnavailable`。
 * 故哨兵的发放条件是「零错误，或被吞的错误**全部**是 ObjectNotFound」。
 *
 * 脚本经 `-EncodedCommand`（UTF-16LE base64）传入，消掉命令行层的转义面；PowerShell 语法层仍靠调用方的
 * 单引号转义 + 输入校验（IP 正则 / 网卡名字符集）把关。
 *
 * **stdout 只可用来比对 ASCII**：中文 Windows 的 PowerShell 按 OEM codepage（936）写 stdout，Node execFile
 * 默认按 utf8 解码 → 非 ASCII 输出必成乱码（真机实测：网卡名「以太网」回传即乱码）。本模块的比对对象全是
 * ASCII——IP 字面量、受 resolveWinTunInterfaceName 限制在 [A-Za-z0-9_-] 的自家网卡名、哨兵本身——故不受影响。
 * 若将来要拿它比对用户可自定义的中文网卡名/别名，必须先在脚本里 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`。
 */
function runPsProbe(pipeline: string): Promise<PsProbeResult> {
  const script = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$Error.Clear()`,
    `try {`,
    `  $r = @(${pipeline})`,
    `  if (@($Error | Where-Object { $_.CategoryInfo.Category -ne 'ObjectNotFound' }).Count -eq 0) {`,
    `    Write-Output '${PROBE_SENTINEL}'`,
    `    foreach ($x in $r) { Write-Output $x }`,
    `  }`,
    `} catch { }`,
    `exit 0`,
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ ok: false, lines: [] });
        const lines = String(stdout)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        const at = lines.indexOf(PROBE_SENTINEL);
        // 无哨兵 = 脚本没跑到那一行（终止性错误）或输出被截断 → 按探测失败处理，绝不当成「查询为空」。
        if (at < 0) return resolve({ ok: false, lines: [] });
        resolve({ ok: true, lines: lines.slice(at + 1) });
      }
    );
  });
}

/**
 * 探测 Windows 上是否仍存在名为 `name` 的网卡（设备级，零提权）。#159 反向释放门用。
 * 命中 → true；查不到 / PowerShell 失败 / 超时 → false（宁判「已释放」放行，绝不卡死启动）。
 * 委托三态版 `probeWinTunAdapterPresence`（单一 Get-NetAdapter 实现，杜绝两处漂移，issue #324 review Low#3）：
 * present→true；absent/unknown 皆→false，正是本方向的 fail-open 语义（探测失败=按「已释放」放行）。
 */
export function probeWinTunAdapterPresent(name: string): Promise<boolean> {
  return probeWinTunAdapterPresence(name).then((p) => p === 'present');
}

/** waitForAdapterReleased 注入依赖（单测可替换为桩，零真实计时器/网卡）。 */
export interface AdapterWaitDeps {
  probe: (name: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
}

/** 等待结果：released=true 已确认网卡消失；false=超时仍在（调用方放行交 retry）。polls=实际探测次数。 */
export interface AdapterWaitResult {
  released: boolean;
  polls: number;
}

/**
 * 有界轮询等名为 `name` 的网卡消失。早退：一旦探测到消失立即返回。
 * maxPolls = ceil(timeoutMs/pollMs)，每轮 probe→（仍在则）sleep；循环末再 probe 一次覆盖最后窗口。
 */
export async function waitForAdapterReleased(
  name: string,
  opts: { timeoutMs: number; pollMs: number },
  deps: AdapterWaitDeps
): Promise<AdapterWaitResult> {
  const pollMs = Math.max(1, opts.pollMs);
  const maxPolls = Math.max(1, Math.ceil(opts.timeoutMs / pollMs));
  for (let i = 0; i < maxPolls; i++) {
    if (!(await deps.probe(name))) return { released: true, polls: i + 1 };
    await deps.sleep(pollMs);
  }
  // 末轮 sleep 后再确认一次（覆盖最后一个 pollMs 窗口内刚释放的情形）。
  if (!(await deps.probe(name))) return { released: true, polls: maxPolls + 1 };
  return { released: false, polls: maxPolls + 1 };
}

// ============================================================================
// issue #324：正向 TUN 就绪验证（等自家 wintun 适配器「出现」，#159 反向门的镜像）。
// ============================================================================

/**
 * 适配器存在性三态（issue #324 正向门用）。
 *  - `present`：查到本名网卡；
 *  - `absent`：查询成功但无此网卡（证明 Get-NetAdapter 可用 → 可据此判「从未创建」）；
 *  - `unknown`：探测本身失败（PowerShell 缺/被杀软拦/超时）→ fail-open 信号，绝不据此判终态失败。
 * 与布尔版 probeWinTunAdapterPresent 的区别：后者把 absent/unknown 都塌成 false（#159 反向门 fail-open=false 正确）；
 * 正向门必须区分「确实没有」与「查不了」——否则杀软拦 PS 的机器会被误判成持续性 TUN 失败。
 */
export type AdapterPresence = 'present' | 'absent' | 'unknown';

/**
 * 三态探测名为 `name` 的网卡是否存在（issue #324）。与 probeWinTunAdapterPresent 同一 Get-NetAdapter 机制，
 * 仅返回值语义更细：err（spawn/执行失败）→ 'unknown'；命中本名 → 'present'；查询成功但空 → 'absent'。
 */
export function probeWinTunAdapterPresence(name: string): Promise<AdapterPresence> {
  const psName = name.replace(/'/g, "''");
  // 哨兵在、命中本名 → present；哨兵在、无命中 → absent（查询确实跑过，可据此判「从未创建」）；
  // 哨兵不在 → unknown（fail-open）。见 runPsProbe 头注：退出码不再参与「空结果」判定。
  return runPsProbe(
    `Get-NetAdapter -Name '${psName}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name`
  ).then((r) => {
    if (!r.ok) return 'unknown';
    return r.lines.some((line) => line === name) ? 'present' : 'absent';
  });
}

/** waitForAdapterPresent 注入依赖（单测可替换为桩；probe 可抛错，内部按 unknown/fail-open 处理）。 */
export interface AdapterPresenceWaitDeps {
  probe: (name: string) => Promise<AdapterPresence>;
  sleep: (ms: number) => Promise<void>;
  /**
   * issue #176/#324 High#1：本腿是否已被更新的 start/stop 接管（可选；缺省视作未接管）。每轮先判——接管后本腿继续
   * 验适配器/停核/发 started 都会抢放接管方的核，故立即让位（outcome='superseded'），调用方绝不 stopCore/emit started。
   */
  isSuperseded?: () => boolean;
}

/**
 * 正向等待结果：
 *  - `present`：确认网卡出现（硬闸放行）；
 *  - `absent-timeout`：预算内**曾拿到过 clean absent** 但网卡始终未出现（Get-NetAdapter 可用 → 判「从未创建」，硬闸失败本腿）；
 *  - `unknown`：预算内探测从未给出 clean 结论（全 unknown/抛错）→ fail-open 放行（绝不据此判终态失败）；
 *  - `superseded`：等待期被更新的 start/stop 接管（#176）→ 让位（不 present/不 absent-timeout，调用方不 stopCore、不 emit started）。
 * polls = 实际探测次数。
 */
export interface AdapterPresentResult {
  outcome: 'present' | 'absent-timeout' | 'unknown' | 'superseded';
  polls: number;
}

/**
 * 有界轮询等名为 `name` 的网卡「出现」（issue #324，镜像 waitForAdapterReleased/waitForCoreReady 结构）。
 * 每轮先判 isSuperseded（被接管即让位，#176 纪律）；present 立即早退；probe 抛错/返回 unknown → 不早退但记；
 * 查得 absent → 记 sawAbsent（证明 PS 可用）。预算耗尽仍未 present：sawAbsent → 'absent-timeout'（可据此硬闸/判持续性）；
 * 否则（只见过 unknown）→ 'unknown'（fail-open）。一次 clean absent 即证明探测链路可用，压过零星 unknown。
 */
export async function waitForAdapterPresent(
  name: string,
  opts: { timeoutMs: number; pollMs: number },
  deps: AdapterPresenceWaitDeps
): Promise<AdapterPresentResult> {
  const pollMs = Math.max(1, opts.pollMs);
  const maxPolls = Math.max(1, Math.ceil(opts.timeoutMs / pollMs));
  // 一次 clean absent 即证明 Get-NetAdapter 探测链路可用；据此把「确实没建起」（→ 硬闸/终态）与「探测本身失败」
  // （全 unknown → fail-open）区分开。零星 unknown 被一次 clean absent 压过。
  let sawAbsent = false;
  const step = async (): Promise<AdapterPresence> => {
    try {
      return await deps.probe(name);
    } catch {
      return 'unknown'; // probe 抛错 → fail-open（按 unknown 处理，绝不据此判失败）
    }
  };
  for (let i = 0; i < maxPolls; i++) {
    if (deps.isSuperseded?.()) return { outcome: 'superseded', polls: i }; // #176：接管先于一切，立即让位
    const p = await step();
    if (p === 'present') return { outcome: 'present', polls: i + 1 };
    if (p === 'absent') sawAbsent = true;
    await deps.sleep(pollMs);
  }
  if (deps.isSuperseded?.()) return { outcome: 'superseded', polls: maxPolls };
  // 末轮 sleep 后再确认一次（覆盖最后一个 pollMs 窗口内刚出现的情形）。
  const last = await step();
  if (last === 'present') return { outcome: 'present', polls: maxPolls + 1 };
  if (last === 'absent') sawAbsent = true;
  return { outcome: sawAbsent ? 'absent-timeout' : 'unknown', polls: maxPolls + 1 };
}

/**
 * issue #324 分类 tracker：单次 start 内、跨所有重试腿 sticky 累计的适配器观测。
 *  - adapterEverSeen：任一腿曾观测到适配器出现（→ 瞬态释放竞态族 #159/#176）。
 *  - probeEverConclusive：探测链路曾给出 clean 结论（present/absent）——排除全 unknown（杀软拦 PowerShell）误判终态。
 */
export interface TunAdapterObservation {
  adapterEverSeen: boolean;
  probeEverConclusive: boolean;
}

/**
 * 把一次探测结果并入 sticky tracker（**monotonic：只置 true、永不复位**——保证跨重试腿累计，一腿见过后续腿死也判瞬态）。
 * present → adapterEverSeen + probeEverConclusive；absent → probeEverConclusive；unknown → 不动（fail-open，不作数）。
 */
export function recordAdapterPresence(obs: TunAdapterObservation, p: AdapterPresence): void {
  if (p === 'present') {
    obs.adapterEverSeen = true;
    obs.probeEverConclusive = true;
  } else if (p === 'absent') {
    obs.probeEverConclusive = true;
  }
}

/**
 * issue #324 终态判据：给定跨腿 sticky tracker，判是否「持续性 TUN init 失败」（vs 瞬态释放竞态）。
 * **true ⟺ 全程未见适配器（!adapterEverSeen）且探测链路曾给出 clean 结论（probeEverConclusive）**。
 *  - 曾见适配器 → 瞬态（false，#159/#176 族，照旧重试语义）。
 *  - 探测全 unknown（!probeEverConclusive，杀软拦 PS）→ fail-open 瞬态（false，绝不据此判终态）。
 * 调用方：dead 分支文案细分（A3）+ 预算耗尽终态转化（A2）共用同一判据，避免两处漂移。
 */
export function isPersistentTunFailure(obs: TunAdapterObservation): boolean {
  return !obs.adapterEverSeen && obs.probeEverConclusive;
}

// ============================================================================
// issue #324：TUN IPv4 地址占用探测（起核前冲突预检用，见 shared/tun-address.ts）。
// ============================================================================

/**
 * 探测某个裸 IPv4 是否已存在于本机任一接口（Windows，零提权）。
 *
 * **必须走 Get-NetIPAddress，不能用 os.networkInterfaces()**：后者（libuv `uv_interface_addresses`）在
 * Windows 上跳过 `OperStatus != IfOperStatusUp` 的适配器，而 #324 的冲突源正是一张 **Disconnected** 的
 * TAP-Windows 适配器——地址条目仍在系统 IP 表里占位（AddressState=Tentative）、照样让
 * `CreateUnicastIpAddressEntry` 返回 ERROR_OBJECT_ALREADY_EXISTS，但 Node 的接口枚举完全看不到它。
 * Get-NetIPAddress 查的是 IP 地址表本身，不受接口 OperStatus 限制（#324 报告者机器实证命中）。
 *
 * 三态语义与 probeWinTunAdapterPresence 一致：err（PS 缺/被拦/超时）→ 'unknown'（fail-open，绝不据此换地址）。
 */
export function probeWinIpv4AddressUsage(
  ip: string,
  excludeInterfaceAlias?: string
): Promise<AddressUsage> {
  // 纵深防御：调用方只传候选池常量，但仍拒绝非法字面量（PowerShell 命令拼接面）。
  if (!/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(ip)) return Promise.resolve('unknown');
  // **必须排除自家 TUN 接口**：预检跑在 startInternal，**早于** #159 的适配器释放门（在 startSingBoxProcess
  // 顶部）。节点切换重启 / 崩溃自动重启时，上一个核的 wintun 适配器连同它的地址条目还滞留着（#159 的存在
  // 本身就是这个滞留的证据）→ 不排除就会把自家残留判成「别人占用」→ 换地址；下次重启地址已释放 → 换回。
  // 地址在重启之间乒乓漂移，恰好造成避让机制声称要避免的代价（用户钉着旧地址的规则失效），且日志会把
  // 自家残留误导性归因为「其它 VPN 客户端」。别名经 resolveWinTunInterfaceName 校验（仅 [A-Za-z0-9_-]），
  // 单引号转义后无注入面。
  const aliasFilter = excludeInterfaceAlias
    ? ` | Where-Object { $_.InterfaceAlias -ne '${excludeInterfaceAlias.replace(/'/g, "''")}' }`
    : '';
  // 哨兵在、命中该地址 → in-use；哨兵在、无命中 → free（**这条是避让机制的全部价值所在**：旧实现因退出码 1
  // 恒落 unknown，候选池永远给不出 free，冲突时经 exhausted 退回被占用的首选地址）。哨兵不在 → unknown。
  return runPsProbe(
    `Get-NetIPAddress -IPAddress '${ip}' -ErrorAction SilentlyContinue${aliasFilter} | Select-Object -ExpandProperty IPAddress`
  ).then((r) => {
    if (!r.ok) return 'unknown';
    return r.lines.some((line) => line === ip) ? 'in-use' : 'free';
  });
}
