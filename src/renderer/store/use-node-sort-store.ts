/**
 * 节点列表「按延迟排序」开关的 localStorage 持久 store。
 *
 * 为何独立 store + localStorage（同 use-tailscale-login-cache-store 惯例）：
 *  - 这是「展示偏好」而非「易变数据」：用户设一次该跨重启保留（与「测速结果只活在应用生命周期、重启清空」
 *    不冲突——结果是数据、排序是偏好）。
 *  - 存 localStorage 而非 UserConfig：UserConfig 改动触发 CONFIG_CHANGED→重启代理；偏好是纯渲染端视图态。
 *
 * 开关只管理「下拉列表 + 托盘列表」的排序：渲染端首页出口选择（connection-control-card 的 ExitNodePicker）读本 store，
 * 主进程托盘经 App.tsx 的 useEffect 把本值经 IPC 推给 TrayManager.setSortByLatency（mount 时一次同步 +
 * 每次切换推送）。无测速结果时两端均退化为按名称（见 server-latency-sort）。
 */
import { create } from 'zustand';

const STORAGE_KEY = 'flowz.nodeSortByLatency';

// 导出供单测直接验证（renderer 测试禁 require，故走显式函数）。
export function loadNodeSortByLatency(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    /* 无 localStorage / 隐私模式 → 默认按名称 */
    return false;
  }
}

function persist(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    /* 持久化失败不阻断 → 退化为会话内记忆 */
  }
}

interface NodeSortState {
  /** true=按延迟排序，false=按名称（默认）。 */
  sortByLatency: boolean;
  setSortByLatency: (value: boolean) => void;
  toggleSortByLatency: () => void;
}

export const useNodeSortStore = create<NodeSortState>((set, get) => ({
  sortByLatency: loadNodeSortByLatency(),
  setSortByLatency: (value) => {
    if (get().sortByLatency === value) return; // 值未变，省写 + 省订阅者重渲染
    persist(value);
    set({ sortByLatency: value });
  },
  toggleSortByLatency: () => get().setSortByLatency(!get().sortByLatency),
}));
