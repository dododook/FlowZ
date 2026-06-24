/**
 * Tailscale 登录态缓存持久化单测：localStorage 往返（代理关时秒显、免起核探针）+ 损坏值兜底 +
 * 非法条目跳过 + 值未变不重写 + 派生布尔表。testEnvironment=node 无 localStorage → 注入内存 mock；
 * 直接测导出的纯 load 函数 + store action（避免 require）。
 */
import {
  loadTailscaleLoginCache,
  loadTailscaleLoginStatesFromCache,
  useTailscaleLoginCacheStore,
} from '../use-tailscale-login-cache-store';

const KEY = 'flowz.tailscaleLoginCache';

function makeLocalStorageMock(seed: Record<string, string> = {}) {
  const store: Record<string, string> = { ...seed };
  return {
    getItem: (k: string): string | null => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    _store: store,
  };
}

describe('loadTailscaleLoginCache', () => {
  afterEach(() => {
    delete (global as any).localStorage;
  });

  it('无持久值 → 空对象', () => {
    (global as any).localStorage = makeLocalStorageMock();
    expect(loadTailscaleLoginCache()).toEqual({});
  });

  it('无 localStorage（未注入）→ 不抛、空对象', () => {
    expect(loadTailscaleLoginCache()).toEqual({});
  });

  it('读回已持久化缓存（跨重启秒显）', () => {
    (global as any).localStorage = makeLocalStorageMock({
      [KEY]: JSON.stringify({
        a: { loggedIn: true, cachedAt: 123 },
        b: { loggedIn: false, cachedAt: 456 },
      }),
    });
    expect(loadTailscaleLoginCache()).toEqual({
      a: { loggedIn: true, cachedAt: 123 },
      b: { loggedIn: false, cachedAt: 456 },
    });
  });

  it('损坏 JSON → 空对象（失败安全，走 state 文件兜底）', () => {
    (global as any).localStorage = makeLocalStorageMock({ [KEY]: '{bad json' });
    expect(loadTailscaleLoginCache()).toEqual({});
  });

  it('非法条目（缺字段/类型错/null）→ 逐条跳过，保留合法条目', () => {
    (global as any).localStorage = makeLocalStorageMock({
      [KEY]: JSON.stringify({
        ok: { loggedIn: true, cachedAt: 1 },
        noBool: { loggedIn: 'yes', cachedAt: 2 },
        noTime: { loggedIn: true },
        nul: null,
      }),
    });
    expect(loadTailscaleLoginCache()).toEqual({ ok: { loggedIn: true, cachedAt: 1 } });
  });
});

describe('loadTailscaleLoginStatesFromCache', () => {
  afterEach(() => {
    delete (global as any).localStorage;
  });

  it('派生 serverId → loggedIn 布尔表（供 app-store 启动初值）', () => {
    (global as any).localStorage = makeLocalStorageMock({
      [KEY]: JSON.stringify({
        a: { loggedIn: true, cachedAt: 1 },
        b: { loggedIn: false, cachedAt: 2 },
      }),
    });
    expect(loadTailscaleLoginStatesFromCache()).toEqual({ a: true, b: false });
  });

  it('无缓存 → 空表', () => {
    (global as any).localStorage = makeLocalStorageMock();
    expect(loadTailscaleLoginStatesFromCache()).toEqual({});
  });
});

describe('useTailscaleLoginCacheStore', () => {
  afterEach(() => {
    delete (global as any).localStorage;
    useTailscaleLoginCacheStore.setState({ cache: {} });
  });

  it('setCached 写入 store 并持久化 localStorage', () => {
    const mock = makeLocalStorageMock();
    (global as any).localStorage = mock;
    useTailscaleLoginCacheStore.getState().setCached('n1', true);
    expect(useTailscaleLoginCacheStore.getState().cache.n1.loggedIn).toBe(true);
    expect(typeof useTailscaleLoginCacheStore.getState().cache.n1.cachedAt).toBe('number');
    expect(JSON.parse(mock._store[KEY]).n1.loggedIn).toBe(true);
  });

  it('setCached 值未变 → 不重写（cachedAt 不刷新、省无谓写）', () => {
    (global as any).localStorage = makeLocalStorageMock();
    useTailscaleLoginCacheStore.getState().setCached('n1', true);
    const firstAt = useTailscaleLoginCacheStore.getState().cache.n1.cachedAt;
    useTailscaleLoginCacheStore.getState().setCached('n1', true);
    expect(useTailscaleLoginCacheStore.getState().cache.n1.cachedAt).toBe(firstAt);
  });

  it('setCached 值变化（true→false，如登出）→ 更新', () => {
    (global as any).localStorage = makeLocalStorageMock();
    useTailscaleLoginCacheStore.getState().setCached('n1', true);
    useTailscaleLoginCacheStore.getState().setCached('n1', false);
    expect(useTailscaleLoginCacheStore.getState().cache.n1.loggedIn).toBe(false);
  });

  it('removeCached 删除条目并持久化（节点删除清理，免陈旧缓存误显已连接）', () => {
    const mock = makeLocalStorageMock();
    (global as any).localStorage = mock;
    useTailscaleLoginCacheStore.getState().setCached('n1', true);
    useTailscaleLoginCacheStore.getState().removeCached('n1');
    expect(useTailscaleLoginCacheStore.getState().cache.n1).toBeUndefined();
    expect(JSON.parse(mock._store[KEY]).n1).toBeUndefined();
  });
});
