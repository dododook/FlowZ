/**
 * ProxyManager 正向 TUN 就绪门 + 持续性失败终态转化单测（issue #324）。
 *
 * 覆盖 waitForCoreReadyOrThrow 的 win32+TUN 编排（A1 硬闸 / A3 dead 文案 / 平台闸 no-op / fail-open）与
 * maybeToTunPersistentError 的终态分类矩阵（A2）。私有方法/字段经 `(svc as any)` 直调注入，不启动 sing-box、
 * 不碰真实网卡/PowerShell——adapterPresenceProbe/coreReadyProbe/isProcessAlive/helperManager 全为桩。
 * 真实 Get-NetAdapter 探测与适配器可见延迟属真机项（无 Windows 环境，不在单测覆盖）。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-tun324-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));

import { ProxyManager } from '../ProxyManager';
import {
  CoreStartRetryError,
  CoreStartSupersededError,
  CoreStartTunPersistentError,
} from '../core-readiness';
import type { AdapterPresence, TunAdapterObservation } from '../win-tun-adapter';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeSvc(): any {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  const svc: any = new ProxyManager(undefined, undefined, configPath, '/fake/sing-box');
  svc.tailscaleApiPort = 9099; // 有管理 API 端口 → 不走 fail-open 早退
  svc.currentConfig = { proxyModeType: 'tun', servers: [], tunConfig: {} };
  svc.helperManager = { stopCore: jest.fn().mockResolvedValue(undefined) };
  return svc;
}

/** win32+TUN tracker（startInternal 会置；此处直接注入模拟已开观测）。 */
function armTun(svc: any): TunAdapterObservation {
  const obs: TunAdapterObservation = { adapterEverSeen: false, probeEverConclusive: false };
  svc.tunReadyObservation = obs;
  return obs;
}

/** 定序三态 probe（用尽后恒返回末值）。 */
function seqProbe(seq: AdapterPresence[]): () => Promise<AdapterPresence> {
  let i = 0;
  return async () => (i < seq.length ? seq[i++] : (seq[seq.length - 1] ?? 'absent'));
}

describe('issue #324 — waitForCoreReadyOrThrow 正向 TUN 就绪门（win32+TUN 编排）', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('平台/模式闸 no-op：tunReadyObservation=null（非 win32+TUN）→ ready 直放行，探针零调用', async () => {
    const svc = makeSvc();
    svc.tunReadyObservation = null; // 模拟 macOS/Linux/非 TUN
    svc.isProcessAlive = () => true;
    svc.coreReadyProbe = async () => true;
    const probe = jest.fn(async () => 'present' as AdapterPresence);
    svc.adapterPresenceProbe = probe;

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    const assertion = expect(p).resolves.toBeUndefined(); // 先挂 handler，防 advance 期未捕获
    await jest.advanceTimersByTimeAsync(20000);
    await assertion;
    expect(probe).not.toHaveBeenCalled(); // 变异「平台闸翻转」→ 此断言失败
  });

  it('ready + 观测窗内适配器出现 → 放行，tracker.adapterEverSeen=true（无需 grace）', async () => {
    const svc = makeSvc();
    const obs = armTun(svc);
    svc.isProcessAlive = () => true;
    svc.coreReadyProbe = async () => true;
    svc.adapterPresenceProbe = seqProbe(['present']);

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    const assertion = expect(p).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(20000);
    await assertion;
    expect(obs.adapterEverSeen).toBe(true);
    expect(svc.helperManager.stopCore).not.toHaveBeenCalled(); // 成功不停核
  });

  it('ready 但适配器确证 absent（探测可用）→ 硬闸 reject CoreStartRetryError + 停核（拒假连接）', async () => {
    const svc = makeSvc();
    const obs = armTun(svc);
    svc.isProcessAlive = () => true;
    svc.coreReadyProbe = async () => true;
    svc.adapterPresenceProbe = async () => 'absent' as AdapterPresence; // 永不出现

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    // 变异「A1 硬闸 throw 改 warn 放行」→ 会 resolve → 此 rejects 断言失败
    const assertion = expect(p).rejects.toBeInstanceOf(CoreStartRetryError);
    await jest.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(svc.helperManager.stopCore).toHaveBeenCalled(); // 停掉「API 通但无 TUN」的半死核
    expect(obs.probeEverConclusive).toBe(true); // clean absent 记入 tracker（供预算耗尽后判持续性）
    expect(obs.adapterEverSeen).toBe(false);
  });

  // review High#1：A1 grace 窗内被更新的 start/stop 接管（#176 高发）→ 静默让位，**绝不 stopCore**（拆接管方核）、不发幻影 started。
  it('ready 后 A1 grace 窗内被接管 → 抛 CoreStartSupersededError，绝不 stopCore', async () => {
    const svc = makeSvc();
    armTun(svc);
    const startGen = svc.lifecycleGeneration;
    svc.isProcessAlive = () => true;
    let readyReturned = false;
    svc.coreReadyProbe = async () => {
      readyReturned = true; // 就绪窗未接管（gen 未变）→ 正常 ready
      return true;
    };
    // 观测窗探测（readyReturned 前）不接管；进入 grace（readyReturned 后）首个探测即模拟接管方 bump 世代。
    svc.adapterPresenceProbe = async () => {
      if (readyReturned) svc.lifecycleGeneration = startGen + 1;
      return 'absent' as AdapterPresence;
    };

    const p = svc.waitForCoreReadyOrThrow(1234, startGen);
    const assertion = expect(p).rejects.toBeInstanceOf(CoreStartSupersededError);
    await jest.advanceTimersByTimeAsync(20000);
    await assertion;
    // 变异「grace 不判 supersede」→ 会走 absent-timeout 分支 stopCore+CoreStartRetryError → 下面两断言失败
    expect(svc.helperManager.stopCore).not.toHaveBeenCalled();
  });

  // review Med#2：A1 每腿独立验证——不吃跨腿 sticky adapterEverSeen（前腿见旧适配器不代表本腿 TUN 已建）。
  it('前腿 sticky adapterEverSeen=true 但本腿探测 absent → A1 仍硬闸 reject（不靠 sticky 免检）', async () => {
    const svc = makeSvc();
    const obs = armTun(svc);
    obs.adapterEverSeen = true; // 模拟前一重试腿曾见（可能是 #159 残留同名旧适配器）
    svc.isProcessAlive = () => true;
    svc.coreReadyProbe = async () => true;
    svc.adapterPresenceProbe = async () => 'absent' as AdapterPresence; // 本腿实际未建

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    // 变异「保留 if(adapterEverSeen)return 免检」→ 会 resolve（假连接漏过）→ 此 rejects 断言失败
    const assertion = expect(p).rejects.toBeInstanceOf(CoreStartRetryError);
    await jest.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(svc.helperManager.stopCore).toHaveBeenCalled();
  });

  it('ready 但适配器探测全 unknown（杀软拦 PS）→ fail-open 放行，不 reject、不停核', async () => {
    const svc = makeSvc();
    const obs = armTun(svc);
    svc.isProcessAlive = () => true;
    svc.coreReadyProbe = async () => true;
    svc.adapterPresenceProbe = async () => 'unknown' as AdapterPresence;

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    const assertion = expect(p).resolves.toBeUndefined(); // fail-open：绝不据探测失败判失败
    await jest.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(svc.helperManager.stopCore).not.toHaveBeenCalled();
    expect(obs.probeEverConclusive).toBe(false); // 全 unknown → 不 conclusive → 后续判瞬态
  });

  it('dead + 探测可用却从未见适配器 → A3 文案「TUN 适配器从未创建，疑 wintun 被拦」', async () => {
    const svc = makeSvc();
    armTun(svc);
    svc.isProcessAlive = () => false; // 起核期进程死
    svc.coreReadyProbe = async () => false;
    svc.adapterPresenceProbe = async () => 'absent' as AdapterPresence; // 探测可用、始终无网卡

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    const assertion = expect(p).rejects.toThrow(/从未创建/);
    await jest.advanceTimersByTimeAsync(20000);
    await assertion;
    expect(svc.helperManager.stopCore).toHaveBeenCalled();
  });

  it('dead + 曾见适配器（瞬态）→ 保持原「TUN 初始化未完成」文案（不误报 wintun 异常）', async () => {
    const svc = makeSvc();
    const obs = armTun(svc);
    svc.isProcessAlive = () => false;
    svc.coreReadyProbe = async () => false;
    svc.adapterPresenceProbe = seqProbe(['present']); // 观测窗曾见 → 瞬态族

    const p = svc.waitForCoreReadyOrThrow(1234, svc.lifecycleGeneration);
    const assertion = expect(p).rejects.toThrow(/TUN 初始化未完成/);
    await jest.advanceTimersByTimeAsync(20000);
    await assertion;
    expect(obs.adapterEverSeen).toBe(true);
  });
});

describe('issue #324 — maybeToTunPersistentError 终态分类矩阵（A2）', () => {
  const retry = (): CoreStartRetryError => new CoreStartRetryError('TUN 初始化未完成');

  it('从未见 + 探测可用 → 转 CoreStartTunPersistentError + emit TUN_INIT_PERSISTENT', () => {
    const svc = makeSvc();
    svc.tunReadyObservation = { adapterEverSeen: false, probeEverConclusive: true };
    const emit = jest.spyOn(svc, 'sendEventToRenderer').mockImplementation(() => {});
    const out = svc.maybeToTunPersistentError(retry());
    expect(out).toBeInstanceOf(CoreStartTunPersistentError);
    const call = emit.mock.calls.find((c: any[]) => c[1]?.errorCode === 'TUN_INIT_PERSISTENT');
    expect(call).toBeTruthy(); // 结构化 code 上渲染端驱动诊断卡
  });

  it('曾见适配器 → 保持原 CoreStartRetryError（瞬态族，不转终态）', () => {
    const svc = makeSvc();
    svc.tunReadyObservation = { adapterEverSeen: true, probeEverConclusive: true };
    const err = retry();
    expect(svc.maybeToTunPersistentError(err)).toBe(err);
  });

  it('探测全 unknown（!conclusive）→ fail-open 保持原错误（绝不误判终态）', () => {
    const svc = makeSvc();
    svc.tunReadyObservation = { adapterEverSeen: false, probeEverConclusive: false };
    const err = retry();
    // 变异「删 fail-open」→ 会转终态 → 此 toBe 失败
    expect(svc.maybeToTunPersistentError(err)).toBe(err);
  });

  it('obs=null（非 win32+TUN）→ 原样（平台闸）', () => {
    const svc = makeSvc();
    svc.tunReadyObservation = null;
    const err = retry();
    expect(svc.maybeToTunPersistentError(err)).toBe(err);
  });

  it('非 CoreStartRetryError（如普通 Error）→ 原样（只转可重试起核错误）', () => {
    const svc = makeSvc();
    svc.tunReadyObservation = { adapterEverSeen: false, probeEverConclusive: true };
    const err = new Error('权限不足');
    expect(svc.maybeToTunPersistentError(err)).toBe(err);
  });
});
