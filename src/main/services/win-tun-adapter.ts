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
  return new Promise((resolve) => {
    const psName = name.replace(/'/g, "''");
    execFile(
      powershellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-NetAdapter -Name '${psName}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name`,
      ],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        // err = PowerShell spawn/执行失败（PS 缺/被拦/超时）→ unknown（fail-open）。
        // -ErrorAction SilentlyContinue 使「网卡不存在」不报错、输出为空 → 落 'absent'（证明 PS 本身可用）。
        if (err) return resolve('unknown');
        const hit = String(stdout)
          .split(/\r?\n/)
          .some((line) => line.trim() === name);
        resolve(hit ? 'present' : 'absent');
      }
    );
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
