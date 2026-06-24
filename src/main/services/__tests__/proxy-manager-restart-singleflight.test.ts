/**
 * ProxyManager 配置变更重启轴「单飞」单测（issue #176）。
 *
 * 验证：起核期内（lifecycleDepth>0）到来的去抖重启**不并发**起第二条，只置 restartPending；在飞操作 settle 回
 * depth 0 时排空一次尾随重启（start/restart 收尾排空、stop 收尾丢弃）。这是 #176「就绪等待中又来重启 → stop/超时/
 * restart 互踩 → wintun 适配器抢放 → 管理 API 未绑定假超时风暴」的根因修复。
 *
 * 私有方法/字段经 `(svc as any)` 直调注入，不启动 sing-box。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-sf176-'));

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
import { CoreStartSupersededError } from '../core-readiness';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeSvc() {
  const configPath = path.join(TMP, `sb-${Math.random().toString(36).slice(2)}.json`);
  const svc: any = new ProxyManager(undefined, undefined, configPath, '/fake/sing-box');
  return svc;
}

const DEBOUNCE = (ProxyManager as any).RESTART_DEBOUNCE_MS as number;

/** 让去抖 timer「视核为运行中」并有配置：否则 trailing 回调会早退（!pid / !currentConfig）。 */
function armRunning(svc: any) {
  svc.singboxPid = 4321;
  svc.currentConfig = { proxyModeType: 'tun', servers: [], selectedServerId: 'x' };
}

describe('issue #176 — 重启单飞 begin/endLifecycleOp', () => {
  it('beginLifecycleOp 重入计数；endLifecycleOp 递减且不下溢', () => {
    const svc = makeSvc();
    expect(svc.lifecycleDepth).toBe(0);
    svc.beginLifecycleOp();
    svc.beginLifecycleOp();
    expect(svc.lifecycleDepth).toBe(2);
    svc.endLifecycleOp('start');
    expect(svc.lifecycleDepth).toBe(1);
    svc.endLifecycleOp('start');
    expect(svc.lifecycleDepth).toBe(0);
    // 不下溢
    svc.endLifecycleOp('start');
    expect(svc.lifecycleDepth).toBe(0);
  });

  it('回到 idle（depth 0）且 restartPending → 排空一次尾随重启（start/restart 收尾）', () => {
    const svc = makeSvc();
    const sched = jest.spyOn(svc, 'scheduleDebouncedRestart').mockImplementation(() => {});
    svc.beginLifecycleOp(); // depth 1
    svc.restartPending = true;
    svc.endLifecycleOp('restart'); // depth 0 → 排空
    expect(svc.lifecycleDepth).toBe(0);
    expect(svc.restartPending).toBe(false);
    expect(sched).toHaveBeenCalledTimes(1);
  });

  it("终态停止（kind='stop'）回到 idle → 丢弃 restartPending，不排空", () => {
    const svc = makeSvc();
    const sched = jest.spyOn(svc, 'scheduleDebouncedRestart').mockImplementation(() => {});
    svc.beginLifecycleOp();
    svc.restartPending = true;
    svc.endLifecycleOp('stop'); // 停止优先：丢弃待决
    expect(svc.restartPending).toBe(false);
    expect(sched).not.toHaveBeenCalled();
  });

  it('仍在更外层操作内（depth>0）→ 不处理待决（留给最外层）', () => {
    const svc = makeSvc();
    const sched = jest.spyOn(svc, 'scheduleDebouncedRestart').mockImplementation(() => {});
    svc.beginLifecycleOp();
    svc.beginLifecycleOp(); // depth 2（如 restart 内嵌 stop）
    svc.restartPending = true;
    svc.endLifecycleOp('stop'); // depth → 1，仍 >0
    expect(svc.lifecycleDepth).toBe(1);
    expect(svc.restartPending).toBe(true); // 未被动到
    expect(sched).not.toHaveBeenCalled();
  });
});

describe('issue #176 — scheduleDebouncedRestart 单飞门控', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('在飞期（depth>0）去抖触发 → 置 restartPending，绝不并发起 restart', () => {
    const svc = makeSvc();
    armRunning(svc);
    const restart = jest.spyOn(svc, 'restart').mockResolvedValue(undefined);
    svc.lifecycleDepth = 1; // 模拟有 lifecycle 操作在飞
    svc.scheduleDebouncedRestart();
    jest.advanceTimersByTime(DEBOUNCE + 10);
    expect(svc.restartPending).toBe(true);
    expect(restart).not.toHaveBeenCalled();
  });

  it('空闲（depth 0）去抖触发 → 正常起一次 restart（吃 currentConfig）', () => {
    const svc = makeSvc();
    armRunning(svc);
    const restart = jest.spyOn(svc, 'restart').mockResolvedValue(undefined);
    svc.lifecycleDepth = 0;
    svc.scheduleDebouncedRestart();
    jest.advanceTimersByTime(DEBOUNCE + 10);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith(svc.currentConfig);
    expect(svc.restartPending).toBe(false);
  });

  it('核未运行 → 去抖触发不起 restart（既有早退行为保持）', () => {
    const svc = makeSvc();
    svc.singboxPid = null;
    svc.singboxProcess = null;
    svc.currentConfig = { proxyModeType: 'tun', servers: [] };
    const restart = jest.spyOn(svc, 'restart').mockResolvedValue(undefined);
    svc.scheduleDebouncedRestart();
    jest.advanceTimersByTime(DEBOUNCE + 10);
    expect(restart).not.toHaveBeenCalled();
  });

  it('端到端：在飞期去抖 → 置待决 → settle 排空 → 再触发时空闲 → 起一次 restart', () => {
    const svc = makeSvc();
    armRunning(svc);
    const restart = jest.spyOn(svc, 'restart').mockResolvedValue(undefined);

    // 1) 模拟「上一条重启的 start 还在就绪等待」：depth>0
    svc.beginLifecycleOp();
    svc.scheduleDebouncedRestart();
    jest.advanceTimersByTime(DEBOUNCE + 10);
    expect(svc.restartPending).toBe(true);
    expect(restart).not.toHaveBeenCalled();

    // 2) 在飞操作 settle 回 idle → endLifecycleOp 排空（重新 arm 去抖 timer）
    svc.endLifecycleOp('start');
    expect(svc.restartPending).toBe(false);

    // 3) 此刻 depth 0，排空的去抖 timer 到点 → 恰好起一次 restart
    jest.advanceTimersByTime(DEBOUNCE + 10);
    expect(restart).toHaveBeenCalledTimes(1);
  });
});

describe('issue #176 — L1.2 就绪等待腿被接管即让位', () => {
  it('就绪等待期被接管（startGen≠lifecycleGeneration）→ 抛 CoreStartSupersededError，绝不 stopCore', async () => {
    const svc = makeSvc();
    svc.tailscaleApiPort = 9099; // 有管理 API 端口，不走 fail-open 早退
    svc.isProcessAlive = () => true;
    svc.coreReadyProbe = async () => false; // 永不就绪
    const stopCore = jest.fn().mockResolvedValue(undefined);
    svc.helperManager = { stopCore };
    // startGen 与当前世代不同 → isSuperseded 首轮即真 → 立即让位
    const staleGen = svc.lifecycleGeneration - 1;
    await expect(svc.waitForCoreReadyOrThrow(1234, staleGen)).rejects.toBeInstanceOf(
      CoreStartSupersededError
    );
    expect(stopCore).not.toHaveBeenCalled(); // 接管方拥有拆核权，本腿不抢放适配器
  });

  it('start() 吞 CoreStartSupersededError：静默让位返回，不 cleanup、不 rethrow、finally 复位 depth、置 lastStartSuperseded', async () => {
    const svc = makeSvc();
    jest.spyOn(svc, 'startInternal').mockRejectedValue(new CoreStartSupersededError());
    const cleanup = jest.spyOn(svc, 'cleanup').mockImplementation(() => {});
    await expect(svc.start({ proxyModeType: 'tun', servers: [] })).resolves.toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();
    expect(svc.lifecycleDepth).toBe(0);
    expect(svc.lastStartSuperseded).toBe(true); // 供 attemptAutoRestart 判别
  });

  // H1（review）：Windows helper-path 就绪让位必须透传 SupersededError，绝不回退 UAC 起第二条流（#176 主路径）。
  it('H1：Windows UAC helper-path 就绪让位 → 透传 CoreStartSupersededError，不回退 UAC', async () => {
    const svc = makeSvc();
    // 非 tun（host=linux 本就跳过 win32&&tun 适配器等待）；走 Windows UAC helper 分支
    svc.currentConfig = { proxyModeType: 'systemProxy', servers: [] };
    svc.needsOsascript = () => false;
    svc.needsWindowsUAC = () => true;
    svc.helperManager = { isReady: async () => true };
    const viaHelper = jest
      .spyOn(svc, 'startViaHelper')
      .mockRejectedValue(new CoreStartSupersededError());
    // 若 catch 漏放行（H1 bug）→ 会吞错回退 UAC、不会以 Superseded reject
    await expect(svc.startSingBoxProcess(0)).rejects.toBeInstanceOf(CoreStartSupersededError);
    expect(viaHelper).toHaveBeenCalled();
  });
});

// M1（review）：自动重启腿的 start 在就绪等待期被接管 → start() 静默让位返回，attemptAutoRestart 不得误报成功/发 started。
describe('issue #176 — M1 attemptAutoRestart 让位不误报', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('start 让位（lastStartSuperseded）→ 不发 autoRestarted started 事件', async () => {
    const svc = makeSvc();
    svc.currentConfig = { proxyModeType: 'tun', servers: [] };
    svc.autoRestartEnabled = true;
    // start 模拟「被接管让位」：置 flag 并正常返回（不起核、不 bump 世代）
    jest.spyOn(svc, 'start').mockImplementation(async () => {
      svc.lastStartSuperseded = true;
    });
    const emit = jest.spyOn(svc, 'sendEventToRenderer').mockImplementation(() => {});

    const p = svc.attemptAutoRestart();
    await jest.advanceTimersByTimeAsync(2100); // 跨过第 1 次退避 2s
    await p;

    const startedEmits = emit.mock.calls.filter((c: any[]) => c[1] && c[1].autoRestarted === true);
    expect(startedEmits.length).toBe(0); // 让位 → 不发「自动重启成功」started
    expect(svc.isRestarting).toBe(false); // finally 复位
  });
});
