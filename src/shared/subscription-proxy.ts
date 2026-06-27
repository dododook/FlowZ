/** 全局订阅代理策略：跟随各订阅自身设定 / 全部强制经代理 / 全部强制直连。默认 follow。 */
export type SubscriptionProxyPolicy = 'follow' | 'proxy' | 'direct';

/**
 * 订阅「经代理更新」生效求值（单一真值；主进程 handler/scheduler 与渲染端 UI 共用）。
 *
 * 语义（设计 docs/design/update-network-unification.md §7）：
 *  - 全局 `subscriptionProxyPolicy` = **三态策略**（默认 `follow`）：
 *    - `follow`：按各订阅自身 per-sub `SubscriptionConfig.updateViaProxy` 决定。
 *    - `proxy`：所有订阅强制经代理，**忽略** per-sub。
 *    - `direct`：所有订阅强制直连，**忽略** per-sub。
 *  - per-sub `SubscriptionConfig.updateViaProxy` = 具体开关（默认关）：仅 `follow` 时生效（其余被全局覆盖、UI 置灰）。
 *
 * 默认 follow + per-sub 默认关的理由：冷启动鸡生蛋（启动时代理未起，默认直连避免首拉失败）+「经代理」是「直连不行才开」的显式选择。
 */
export function resolveSubscriptionViaProxy(
  policy: SubscriptionProxyPolicy | undefined,
  subEnabled: boolean | undefined
): boolean {
  if (policy === 'proxy') return true;
  if (policy === 'direct') return false;
  return subEnabled === true; // follow（默认）
}
