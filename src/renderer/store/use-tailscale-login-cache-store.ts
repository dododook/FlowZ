/**
 * Tailscale 登录态持久缓存（serverId → {loggedIn, cachedAt}）的 localStorage store。
 *
 * 为何独立 store + localStorage：
 *  - 登录态本质持久：凭据存在 state 文件（node key），登录一次长期有效，只在罕见事件失效
 *    （用户 logout / key 过期默认 180d / admin 踢设备）。代理关时无常驻核 STATUS，过去靠每次进组网页
 *    spawn 瞬态核探针读真实态（12-13s「检测中」反复闪、切 tab 重探）——为罕见事件付高频代价，过度主动。
 *    缓存上次已知态即可秒显；代理开时由 api STATUS 流自动校正（免费、实时，key 失效在此暴露）。
 *  - 存 localStorage 而非 UserConfig：UserConfig 改动触发 CONFIG_CHANGED→switchMode 重启代理；
 *    ServerConfig 是静态配置，混入动态登录态会污染导出/订阅同步。localStorage 是纯渲染端视图态，零 IPC、零重启。
 *  - 真值仍是 api STATUS 流（代理开时实时校正缓存）；本缓存只服务「代理关时秒显 + 不起核」。
 *    无缓存命中时由 state 文件存在性兜底（main TAILSCALE_STATE_EXISTS），优先级：缓存 > state 文件 > 未连接。
 */
import { create } from 'zustand';

const STORAGE_KEY = 'flowz.tailscaleLoginCache';

export interface TailscaleLoginCacheEntry {
  loggedIn: boolean;
  cachedAt: number;
}

// 导出供 app-store 初始化与单测直接验证（renderer 测试禁 require，故走显式函数而非 isolateModules）。
export function loadTailscaleLoginCache(): Record<string, TailscaleLoginCacheEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const out: Record<string, TailscaleLoginCacheEntry> = {};
        for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
          const e = v as { loggedIn?: unknown; cachedAt?: unknown } | null;
          if (e && typeof e.loggedIn === 'boolean' && typeof e.cachedAt === 'number') {
            out[id] = { loggedIn: e.loggedIn, cachedAt: e.cachedAt };
          }
        }
        return out;
      }
    }
  } catch {
    /* 无 localStorage / 解析失败 / 损坏值 → 空缓存（走 state 文件兜底） */
  }
  return {};
}

// 派生「serverId → loggedIn」纯布尔表，供 app-store.tailscaleLoginStates 初始化（启动秒显）。
export function loadTailscaleLoginStatesFromCache(): Record<string, boolean> {
  const cache = loadTailscaleLoginCache();
  const out: Record<string, boolean> = {};
  for (const [id, e] of Object.entries(cache)) out[id] = e.loggedIn;
  return out;
}

function persist(cache: Record<string, TailscaleLoginCacheEntry>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* 持久化失败（隐私模式/storage 禁用）不阻断 → 退化为会话内记忆 */
  }
}

interface TailscaleLoginCacheState {
  cache: Record<string, TailscaleLoginCacheEntry>;
  // 写入一条（STATUS 流真值到达时调用）。值未变则不重写，省无谓 localStorage 写 + 订阅者重渲染。
  setCached: (serverId: string, loggedIn: boolean) => void;
  // 删除一条（节点删除时清理，避免陈旧缓存误显「已连接」）。
  removeCached: (serverId: string) => void;
}

export const useTailscaleLoginCacheStore = create<TailscaleLoginCacheState>((set, get) => ({
  cache: loadTailscaleLoginCache(),
  setCached: (serverId, loggedIn) => {
    const prev = get().cache[serverId];
    if (prev && prev.loggedIn === loggedIn) return; // 值未变，省写
    const next = { ...get().cache, [serverId]: { loggedIn, cachedAt: Date.now() } };
    persist(next);
    set({ cache: next });
  },
  removeCached: (serverId) => {
    if (!(serverId in get().cache)) return;
    const next = { ...get().cache };
    delete next[serverId];
    persist(next);
    set({ cache: next });
  },
}));
