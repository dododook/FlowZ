/**
 * 解锁检测的代理连接态跃迁谓词（纯函数，供 use-unlock-detection 用 + 单测）。
 *
 * 抽成纯函数：jest 无 jsdom 不能渲染 hook，把「连接态变了该做什么」的判定抽出即可无渲染单测。
 */

/** 跃迁动作：'detect'=自动跑检测；'reset'=复位 idle；'none'=不动。 */
export type UnlockTransition = 'detect' | 'reset' | 'none';

/**
 * 代理 core 连接态从 was → now 的应对：
 *  - false→true（刚连上）：自动检测；
 *  - true→false（断开）：复位 idle（gating，不检测）；
 *  - 无变化：不动（初检交挂载路径，避免重复）。
 */
export function unlockOnProxyChange(was: boolean, now: boolean): UnlockTransition {
  if (now && !was) return 'detect';
  if (!now && was) return 'reset';
  return 'none';
}
