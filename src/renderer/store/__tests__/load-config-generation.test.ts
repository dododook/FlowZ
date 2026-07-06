/**
 * loadConfig 代际护栏单测：mutation（删节点）后，一个「早于删除就已开始拉取」的在飞 loadConfig
 * 迟到 resolve 时携带的是删前旧快照，必须被丢弃、不得回填 store（否则 UI 复活已删节点）。
 * testEnvironment=node：mock 掉 ipc / i18n / sonner / tailscale 缓存，用 deferred promise 精确编排竞态时序。
 */

// 用 mock 前缀变量绕过 jest.mock 工厂的作用域限制，供测试内逐用例配置返回值。
const mockConfigGet = jest.fn();
const mockGetPrivacyMode = jest.fn().mockResolvedValue(false);
const mockServerDelete = jest.fn().mockResolvedValue(undefined);

jest.mock('../../ipc', () => ({
  api: {
    config: { get: mockConfigGet, getPrivacyMode: mockGetPrivacyMode },
    server: { delete: mockServerDelete },
  },
}));
jest.mock('sonner', () => ({
  toast: { error: jest.fn(), success: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));
jest.mock('../../i18n', () => ({ __esModule: true, default: { t: (k: string) => k } }));
jest.mock('../use-tailscale-login-cache-store', () => ({
  loadTailscaleLoginStatesFromCache: () => ({}),
  useTailscaleLoginCacheStore: {
    getState: () => ({ cache: {}, removeCached: jest.fn(), setCached: jest.fn() }),
  },
}));

import { useAppStore } from '../app-store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// 最小可用 config：带 tunConfig / proxyModeType 以跳过 loadConfig 内的默认注入（避免触碰 window.electron）。
const makeConfig = (serverIds: string[]) => ({
  servers: serverIds.map((id) => ({ id })),
  tunConfig: { mtu: 1400, stack: 'auto', autoRoute: true, strictRoute: true },
  proxyModeType: 'systemProxy',
});

const serverIdsInStore = () => useAppStore.getState().config?.servers.map((s: any) => s.id);

describe('loadConfig 代际护栏', () => {
  beforeEach(() => {
    mockConfigGet.mockReset();
    useAppStore.setState({ config: null });
  });

  it('删节点后，早于删除的在飞旧 load 迟到 resolve 不复活已删节点', async () => {
    const preDelete = deferred<any>();
    const postDelete = deferred<any>();
    // 第一次 get（早于删除的 load）→ 删前快照；第二次 get（deleteServer 触发的 load）→ 删后快照。
    mockConfigGet.mockReturnValueOnce(preDelete.promise).mockReturnValueOnce(postDelete.promise);

    // 1) 早于删除就开始的一次 loadConfig（在飞，尚未 resolve）
    const loadEarly = useAppStore.getState().loadConfig();

    // 2) 删除 B：invalidateLoadConfig 自增代际 + 置空句柄，并触发删后 load
    const del = useAppStore.getState().deleteServer('B');

    // 3) 删后 load 先返回 [A]，写入 store
    postDelete.resolve(makeConfig(['A']));
    await del;
    expect(serverIdsInStore()).toEqual(['A']);

    // 4) 旧 load 迟到 resolve 返回删前 [A,B]：代际已变 → 丢弃，不复活 B
    preDelete.resolve(makeConfig(['A', 'B']));
    await loadEarly;
    expect(serverIdsInStore()).toEqual(['A']);
  });

  it('无 mutation 干预时，正常 loadConfig 照常回填 store', async () => {
    const only = deferred<any>();
    mockConfigGet.mockReturnValueOnce(only.promise);
    const load = useAppStore.getState().loadConfig();
    only.resolve(makeConfig(['X', 'Y']));
    await load;
    expect(serverIdsInStore()).toEqual(['X', 'Y']);
  });
});
