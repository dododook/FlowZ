/**
 * ProxyManager 侧 DNS flush **接线层**单测（issue #367/#368 复审）。
 *
 * 为什么必须有：限频/补刷延迟/抑制判据/基线推进的零件全是纯函数且各自有测，但**接线**（拦下时有没有真的
 * 武装补刷、抑制标志有没有真的短路、乱序 settle 有没有真的作废）此前零覆盖——复审用变异证明过：把补刷
 * 排程守卫 `!== null` 反转成 `=== null`（= 回到「拦下即丢弃」的缺陷形态），534 个测试全绿。
 * 与 lastDnsFlush 漏抄 partial 是同一形态：零件有测、门之间的缝就是生产路径。
 *
 * 只桩 flushOsDnsCache，不起核、不碰宿主网络。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-dnsflush-wiring-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
  powerMonitor: { on: jest.fn(), removeListener: jest.fn() },
}));

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
}));

jest.mock('../os-dns-flush', () => ({
  ...jest.requireActual('../os-dns-flush'),
  flushOsDnsCache: jest.fn(),
}));

import { ProxyManager } from '../ProxyManager';
import {
  flushOsDnsCache,
  LINK_CHANGE_FLUSH_FAIL_STREAK_LIMIT,
  LINK_CHANGE_FLUSH_MIN_INTERVAL_MS,
} from '../os-dns-flush';
import { withPlatformAsync } from './platform-test-utils';
import { spawn } from 'child_process';
import { powerMonitor } from 'electron';

const mockFlush = flushOsDnsCache as jest.MockedFunction<typeof flushOsDnsCache>;

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 让已 resolve 的 promise 链跑完（flushOsDnsCacheBestEffort 是 fire-and-forget）。 */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function makeSvc(): any {
  const svc: any = new ProxyManager(
    undefined,
    undefined,
    path.join(TMP, 'cfg.json'),
    path.join(TMP, 'sing-box')
  );
  // 补刷走的是 watcher 的 handler；这里直接注入探针，免起真 watcher。
  svc.linkChangeHandler = jest.fn(() => Promise.resolve());
  return svc;
}

beforeEach(() => {
  mockFlush.mockReset();
  mockFlush.mockResolvedValue({ ok: true, detail: 'stub' });
});

describe('link-change 限频与补刷接线', () => {
  it('窗口内第二次被拦下 → 清基线 + 武装补刷；到期走同一个 handler', async () => {
    // 不 fake hrtime：限频用单调钟，而 fake timers 会把它归零，`lastAtMs <= 0` 的「本会话首次」哨兵
    // 就会把每一次都当首次放行（真实进程里 hrtime 恒 > 0，这只是测试环境的伪装）。
    jest.useFakeTimers({ doNotFake: ['hrtime'] });
    try {
      const svc = makeSvc();
      svc.flushOsDnsCacheBestEffort('link-change', 'fp-A');
      await settle();
      expect(svc.lastNetworkFingerprint).toBe('fp-A');

      svc.flushOsDnsCacheBestEffort('link-change', 'fp-B');
      expect(mockFlush).toHaveBeenCalledTimes(1); // 第二次没真刷
      expect(svc.lastNetworkFingerprint).toBeNull(); // 判脏：下次无条件放行
      expect(svc.linkChangeRetryTimer).not.toBeNull(); // 补刷已武装

      jest.advanceTimersByTime(LINK_CHANGE_FLUSH_MIN_INTERVAL_MS);
      expect(svc.linkChangeHandler).toHaveBeenCalledTimes(1);
      expect(svc.linkChangeRetryTimer).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('多次被拦下只武装一次补刷（不堆积定时器）', async () => {
    // 不 fake hrtime：限频用单调钟，而 fake timers 会把它归零，`lastAtMs <= 0` 的「本会话首次」哨兵
    // 就会把每一次都当首次放行（真实进程里 hrtime 恒 > 0，这只是测试环境的伪装）。
    jest.useFakeTimers({ doNotFake: ['hrtime'] });
    try {
      const svc = makeSvc();
      svc.flushOsDnsCacheBestEffort('link-change', 'fp-A');
      await settle();
      svc.flushOsDnsCacheBestEffort('link-change', 'fp-B');
      const armed = svc.linkChangeRetryTimer;
      svc.flushOsDnsCacheBestEffort('link-change', 'fp-C');
      expect(svc.linkChangeRetryTimer).toBe(armed);

      jest.advanceTimersByTime(LINK_CHANGE_FLUSH_MIN_INTERVAL_MS);
      expect(svc.linkChangeHandler).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('watcher 已停（handler 为空）→ 不武装补刷，不留空转定时器', async () => {
    // 不 fake hrtime：限频用单调钟，而 fake timers 会把它归零，`lastAtMs <= 0` 的「本会话首次」哨兵
    // 就会把每一次都当首次放行（真实进程里 hrtime 恒 > 0，这只是测试环境的伪装）。
    jest.useFakeTimers({ doNotFake: ['hrtime'] });
    try {
      const svc = makeSvc();
      svc.flushOsDnsCacheBestEffort('link-change', 'fp-A');
      await settle();
      svc.linkChangeHandler = null; // 核死 / 还原
      svc.flushOsDnsCacheBestEffort('link-change', 'fp-B');
      expect(svc.linkChangeRetryTimer).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('start/stop 不受限频约束（跨越接管/还原边界，漏刷代价留到下次启停）', async () => {
    const svc = makeSvc();
    svc.flushOsDnsCacheBestEffort('start', 'fp-A');
    await settle();
    svc.flushOsDnsCacheBestEffort('stop');
    await settle();
    expect(mockFlush).toHaveBeenCalledTimes(2);
  });
});

describe('link-change 失败止损接线', () => {
  it('command-missing 一次即短路后续 link-change（start/stop 仍照刷）', async () => {
    const svc = makeSvc();
    mockFlush.mockResolvedValue({ ok: false, reason: 'command-missing', detail: 'ENOENT' });
    svc.flushOsDnsCacheBestEffort('link-change', 'fp-A');
    await settle();
    expect(svc.linkChangeFlushSuppressed).toBe(true);

    mockFlush.mockClear();
    svc.lastLinkChangeFlushAt = 0; // 排除限频干扰，单独看抑制
    svc.flushOsDnsCacheBestEffort('link-change', 'fp-B');
    expect(mockFlush).not.toHaveBeenCalled();

    svc.flushOsDnsCacheBestEffort('start', 'fp-B');
    expect(mockFlush).toHaveBeenCalledTimes(1);
  });

  it('unknown 连败达上限才抑制——达标前每次都真刷（瞬态失败值得重试）', async () => {
    const svc = makeSvc();
    mockFlush.mockResolvedValue({
      ok: false,
      reason: 'unknown',
      detail: 'Failed to connect to bus',
    });
    for (let i = 0; i < LINK_CHANGE_FLUSH_FAIL_STREAK_LIMIT; i++) {
      svc.lastLinkChangeFlushAt = 0;
      svc.flushOsDnsCacheBestEffort('link-change', `fp-${i}`);
      await settle();
    }
    expect(mockFlush).toHaveBeenCalledTimes(LINK_CHANGE_FLUSH_FAIL_STREAK_LIMIT);
    expect(svc.linkChangeFlushSuppressed).toBe(true);

    mockFlush.mockClear();
    svc.lastLinkChangeFlushAt = 0;
    svc.flushOsDnsCacheBestEffort('link-change', 'fp-after');
    expect(mockFlush).not.toHaveBeenCalled();
  });

  it('抑制后任意一次成功刷新即解除（会话中途装上 systemd-resolved / 修好授权可恢复）', async () => {
    const svc = makeSvc();
    mockFlush.mockResolvedValue({ ok: false, reason: 'command-missing', detail: 'ENOENT' });
    svc.flushOsDnsCacheBestEffort('link-change', 'fp-A');
    await settle();
    expect(svc.linkChangeFlushSuppressed).toBe(true);

    mockFlush.mockResolvedValue({ ok: true, detail: 'resolvectl flush-caches' });
    svc.flushOsDnsCacheBestEffort('start', 'fp-B');
    await settle();
    expect(svc.linkChangeFlushSuppressed).toBe(false);
    expect(svc.linkChangeFlushFailStreak).toBe(0);

    mockFlush.mockClear();
    svc.lastLinkChangeFlushAt = 0;
    svc.flushOsDnsCacheBestEffort('link-change', 'fp-C');
    expect(mockFlush).toHaveBeenCalledTimes(1);
  });

  it('skipped（平台无机制）不计连败，也不解除抑制——它既不是成功也不是失败', async () => {
    const svc = makeSvc();
    mockFlush.mockResolvedValue({ ok: true, skipped: true, detail: '平台无机制' });
    svc.flushOsDnsCacheBestEffort('link-change', 'fp-A');
    await settle();
    expect(svc.linkChangeFlushFailStreak).toBe(0);
    expect(svc.linkChangeFlushSuppressed).toBe(false);
    expect(svc.lastNetworkFingerprint).toBeNull(); // 没真刷 → 不推进基线
  });
});

describe('乱序 settle 接线', () => {
  it('后发起的先 settle 后，先发起的那次结果一律作废（基线不得退回过期指纹）', async () => {
    const svc = makeSvc();
    let resolveSlow: (r: { ok: boolean; detail: string }) => void = () => {};
    mockFlush.mockImplementationOnce(
      () =>
        new Promise<{ ok: boolean; detail: string }>((r) => {
          resolveSlow = r;
        })
    );
    mockFlush.mockResolvedValueOnce({ ok: true, detail: 'fast' });

    svc.flushOsDnsCacheBestEffort('start', 'fp-OLD'); // 慢（darwin helper 可达数秒）
    svc.flushOsDnsCacheBestEffort('link-change', 'fp-NEW'); // 快，先 settle
    await settle();
    expect(svc.lastNetworkFingerprint).toBe('fp-NEW');

    resolveSlow({ ok: true, detail: 'slow' });
    await settle();
    expect(svc.lastNetworkFingerprint).toBe('fp-NEW'); // 不回退
    expect(svc.lastDnsFlush.detail).toBe('fast'); // 诊断快照也按发起序，不按 settle 序
  });
});

describe('指纹组装接线', () => {
  it('非 Linux 退化为纯地址指纹，不含 resolver 段', async () => {
    const fp = await withPlatformAsync('darwin', async () => makeSvc().readNetworkFingerprint());
    expect(fp).not.toContain('#resolver');
  });

  it('Linux 下以地址指纹为前缀（resolver 段只追加、不篡改地址部分）', async () => {
    const fp = await withPlatformAsync('linux', async () => makeSvc().readNetworkFingerprint());
    const addrOnly = await withPlatformAsync('darwin', async () =>
      makeSvc().readNetworkFingerprint()
    );
    expect(fp.startsWith(addrOnly)).toBe(true);
  });
});

/**
 * watcher 起停接线（复审 Low-A）。
 * 这段薄接线此前零覆盖，而删掉其中一行 `this.linkChangeHandler = handler` 就能**静默**复活「限频拦下即丢弃」
 * ——补刷守卫 `if (!this.linkChangeHandler) return` 会恒真短路，全量测试照样绿。与 partial 漏抄、补刷守卫反转
 * 是同一形态：判据是「接线缺陷能不能静默过全绿」，缝挪个位置就得再补一次门。
 */
describe('startDnsInterfaceWatcher 接线', () => {
  const makeFakeChild = (): {
    child: unknown;
    fireClose: () => void;
  } => {
    let closeCb: (() => void) | null = null;
    const child: Record<string, unknown> = {
      stdout: { on: jest.fn() },
      kill: jest.fn(() => true),
    };
    child.on = jest.fn((event: string, listener: () => void): unknown => {
      if (event === 'close') closeCb = listener;
      return child;
    });
    return { child, fireClose: (): void => closeCb?.() };
  };

  it('起 watcher 后补刷 handler 就位（缺这一行，补刷守卫恒短路 = 拦下即丢弃）', async () => {
    await withPlatformAsync('linux', async () => {
      const svc = makeSvc();
      svc.linkChangeHandler = null; // 抹掉 makeSvc 注入的探针，看真实接线
      (spawn as unknown as jest.Mock).mockReturnValue(makeFakeChild().child);

      svc.startDnsInterfaceWatcher();
      expect(svc.linkChangeHandler).not.toBeNull();
      expect(svc.dnsInterfaceWatcher).not.toBeNull();

      svc.stopDnsInterfaceWatcher();
      expect(svc.linkChangeHandler).toBeNull(); // 停时一并收，防跨代触发
    });
  });

  it('唤醒豁免限频真的接上了（onResume → lastLinkChangeFlushAt 归零）', async () => {
    await withPlatformAsync('linux', async () => {
      const svc = makeSvc();
      (spawn as unknown as jest.Mock).mockReturnValue(makeFakeChild().child);
      (powerMonitor.on as jest.Mock).mockClear();

      svc.startDnsInterfaceWatcher();
      svc.lastLinkChangeFlushAt = 123_456; // 假装刚刷过，正处抑制窗口内

      // watcher 订阅的 resume 监听器：由它同步回调 onResume。
      const resumeListener = (powerMonitor.on as jest.Mock).mock.calls.find(
        (c) => c[0] === 'resume'
      )?.[1] as (() => void) | undefined;
      expect(resumeListener).toBeDefined();
      resumeListener?.();

      expect(svc.lastLinkChangeFlushAt).toBe(0); // 唤醒后下一次刷新不再被限频吃掉
      svc.stopDnsInterfaceWatcher();
    });
  });
});
