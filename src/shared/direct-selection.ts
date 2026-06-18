/**
 * 全局节点选择「直连」哨兵（#73 proxifier）。
 *
 * selectedServerId 取此值 = 全局出口走 direct（proxy-selector default=direct）。配 smart 模式即 proxifier：
 * 未命中规则的流量直连，仅 custom/app `action=proxy`+指定目标节点的走代理。global 模式下=等同直连模式。
 *
 * **只作"全局节点选择"用**（首页 / 托盘「选择服务器」），不作 per-rule 目标（per-rule 直连用 action=direct）。
 * 故不会进 rule-sel 目标解析；仅 generateSingBoxConfig/buildOutbounds/planHotSwitch 识别它。
 */
export const DIRECT_SERVER_ID = '__direct__';

export function isDirectSelection(selectedServerId: string | null | undefined): boolean {
  return selectedServerId === DIRECT_SERVER_ID;
}

/**
 * 全局出口的 proxy-selector 成员 tag（单一真值，收口「selectedServerId → memberTag」）：直连哨兵→'direct'，
 * 否则查 idToTagMap 得节点 tag。generate-time 的 selector default 与 hot-switch 的 PUT 目标共用此映射、锁步
 * （改哨兵值 / direct tag 名只此一处）。未知节点返回 undefined，由调用方按场景兜底
 * （buildOutbounds → nodeTags[0]/'proxy'；planHotSwitch → 退回重启）。
 */
export function resolveGlobalExitTag(
  selectedServerId: string | null | undefined,
  idToTagMap: Map<string, string> | null | undefined
): string | undefined {
  if (isDirectSelection(selectedServerId)) return 'direct';
  return selectedServerId ? idToTagMap?.get(selectedServerId) : undefined;
}
