import type { PendingNodeChanges } from '@shared/types';

/**
 * issue 3：选中「待入池(added)/待生效(modified)」节点时是否将触发自动整核重启。
 *
 * 待应用差集里的 added/modified 均为**未被引用**节点（getPendingNodeChanges 已按 referencedServerIds 过滤掉被引用者）。
 * 一旦选中其一 → 该节点从「未引用」变「被引用(selected)」→ 恒立即整核重启（设计 §2/F14，不受 restartOnNodeChange 开关）
 * → 差集瞬态清空 → PendingChangesBar 无声卸载。据此在选节点入口给一次性友好提示，解释「动作条为何随即消失」。
 *
 * removed 不可被选，天然不计；核未运行时 pendingChanges 恒空 → 返回 false，不误报。
 */
export function willRestartOnSelect(pending: PendingNodeChanges, serverId: string): boolean {
  return pending.added.includes(serverId) || pending.modified.includes(serverId);
}
