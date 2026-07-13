import { willRestartOnSelect } from '../pending-select-hint';
import type { PendingNodeChanges } from '@shared/types';

const empty: PendingNodeChanges = { added: [], modified: [] };

describe('willRestartOnSelect（issue 3 选中待应用节点触发重启提示判据）', () => {
  it('选中待入池(added)节点 → true（选中使其变被引用触发重启）', () => {
    expect(willRestartOnSelect({ ...empty, added: ['new1'] }, 'new1')).toBe(true);
  });

  it('选中待生效(modified)节点 → true', () => {
    expect(willRestartOnSelect({ ...empty, modified: ['edited1'] }, 'edited1')).toBe(true);
  });

  it('选中普通(不在差集)节点 → false（不误弹）', () => {
    expect(willRestartOnSelect({ ...empty, added: ['new1'] }, 'other')).toBe(false);
  });

  it('选中直连哨兵 → false（direct 永不入 pending）', () => {
    expect(willRestartOnSelect(empty, '__direct__')).toBe(false);
  });

  it('停代理/空差集态 → false（核未运行 pendingChanges 恒空）', () => {
    expect(willRestartOnSelect(empty, 'any')).toBe(false);
  });
  // （F-2：removed 已从 PendingNodeChanges 移除；willRestartOnSelect 只算 added/modified，删除节点天然不参与。）
});
