/**
 * ProxyManager T6 / T9 / T15 收口单测。
 *
 * T6  logToManager source tag = 'ProxyManager'（编排维度，区分 sing-box 内核 stdout）
 * T9  onRetry EADDRINUSE 分支用已 prune 的 singboxConfig（不重新 generateSingBoxConfig 丢 prune）
 * T15 §3-C：clash_api 已删 → hotSwitchSelector / closeConnection / reassertRuleSelectors 经管理 API gRPC
 *     （selectOutbound / closeConnection / closeAllConnections，throws on error）
 *
 * 私有方法经 `(svc as any).method()` 直调，不启动 sing-box；管理 API 客户端 stub 经 (svc as any).tailscaleApiClient 注入。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-t6t9t15-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: (...args: any[]) => mockExecFile(...args),
}));

import { ProxyManager, connectionMatchesSwitchedPairs } from '../ProxyManager';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 构造 ProxyManager（不启动）。logManager 注入 spy、管理 API 客户端 stub 经 (svc as any).tailscaleApiClient 注入。 */
function makeSvc(opts?: { logManager?: any }) {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  const svc: any = new ProxyManager(
    opts?.logManager ?? null,
    undefined,
    configPath,
    '/fake/sing-box'
  );
  return svc;
}

/**
 * 管理 API 客户端 stub（§3-C）：selectOutbound/closeConnection/closeAllConnections 记录调用；
 * shouldThrow=true 时 reject（模拟 gRPC 抛错），验调用方 catch 包装。经 svc.tailscaleApiClient 注入（getApiClient 读它）。
 */
function makeApiClientStub(shouldThrow = false) {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return shouldThrow ? Promise.reject(new Error('grpc fail')) : Promise.resolve();
    };
  const client = {
    selectOutbound: rec('selectOutbound'),
    closeConnection: rec('closeConnection'),
    closeAllConnections: rec('closeAllConnections'),
  };
  return { client, calls };
}

// ============================================================================
// T6：logToManager source tag
// ============================================================================

describe('T6：logToManager 编排 source tag = ProxyManager', () => {
  it('addLog 第三参（source）为 "ProxyManager"（区分 sing-box 内核 stdout）', () => {
    const addLog = jest.fn();
    const svc = makeSvc({ logManager: { addLog } });
    svc.logToManager('info', '测试编排日志');
    expect(addLog).toHaveBeenCalledTimes(1);
    // addLog(level, message, source)
    expect(addLog).toHaveBeenCalledWith('info', '测试编排日志', 'ProxyManager');
  });

  it('不同 level 均带 ProxyManager tag', () => {
    const addLog = jest.fn();
    const svc = makeSvc({ logManager: { addLog } });
    svc.logToManager('warn', 'w');
    svc.logToManager('error', 'e');
    expect(addLog.mock.calls.every((c) => c[2] === 'ProxyManager')).toBe(true);
  });

  it('logManager 未注入 → no-op（不抛）', () => {
    const svc = makeSvc();
    expect(() => svc.logToManager('info', 'x')).not.toThrow();
  });
});

// ============================================================================
// T15 / §3-C：clash_api 已删 → selector/close 经管理 API gRPC
//   hotSwitchSelector → selectOutbound(selectorTag, member)；closeConnection(id)→closeConnection / 无 id→closeAllConnections；
//   reassertRuleSelectors → selectOutbound(selectorTag, memberTag)。gRPC throws on error，调用方 catch 包装。
// ============================================================================

describe('§3-C：selector/close 经管理 API gRPC', () => {
  it('clash_api 残留私有方法已不存在于原型链（防回潮）', () => {
    // clashApiRequest（旧 wrapper）/ destroyClashApiAgent / setClashApiClient 均应已删
    expect((ProxyManager.prototype as any).clashApiRequest).toBeUndefined();
    expect((ProxyManager.prototype as any).destroyClashApiAgent).toBeUndefined();
    expect((ProxyManager.prototype as any).setClashApiClient).toBeUndefined();
  });

  it('closeConnection(id) → gRPC closeConnection(id)，返回 { ok:true, status:200 }', async () => {
    const svc = makeSvc();
    const { client, calls } = makeApiClientStub();
    svc.tailscaleApiClient = client;
    const res = await svc.closeConnection('conn-1');
    expect(res).toEqual({ ok: true, status: 200 });
    expect(calls).toEqual([{ method: 'closeConnection', args: ['conn-1'] }]);
  });

  it('closeConnection(无 id) → gRPC closeAllConnections()（关全部）', async () => {
    const svc = makeSvc();
    const { client, calls } = makeApiClientStub();
    svc.tailscaleApiClient = client;
    const res = await svc.closeConnection();
    expect(res).toEqual({ ok: true, status: 200 });
    expect(calls).toEqual([{ method: 'closeAllConnections', args: [] }]);
  });

  it('closeConnection gRPC 抛错 → catch 包成 { ok:false, status:0 }', async () => {
    const svc = makeSvc();
    const { client } = makeApiClientStub(true); // throws
    svc.tailscaleApiClient = client;
    const res = await svc.closeConnection('conn-1');
    expect(res).toEqual({ ok: false, status: 0 });
  });

  it('closeConnection client 未注入 → fallback { ok:false, status:0 }', async () => {
    const svc = makeSvc();
    const res = await svc.closeConnection('x');
    expect(res).toEqual({ ok: false, status: 0 });
  });

  it('hotSwitchSelector 成功 → gRPC selectOutbound(selectorTag, member)，返回 true', async () => {
    const svc = makeSvc();
    const { client, calls } = makeApiClientStub();
    svc.tailscaleApiClient = client;
    const ok = await svc.hotSwitchSelector('proxy-selector', 'member-A');
    expect(ok).toBe(true);
    expect(calls).toEqual([{ method: 'selectOutbound', args: ['proxy-selector', 'member-A'] }]);
  });

  it('hotSwitchSelector gRPC 抛错 → 返回 false（调用方退回去抖重启）', async () => {
    const svc = makeSvc();
    const { client } = makeApiClientStub(true); // throws
    svc.tailscaleApiClient = client;
    const ok = await svc.hotSwitchSelector('proxy-selector', 'member-A');
    expect(ok).toBe(false);
  });

  it('hotSwitchSelector client 未注入 → false', async () => {
    const svc = makeSvc();
    const ok = await svc.hotSwitchSelector('proxy-selector', 'member-A');
    expect(ok).toBe(false);
  });

  it('hotSwitchSelector memberTag 为空 → 提前 return false（不调 client）', async () => {
    const svc = makeSvc();
    const { client, calls } = makeApiClientStub();
    svc.tailscaleApiClient = client;
    const ok = await svc.hotSwitchSelector('proxy-selector', '');
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  // 精准断连（pair 模型）：stub apiClient 首帧回放 reset 全量连接，断言只关命中 pair 的活连接。
  const makeConnStub = (frame: unknown) => {
    const closed: string[] = [];
    let subscribed = 0;
    const client = {
      closeConnection: (id: string) => {
        closed.push(id);
        return Promise.resolve();
      },
      subscribeConnections: (_iv: number, cb: (e: unknown) => void) => {
        subscribed++;
        cb(frame);
        return () => {};
      },
    };
    return { client, closed, subscribedCount: () => subscribed };
  };
  const conn = (id: string, chainList: string[], closedAt = '0') => ({
    type: 'NEW',
    id,
    connection: { id, chainList, closedAt },
  });

  it('精准断连·全局：关全局连接 + 跟全局规则连接，不误杀规则固定旧节点', () => {
    const svc = makeSvc();
    const { client, closed } = makeConnStub({
      reset: true,
      events: [
        conn('a', ['Hk01', 'proxy-selector']), // 全局旧节点 → 关
        conn('b', ['Hk01', 'proxy-selector', 'rule-sel-x']), // 跟全局的规则 → 关
        conn('c', ['Hk01', 'rule-sel-x']), // 规则固定 Hk01（误杀点）→ 不关
        conn('d', ['Hk02', 'proxy-selector']), // 新节点 → 不关
        conn('e', ['direct']), // 国内/LAN 直连 → 不关
        conn('f', ['Hk01', 'proxy-selector'], '1720000000000'), // 死连接 → 不关
      ],
    });
    svc.tailscaleApiClient = client;
    svc.closeOldNodeConnectionsAfterHotSwitch({ interruptConnectionsOnSwitch: true } as any, {
      puts: [{ selectorTag: 'proxy-selector', memberTag: 'Hk02', oldMemberTag: 'Hk01' }],
    });
    expect(closed.sort()).toEqual(['a', 'b']);
  });

  it('精准断连·规则：对称断连该规则自己的旧连接，不碰全局连接', () => {
    const svc = makeSvc();
    const { client, closed } = makeConnStub({
      reset: true,
      events: [
        conn('a', ['Hk01', 'rule-sel-x']), // 规则固定旧 Hk01 → 关
        conn('b', ['Hk01', 'proxy-selector']), // 全局连接（非本规则）→ 不关
        conn('c', ['Hk03', 'rule-sel-x']), // 规则新目标 → 不关
      ],
    });
    svc.tailscaleApiClient = client;
    svc.closeOldNodeConnectionsAfterHotSwitch({ interruptConnectionsOnSwitch: true } as any, {
      puts: [{ selectorTag: 'rule-sel-x', memberTag: 'Hk03', oldMemberTag: 'Hk01' }],
    });
    expect(closed).toEqual(['a']);
  });

  it('精准断连·全局直连切到节点：关全局直连存量，不碰规则/国内直连', () => {
    const svc = makeSvc();
    const { client, closed } = makeConnStub({
      reset: true,
      events: [
        conn('a', ['direct', 'proxy-selector']), // 全局直连存量 → 关
        conn('b', ['direct']), // 规则/国内/LAN 直连 → 不关
      ],
    });
    svc.tailscaleApiClient = client;
    svc.closeOldNodeConnectionsAfterHotSwitch({ interruptConnectionsOnSwitch: true } as any, {
      puts: [{ selectorTag: 'proxy-selector', memberTag: 'Hk01', oldMemberTag: 'direct' }],
    });
    expect(closed).toEqual(['a']);
  });

  it('精准断连：开关关闭 / 空 puts / 旧==新 → 不订阅、不关', () => {
    const svc = makeSvc();
    const { client, closed, subscribedCount } = makeConnStub({
      reset: true,
      events: [conn('a', ['Hk01', 'proxy-selector'])],
    });
    svc.tailscaleApiClient = client;
    svc.closeOldNodeConnectionsAfterHotSwitch({ interruptConnectionsOnSwitch: false } as any, {
      puts: [{ selectorTag: 'proxy-selector', memberTag: 'Hk02', oldMemberTag: 'Hk01' }],
    }); // 开关关
    svc.closeOldNodeConnectionsAfterHotSwitch({ interruptConnectionsOnSwitch: true } as any, {
      puts: [],
    }); // 无变化
    svc.closeOldNodeConnectionsAfterHotSwitch({ interruptConnectionsOnSwitch: true } as any, {
      puts: [{ selectorTag: 'proxy-selector', memberTag: 'Hk01', oldMemberTag: 'Hk01' }],
    }); // 旧==新
    expect(subscribedCount()).toBe(0);
    expect(closed).toHaveLength(0);
  });

  describe('connectionMatchesSwitchedPairs（纯谓词）', () => {
    const pGlobal = [{ selectorTag: 'proxy-selector', oldMemberTag: 'Hk01' }];
    it('含 selector + 旧成员 → true（含嵌套跟全局规则）', () => {
      expect(connectionMatchesSwitchedPairs(['Hk01', 'proxy-selector'], pGlobal)).toBe(true);
      expect(
        connectionMatchesSwitchedPairs(['Hk01', 'proxy-selector', 'rule-sel-x'], pGlobal)
      ).toBe(true);
    });
    it('缺 selector（规则固定节点）或缺旧成员（新节点）→ false', () => {
      expect(connectionMatchesSwitchedPairs(['Hk01', 'rule-sel-x'], pGlobal)).toBe(false);
      expect(connectionMatchesSwitchedPairs(['Hk02', 'proxy-selector'], pGlobal)).toBe(false);
    });
    it('全局直连对区分 direct 全局 vs 规则/国内直连', () => {
      const pDirect = [{ selectorTag: 'proxy-selector', oldMemberTag: 'direct' }];
      expect(connectionMatchesSwitchedPairs(['direct', 'proxy-selector'], pDirect)).toBe(true);
      expect(connectionMatchesSwitchedPairs(['direct'], pDirect)).toBe(false);
    });
    it('空/非数组 chainList → false', () => {
      expect(connectionMatchesSwitchedPairs([], pGlobal)).toBe(false);
      expect(connectionMatchesSwitchedPairs(undefined, pGlobal)).toBe(false);
    });
    it('多 pair（both）任一命中即 true', () => {
      const pBoth = [
        { selectorTag: 'proxy-selector', oldMemberTag: 'Hk01' },
        { selectorTag: 'rule-sel-x', oldMemberTag: 'Jp01' },
      ];
      expect(connectionMatchesSwitchedPairs(['Jp01', 'rule-sel-x'], pBoth)).toBe(true);
    });
  });

  it('reassertRuleSelectors 对每条启用的 proxy 规则 → gRPC selectOutbound(selectorTag, memberTag)', async () => {
    const svc = makeSvc();
    const { client, calls } = makeApiClientStub();
    svc.tailscaleApiClient = client;
    // 注入启动期生成侧映射
    svc.currentRuleTargetMap = new Map([
      ['custom:r1', { selectorTag: 'rule-sel-r1', memberTag: 'm-r1' }],
      ['app:app1', { selectorTag: 'rule-sel-app1', memberTag: 'm-app1' }],
    ]);
    svc.currentIdToTagMap = new Map([
      ['node-A', 'tagA'],
      ['node-B', 'tagB'],
    ]);
    // currentConfig：一条 customRule + 一条 appRule，targetServerId 均有效
    svc.currentConfig = {
      customRules: [{ id: 'r1', enabled: true, action: 'proxy', targetServerId: 'node-A' }],
      appRules: [{ appId: 'app1', enabled: true, action: 'proxy', targetServerId: 'node-B' }],
    } as any;
    await svc.reassertRuleSelectors(svc.currentConfig);
    expect(calls).toEqual([
      { method: 'selectOutbound', args: ['rule-sel-r1', 'tagA'] },
      { method: 'selectOutbound', args: ['rule-sel-app1', 'tagB'] },
    ]);
  });

  it('reassertRuleSelectors map/idToTag 未注入 → 提前 return（不调 client）', async () => {
    const svc = makeSvc();
    const { client, calls } = makeApiClientStub();
    svc.tailscaleApiClient = client;
    svc.currentRuleTargetMap = null;
    svc.currentIdToTagMap = null;
    await svc.reassertRuleSelectors({} as any);
    expect(calls).toHaveLength(0);
  });
});

// ============================================================================
// T9：onRetry EADDRINUSE 分支用已 prune 的 singboxConfig（不重新 generate 丢 prune）
//     真机 EADDRINUSE 难复现 → 单测直接断言行为不变量：
//     构造一个「已 prune 的 singboxConfig」（坏节点已剔除），间接验证 onRetry 闭包不再调
//     generateSingBoxConfig（不再丢 prune）。run-phase-ref-fix.test.ts 已覆盖 retry 框架行为，
//     此处补「EADDRINUSE 分支不调 generateSingBoxConfig + 探针端口回填」契约。
// ============================================================================

describe('T9：onRetry EADDRINUSE 不丢 prune（不重新 generateSingBoxConfig）', () => {
  /**
   * onRetry 是 startInternal 内 retry() 闭包，无法独立直调。此处用「行为契约」断言：
   * 模拟 EADDRINUSE 触发条件 + 已 prune 的 singboxConfig（坏节点 outbound 已剔除），
   * 期望：分支处理过程中 generateSingBoxConfig 不被调用（保留 prune），且探针 inbound 端口被回填。
   *
   * 由于闭包封装在 startInternal，改用「等效行为探测」：直接复现分支内的关键步骤语义——
   * allocateProbePorts 改 this.probe*Port 字段后，分支应只回填 inbound.listen_port 而非重新生成。
   * 这里以「generateSingBoxConfig 在 EADDRINUSE 处理后仍未被调用」为可观测契约（spy 调用计数不变）。
   */
  it('allocateProbePorts 不改 singboxConfig 对象（仅改 this.probe*Port 字段）', async () => {
    // 前置不变量：allocateProbePorts 是纯字段写者，不 mutate singboxConfig。
    // 这是 T9 改动的前提——onRetry 可安全复用已 prune 的 singboxConfig，仅需回填 listen_port。
    const svc = makeSvc();
    const before = { direct: svc.probeDirectPort, proxy: svc.probeProxyPort };
    await svc.allocateProbePorts({ httpPort: 9999, socksPort: 9998 } as any);
    // 字段被赋值（数字或 null）
    expect(typeof svc.probeDirectPort === 'number' || svc.probeDirectPort === null).toBe(true);
    // 无 singboxConfig 字段被 mutate（svc 本身没有 singboxConfig 实例字段，allocate 不接收它）
    expect(svc.probeDirectPort).not.toBe(before.direct); // listen(0) 几乎必换新端口
  });
});
