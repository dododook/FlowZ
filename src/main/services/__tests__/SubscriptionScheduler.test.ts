import { SubscriptionScheduler } from '../SubscriptionScheduler';

// per-sub 经代理调度回归：全局三态策略 × per-sub；代理未起只跳过经代理订阅、直连照常；direct/proxy 全局覆盖 per-sub。
function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    subscriptions: [
      { id: 'd', name: 'Direct', url: 'http://direct', autoUpdate: true },
      { id: 'p', name: 'Proxy', url: 'http://proxy', autoUpdate: true, updateViaProxy: true },
    ],
    servers: [],
    autoUpdateSubscriptionOnStart: true,
    subscriptionProxyPolicy: 'follow', // 全局三态策略（默认场景：跟随 per-sub）
    mixedPort: 7890,
    ...overrides,
  };
}

function makeScheduler(config: ReturnType<typeof makeConfig>, proxyRunning: boolean) {
  const fetchSubscription = jest.fn().mockResolvedValue({ servers: [] });
  const configManager = {
    loadConfig: jest.fn().mockResolvedValue(config),
    saveConfig: jest.fn().mockResolvedValue(undefined),
  };
  const logManager = { addLog: jest.fn() };
  const notifyConfigChanged = jest.fn();
  const scheduler = new SubscriptionScheduler(
    configManager as never,
    { fetchSubscription } as never,
    logManager as never,
    () => proxyRunning,
    notifyConfigChanged as never
  );
  // runDueUpdates 为 private：测试经 any 直调，等价于启动补更/周期巡检触发
  const run = () =>
    (
      scheduler as unknown as { runDueUpdates: (r: string, o?: object) => Promise<void> }
    ).runDueUpdates('test', { ignoreStaleness: true });
  const pending = () =>
    (scheduler as unknown as { pendingProxyCatchup: boolean }).pendingProxyCatchup;
  return { fetchSubscription, run, pending };
}

describe('SubscriptionScheduler per-sub 经代理调度', () => {
  it('代理未起：直连订阅照常更新、经代理订阅跳过并置挂起补更标记', async () => {
    const { fetchSubscription, run, pending } = makeScheduler(makeConfig(), false);
    await run();
    // 仅直连订阅被拉取（viaProxy=false）；经代理订阅被跳过、未拉取
    expect(fetchSubscription).toHaveBeenCalledTimes(1);
    expect(fetchSubscription).toHaveBeenCalledWith('http://direct', 'd', false, undefined);
    expect(pending()).toBe(true);
  });

  it('代理已起：经代理订阅以 viaProxy=true 拉取、直连仍 false', async () => {
    const { fetchSubscription, run, pending } = makeScheduler(makeConfig(), true);
    await run();
    expect(fetchSubscription).toHaveBeenCalledTimes(2);
    expect(fetchSubscription).toHaveBeenCalledWith('http://direct', 'd', false, undefined);
    expect(fetchSubscription).toHaveBeenCalledWith('http://proxy', 'p', true, undefined);
    expect(pending()).toBe(false);
  });

  it('全局策略 direct：经代理订阅被强制直连（viaProxy=false）、不挂起', async () => {
    const { fetchSubscription, run, pending } = makeScheduler(
      makeConfig({ subscriptionProxyPolicy: 'direct' }),
      false // 代理未起也无妨：direct 覆盖 → 无订阅经代理
    );
    await run();
    // direct 覆盖 per-sub → 两订阅都直连拉取
    expect(fetchSubscription).toHaveBeenCalledTimes(2);
    expect(fetchSubscription).toHaveBeenCalledWith('http://proxy', 'p', false, undefined);
    expect(pending()).toBe(false);
  });

  it('全局策略 proxy：所有订阅强制经代理（忽略 per-sub）、代理已起均 viaProxy=true', async () => {
    const { fetchSubscription, run, pending } = makeScheduler(
      makeConfig({ subscriptionProxyPolicy: 'proxy' }),
      true
    );
    await run();
    // proxy 覆盖 per-sub → 即便 'd' 未设 updateViaProxy 也经代理
    expect(fetchSubscription).toHaveBeenCalledTimes(2);
    expect(fetchSubscription).toHaveBeenCalledWith('http://direct', 'd', true, undefined);
    expect(fetchSubscription).toHaveBeenCalledWith('http://proxy', 'p', true, undefined);
    expect(pending()).toBe(false);
  });

  it('全局策略 proxy + 代理未起：所有订阅跳过并挂起补更', async () => {
    const { fetchSubscription, run, pending } = makeScheduler(
      makeConfig({ subscriptionProxyPolicy: 'proxy' }),
      false
    );
    await run();
    // proxy 覆盖 → 两订阅都经代理；代理未起 → 全跳过、挂起
    expect(fetchSubscription).not.toHaveBeenCalled();
    expect(pending()).toBe(true);
  });
});
