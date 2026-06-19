/**
 * Tailscale 登录态「整表刷新 vs 乐观单点点亮」防覆盖合并（纯逻辑，无 store/IPC 依赖，便于单测）。
 *
 * 竞态：refreshTailscaleLoginStates 整表覆盖 与 setTailscaleLoginState 乐观单点点亮并发时，
 * 一次更早发起、磁盘快照仍是登录前 false 的 refresh 后到 → 把刚点亮的 true 覆盖回 false（角标闪/回退）。
 *
 * 单调代际防覆盖：每次乐观点亮 true 递增 gen 并登记 serverId→gen；refresh 发起时捕获 gen（genAtStart），
 * 响应回来合并时，对「refresh 发起之后」又被乐观点亮（登记 gen > genAtStart）且磁盘快照给 falsy 的 serverId，
 * 保留当前内存里的乐观 true（丢弃这次过期整表覆盖）。磁盘真值仍权威：登出（磁盘 false 且无更新乐观点亮）
 * 正常生效；仅保护「在途 refresh 期间新点亮的 true」。
 */

/** 合并一次整表刷新结果：返回应写回 store 的最终登录态表。不修改入参。 */
export function mergeTailscaleLoginStates(
  diskStates: Record<string, boolean>,
  currentStates: Record<string, boolean>,
  optimisticTrueAt: ReadonlyMap<string, number>,
  genAtStart: number
): Record<string, boolean> {
  const merged: Record<string, boolean> = { ...diskStates };
  for (const [serverId, gen] of optimisticTrueAt) {
    // 仅保护「refresh 发起之后」新点亮且磁盘尚未反映为 true 的乐观值（磁盘写入延迟未落地）。
    if (gen > genAtStart && !merged[serverId] && currentStates[serverId]) {
      merged[serverId] = true;
    }
  }
  return merged;
}
