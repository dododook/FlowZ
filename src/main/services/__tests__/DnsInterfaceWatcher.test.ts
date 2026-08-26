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

import {
  DnsInterfaceWatcher,
  shouldReconcileDns,
  createLinkChangeHandler,
} from '../DnsInterfaceWatcher';
import { isDnsReconcileTriggerLine, isLinuxLinkChangeLine } from '../dns-route-events';
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
  emitClose: (code: number | null, signal: NodeJS.Signals | null) => void;
  kill: jest.Mock;
} {
  let dataCb: ((chunk: Buffer | string) => void) | null = null;
  let errCb: ((err: Error) => void) | null = null;
  let closeCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  const kill = jest.fn(() => true);
  const child: WatchableChildProcess = {
    stdout: {
      on: (_event, listener) => {
        dataCb = listener;
      },
    },
    on: ((event: string, listener: (...a: never[]) => void) => {
      if (event === 'error') errCb = listener as unknown as (err: Error) => void;
      if (event === 'close')
        closeCb = listener as unknown as (
          code: number | null,
          signal: NodeJS.Signals | null
        ) => void;
      return child;
    }) as WatchableChildProcess['on'],
    kill,
  };
  return {
    child,
    emitData: (chunk) => dataCb?.(chunk),
    emitError: (err) => errCb?.(err),
    emitClose: (code, signal) => closeCb?.(code, signal),
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
    // 既有用例全部以 macOS 的 RTM_ 判定为前提（TRIGGER_LINE 是 RTM_IFINFO 行）→ 默认注入它，行为逐条不变。
    isTriggerLine: isDnsReconcileTriggerLine,
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
    expect(onWarn).toHaveBeenCalledWith('warn', expect.stringContaining('链路变化处理失败'));
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

describe('DnsInterfaceWatcher — 平台注入（issue #368）', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('spawnRouteMonitor=null（Windows 无链路监听命令）→ 不 spawn，但仍订阅 resume 且 resume 能触发', () => {
    const { watcher, fakePm, onTrigger, onWarn } = setup({ spawnRouteMonitor: null });
    watcher.start();
    // 无子进程可 spawn 不是错误：Windows 本就没有等价命令，走 resume 单腿是设计而非降级。
    expect(onWarn).not.toHaveBeenCalled();
    fakePm.fireResume();
    jest.advanceTimersByTime(DEBOUNCE);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    // stop 仍须能反注册（started 置位不依赖 spawn 成功）。
    watcher.stop();
    expect(fakePm.removeListener).toHaveBeenCalledTimes(1);
  });

  it('注入 isLinuxLinkChangeLine → ip monitor 的任意非空行都触发，空行不触发', () => {
    const { watcher, fakeChild, onTrigger } = setup({ isTriggerLine: isLinuxLinkChangeLine });
    watcher.start();
    // 真实 `ip -o monitor link addr route` 行（netns 实测取样）：RTM_ 前缀一个都没有，macOS 判定会全部漏掉。
    fakeChild.emitData('default via 10.9.9.1 dev d0 \n');
    jest.advanceTimersByTime(DEBOUNCE);
    expect(onTrigger).toHaveBeenCalledTimes(1);

    onTrigger.mockClear();
    fakeChild.emitData('\n   \n');
    jest.advanceTimersByTime(DEBOUNCE);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('spawn 同步抛 → 不回退 started：再次 start() 不会双订阅 resume（stop 只能反注册一次）', () => {
    const spawnRouteMonitor = jest.fn(() => {
      throw new Error('boom');
    });
    const { watcher, fakePm, onWarn } = setup({ spawnRouteMonitor });
    watcher.start();
    watcher.start(); // 幂等：started 未回退 → 第二次应整体 no-op
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(fakePm.on).toHaveBeenCalledTimes(1);
    watcher.stop();
    expect(fakePm.removeListener).toHaveBeenCalledTimes(1);
  });

  it('pollIntervalMs>0 → 周期性走同一去抖入口（Windows 靠它覆盖换网/插拔）', () => {
    const { watcher, onTrigger } = setup({
      spawnRouteMonitor: null,
      pollIntervalMs: 30_000,
    });
    watcher.start();
    jest.advanceTimersByTime(30_000 + DEBOUNCE);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    // 自重排：第二个周期照样触发。
    jest.advanceTimersByTime(30_000 + DEBOUNCE);
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it('stop() 后轮询不再重排（否则 watcher 停了仍在打 onTrigger）', () => {
    const { watcher, onTrigger } = setup({ spawnRouteMonitor: null, pollIntervalMs: 30_000 });
    watcher.start();
    watcher.stop();
    jest.advanceTimersByTime(30_000 * 5 + DEBOUNCE);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('pollIntervalMs 缺省 → 不轮询（有事件源的平台不该多一条定时腿）', () => {
    const { watcher, onTrigger } = setup();
    watcher.start();
    jest.advanceTimersByTime(60_000 * 10);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('macOS 判定注入下，ip monitor 行不触发（反向对照：判定确实来自注入而非内嵌）', () => {
    const { watcher, fakeChild, onTrigger } = setup({ isTriggerLine: isDnsReconcileTriggerLine });
    watcher.start();
    fakeChild.emitData('2: d0    inet 10.9.9.2/24 scope global d0\n');
    jest.advanceTimersByTime(DEBOUNCE);
    expect(onTrigger).not.toHaveBeenCalled();
  });
});

describe('createLinkChangeHandler — 组合语义（issue #368）', () => {
  const setupHandler = (over?: Partial<Parameters<typeof createLinkChangeHandler>[0]>) => {
    const flush = jest.fn();
    const onWarn = jest.fn();
    const reconcile = jest.fn(() => Promise.resolve());
    const deps = {
      reconcile,
      readFingerprint: () => 'FP-NEW',
      getLastFingerprint: () => 'FP-OLD',
      flush,
      onWarn,
      ...over,
    };
    return { handler: createLinkChangeHandler(deps), flush, onWarn, reconcile };
  };

  it('指纹变化 → 刷，且把新指纹传给 flush（由调用方在成功后落库）', async () => {
    const { handler, flush } = setupHandler();
    await handler();
    expect(flush).toHaveBeenCalledWith('FP-NEW');
  });

  it('指纹相同 → 不刷（周期性 RA / DHCP renew 是噪音，自身路由操作是自触发）', async () => {
    const { handler, flush } = setupHandler({ getLastFingerprint: () => 'FP-NEW' });
    await handler();
    expect(flush).not.toHaveBeenCalled();
  });

  it('首次（上次指纹为 null）→ 刷', async () => {
    const { handler, flush } = setupHandler({ getLastFingerprint: () => null });
    await handler();
    expect(flush).toHaveBeenCalledWith('FP-NEW');
  });

  it('reconcile 抛异常 → 仅 warn，**flush 仍执行**（最需要刷的那次恰是重灌最易失败的那次）', async () => {
    const { handler, flush, onWarn } = setupHandler({
      reconcile: () => Promise.reject(new Error('networksetup boom')),
    });
    await expect(handler()).resolves.toBeUndefined();
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('networksetup boom'));
    expect(flush).toHaveBeenCalledWith('FP-NEW');
  });

  it('顺序：先 reconcile 再读指纹（接管改完系统 DNS 后取到的才是刷新后的世界）', async () => {
    const order: string[] = [];
    const { handler } = setupHandler({
      reconcile: async () => {
        order.push('reconcile');
      },
      readFingerprint: () => {
        order.push('fingerprint');
        return 'FP-NEW';
      },
    });
    await handler();
    expect(order).toEqual(['reconcile', 'fingerprint']);
  });

  it('reconcile 为 null（门控未过 / 无 manager）→ 直接走指纹对差', async () => {
    const { handler, flush, onWarn } = setupHandler({ reconcile: null });
    await handler();
    expect(flush).toHaveBeenCalledWith('FP-NEW');
    expect(onWarn).not.toHaveBeenCalled();
  });
});

describe('DnsInterfaceWatcher — 事件源死亡自曝 + 降级轮询（issue #368 复审 Med-2）', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  const FALLBACK = 60_000;

  it('子进程异常退出 → warn 留痕 + 降级为指纹轮询（此前静默失效到下次核重启且无迹象）', () => {
    const { watcher, fakeChild, onTrigger, onWarn } = setup({
      pollIntervalMs: 0,
      fallbackPollIntervalMs: FALLBACK,
    });
    watcher.start();

    fakeChild.emitClose(1, null);
    expect(onWarn).toHaveBeenCalledWith('warn', expect.stringContaining('链路事件源已退出'));

    // 降级腿真的在跑：轮询间隔 + 去抖窗口后触发一次。
    expect(onTrigger).not.toHaveBeenCalled();
    jest.advanceTimersByTime(FALLBACK + DEBOUNCE);
    expect(onTrigger).toHaveBeenCalledTimes(1);

    // 自重排：再过一个周期还会触发（一次性定时器会让降级只生效一轮）。
    jest.advanceTimersByTime(FALLBACK + DEBOUNCE);
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it('spawn 失败（只发 error + close、不发 exit）同样降级——挂 exit 会让这条腿双失', () => {
    // 本机 node 实测：ENOENT 的 spawn 只发 error 与 close。判据挂 exit 时本条转红。
    const { watcher, fakeChild, onTrigger, onWarn } = setup({
      pollIntervalMs: 0,
      fallbackPollIntervalMs: FALLBACK,
    });
    watcher.start();

    fakeChild.emitError(new Error('spawn ip ENOENT'));
    fakeChild.emitClose(null, null); // 无 exit
    expect(onWarn).toHaveBeenCalledWith('warn', expect.stringContaining('链路事件源已退出'));
    jest.advanceTimersByTime(FALLBACK + DEBOUNCE);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('上一代子进程的迟到 close 不空掉当前代（同实例 stop→start 复用时的伪降级）', () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    let n = 0;
    const { watcher, onWarn } = setup({
      spawnRouteMonitor: jest.fn<WatchableChildProcess, []>(() =>
        n++ === 0 ? first.child : second.child
      ),
      pollIntervalMs: 0,
      fallbackPollIntervalMs: FALLBACK,
    });
    watcher.start();
    watcher.stop();
    watcher.start(); // 第二代
    onWarn.mockClear();

    first.emitClose(1, null); // 上一代迟到事件
    expect(onWarn).not.toHaveBeenCalled();

    second.emitClose(1, null); // 当前代真死 → 照常自曝
    expect(onWarn).toHaveBeenCalledWith('warn', expect.stringContaining('链路事件源已退出'));
  });

  it('未配置 fallbackPollIntervalMs → 只 warn 不轮询（不擅自给没声明降级的平台加轮询）', () => {
    const { watcher, fakeChild, onTrigger, onWarn } = setup({ pollIntervalMs: 0 });
    watcher.start();

    fakeChild.emitClose(null, 'SIGKILL');
    expect(onWarn).toHaveBeenCalledWith('warn', expect.stringContaining('链路事件源已退出'));
    jest.advanceTimersByTime(FALLBACK * 3 + DEBOUNCE);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('stop() 自己 kill 引发的 close 不算异常：不 warn、不降级、不留在飞轮询', () => {
    const { watcher, fakeChild, onTrigger, onWarn } = setup({
      pollIntervalMs: 0,
      fallbackPollIntervalMs: FALLBACK,
    });
    watcher.start();
    watcher.stop();
    onWarn.mockClear();

    // 真实 kill 后 exit 事件异步到达，此时 started 已为 false。
    fakeChild.emitClose(null, 'SIGTERM');
    expect(onWarn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(FALLBACK * 2 + DEBOUNCE);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('降级态不跨代继承：stop→start 后重新尝试事件源，不残留上一代的轮询', () => {
    const { watcher, fakeChild, onTrigger, spawnRouteMonitor } = setup({
      pollIntervalMs: 0,
      fallbackPollIntervalMs: FALLBACK,
    });
    watcher.start();
    fakeChild.emitClose(1, null); // 降级
    watcher.stop();
    onTrigger.mockClear();

    watcher.start();
    expect(spawnRouteMonitor).toHaveBeenCalledTimes(2); // 重新起事件源
    jest.advanceTimersByTime(FALLBACK * 2 + DEBOUNCE);
    expect(onTrigger).not.toHaveBeenCalled(); // 新一代不在降级态
  });

  it('已在轮询的平台（Windows）事件源为 null 时不受影响：退出路径根本不存在', () => {
    const { watcher, onTrigger, spawnRouteMonitor } = setup({
      spawnRouteMonitor: null,
      pollIntervalMs: 30_000,
      fallbackPollIntervalMs: FALLBACK,
    });
    watcher.start();
    expect(spawnRouteMonitor).not.toHaveBeenCalled();
    jest.advanceTimersByTime(30_000 + DEBOUNCE);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });
});

describe('DnsInterfaceWatcher — onResume 唤醒回调（复审 F2：豁免上层限频）', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('resume 时同步回调 onResume，且发生在去抖触发之前', () => {
    const order: string[] = [];
    const onResume = jest.fn(() => void order.push('resume'));
    const onTrigger = jest.fn(() => {
      order.push('trigger');
      return Promise.resolve();
    });
    const { watcher, fakePm } = setup({ onResume, onTrigger });
    watcher.start();

    fakePm.fireResume();
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onTrigger).not.toHaveBeenCalled(); // 仍在去抖窗口内
    jest.advanceTimersByTime(DEBOUNCE);
    expect(order).toEqual(['resume', 'trigger']);
  });

  it('链路事件行与轮询触发**不**调 onResume（限频豁免只属于唤醒）', () => {
    const onResume = jest.fn();
    const { watcher, fakeChild, onTrigger } = setup({
      onResume,
      pollIntervalMs: 10_000,
    });
    watcher.start();

    fakeChild.emitData(TRIGGER_LINE);
    jest.advanceTimersByTime(DEBOUNCE);
    jest.advanceTimersByTime(10_000 + DEBOUNCE);
    expect(onTrigger.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onResume).not.toHaveBeenCalled();
  });

  it('onResume 抛错只 warn，不吃掉本次去抖触发', () => {
    const onResume = jest.fn(() => {
      throw new Error('boom');
    });
    const { watcher, fakePm, onTrigger, onWarn } = setup({ onResume });
    watcher.start();

    expect(() => fakePm.fireResume()).not.toThrow();
    expect(onWarn).toHaveBeenCalledWith('warn', expect.stringContaining('处理系统唤醒事件失败'));
    jest.advanceTimersByTime(DEBOUNCE);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('未注入 onResume 时 resume 照常走去抖（可选依赖不得成为必填）', () => {
    const { watcher, fakePm, onTrigger } = setup();
    watcher.start();
    fakePm.fireResume();
    jest.advanceTimersByTime(DEBOUNCE);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });
});
