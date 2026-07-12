/**
 * ProxyManager：选中账号制（Tailscale）节点的「隧道就绪即 emit」去重 + 会话起点重置单测。
 *
 * 背景（修 review Med）：handleTailscaleStatus 用 lastTsSelectedRunningId 对「选中 TS 节点翻 Running」做上升沿去重
 * （STATUS 持续推帧不每帧触发）；运行期掉线/切节点由「本帧非 Running → 清标记」兜。但 stop() 断 tailscaleApiClient
 * 后不再有 STATUS 帧来清此标记，残留的 Running 标记会让重连同一节点时新 STATUS 首帧 Running 被去重命中、
 * 'tailscale-selected-running' 不发射 → 事件驱动出口 re-probe 丢失。修：startInternal 起点显式重置该字段。
 *
 * 全 mock、零网络、零进程：仅直接驱动 private handleTailscaleStatus（推 STATUS 帧）+ 验字段/事件，
 * 并验 startInternal 起点重置点（spy maybePromptHelperGate reject 截停于任何 spawn/写盘之前）。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-ts-selrun-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {
    static isSupported() {
      return false;
    }
  },
  shell: { openExternal: jest.fn(() => Promise.resolve()) },
  net: {},
  session: {},
}));

// ResourceManager mock：startInternal 早段（重置行之后、截停点之前）在 Linux 会调 ensureWritableCore 准备可写核 —— mock
// 成安全 no-op，杜绝任何真核拷贝/文件系统副作用（本测仅验字段重置点，不跑真 spawn/写盘/版本探测）。
jest.mock('../ResourceManager', () => ({
  resourceManager: {
    ensureWritableCore: jest.fn(async () => '/fake/sing-box'),
    getSingBoxPath: jest.fn(() => '/fake/sing-box'),
  },
}));

import { ProxyManager } from '../ProxyManager';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { ServerConfig, UserConfig } from '../../../shared/types';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function tsServer(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'srv-ts',
    name: 'my-ts',
    protocol: 'tailscale',
    address: '',
    port: 0,
    tailscaleSettings: {},
    ...over,
  } as ServerConfig;
}

/** 构造 ProxyManager + fake mainWindow（webContents.send no-op，仅吸收 emitTailscaleStatus）。 */
function makeSvc() {
  const sent: { channel: string; data: any }[] = [];
  const mainWindow: any = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, data: any) => sent.push({ channel, data }) },
  };
  const svc: any = new ProxyManager(
    { addLog: jest.fn() } as any,
    mainWindow,
    path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`),
    '/fake/sing-box'
  );
  return { svc, sent };
}

/** currentConfig：选中一个 TS 节点为全局出口。 */
function configWithSelectedTs(): UserConfig {
  return {
    selectedServerId: 'srv-ts',
    servers: [tsServer()],
  } as unknown as UserConfig;
}

const RUNNING = [{ endpointTag: 'my-ts', backendState: 'Running', authURL: '' }];
const STARTING = [{ endpointTag: 'my-ts', backendState: 'Starting', authURL: '' }];
const NEEDS_LOGIN = [
  { endpointTag: 'my-ts', backendState: 'NeedsLogin', authURL: 'https://login.tailscale.com/a/x' },
];

describe('选中 TS 节点 Running 上升沿 → emit tailscale-selected-running（去重）', () => {
  it('首帧 Running → emit + 置 lastTsSelectedRunningId；持续 Running 帧不重复 emit', () => {
    const { svc } = makeSvc();
    svc.currentConfig = configWithSelectedTs();
    const emitted = jest.fn();
    svc.on('tailscale-selected-running', emitted);

    svc.handleTailscaleStatus(RUNNING);
    expect(emitted).toHaveBeenCalledTimes(1);
    expect(svc.lastTsSelectedRunningId).toBe('srv-ts');

    // 同节点持续推 Running（STATUS 流每秒推帧）→ 去重命中，不再 emit。
    svc.handleTailscaleStatus(RUNNING);
    svc.handleTailscaleStatus(RUNNING);
    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it('Starting / 非 Running 不触发；运行期翻 Running 才上升沿 emit', () => {
    const { svc } = makeSvc();
    svc.currentConfig = configWithSelectedTs();
    const emitted = jest.fn();
    svc.on('tailscale-selected-running', emitted);

    svc.handleTailscaleStatus(STARTING);
    expect(emitted).not.toHaveBeenCalled();
    expect(svc.lastTsSelectedRunningId).toBeNull();

    svc.handleTailscaleStatus(RUNNING);
    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it('运行期掉线（本帧非 Running）→ 清标记，重新 Running 能再 emit（覆盖运行期重连）', () => {
    const { svc } = makeSvc();
    svc.currentConfig = configWithSelectedTs();
    const emitted = jest.fn();
    svc.on('tailscale-selected-running', emitted);

    svc.handleTailscaleStatus(RUNNING);
    expect(emitted).toHaveBeenCalledTimes(1);

    // 掉线一帧（非 Running）→ STATUS 流自身清标记。
    svc.handleTailscaleStatus(STARTING);
    expect(svc.lastTsSelectedRunningId).toBeNull();

    svc.handleTailscaleStatus(RUNNING);
    expect(emitted).toHaveBeenCalledTimes(2);
  });
});

describe('会话起点重置 lastTsSelectedRunningId（修 stop 后重连同节点丢事件）', () => {
  it('stop 后残留 Running 标记，下次会话起点（startInternal）归零 → 重连同节点能再次 emit', async () => {
    const { svc } = makeSvc();
    svc.currentConfig = configWithSelectedTs();
    const emitted = jest.fn();
    svc.on('tailscale-selected-running', emitted);

    // 会话 1：选中 TS 节点翻 Running → emit。
    svc.handleTailscaleStatus(RUNNING);
    expect(emitted).toHaveBeenCalledTimes(1);
    expect(svc.lastTsSelectedRunningId).toBe('srv-ts');

    // 模拟 stop()：断 tailscaleApiClient（不再有 STATUS 帧来清标记），末状态 Running 标记残留。
    // stop() 在无进程时早退、不清此字段 —— 故标记一直残留到下次会话。
    await svc.stop();
    expect(svc.lastTsSelectedRunningId).toBe('srv-ts'); // 残留确认（stop 本身不重置）

    // 会话 2：startInternal 起点重置该字段。spy maybePromptHelperGate reject 截停于任何 spawn/写盘/版本探测之前
    // （重置行在 startInternal 极早处、先于这些重活），既验重置点又不触碰真核/网络。
    jest.spyOn(svc, 'maybePromptHelperGate').mockRejectedValue(new Error('test-cut-before-spawn'));
    await expect(svc.startInternal(configWithSelectedTs(), { interactive: true })).rejects.toThrow(
      'test-cut-before-spawn'
    );
    expect(svc.lastTsSelectedRunningId).toBeNull(); // 会话起点已归零

    // 会话 2 的新 STATUS 首帧 Running → 标记已干净 → 能再次 emit（修复前会被残留标记去重吞掉）。
    svc.currentConfig = configWithSelectedTs();
    svc.handleTailscaleStatus(RUNNING);
    expect(emitted).toHaveBeenCalledTimes(2);
  });
});

describe('缺陷1 登录期出口让位对账（reconcileLoginFallback，经 handleTailscaleStatus 驱动）', () => {
  // 微任务 flush：reconcile 是 async void（handleTailscaleStatus 内 void 掉）→ PUT+翻 flag 在 await 之后，
  // 断言前须 flush（setImmediate 排到宏任务尾，微任务链已清）。
  const flush = () => new Promise((r) => setImmediate(r));

  // 选中一个【承载全隧道】的 TS 出口——P0b 后 meshAllowsInternet(TS) 由 exit_node 派生，故须配 exitNode 才承载全隧道
  // （meshSelectedExitFallsBackToDirect=false）、符合让位条件。（旧 fixture 只 allowInternet:true 无 exitNode → P0b 后
  // 回退 direct、不符合让位——见 §H F1 + 下方 S-b 反例用例。）
  function fullTunnelTsConfig(over: Partial<UserConfig> = {}): UserConfig {
    return {
      selectedServerId: 'srv-ts',
      proxyMode: 'smart',
      servers: [tsServer({ tailscaleSettings: { allowInternet: true, exitNode: '100.64.0.1' } })],
      ...over,
    } as unknown as UserConfig;
  }

  it('选中 TS 出口 NeedsLogin → engage：hotSwitch(proxy-selector,direct) + PUT 成功才置 flag', async () => {
    const { svc } = makeSvc();
    svc.currentConfig = fullTunnelTsConfig();
    svc.currentIdToTagMap = new Map([['srv-ts', 'my-ts']]);
    const hot = jest.spyOn(svc, 'hotSwitchSelector').mockResolvedValue(true);

    svc.handleTailscaleStatus(NEEDS_LOGIN);
    await flush();
    expect(hot).toHaveBeenCalledWith('proxy-selector', 'direct');
    expect(svc.bootstrapFallbackEngaged).toBe(true);
    expect(svc.bootstrapFallbackServerId).toBe('srv-ts');
  });

  it('engage 效果幂等：连续 NeedsLogin 帧 flag 稳定 + UI 只 emit engaged:true 一次（N1 修复：允许重 PUT direct 自愈）', async () => {
    const { svc, sent } = makeSvc();
    svc.currentConfig = fullTunnelTsConfig();
    svc.currentIdToTagMap = new Map([['srv-ts', 'my-ts']]);
    jest.spyOn(svc, 'hotSwitchSelector').mockResolvedValue(true);
    svc.handleTailscaleStatus(NEEDS_LOGIN);
    await flush();
    svc.handleTailscaleStatus(NEEDS_LOGIN);
    await flush();
    // 效果幂等：flag 稳定 engaged；N1 修复后每帧重 PUT direct（核侧 no-op 自愈），但 UI engaged:true 仅一次（first 守卫）。
    expect(svc.bootstrapFallbackEngaged).toBe(true);
    expect(svc.bootstrapFallbackServerId).toBe('srv-ts');
    const engagedTrueEmits = sent.filter(
      (e) => e.channel === IPC_CHANNELS.EVENT_MESH_LOGIN_FALLBACK && e.data?.engaged === true
    );
    expect(engagedTrueEmits).toHaveLength(1);
  });

  it('[review N1] engaged 期间 selector 被外部改回死 tag（模拟 reassert 竞态）→ 后续 NeedsLogin 帧重 PUT direct 自愈', async () => {
    const { svc } = makeSvc();
    svc.currentConfig = fullTunnelTsConfig();
    svc.currentIdToTagMap = new Map([['srv-ts', 'my-ts']]);
    const hot = jest.spyOn(svc, 'hotSwitchSelector').mockResolvedValue(true);
    svc.handleTailscaleStatus(NEEDS_LOGIN); // engage
    await flush();
    expect(svc.bootstrapFallbackEngaged).toBe(true);
    hot.mockClear();
    // N1 反例：flag 仍 engaged，但（并发 reassert）selector 已被 PUT 回死 tag。下一 NeedsLogin 帧（或 10s 健康检查）
    // 须【重】PUT direct 自愈——短路存在时此处 hot 不会被调用（旧 bug），修复后必被调用。
    svc.handleTailscaleStatus(NEEDS_LOGIN);
    await flush();
    expect(hot).toHaveBeenCalledWith('proxy-selector', 'direct');
  });

  it('[review finding 2] engage PUT 失败 → 不置 flag，后续帧重试（不被永久扼杀）', async () => {
    const { svc } = makeSvc();
    svc.currentConfig = fullTunnelTsConfig();
    svc.currentIdToTagMap = new Map([['srv-ts', 'my-ts']]);
    const hot = jest.spyOn(svc, 'hotSwitchSelector').mockResolvedValue(false); // PUT 失败

    svc.handleTailscaleStatus(NEEDS_LOGIN);
    await flush();
    expect(svc.bootstrapFallbackEngaged).toBe(false); // 失败不置 flag（避免 flag 与 selector 脱节）
    expect(hot).toHaveBeenCalledTimes(1);

    hot.mockResolvedValue(true); // 下一帧管理 API 恢复
    svc.handleTailscaleStatus(NEEDS_LOGIN);
    await flush();
    expect(svc.bootstrapFallbackEngaged).toBe(true); // 重试成功（未被去重扼杀）
    expect(hot).toHaveBeenCalledTimes(2);
  });

  it('隧道 Running → restore：hotSwitch 切回 TS tag + PUT 成功才清 flag', async () => {
    const { svc } = makeSvc();
    svc.currentConfig = fullTunnelTsConfig();
    svc.currentIdToTagMap = new Map([['srv-ts', 'my-ts']]);
    const hot = jest.spyOn(svc, 'hotSwitchSelector').mockResolvedValue(true);

    svc.handleTailscaleStatus(NEEDS_LOGIN); // engage
    await flush();
    hot.mockClear();
    svc.handleTailscaleStatus(RUNNING); // restore
    await flush();
    expect(hot).toHaveBeenCalledWith('proxy-selector', 'my-ts');
    expect(svc.bootstrapFallbackEngaged).toBe(false);
    expect(svc.bootstrapFallbackServerId).toBeNull();
  });

  it('[review finding 2] restore PUT 失败 → 保持 engaged，后续 Running 帧重试（不永久卡 direct）', async () => {
    const { svc } = makeSvc();
    svc.currentConfig = fullTunnelTsConfig();
    svc.currentIdToTagMap = new Map([['srv-ts', 'my-ts']]);
    const hot = jest.spyOn(svc, 'hotSwitchSelector').mockResolvedValue(true);
    svc.handleTailscaleStatus(NEEDS_LOGIN); // engage
    await flush();

    hot.mockResolvedValue(false); // restore PUT 失败
    svc.handleTailscaleStatus(RUNNING);
    await flush();
    expect(svc.bootstrapFallbackEngaged).toBe(true); // 失败仍 engaged（未谎报切回、未清 flag）

    hot.mockResolvedValue(true); // 又一 Running 帧（管理 API 恢复）→ 重试成功
    svc.handleTailscaleStatus(RUNNING);
    await flush();
    expect(svc.bootstrapFallbackEngaged).toBe(false);
    expect(hot).toHaveBeenLastCalledWith('proxy-selector', 'my-ts');
  });

  it('切出口（selectedServerId 变为非 TS/其它）→ disengage 清 flag，不 PUT 回旧 tag', async () => {
    const { svc } = makeSvc();
    svc.currentConfig = fullTunnelTsConfig();
    svc.currentIdToTagMap = new Map([['srv-ts', 'my-ts']]);
    const hot = jest.spyOn(svc, 'hotSwitchSelector').mockResolvedValue(true);
    svc.handleTailscaleStatus(NEEDS_LOGIN); // engage srv-ts
    await flush();
    expect(svc.bootstrapFallbackEngaged).toBe(true);
    hot.mockClear();

    // 用户切到别的出口：selectedServerId 变（该节点无 STATUS 缓存帧 → backendState undefined）。
    svc.currentConfig = { ...svc.currentConfig, selectedServerId: 'other' };
    svc.handleTailscaleStatus(RUNNING); // 仍是 my-ts 帧，但选中已是 other
    await flush();
    expect(svc.bootstrapFallbackEngaged).toBe(false);
    expect(svc.bootstrapFallbackServerId).toBeNull();
    expect(hot).not.toHaveBeenCalledWith('proxy-selector', 'my-ts'); // 切走→不 PUT（planHotSwitch 管）
  });

  it('[finding 8] 让位中关开关（reconcile 见 eligible=false）→ PUT 切回出口 tag + 清 flag', async () => {
    const { svc } = makeSvc();
    svc.currentConfig = fullTunnelTsConfig();
    svc.currentIdToTagMap = new Map([['srv-ts', 'my-ts']]);
    const hot = jest.spyOn(svc, 'hotSwitchSelector').mockResolvedValue(true);
    svc.handleTailscaleStatus(NEEDS_LOGIN); // engage
    await flush();
    hot.mockClear();

    // 关开关：同一选中出口，eligible 变 false → 撤销让位并 PUT 回出口 tag（用户明确「宁可授权失败也不直连」）。
    svc.currentConfig = { ...svc.currentConfig, meshLoginFallbackDirect: false };
    await svc.reconcileLoginFallback('NeedsLogin');
    expect(hot).toHaveBeenCalledWith('proxy-selector', 'my-ts');
    expect(svc.bootstrapFallbackEngaged).toBe(false);
  });

  it('开关关闭（meshLoginFallbackDirect=false）→ NeedsLogin 不 engage', async () => {
    const { svc } = makeSvc();
    svc.currentConfig = fullTunnelTsConfig({ meshLoginFallbackDirect: false });
    svc.currentIdToTagMap = new Map([['srv-ts', 'my-ts']]);
    const hot = jest.spyOn(svc, 'hotSwitchSelector').mockResolvedValue(true);
    svc.handleTailscaleStatus(NEEDS_LOGIN);
    await flush();
    expect(hot).not.toHaveBeenCalled();
    expect(svc.bootstrapFallbackEngaged).toBe(false);
  });

  it('子网段-only TS 出口（无 exit_node）→ 不 engage（final 已直连，无死锁）', async () => {
    const { svc } = makeSvc();
    svc.currentConfig = {
      selectedServerId: 'srv-ts',
      proxyMode: 'smart',
      servers: [tsServer({ tailscaleSettings: { allowInternet: false } })],
    } as unknown as UserConfig;
    svc.currentIdToTagMap = new Map([['srv-ts', 'my-ts']]);
    const hot = jest.spyOn(svc, 'hotSwitchSelector').mockResolvedValue(true);
    svc.handleTailscaleStatus(NEEDS_LOGIN);
    await flush();
    expect(hot).not.toHaveBeenCalled();
    expect(svc.bootstrapFallbackEngaged).toBe(false);
  });

  it('[P0b/S-b] 选中 TS 有 allowInternet:true 但【无 exit_node】+ NeedsLogin → 不 engage（P0b 后 final 回退 direct，授权页本就可达）', async () => {
    const { svc } = makeSvc();
    // quick-join 造出的 S-b 态：allowInternet:true 但无 exit_node。P0b 后 meshAllowsInternet 由 exit_node 派生=false
    // → meshSelectedExitFallsBackToDirect=true → loginFallbackEligible=false → 不 engage（正确收敛，非死锁）。
    svc.currentConfig = {
      selectedServerId: 'srv-ts',
      proxyMode: 'smart',
      servers: [tsServer({ tailscaleSettings: { allowInternet: true } })],
    } as unknown as UserConfig;
    svc.currentIdToTagMap = new Map([['srv-ts', 'my-ts']]);
    const hot = jest.spyOn(svc, 'hotSwitchSelector').mockResolvedValue(true);
    svc.handleTailscaleStatus(NEEDS_LOGIN);
    await flush();
    expect(hot).not.toHaveBeenCalled();
    expect(svc.bootstrapFallbackEngaged).toBe(false);
  });

  it('过渡态（Starting）不翻转：未 engage 保持不动（避免已登录节点起核闪直连）', async () => {
    const { svc } = makeSvc();
    svc.currentConfig = fullTunnelTsConfig();
    svc.currentIdToTagMap = new Map([['srv-ts', 'my-ts']]);
    const hot = jest.spyOn(svc, 'hotSwitchSelector').mockResolvedValue(true);
    svc.handleTailscaleStatus(STARTING);
    await flush();
    expect(hot).not.toHaveBeenCalled();
    expect(svc.bootstrapFallbackEngaged).toBe(false);
  });
});

describe('S1（§13.2）selector-settled 门：whenSelectorSettled', () => {
  it('无在跑 deferred（未 reset）→ 即时 resolve（零成本放行）', async () => {
    const { svc } = makeSvc();
    await expect(svc.whenSelectorSettled(5000)).resolves.toBeUndefined();
  });

  it('reset 后 pending → markSelectorSettled 即 resolve（reassert 完成放行首探）', async () => {
    const { svc } = makeSvc();
    svc.resetSelectorSettled();
    let resolved = false;
    const p = svc.whenSelectorSettled(5000).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false); // 未 mark、超时远 → 仍 pending
    svc.markSelectorSettled('test');
    await p;
    expect(resolved).toBe(true);
  });

  it('reset 后未 mark → 超时兜底 resolve（恒不 hang，reassert 失败降级）', async () => {
    jest.useFakeTimers();
    try {
      const { svc } = makeSvc();
      svc.resetSelectorSettled();
      let resolved = false;
      const p = svc.whenSelectorSettled(4000).then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);
      jest.advanceTimersByTime(4000);
      await p;
      expect(resolved).toBe(true); // 超时 race 兜底 resolve
    } finally {
      jest.useRealTimers();
    }
  });
});
