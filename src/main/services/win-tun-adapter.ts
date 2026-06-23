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

/**
 * 探测 Windows 上是否仍存在名为 `name` 的网卡（设备级，零提权）。
 * 命中 → true；查不到 / PowerShell 失败 / 超时 → false（宁判「已释放」放行，绝不卡死启动）。
 */
export function probeWinTunAdapterPresent(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    // -Name 精确匹配（PS 单引号内 '' 转义防注入）；命中输出网卡名，未命中经 SilentlyContinue 吞错→空输出。
    const psName = name.replace(/'/g, "''");
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-NetAdapter -Name '${psName}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name`,
      ],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(false); // 查询失败 → fail-open（按已释放处理）
        resolve(
          String(stdout)
            .split(/\r?\n/)
            .some((line) => line.trim() === name)
        );
      }
    );
  });
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
