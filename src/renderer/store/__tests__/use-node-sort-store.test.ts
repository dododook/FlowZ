/**
 * 「按延迟排序」开关持久化单测：localStorage 往返 + 非 'true' 值视为 false + 无 localStorage 兜底 +
 * setSortByLatency 持久化/更新 state + toggle 翻转 + 值未变不重写。testEnvironment=node 无 localStorage → 注入内存 mock。
 */
import { loadNodeSortByLatency, useNodeSortStore } from '../use-node-sort-store';

const KEY = 'flowz.nodeSortByLatency';

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

describe('loadNodeSortByLatency', () => {
  afterEach(() => {
    delete (global as any).localStorage;
  });

  it('无 localStorage（未注入）→ false、不抛', () => {
    expect(loadNodeSortByLatency()).toBe(false);
  });

  it('"true" → true', () => {
    (global as any).localStorage = makeLocalStorageMock({ [KEY]: 'true' });
    expect(loadNodeSortByLatency()).toBe(true);
  });

  it('其他值（非 "true"）→ false', () => {
    (global as any).localStorage = makeLocalStorageMock({ [KEY]: '1' });
    expect(loadNodeSortByLatency()).toBe(false);
  });
});

describe('useNodeSortStore actions', () => {
  afterEach(() => {
    delete (global as any).localStorage;
    useNodeSortStore.setState({ sortByLatency: false });
  });

  it('setSortByLatency 持久化 + 更新 state', () => {
    const ls = makeLocalStorageMock();
    (global as any).localStorage = ls;
    useNodeSortStore.getState().setSortByLatency(true);
    expect(useNodeSortStore.getState().sortByLatency).toBe(true);
    expect(ls._store[KEY]).toBe('true');
  });

  it('toggleSortByLatency 翻转并持久化', () => {
    const ls = makeLocalStorageMock();
    (global as any).localStorage = ls;
    useNodeSortStore.setState({ sortByLatency: false });
    useNodeSortStore.getState().toggleSortByLatency();
    expect(useNodeSortStore.getState().sortByLatency).toBe(true);
    expect(ls._store[KEY]).toBe('true');
  });

  it('值未变 → 不重写 localStorage', () => {
    const ls = makeLocalStorageMock();
    (global as any).localStorage = ls;
    const spy = jest.spyOn(ls, 'setItem');
    useNodeSortStore.setState({ sortByLatency: true });
    useNodeSortStore.getState().setSortByLatency(true); // 同值
    expect(spy).not.toHaveBeenCalled();
  });
});
