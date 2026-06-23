/**
 * 节点排序偏好（sortKey/sortOrder）的持久化 store。
 *
 * 为何独立 store + localStorage：
 *  - 排序是「用户意图」，应跨 Tab / 页面 / 重启记忆——原先在 useServerFilter 里是每实例 useState，
 *    切 Tab/页面即重挂重置（用户反馈「排序无记忆」的根因）。提到共享 store 后全 Tab 同步、刷新即用。
 *  - 存 localStorage 而非 UserConfig：UserConfig 改动会触发 CONFIG_CHANGED→switchMode 重启代理，
 *    改个排序绝不能重连；localStorage 是纯渲染端视图态，零 IPC、零重启。
 *  - 仅持久化排序偏好，不持久化测速结果（latencyMap）——见 sortServers 注释（陈旧延迟会误导）。
 */
import { create } from 'zustand';
import type { SortKey, SortOrder } from './server-list-helpers';

const STORAGE_KEY = 'flowz.serverSort';
const VALID_KEYS: readonly SortKey[] = ['name', 'protocol', 'latency', 'address'];
const DEFAULT_KEY: SortKey = 'name';
const DEFAULT_ORDER: SortOrder = 'asc';

// 导出供单测直接验证（避免 isolateModules+require：renderer 测试禁 require）。
export function loadServerSortPref(): { sortKey: SortKey; sortOrder: SortOrder } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (VALID_KEYS.includes(p?.sortKey) && (p?.sortOrder === 'asc' || p?.sortOrder === 'desc')) {
        return { sortKey: p.sortKey, sortOrder: p.sortOrder };
      }
    }
  } catch {
    /* 无 localStorage / 解析失败 / 损坏值 → 回落默认 */
  }
  return { sortKey: DEFAULT_KEY, sortOrder: DEFAULT_ORDER };
}

export function saveServerSortPref(sortKey: SortKey, sortOrder: SortOrder): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sortKey, sortOrder }));
  } catch {
    /* 持久化失败（隐私模式/storage 禁用）不阻断 → 退化为会话内记忆 */
  }
}

interface ServerSortState {
  sortKey: SortKey;
  sortOrder: SortOrder;
  setSortKey: (key: SortKey) => void;
  // 兼容函数式 updater（server-list 的「点同一列切换 asc/desc」用 (o) => ... 形式）。
  setSortOrder: (order: SortOrder | ((prev: SortOrder) => SortOrder)) => void;
}

export const useServerSortStore = create<ServerSortState>((set, get) => ({
  ...loadServerSortPref(),
  setSortKey: (key) => {
    saveServerSortPref(key, get().sortOrder);
    set({ sortKey: key });
  },
  setSortOrder: (order) => {
    const next = typeof order === 'function' ? order(get().sortOrder) : order;
    saveServerSortPref(get().sortKey, next);
    set({ sortOrder: next });
  },
}));
