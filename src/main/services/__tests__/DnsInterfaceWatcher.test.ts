/**
 * DnsInterfaceWatcher + shouldReconcileDns 单测（T2c）。
 * 全离线：jest fake timers + mock spawn 工厂 / powerMonitor / onTrigger / schedule。无真实 spawn/electron。
 *
 * 覆盖：
 *  ① 触发行经去抖后只调一次 onTrigger（burst 合并）。
 *  ② 门控不满足（非 tun / takeover=false / 无 marker）→ shouldReconcileDns=false → onTrigger 内不 reconcile。
 *  ③ powerMonitor 'resume' → 触发去抖 onTrigger。
 *  ④ stop → 杀 route monitor 子进程 + 移除 powerMonitor 监听 + 取消在飞去抖。
 *  ⑤ spawn 抛错 → 不抛、仅 warn。
 *  ⑥ 平台/门控真值（shouldReconcileDns）：仅 tun + 未关接管 + marker 在才放行（startDnsInterfaceWatcher 的
 *     darwin no-op 是 ProxyManager 薄接线层对 process.platform 的判定，逻辑核心 = 此门控真值，于此处覆盖）。
 */

import { DnsInterfaceWatcher, shouldReconcileDns } from '../DnsInterfaceWatcher';
import type {
  DnsInterfaceWatcherDeps,
  WatchableChildProcess,
  ResumeMonitor,
} from '../DnsInterfaceWatcher';
import type { UserConfig } from '../../../shared/types';

const DEBOUNCE = 1500;

/** 可控的假子进程：暴露 stdout.on 注册的回调 + kill 探针。 */
function makeFakeChild(): {
  child: WatchableChildProcess;
  emitData: (chunk: string) => void;
  emitError: (err: Error) => void;
  kill: jest.Mock;
} {
  let dataCb: ((chunk: Buffer | string) => void) | null = null;
  let errCb: ((err: Error) => void) | null = null;
  const kill = jest.fn(() => true);
  const child: WatchableChildProcess = {
    stdout: {
      on: (_event, listener) => {
        dataCb = listener;
      },
    },
    on: (event, listener) => {
      if (event === 'error') errCb = listener as (err: Error) => void;
      return child;
    },
    kill,
  };
  return {
    child,
    emitData: (chunk) => dataCb?.(chunk),
    emitError: (err) => errCb?.(err),
    kill,
  };
}

/** 可控 powerMonitor：捕获 resume 监听 + 暴露触发 / removeListener 探针。 */
function makeFakePowerMonitor(): {
  pm: ResumeMonitor;
  fireResume: () => void;
  on: jest.Mock;
  removeListener: jest.Mock;
} {
  let resumeCb: (() => void) | null = null;
  const on = jest.fn((event: string, listener: () => void) => {
    if (event === 'resume') resumeCb = listener;
  });
  // 真清回调（模拟真实 electron removeListener 行为）：stop 反注册后 fireResume 不再触达 watcher。
  const removeListener = jest.fn((event: string, listener: () => void) => {
    if (event === 'resume' && resumeCb === listener) resumeCb = null;
  });
  const pm: ResumeMonitor = {
    on: on as ResumeMonitor['on'],
    removeListener: removeListener as ResumeMonitor['removeListener'],
  };
  return { pm, fireResume: () => resumeCb?.(), on, removeListener };
}

/** 组装一个 watcher + 全 mock 依赖（schedule/clearSchedule 走真实 setTimeout/clearTimeout，配 fake timers）。 */
function setup(overrides?: Partial<DnsInterfaceWatcherDeps>) {
  const fakeChild = makeFakeChild();
  const fakePm = makeFakePowerMonitor();
  const onTrigger = jest.fn(() => Promise.resolve());
  const onWarn = jest.fn();
  const spawnRouteMonitor = jest.fn<WatchableChildProcess, []>(() => fakeChild.child);

  const deps: DnsInterfaceWatcherDeps = {
    spawnRouteMonitor,
    powerMonitor: fakePm.pm,
    onTrigger,
    debounceMs: DEBOUNCE,
    schedule: (fn, ms) => setTimeout(fn, ms),
    clearSchedule: (h) => clearTimeout(h),
    onWarn,
    ...overrides,
  };
  const watcher = new DnsInterfaceWatcher(deps);
  return { watcher, deps, fakeChild, fakePm, onTrigger, onWarn, spawnRouteMonitor };
}

const TRIGGER_LINE = 'RTM_IFINFO: iface status change\n';

describe('DnsInterfaceWatcher', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  // ① burst 合并：一个去抖窗口内连发多条触发行 → 只调一次 onTrigger。
  it('① 触发行 burst 经去抖只调一次 onTrigger', () => {
    const { watcher, fakeChild, onTrigger } = setup();
    watcher.start();

    // 插坞站连发多条 RTM_ —— 模拟 burst。
    fakeChild.emitData('RTM_IFINFO: up\n');
    fakeChild.emitData('RTM_NEWADDR: addr\n');
    fakeChild.emitData('RTM_ADD: Add Route: default\n');
    expect(onTrigger).not.toHaveBeenCalled(); // 去抖窗口未到，尚未触发。

    jest.advanceTimersByTime(DEBOUNCE);
    expect(onTrigger).toHaveBeenCalledTimes(1); // burst 合并为一次。
  });

  it('① 噪音行不排去抖（不调 onTrigger）', () => {
    const { watcher, fakeChild, onTrigger } = setup();
    watcher.start();
    fakeChild.emitData('got message of size 240 on 2026-06-21\n');
    fakeChild.emitData('   default link#1 UCSg\n');
    jest.advanceTimersByTime(DEBOUNCE);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('① stdout 跨 chunk 半行拼接：分片到达的触发行仍命中', () => {
    const { watcher, fakeChild, onTrigger } = setup();
    watcher.start();
    fakeChild.emitData('RTM_IF'); // 半行，无换行 → 留缓存。
    fakeChild.emitData('INFO: iface status change\n'); // 补全 + 换行 → 命中。
    jest.advanceTimersByTime(DEBOUNCE);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  // ② 门控不满足 → onTrigger（内含 shouldReconcileDns 门控）不 reconcile。此处直接验门控真值，
  //   并验「onTrigger 用门控包裹 reconcile」的组合：门控 false → reconcile 不调。
  it('② 门控不满足 → reconcile 不被调用', () => {
    const reconcileDns = jest.fn(() => Promise.resolve());
    // 模拟 ProxyManager 注入的 onTrigger：门控 false → 不调 reconcile。
    const gatedTrigger = jest.fn(async () => {
      if (!shouldReconcileDns({ proxyModeType: 'systemProxy' } as UserConfig, true)) return;
      await reconcileDns();
    });
    const { watcher, fakeChild } = setup({ onTrigger: gatedTrigger });
    watcher.start();
    fakeChild.emitData(TRIGGER_LINE);
    jest.advanceTimersByTime(DEBOUNCE);
    expect(gatedTrigger).toHaveBeenCalledTimes(1); // 去抖确实触发了入口…
    expect(reconcileDns).not.toHaveBeenCalled(); // …但门控 false 拦下 reconcile。
  });

  // ③ powerMonitor 'resume' → 去抖 onTrigger。
  it('③ resume 事件触发去抖 onTrigger', () => {
    const { watcher, fakePm, onTrigger } = setup();
    watcher.start();
    fakePm.fireResume();
    expect(onTrigger).not.toHaveBeenCalled();
    jest.advanceTimersByTime(DEBOUNCE);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('③ resume 与 route 行同窗口 burst → 仍只一次', () => {
    const { watcher, fakeChild, fakePm, onTrigger } = setup();
    watcher.start();
    fakeChild.emitData(TRIGGER_LINE);
    fakePm.fireResume();
    jest.advanceTimersByTime(DEBOUNCE);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  // ④ stop → 杀子进程 + 移除 resume 监听 + 取消在飞去抖。
  it('④ stop 杀子进程 + 反注册 resume + 取消在飞去抖', () => {
    const { watcher, fakeChild, fakePm, onTrigger } = setup();
    watcher.start();
    fakeChild.emitData(TRIGGER_LINE); // 排了一个在飞去抖。
    watcher.stop();

    expect(fakeChild.kill).toHaveBeenCalledTimes(1); // 杀 route monitor。
    expect(fakePm.removeListener).toHaveBeenCalledWith('resume', expect.any(Function)); // 反注册 resume。

    jest.advanceTimersByTime(DEBOUNCE);
    expect(onTrigger).not.toHaveBeenCalled(); // 在飞去抖被取消 → stop 后不再触发。
  });

  it('④ stop 后 resume 不再触发（监听已移除）', () => {
    const { watcher, fakePm, onTrigger } = setup();
    watcher.start();
    watcher.stop(); // 反注册 resume（fake removeListener 真清回调，镜像 electron 行为）。
    fakePm.fireResume(); // 监听已移除 → 不触达 watcher → 不排去抖。
    jest.advanceTimersByTime(DEBOUNCE);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('④ stop 幂等：未 start 直接 stop 不抛、重复 stop 安全', () => {
    const { watcher, fakeChild } = setup();
    expect(() => watcher.stop()).not.toThrow();
    watcher.start();
    watcher.stop();
    watcher.stop();
    expect(fakeChild.kill).toHaveBeenCalledTimes(1); // 第二次 stop 时 child 已 null，不重复 kill。
  });

  // ⑤ spawn 抛错 → 不抛、仅 warn；resume 订阅仍生效（spawn 失败不连累唤醒路径）。
  it('⑤ spawn 抛错 → 不抛、仅 warn', () => {
    const spawnRouteMonitor = jest.fn(() => {
      throw new Error('route: command not found');
    });
    const { watcher, onWarn, fakePm } = setup({ spawnRouteMonitor });
    expect(() => watcher.start()).not.toThrow();
    expect(onWarn).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('启动 DNS 接口 watcher 失败')
    );
    // spawn 失败仍订阅 resume（唤醒是独立补接管路径）。
    expect(fakePm.on).toHaveBeenCalledWith('resume', expect.any(Function));
  });

  it('⑤ 子进程 error 事件 → 仅 warn 不抛', () => {
    const { watcher, fakeChild, onWarn } = setup();
    watcher.start();
    expect(() => fakeChild.emitError(new Error('route monitor died'))).not.toThrow();
    expect(onWarn).toHaveBeenCalledWith('warn', expect.stringContaining('子进程错误'));
  });

  it('⑤ onTrigger reject → 仅 warn 不冒泡', async () => {
    const onTrigger = jest.fn(() => Promise.reject(new Error('reconcile boom')));
    const { watcher, fakeChild, onWarn } = setup({ onTrigger });
    watcher.start();
    fakeChild.emitData(TRIGGER_LINE);
    jest.advanceTimersByTime(DEBOUNCE);
    await Promise.resolve(); // 放行 reject 的 .catch 微任务。
    await Promise.resolve();
    expect(onWarn).toHaveBeenCalledWith('warn', expect.stringContaining('DNS 重灌'));
  });

  // start 幂等：重复 start 不重复 spawn。
  it('start 幂等：重复 start 只 spawn 一次', () => {
    const { watcher, spawnRouteMonitor } = setup();
    watcher.start();
    watcher.start();
    expect(spawnRouteMonitor).toHaveBeenCalledTimes(1);
  });

  // 无 powerMonitor（注入 null）：start/stop 不碰 resume、不抛。
  it('powerMonitor=null：start/stop 不订阅 resume、不抛', () => {
    const { watcher } = setup({ powerMonitor: null });
    expect(() => {
      watcher.start();
      watcher.stop();
    }).not.toThrow();
  });
});

// ⑥ 门控真值表（= startDnsInterfaceWatcher 的逻辑核心 + ProxyManager 注入 onTrigger 的门控判定）。
describe('shouldReconcileDns 门控真值', () => {
  const tunOn = { proxyModeType: 'tun' } as UserConfig;
  const tunTakeoverOff = {
    proxyModeType: 'tun',
    dnsConfig: { takeoverSystemDns: false },
  } as UserConfig;
  const sysProxy = { proxyModeType: 'systemProxy' } as UserConfig;
  const manual = { proxyModeType: 'manual' } as unknown as UserConfig;

  it('tun + 未关接管 + marker 在 → true', () => {
    expect(shouldReconcileDns(tunOn, true)).toBe(true);
  });
  it('tun + marker 不在 → false（接管未激活，不擅自动手）', () => {
    expect(shouldReconcileDns(tunOn, false)).toBe(false);
  });
  it('tun + takeover=false → false（用户关掉接管开关）', () => {
    expect(shouldReconcileDns(tunTakeoverOff, true)).toBe(false);
  });
  it('systemProxy 模式 → false（系统代理走远程解析，watcher 不改 DNS）', () => {
    expect(shouldReconcileDns(sysProxy, true)).toBe(false);
  });
  it('manual 模式 → false', () => {
    expect(shouldReconcileDns(manual, true)).toBe(false);
  });
  it('config 为 null/undefined → false', () => {
    expect(shouldReconcileDns(null, true)).toBe(false);
    expect(shouldReconcileDns(undefined, true)).toBe(false);
  });
});
