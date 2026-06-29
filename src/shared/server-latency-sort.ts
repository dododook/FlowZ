/**
 * 节点列表「按延迟排序」单一比较器 —— 渲染下拉 + 主进程托盘 + 服务器页 sortServers 三处共用，
 * 杜绝排序语义在多处漂移（server-list-helpers.sortServers 的 latency 分支委托至此）。
 *
 * 语义（与 server-list 历史行为一致）：
 *  - 有效延迟（>=0）按 order 升/降序；无有效结果（未测 undefined / 超时）始终沉底、不随 order 翻转；
 *    两者都无结果 → 按名称升序（locale 感知，**与 order 无关**）——空测速=稳定默认序。
 *  - 「无测速结果默认按名称」即两者都无结果分支；调用方在开关关时**不调用本函数**（保留 config 原序），
 *    故本函数恒做延迟排序，是否启用由调用方门控。
 *
 * 超时表示两端不同（渲染端 latencyMap 用 -1、托盘 speedTestResults 用 null）：本函数对 null 与负数一视同仁为无结果。
 * 取值经 decorate-sort 每节点只算一次（O(n)），避免比较器内重复 getLatency。
 */
export function sortServersByLatency<T extends { id: string; name: string }>(
  servers: readonly T[],
  getLatency: (id: string) => number | null | undefined,
  order: 'asc' | 'desc' = 'asc'
): T[] {
  const decorated = servers.map((server) => {
    const v = getLatency(server.id);
    // 无有效结果（未测 / 超时：-1 或 null）→ null，统一沉底。
    const latency = v === undefined || v === null || v < 0 ? null : v;
    return { server, latency, name: server.name || '' };
  });
  decorated.sort((a, b) => {
    if (a.latency === null && b.latency === null) return a.name.localeCompare(b.name);
    if (a.latency === null) return 1; // 无结果沉底（不随 asc/desc 翻转）
    if (b.latency === null) return -1;
    // 同延迟返回 0：稳定排序保留入参顺序（与 server-list sortServers 历史行为一致，不额外按名称打散）。
    return order === 'asc' ? a.latency - b.latency : b.latency - a.latency;
  });
  return decorated.map((d) => d.server);
}
