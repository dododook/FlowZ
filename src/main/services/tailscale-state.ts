/**
 * Tailscale 登录态求真（Phase 1）：state_directory 是登录态的单一真值。
 *
 * 交互登录（无 auth_key）产出的是 `<userData>/tailscale/<serverId>` 下的会话文件，而非 authKey。
 * 故「已登录」= `hasAuthKey || tailscaleStateExists(id)`，与日志等级、是否选中为出口完全解耦。
 *
 * 原为 singbox-outbound-builder.ts 内部函数，抽到此独立模块以便：
 * 1) IPC handler / ProxyManager 轮询复用同一真值判定（避免漂移成两套逻辑）；
 * 2) 纯逻辑单测（目录空/不存在→false，有文件→true）。
 * singbox-outbound-builder.ts 改为 import 复用，行为字节级不变（config-snapshot 不变）。
 */

import * as path from 'path';
import { getUserDataPath } from '../utils/paths';

/** Tailscale state 目录：`<userData>/tailscale/<serverId>`，跨重启免重认证、删节点时清理。 */
export function tailscaleStateDir(serverId: string): string {
  return path.join(getUserDataPath(), 'tailscale', serverId);
}

/** state 目录存在且非空 → 已有持久登录会话。缺失/空/读失败 → false（失败安全）。 */
export function tailscaleStateExists(serverId: string): boolean {
  try {
    // readdirSync 在目录缺失时抛 ENOENT → catch 返 false，无需先 existsSync（省一次 stat）。
    return require('fs').readdirSync(tailscaleStateDir(serverId)).length > 0;
  } catch {
    return false;
  }
}

/** 登录成功轮询参数（注入式，便于单测：check/sleep 可替换为假实现，不依赖真实文件系统/定时器）。 */
export interface PollLoginOptions {
  /** 单次判定「是否已登录」（默认 tailscaleStateExists(serverId)）。返回 true 即判成功。 */
  check: () => boolean | Promise<boolean>;
  /** 轮询间隔（ms）。默认 1500。 */
  intervalMs?: number;
  /** 上限（ms）。超过即判超时失败。默认 120000（~2min）。 */
  timeoutMs?: number;
  /** 休眠实现（默认 setTimeout）。单测注入立即 resolve 以免真等。 */
  sleep?: (ms: number) => Promise<void>;
  /** 取消信号（如进程停止 / 节点删除）：返回 true 即中止轮询、判失败（reason='cancelled'）。 */
  isCancelled?: () => boolean;
}

/** 轮询结果：成功 / 超时 / 被取消。纯返回值，不带副作用（事件发射由调用方做）。 */
export type PollLoginResult = 'success' | 'timeout' | 'cancelled';

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询直到「已登录」(check→true) 或超时/取消（log-level 无关，纯靠 state 目录真值）。
 *
 * 纯逻辑（check/sleep/isCancelled 全可注入）→ 单测覆盖「立即成功 / 第 N 次成功 / 始终未出现→超时 / 中途取消」。
 * 首次进入先 check 一次（authKey 已就绪或 state 已落盘的情形零等待返回 success），随后每 intervalMs 复查。
 */
export async function pollTailscaleLoginSuccess(opts: PollLoginOptions): Promise<PollLoginResult> {
  const intervalMs = opts.intervalMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 120000;
  const sleep = opts.sleep ?? defaultSleep;
  // deadline 用「累计等待时长」而非 Date.now()：注入假 sleep 时不依赖墙钟，单测确定可复现。
  let waited = 0;
  for (;;) {
    if (opts.isCancelled?.()) return 'cancelled';
    if (await opts.check()) return 'success';
    if (waited >= timeoutMs) return 'timeout';
    await sleep(intervalMs);
    waited += intervalMs;
  }
}
