/**
 * SERVER_DELETE_BATCH 批量删除 handler 单测。
 *
 * 收敛目标（修复「多选删除只删 1 个」的根因 = N 个并发单删各读旧配置、末次写覆盖前面）：
 *  1. 原子性：一次 saveConfig 写回剩余节点（不是 per-id 多写）。
 *  2. selectedServerId：命中删除集合 → 清 null（否则 validateConfig 抛「指向不存在节点」）；不命中 → 不动。
 *  3. 副作用与单删等价：每个被删 Tailscale 节点 rm 其 state 目录；每个带凭据的 WARP 节点入待注销队列。
 *  4. 幂等：不存在的 id 静默跳过；空集合不写配置、返回 0。
 *
 * 隔离：mock electron(ipcMain.handle 捕获 handler) + fs/promises(rm) + tailscale-state + WarpDeregisterQueue
 *   + ProtocolParser/ConfigManager/WarpService（仅作签名占位，避免加载重依赖）。
 */
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import { mainEventEmitter, MAIN_EVENTS } from '../../ipc/main-events';
import { DIRECT_SERVER_ID } from '../../../shared/direct-selection';

const handleSpy = jest.fn();
jest.mock('electron', () => ({
  ipcMain: {
    handle: (...args: any[]) => handleSpy(...args),
    removeHandler: jest.fn(),
  },
}));

const rmSpy = jest.fn().mockResolvedValue(undefined);
jest.mock('fs/promises', () => ({
  rm: (...args: any[]) => rmSpy(...args),
}));

jest.mock('../tailscale-state', () => ({
  tailscaleStateDir: (id: string) => `/state/${id}`,
}));

const enqueueSpy = jest.fn().mockResolvedValue(undefined);
jest.mock('../WarpDeregisterQueue', () => ({
  getWarpDeregisterQueue: () => ({ enqueue: (...a: any[]) => enqueueSpy(...a) }),
}));

// 下列仅在 server-handlers 顶部作值导入 / 函数签名占位，删除路径不触达其实现 → 占位 class 即可。
jest.mock('../ProtocolParser', () => ({ ProtocolParser: class {} }));
jest.mock('../ConfigManager', () => ({ ConfigManager: class {} }));
jest.mock('../WarpService', () => ({ WarpService: class {} }));

// F-1：删除恒 sendToAll('event:configChanged')（渲染端差集刷新）。mock 避免真实 BrowserWindow（未 mock 会炸）。
const sendToAllSpy = jest.fn();
jest.mock('../../ipc/ipc-events', () => ({
  ipcEventEmitter: { sendToAll: (...a: any[]) => sendToAllSpy(...a) },
}));

function makeConfig() {
  return {
    selectedServerId: 's2' as string | null,
    servers: [
      { id: 's1', name: 'A', protocol: 'vless' },
      { id: 's2', name: 'B', protocol: 'tailscale' },
      {
        id: 's3',
        name: 'C',
        protocol: 'wireguard',
        wireguardSettings: { warpDevice: { token: 'tok', deviceId: 'dev' } },
      },
      { id: 's4', name: 'D', protocol: 'vmess' },
    ],
  };
}

const loadConfigSpy = jest.fn();
const saveConfigSpy = jest.fn().mockResolvedValue(undefined);
const configManager = { loadConfig: loadConfigSpy, saveConfig: saveConfigSpy } as any;

let batchHandler: (
  event: any,
  args: { serverIds: string[]; fallbackSelectedId?: string | null }
) => Promise<any>;
let emitSpy: jest.SpyInstance;

beforeAll(() => {
  const { registerServerHandlers } = require('../../ipc/handlers/server-handlers');
  registerServerHandlers({} as any, configManager);
  const call = handleSpy.mock.calls.find((c) => c[0] === IPC_CHANNELS.SERVER_DELETE_BATCH);
  if (!call) throw new Error('SERVER_DELETE_BATCH handler 未注册');
  batchHandler = call[1];
});

beforeEach(() => {
  loadConfigSpy.mockImplementation(async () => makeConfig());
  saveConfigSpy.mockClear();
  rmSpy.mockClear();
  enqueueSpy.mockClear();
  // D4：spy emit（无 listener→本就 no-op，仅为断言「删选中/被规则指向→触发 CONFIG_CHANGED 重启」）。
  emitSpy = jest.spyOn(mainEventEmitter, 'emit').mockReturnValue(true);
});

afterEach(() => emitSpy.mockRestore());

// registerIpcHandler 把 handler 包成返回 ApiResponse {success,data} → 解包 data。
async function invoke(serverIds: string[], fallbackSelectedId?: string | null): Promise<number> {
  const res = await batchHandler({}, { serverIds, fallbackSelectedId });
  return res.data;
}
const emittedConfigChanged = () =>
  emitSpy.mock.calls.some((c) => c[0] === MAIN_EVENTS.CONFIG_CHANGED);

describe('SERVER_DELETE_BATCH', () => {
  it('一次 saveConfig 删除全部入参节点（非未选中节点）', async () => {
    const count = await invoke(['s1', 's3', 's4']);
    expect(count).toBe(3);
    expect(saveConfigSpy).toHaveBeenCalledTimes(1);
    const saved = saveConfigSpy.mock.calls[0][0];
    expect(saved.servers.map((s: any) => s.id)).toEqual(['s2']);
  });

  it('未命中选中/未被规则指向 → selectedServerId 不变 + 恒双播（F-1；重启分类归 switchMode canSkip）', async () => {
    sendToAllSpy.mockClear();
    await invoke(['s1', 's4']);
    expect(saveConfigSpy.mock.calls[0][0].selectedServerId).toBe('s2');
    // F-1：删除**恒** emit + sendToAll（不再在 handler 层复刻 wasSelected‖ruleTargeted 判据——那漏 detour/endpoint）。
    // 「未引用删除不重启」的 defer 判定移到 switchMode.canSkipRestartForAddedUnreferenced（此处不可观测）。
    expect(emittedConfigChanged()).toBe(true);
    expect(sendToAllSpy).toHaveBeenCalledWith('event:configChanged', expect.objectContaining({}));
  });

  it('命中选中节点(无兜底) → selectedServerId=DIRECT_SERVER_ID（0 剩余走直连哨兵，非 null）+ 触发重启', async () => {
    await invoke(['s2']);
    expect(saveConfigSpy.mock.calls[0][0].selectedServerId).toBe(DIRECT_SERVER_ID);
    expect(emittedConfigChanged()).toBe(true);
  });

  it('命中选中节点 + 传兜底 → selectedServerId=兜底节点 id + 触发重启', async () => {
    await invoke(['s2'], 's4');
    expect(saveConfigSpy.mock.calls[0][0].selectedServerId).toBe('s4');
    expect(emittedConfigChanged()).toBe(true);
  });

  it('命中被规则指向的非选中节点 → 触发重启（清运行核陈旧引用）+ selectedServerId 不动', async () => {
    loadConfigSpy.mockImplementationOnce(async () => ({
      ...makeConfig(),
      customRules: [{ enabled: true, action: 'proxy', targetServerId: 's1' }],
    }));
    await invoke(['s1']); // s1 非选中（选中 s2），但被规则指向
    expect(emittedConfigChanged()).toBe(true);
    expect(saveConfigSpy.mock.calls[0][0].selectedServerId).toBe('s2');
  });

  it('每个被删 WARP 节点入待注销队列（副作用与单删等价）', async () => {
    await invoke(['s3']);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'dev', token: 'tok' })
    );
  });

  it('每个被删 Tailscale 节点清其 state 目录', async () => {
    await invoke(['s2']);
    expect(rmSpy).toHaveBeenCalledWith('/state/s2', expect.objectContaining({ recursive: true }));
  });

  it('非 WARP/非 TS 节点不触发任何副作用', async () => {
    await invoke(['s1', 's4']);
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(rmSpy).not.toHaveBeenCalled();
  });

  it('不存在的 id 静默跳过、只删真实命中', async () => {
    const count = await invoke(['s1', 'ghost']);
    expect(count).toBe(1);
    expect(saveConfigSpy.mock.calls[0][0].servers.map((s: any) => s.id)).toEqual([
      's2',
      's3',
      's4',
    ]);
  });

  it('空集合：不写配置、返回 0', async () => {
    const count = await invoke([]);
    expect(count).toBe(0);
    expect(saveConfigSpy).not.toHaveBeenCalled();
  });
});
