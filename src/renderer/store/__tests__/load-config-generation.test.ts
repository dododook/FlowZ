/**
 * loadConfig 代际护栏单测：mutation（删节点）后，一个「早于删除就已开始拉取」的在飞 loadConfig
 * 迟到 resolve 时携带的是删前旧快照，必须被丢弃、不得回填 store（否则 UI 复活已删节点）。
 * testEnvironment=node：mock 掉 ipc / i18n / sonner / tailscale 缓存，用 deferred promise 精确编排竞态时序。
 */

// 用 mock 前缀变量绕过 jest.mock 工厂的作用域限制，供测试内逐用例配置返回值。
const mockConfigGet = jest.fn();
const mockGetPrivacyMode = jest.fn().mockResolvedValue(false);
const mockServerDelete = jest.fn().mockResolvedValue(undefined);
// TS 登录缓存 mock：可配置 cache 内容 + 稳定 removeCached spy，供孤儿 GC 用例断言。
const mockRemoveCached = jest.fn();
let mockLoginCache: Record<string, unknown> = {};

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
    getState: () => ({
      cache: mockLoginCache,
      removeCached: mockRemoveCached,
      setCached: jest.fn(),
    }),
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

// #325 A2：main push 的 config 事件（replay + 常规 configChanged newValue）经 applyConfigFromEvent 落地——
// 写 config + 作废在飞旧 pull，防「push 与 mount pull 并发」时旧 pull 迟到覆盖新 push。
describe('applyConfigFromEvent（#325 replay 护栏）', () => {
  beforeEach(() => {
    mockConfigGet.mockReset();
    mockGetPrivacyMode.mockReset();
    mockGetPrivacyMode.mockResolvedValue(false);
    mockRemoveCached.mockReset();
    mockLoginCache = {};
    useAppStore.setState({ config: null, isPrivacyMode: false });
  });

  it('T1 丢事件后补偿 + 清在飞句柄：mount pull 在飞时 apply 终态 → config 即落地，且 invalidate 清句柄使后续 loadConfig 真实重拉（非复用旧 promise）', async () => {
    // silent-start：mount loadConfig 已起飞但快照未回（churn 中）→ config 仍 null。
    const churnPull = deferred<any>();
    mockConfigGet.mockReturnValueOnce(churnPull.promise);
    const churnLoad = useAppStore.getState().loadConfig();
    expect(mockConfigGet).toHaveBeenCalledTimes(1);
    expect(serverIdsInStore()).toBeUndefined(); // 尚未回填

    // replay push 终态 → config 即落地（不等 churn pull），并 invalidate 在飞句柄。
    useAppStore.getState().applyConfigFromEvent(makeConfig(['NODE-A', 'NODE-B']) as any);
    expect(serverIdsInStore()).toEqual(['NODE-A', 'NODE-B']);

    // 杀变异「apply 只 gen++ 不清 inflight」：若句柄未清，下面 loadConfig 会复用 churnPull（单飞早退、不再调
    // api.config.get）→ toHaveBeenCalledTimes(2) 失败。清了才会真实第二次拉取。
    const reloadPull = deferred<any>();
    mockConfigGet.mockReturnValueOnce(reloadPull.promise);
    const reload = useAppStore.getState().loadConfig();
    expect(mockConfigGet).toHaveBeenCalledTimes(2);

    // churn pull 迟到 resolve：代际已变 → 丢弃，不覆盖 push 的 config；reload pull 回填最新。
    churnPull.resolve(makeConfig(['STALE']));
    reloadPull.resolve(makeConfig(['NODE-A', 'NODE-B', 'NODE-C']));
    await Promise.all([churnLoad, reload]);
    expect(serverIdsInStore()).toEqual(['NODE-A', 'NODE-B', 'NODE-C']);
  });

  it('T2 push-while-pull-in-flight：mount loadConfig 在飞时 apply(v2) → 在飞旧 pull 迟到 resolve 被代际丢弃，store 保持 v2 不回退', async () => {
    const inflightPull = deferred<any>();
    mockConfigGet.mockReturnValueOnce(inflightPull.promise);

    // 1) mount loadConfig 起飞（快照 v1 尚未 resolve）
    const load = useAppStore.getState().loadConfig();

    // 2) main push 终态 v2 → set config=v2 + invalidateLoadConfig（自增代际、置空句柄）
    useAppStore.getState().applyConfigFromEvent(makeConfig(['V2']) as any);
    expect(serverIdsInStore()).toEqual(['V2']);

    // 3) 在飞旧 pull 迟到 resolve 返回 v1 旧快照：代际已变 → 丢弃，不覆盖 v2
    inflightPull.resolve(makeConfig(['V1-STALE']));
    await load;
    expect(serverIdsInStore()).toEqual(['V2']);
  });

  it('T-High（复审 High 1）apply-during-pull：在飞 mount pull 的 isPrivacyMode 水合不被 replay 作废 → 隐私锁不旁路', async () => {
    // silent-start + autoPrivacyMode：main 无窗期已 setPrivacyMode(true)，ENTER 事件丢失 → 挂载期隐私态唯一水合
    // 路径 = mount pull 的 getPrivacyMode。若 isPrivacyMode 随 config 代际护栏被 replay 一起作废 → 恒 false = 锁旁路。
    const pull = deferred<any>();
    mockConfigGet.mockReturnValueOnce(pull.promise);
    mockGetPrivacyMode.mockResolvedValueOnce(true); // 主进程隐私锁已开

    const load = useAppStore.getState().loadConfig();

    // replay push 终态 config v2 → invalidate 在飞 pull 的 config回填（但不得殃及 isPrivacyMode 水合）。
    useAppStore.getState().applyConfigFromEvent(makeConfig(['V2']) as any);

    // 在飞 pull resolve：config 快照陈旧被代际丢弃；isPrivacyMode 必须仍水合为 true。
    pull.resolve(makeConfig(['V1-STALE']));
    await load;

    expect(useAppStore.getState().isPrivacyMode).toBe(true); // 遮罩正确出现，锁未旁路
    expect(serverIdsInStore()).toEqual(['V2']); // config 仍是 push v2，不被 stale 覆盖
  });

  it('T-GC（复审追零 Nit）apply-during-pull：在飞 pull 的孤儿 GC 被作废跳过时，push 落地补跑 GC → 挂载期不漏清 TS 缓存孤儿', async () => {
    mockLoginCache = { KEEP: {}, ORPHAN: {} }; // 缓存含一存活 + 一孤儿条目
    const pull = deferred<any>();
    mockConfigGet.mockReturnValueOnce(pull.promise);
    const load = useAppStore.getState().loadConfig(); // mount pull 在飞

    // replay push 终态 servers=[KEEP]：apply 路径同步跑孤儿 GC，清 ORPHAN、留 KEEP（不依赖在飞 pull 的 GC）。
    useAppStore.getState().applyConfigFromEvent(makeConfig(['KEEP']) as any);
    expect(mockRemoveCached).toHaveBeenCalledWith('ORPHAN');
    expect(mockRemoveCached).not.toHaveBeenCalledWith('KEEP');

    // 在飞 pull 迟到 resolve：gen 已变 → config回填 + 其 GC 被守卫跳过（否则会用陈旧 servers 再 GC）。
    mockRemoveCached.mockClear();
    pull.resolve(makeConfig(['STALE-SERVER']));
    await load;
    expect(mockRemoveCached).not.toHaveBeenCalled();
  });
});
