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
  const applyConfigForcingRestart = jest.fn();
  const scheduler = new SubscriptionScheduler(
    configManager as never,
    { fetchSubscription } as never,
    logManager as never,
    () => proxyRunning,
    notifyConfigChanged as never,
    applyConfigForcingRestart as never
  );
  // runDueUpdates 为 private：测试经 any 直调，等价于启动补更/周期巡检触发
  const run = () =>
    (
      scheduler as unknown as { runDueUpdates: (r: string, o?: object) => Promise<void> }
    ).runDueUpdates('test', { ignoreStaleness: true });
  const pending = () =>
    (scheduler as unknown as { pendingProxyCatchup: boolean }).pendingProxyCatchup;
  return {
    fetchSubscription,
    run,
    pending,
    configManager,
    notifyConfigChanged,
    applyConfigForcingRestart,
  };
}

describe('SubscriptionScheduler per-sub 经代理调度', () => {
  it('代理未起：直连订阅照常更新、经代理订阅跳过并置挂起补更标记', async () => {
    const { fetchSubscription, run, pending } = makeScheduler(makeConfig(), false);
    await run();
    // 仅直连订阅被拉取（viaProxy=false）；经代理订阅被跳过、未拉取
    expect(fetchSubscription).toHaveBeenCalledTimes(1);
    expect(fetchSubscription).toHaveBeenCalledWith('http://direct', 'd', false, undefined, {
      etag: undefined,
      lastModified: undefined,
    });
    expect(pending()).toBe(true);
  });

  it('代理已起：经代理订阅以 viaProxy=true 拉取、直连仍 false', async () => {
    const { fetchSubscription, run, pending } = makeScheduler(makeConfig(), true);
    await run();
    expect(fetchSubscription).toHaveBeenCalledTimes(2);
    expect(fetchSubscription).toHaveBeenCalledWith('http://direct', 'd', false, undefined, {
      etag: undefined,
      lastModified: undefined,
    });
    expect(fetchSubscription).toHaveBeenCalledWith('http://proxy', 'p', true, undefined, {
      etag: undefined,
      lastModified: undefined,
    });
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
    expect(fetchSubscription).toHaveBeenCalledWith('http://proxy', 'p', false, undefined, {
      etag: undefined,
      lastModified: undefined,
    });
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
    expect(fetchSubscription).toHaveBeenCalledWith('http://direct', 'd', true, undefined, {
      etag: undefined,
      lastModified: undefined,
    });
    expect(fetchSubscription).toHaveBeenCalledWith('http://proxy', 'p', true, undefined, {
      etag: undefined,
      lastModified: undefined,
    });
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

// §2 待应用差集 — 自动刷新变更源分流（F14 + toggle-gating）
describe('SubscriptionScheduler §2 自动刷新分流', () => {
  const ss = (over: Record<string, unknown>) => ({
    protocol: 'shadowsocks',
    address: '1.1.1.1',
    port: 8388,
    ...over,
  });
  // 单订阅 'd'（直连），含选中节点 S。fetchResult 决定本轮拉到的节点集。
  const oneSubConfig = (over: Record<string, unknown> = {}) =>
    makeConfig({
      subscriptions: [{ id: 'd', name: 'Direct', url: 'http://direct', autoUpdate: true }],
      servers: [ss({ id: 'S', name: 'S', address: '1.1.1.1', subscriptionId: 'd' })],
      selectedServerId: 'S',
      ...over,
    });

  it('F14：自动刷新下架选中节点 → 重选出口（无存活节点回退 direct）+ 强制重启', async () => {
    const { run, configManager, applyConfigForcingRestart } = makeScheduler(oneSubConfig(), true);
    // 默认 fetch mock 返 { servers: [] } → S 被下架、无新节点。
    await run();
    const saved = configManager.saveConfig.mock.calls[0][0] as { selectedServerId: string };
    expect(saved.selectedServerId).toBe('__direct__'); // 无存活节点 → direct 哨兵（非 null）
    expect(applyConfigForcingRestart).toHaveBeenCalledTimes(1); // 逃死节点恒重启
  });

  it('开关 OFF + 仅新增未引用节点（选中 S 仍在）→ 只落盘不重启（defer 待应用）', async () => {
    const { run, fetchSubscription, configManager, applyConfigForcingRestart } = makeScheduler(
      oneSubConfig(),
      true
    );
    // fetch 返 S（同指纹+同内容保留）+ 新节点 N → 无下架、纯新增。subscriptionId:'d' 镜像真实 fetch（parse 赋值），
    // 否则 reconcile/内容比对因缺该字段误判选中节点「变更」。
    fetchSubscription.mockResolvedValue({
      servers: [
        ss({ name: 'S', address: '1.1.1.1', subscriptionId: 'd' }),
        ss({ name: 'N', address: '2.2.2.2', subscriptionId: 'd' }),
      ],
    });
    await run();
    const saved = configManager.saveConfig.mock.calls[0][0] as { selectedServerId: string };
    expect(saved.selectedServerId).toBe('S'); // 选中未变
    expect(applyConfigForcingRestart).not.toHaveBeenCalled(); // OFF + 未下架 + 选中内容未变 → defer
  });

  it('开关 ON + 新增节点 → auto-apply 强制重启', async () => {
    const { run, fetchSubscription, applyConfigForcingRestart } = makeScheduler(
      oneSubConfig({ restartOnNodeChange: true }),
      true
    );
    fetchSubscription.mockResolvedValue({
      servers: [
        ss({ name: 'S', address: '1.1.1.1', subscriptionId: 'd' }),
        ss({ name: 'N', address: '2.2.2.2', subscriptionId: 'd' }),
      ],
    });
    await run();
    expect(applyConfigForcingRestart).toHaveBeenCalledTimes(1); // ON + 真新增 → auto-apply
  });

  // review F-A：ON 开关下 304（无变化）刷新周期**不得**重启（否则 ON 用户每个订阅间隔无谓断流）。
  it('开关 ON + 304 无变化刷新 → 不重启（nodesChanged=false）', async () => {
    const { run, fetchSubscription, applyConfigForcingRestart } = makeScheduler(
      oneSubConfig({ restartOnNodeChange: true }),
      true
    );
    // 304：notModified → 只刷元数据、无节点变更。
    fetchSubscription.mockResolvedValue({ servers: [], notModified: true });
    await run();
    expect(applyConfigForcingRestart).not.toHaveBeenCalled();
  });

  // review F-C：OFF 下选中节点同 id 但连接参数被改（轮换 SNI 等）→ 活出口须重启对齐（恒重启不受开关）。
  it('开关 OFF + 选中节点参数被改（同 id）→ 强制重启对齐', async () => {
    const { run, fetchSubscription, applyConfigForcingRestart } = makeScheduler(
      oneSubConfig(),
      true
    );
    // 同指纹（host:port:cred:network 不变 → reconcile 保同 id）但内容字段变（sni 改）→ selectedModified。
    fetchSubscription.mockResolvedValue({
      servers: [ss({ name: 'S', address: '1.1.1.1', subscriptionId: 'd', sni: 'new.example.com' })],
    });
    await run();
    expect(applyConfigForcingRestart).toHaveBeenCalledTimes(1);
  });

  // review 非 finding#1 扩 F14：OFF 下**规则目标（非选中）**节点被改 → 恒重启（同为被引用节点，矩阵 line 88）。
  it('开关 OFF + 规则目标(非选中)节点被改 → 强制重启（被引用节点变更）', async () => {
    const config = makeConfig({
      subscriptions: [{ id: 'd', name: 'Direct', url: 'http://direct', autoUpdate: true }],
      servers: [
        ss({ id: 'S', name: 'S', address: '1.1.1.1', subscriptionId: 'd' }),
        ss({ id: 'T', name: 'T', address: '2.2.2.2', subscriptionId: 'd' }),
      ],
      selectedServerId: 'S', // 选中 S（不变），规则指向 T
      customRules: [
        {
          id: 'r1',
          type: 'domainSuffix',
          values: ['x'],
          action: 'proxy',
          enabled: true,
          targetServerId: 'T',
        },
      ],
    });
    const { run, fetchSubscription, applyConfigForcingRestart } = makeScheduler(config, true);
    // S 不变 + T（规则目标）改 sni（同指纹保 id）→ T 被引用被改 → referencedAffected。
    fetchSubscription.mockResolvedValue({
      servers: [
        ss({ name: 'S', address: '1.1.1.1', subscriptionId: 'd' }),
        ss({ name: 'T', address: '2.2.2.2', subscriptionId: 'd', sni: 'new.example.com' }),
      ],
    });
    await run();
    expect(applyConfigForcingRestart).toHaveBeenCalledTimes(1); // 规则目标(被引用)被改 → 恒重启，虽 OFF
  });
});
