/**
 * 侧栏折叠态(icon-rail)持久化 store。
 * collapsed 存 localStorage、跨 Tab/重启记忆；与排序偏好同模式——纯渲染端视图态，
 * 不进 UserConfig（避免 CONFIG_CHANGED→重启代理）。
 */
import { create } from 'zustand';

const STORAGE_KEY = 'flowz.sidebarCollapsed';

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveCollapsed(v: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, v ? '1' : '0');
  } catch {
    /* 隐私模式 / storage 禁用 → 退化为会话内记忆 */
  }
}

interface SidebarState {
  collapsed: boolean;
  toggleCollapsed: () => void;
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  collapsed: loadCollapsed(),
  toggleCollapsed: () => {
    const next = !get().collapsed;
    saveCollapsed(next);
    set({ collapsed: next });
  },
}));
