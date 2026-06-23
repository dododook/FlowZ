/**
 * 节点排序偏好持久化单测：localStorage 往返（跨 Tab/重启记忆）+ 损坏值回落 + 函数式 setSortOrder。
 * testEnvironment=node 无 localStorage → 注入内存 mock；直接测导出的纯 load/save（避免 require）。
 */
import {
  loadServerSortPref,
  saveServerSortPref,
  useServerSortStore,
} from '../use-server-sort-store';

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

describe('排序偏好持久化（loadServerSortPref / saveServerSortPref）', () => {
  afterEach(() => {
    delete (global as any).localStorage;
  });

  it('无持久值 → 默认 name/asc', () => {
    (global as any).localStorage = makeLocalStorageMock();
    expect(loadServerSortPref()).toEqual({ sortKey: 'name', sortOrder: 'asc' });
  });

  it('无 localStorage（未注入）→ 不抛、回落默认', () => {
    expect(loadServerSortPref()).toEqual({ sortKey: 'name', sortOrder: 'asc' });
  });

  it('读回已持久化偏好（跨重启记忆）', () => {
    (global as any).localStorage = makeLocalStorageMock({
      'flowz.serverSort': JSON.stringify({ sortKey: 'protocol', sortOrder: 'desc' }),
    });
    expect(loadServerSortPref()).toEqual({ sortKey: 'protocol', sortOrder: 'desc' });
  });

  it('save → load 往返', () => {
    (global as any).localStorage = makeLocalStorageMock();
    saveServerSortPref('latency', 'desc');
    expect(loadServerSortPref()).toEqual({ sortKey: 'latency', sortOrder: 'desc' });
  });

  it('损坏 JSON → 回落默认', () => {
    (global as any).localStorage = makeLocalStorageMock({ 'flowz.serverSort': '{bad json' });
    expect(loadServerSortPref().sortKey).toBe('name');
  });

  it('非法字段值 → 回落默认', () => {
    (global as any).localStorage = makeLocalStorageMock({
      'flowz.serverSort': JSON.stringify({ sortKey: 'bogus', sortOrder: 'sideways' }),
    });
    expect(loadServerSortPref().sortKey).toBe('name');
  });
});

describe('useServerSortStore setter', () => {
  afterEach(() => {
    delete (global as any).localStorage;
  });

  it('setSortKey + 函数式 setSortOrder 更新状态并持久化', () => {
    const mock = makeLocalStorageMock();
    (global as any).localStorage = mock;
    useServerSortStore.getState().setSortKey('latency');
    useServerSortStore.getState().setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    expect(useServerSortStore.getState().sortKey).toBe('latency');
    expect(useServerSortStore.getState().sortOrder).toBe('desc');
    expect(JSON.parse(mock._store['flowz.serverSort'])).toEqual({
      sortKey: 'latency',
      sortOrder: 'desc',
    });
  });
});
