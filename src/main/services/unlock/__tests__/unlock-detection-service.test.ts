/**
 * UnlockDetectionService 编排单测（node env）：mock electron session（fromPartition + setProxy）+ 注入
 * fake transport + fake clock。覆盖单飞 / 缓存 TTL / force 硬下限 / egress 失败不写缓存 / gating 短路 /
 * progress / invalidate / 端口变重 pin / setProxy reject 不落 default session（照 update-network.test.ts 范式）。
 */
const mockFromPartition = jest.fn();
jest.mock('electron', () => ({
  session: { fromPartition: (...a: unknown[]) => mockFromPartition(...a) },
}));

import {
  READINESS_BACKOFF_SCHEDULE_MS,
  READINESS_CONFIRM_MS,
  READINESS_MAX_ATTEMPTS,
  SETTLE_RETRY_BACKOFF_MS,
  SETTLE_RETRY_MAX_ROUNDS,
  TOTAL_DETECTION_BUDGET_MS,
  RECHECK_DELAY_MS,
  TIMEOUT_TTL_MS,
  UnlockDetectionService,
  type UnlockServiceDeps,
} from '../UnlockDetectionService';

/** 就绪门退避序列总和（advance timers 用）：sum(schedule)。 */
const READINESS_TOTAL_BACKOFF_MS = READINESS_BACKOFF_SCHEDULE_MS.reduce((a, b) => a + b, 0);
import { DISNEY, EGRESS_TRACE_URL, GEMINI, NETFLIX, SPOTIFY } from '../unlock-endpoints';
import type { UnlockResponse } from '../unlock-http';
import { SERVICE_IDS } from '../../../../shared/unlock-detection';
import type { ProxyExitBlock } from '../../../../shared/types';

function res(over: Partial<UnlockResponse> = {}): UnlockResponse {
  return { status: 200, headers: {}, body: '', truncated: false, redirectChain: [], ...over };
}

/**
 * 默认「全 reachable」响应：让 6 个 checker 都**不落 timeout**——disney 需 assertion 链、spotify 需 status，否则
 * 空 body 会 timeout → 触发 warmup 补测循环（退避 sleep）污染无关测试。disney/spotify 给早退 blocked body 即非
 * timeout；其余空 200 已非 timeout（chatgpt/netflix→ok、claude→ok、gemini→blocked）。
 */
function okBody(url: string): UnlockResponse {
  if (url === DISNEY.devicesUrl) return res({ status: 200, body: '403 ERROR' }); // → blocked（早退，不进后续链）
  if (url === SPOTIFY.signupUrl) return res({ status: 200, body: '{"status":320}' }); // → blocked
  return res({ status: 200 });
}

interface Harness {
  svc: UnlockDetectionService;
  sess: { setProxy: jest.Mock };
  onProgress: jest.Mock;
  onInvalidated: jest.Mock;
  transport: jest.Mock;
  log: jest.Mock;
  setTime: (v: number) => void;
  setPort: (v: number) => void;
  setExitBlock: (v: ProxyExitBlock | null) => void;
  egressCalls: () => number;
  netflixCalls: () => number;
}

function build(
  opts: {
    running?: () => boolean;
    setProxy?: jest.Mock;
    egress?: () => UnlockResponse;
    /** 非 egress 请求按 url 定制响应（warmup 补测测试用；缺省全 200 空 body）。 */
    responder?: (url: string) => UnlockResponse;
    /** 选中 TS 出口直判无效初值（M-gate 测试用；缺省 null=出口有效）。 */
    exitBlock?: ProxyExitBlock | null;
  } = {}
): Harness {
  const sess = { setProxy: opts.setProxy ?? jest.fn().mockResolvedValue(undefined) };
  mockFromPartition.mockReturnValue(sess);
  const onProgress = jest.fn();
  const onInvalidated = jest.fn();
  const log = jest.fn();
  const egress = opts.egress ?? (() => res({ body: 'ip=9.9.9.9\nloc=HK\n' }));
  const transport = jest.fn((_s: unknown, req: { url: string }) =>
    Promise.resolve(
      req.url === EGRESS_TRACE_URL
        ? egress()
        : opts.responder
          ? opts.responder(req.url)
          : okBody(req.url)
    )
  );
  let t = 1_000_000;
  let port = 7890;
  let exitBlock: ProxyExitBlock | null = opts.exitBlock ?? null;
  const deps: UnlockServiceDeps = {
    getMixedPort: () => port,
    isRunning: opts.running ?? (() => true),
    getExitBlock: () => exitBlock,
    onProgress,
    onInvalidated,
    log,
    transport: transport as unknown as UnlockServiceDeps['transport'],
    now: () => t,
  };
  const svc = new UnlockDetectionService(deps);
  return {
    svc,
    sess,
    onProgress,
    onInvalidated,
    log,
    transport,
    setTime: (v) => (t = v),
    setPort: (v) => (port = v),
    setExitBlock: (v) => (exitBlock = v),
    egressCalls: () => transport.mock.calls.filter((c) => c[1].url === EGRESS_TRACE_URL).length,
    netflixCalls: () =>
      transport.mock.calls.filter((c) => c[1].url === NETFLIX.nonOriginalUrl).length,
  };
}

beforeEach(() => mockFromPartition.mockReset());
afterEach(() => jest.useRealTimers()); // 就绪门退避测试用 fake timers，收尾复位防泄漏

describe('gating', () => {
  it('核未运行 → blockedReason，零网络', async () => {
    const h = build({ running: () => false });
    const snap = await h.svc.run();
    expect(snap).toEqual({
      results: {},
      checkedAt: null,
      egress: null,
      blockedReason: 'proxy-not-running',
    });
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.onProgress).not.toHaveBeenCalled();
  });
});

describe('M-gate：选中 TS 出口无效 → 短路（零网络）', () => {
  it('getExitBlock 非空 → blockedReason=exit-invalid，transport/progress 零调用', async () => {
    const h = build({ exitBlock: 'ts-no-exit-device' });
    const snap = await h.svc.run();
    expect(snap).toEqual({
      results: {},
      checkedAt: null,
      egress: null,
      blockedReason: 'exit-invalid',
    });
    expect(h.transport).not.toHaveBeenCalled(); // 就绪门/checker 全不打
    expect(h.onProgress).not.toHaveBeenCalled();
  });

  it('force 亦短路（用户手动刷新经无效出口同样零网络，毫秒级返回）', async () => {
    const h = build({ exitBlock: 'ts-exit-not-advertised' });
    const snap = await h.svc.run(true);
    expect(snap.blockedReason).toBe('exit-invalid');
    expect(h.transport).not.toHaveBeenCalled();
  });

  it('出口恢复有效（setExitBlock(null)）→ 下轮正常检测（打网络、点亮）', async () => {
    const h = build({ exitBlock: 'ts-exit-device-offline' });
    await h.svc.run();
    expect(h.transport).not.toHaveBeenCalled();
    h.setExitBlock(null); // 翻回有效（真机由 reconcileTsExitBlock invalidate + 本轮重跑驱动）
    await h.svc.run();
    expect(h.egressCalls()).toBe(2); // 就绪门探测(1) + F-B 轮尾归属 bracket 复测(1)
    expect(h.onProgress).toHaveBeenCalledTimes(SERVICE_IDS.length);
  });
});

describe('单飞', () => {
  it('并发 run 只跑一轮', async () => {
    const h = build();
    const [a, b] = await Promise.all([h.svc.run(), h.svc.run()]);
    expect(a).toBe(b); // 同一 promise 结果
    expect(h.egressCalls()).toBe(2); // 就绪门(1) + F-B bracket(1)；单飞只一轮
    expect(h.netflixCalls()).toBe(1);
  });
});

describe('progress', () => {
  it('每服务 settle 各广播一次', async () => {
    const h = build();
    await h.svc.run();
    expect(h.onProgress).toHaveBeenCalledTimes(SERVICE_IDS.length);
    const ids = h.onProgress.mock.calls.map((c) => c[0].serviceId).sort();
    expect(ids).toEqual([...SERVICE_IDS].sort());
  });
});

describe('缓存 / TTL', () => {
  it('非 force 命中 TTL → 不重打 checker', async () => {
    const h = build();
    await h.svc.run();
    expect(h.netflixCalls()).toBe(1);
    h.setTime(1_000_000 + 60_000); // < 30min
    await h.svc.run();
    // run1 = 就绪门(1)+bracket(1)=2；run2 命中 TTL 缓存（就绪门(1) → 命中即返回，在 bracket 之前）=1 → 共 3。
    expect(h.egressCalls()).toBe(3);
    expect(h.netflixCalls()).toBe(1); // 命中缓存，checker 未重打
  });

  it('超 TTL → 重打', async () => {
    const h = build();
    await h.svc.run();
    h.setTime(1_000_000 + 31 * 60_000); // > 30min
    await h.svc.run();
    expect(h.netflixCalls()).toBe(2);
  });

  it('force 绕 TTL 但 15s 硬下限内直接返回上次快照（零网络）', async () => {
    const h = build();
    await h.svc.run();
    const before = h.egressCalls();
    h.setTime(1_000_000 + 5_000); // < 15s
    await h.svc.run(true);
    expect(h.egressCalls()).toBe(before); // 未再打 trace
    expect(h.netflixCalls()).toBe(1);
  });

  it('force 超 15s 硬下限 → 重打', async () => {
    const h = build();
    await h.svc.run();
    h.setTime(1_000_000 + 20_000);
    await h.svc.run(true);
    expect(h.netflixCalls()).toBe(2);
  });
});

describe('就绪门（H6：核起了但 inbound 未路由）', () => {
  const flushMicrotasks = async (n = 12): Promise<void> => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };

  it('核已就绪（第1次探测即通）→ 零额外延迟，单次 trace，正常跑 checker', async () => {
    // 默认 egress 首次即有效；用真实定时器证明无退避（若走了退避会需要 fake timer 推进才能完成）。
    const h = build();
    const snap = await h.svc.run();
    expect(h.egressCalls()).toBe(2); // 就绪门未重试(1) + F-B bracket(1)
    expect(snap.notReady).toBeUndefined();
    expect(snap.egress).toEqual({ ip: '9.9.9.9', region: 'HK' });
    expect(h.netflixCalls()).toBe(1);
  });

  it('B1：曾失败过（第1次失败、第2次成功）→ 追加 1 次确认（连续 2 成才就绪）+ 正常跑 checker', async () => {
    jest.useFakeTimers();
    let attempt = 0;
    const h = build({
      egress: () => {
        attempt++;
        return attempt === 1
          ? res({ status: 0, error: 'x' })
          : res({ body: 'ip=9.9.9.9\nloc=HK\n' });
      },
    });
    const p = h.svc.run();
    // probe0 失败 → 退避 schedule[0] → probe1 成功（everFailed）→ 确认退避 CONFIRM → probe2 确认成功 → 就绪。
    await jest.advanceTimersByTimeAsync(READINESS_BACKOFF_SCHEDULE_MS[0] + READINESS_CONFIRM_MS);
    const snap = await p;
    expect(h.egressCalls()).toBe(4); // 失败+成功+确认成功（B1 3 次）+ F-B bracket(1)
    expect(snap.notReady).toBeUndefined();
    expect(snap.egress).toEqual({ ip: '9.9.9.9', region: 'HK' });
    expect(h.netflixCalls()).toBe(1); // 就绪后正常跑 checker
    expect(h.svc.getSnapshot()).not.toBeNull();
  });

  it('B1：首攻即成（一路成功）→ 零确认、零延迟就绪（健康路径不加确认）', async () => {
    const h = build(); // 默认 egress 恒成功
    const snap = await h.svc.run();
    expect(h.egressCalls()).toBe(2); // 首攻成功即就绪(1) + F-B bracket(1)
    expect(snap.notReady).toBeUndefined();
    expect(h.netflixCalls()).toBe(1);
  });

  it('D1：就绪门耗尽 → notReady 终态**已提交**（checkedAt null、不写缓存、lastRunAt 推进）', async () => {
    jest.useFakeTimers();
    const h = build({ egress: () => res({ status: 0, error: 'x' }) });
    const p1 = h.svc.run();
    await jest.advanceTimersByTimeAsync(READINESS_TOTAL_BACKOFF_MS + 100);
    const snap1 = await p1;
    expect(snap1.notReady).toBe(true);
    expect(snap1.checkedAt).toBeNull();
    expect(snap1.egress).toBeNull();
    expect(h.netflixCalls()).toBe(0); // 未就绪 → 不跑 checker
    expect(h.svc.getSnapshot()?.notReady).toBe(true); // D1：**已提交** notReady 终态（非原「不提交」）
    expect(h.egressCalls()).toBe(READINESS_MAX_ATTEMPTS); // 探满 7 次（schedule.length+1）
  });

  it('D2 S-gate：notReady 终态后 run(false) 短路返终态、零就绪门；invalidate 解除后重试', async () => {
    jest.useFakeTimers();
    const h = build({ egress: () => res({ status: 0, error: 'x' }) });
    const p1 = h.svc.run();
    await jest.advanceTimersByTimeAsync(READINESS_TOTAL_BACKOFF_MS + 100);
    await p1;
    expect(h.egressCalls()).toBe(READINESS_MAX_ATTEMPTS); // 首轮探满

    // S-gate：非 force run → 直接返 notReady 终态，**不再探就绪门**（防 mount/切 tab 风暴）。
    const snap2 = await h.svc.run();
    expect(snap2.notReady).toBe(true);
    expect(h.egressCalls()).toBe(READINESS_MAX_ATTEMPTS); // 零新增 egress trace

    // invalidate（真状态变化）解除 S-gate → 下一轮真重试。
    h.svc.invalidate();
    const p3 = h.svc.run();
    await jest.advanceTimersByTimeAsync(READINESS_TOTAL_BACKOFF_MS + 100);
    await p3;
    expect(h.egressCalls()).toBe(READINESS_MAX_ATTEMPTS * 2); // 再探满 → 证明解除
  });

  it('退避期间 invalidate（epoch 变）→ 放弃本轮、不落陈旧 notReady 终态、不悬挂定时器', async () => {
    jest.useFakeTimers();
    const h = build({ egress: () => res({ status: 0, error: 'x' }) });
    const p = h.svc.run();
    await flushMicrotasks(); // 推进过首探失败，进入第一次退避 sleep
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    h.svc.invalidate(); // epoch++ → 唤醒退避 sleep + 清定时器
    expect(jest.getTimerCount()).toBe(0);

    const snap = await p;
    // 被 invalidate → commit 的 epoch 守卫丢弃陈旧终态（返复位快照，无 notReady）；不锁 S-gate（下轮可重试）。
    expect(snap.notReady).toBeFalsy();
    expect(h.netflixCalls()).toBe(0);
    expect(h.svc.getSnapshot()).toBeNull(); // 陈旧终态未提交
    expect(h.onInvalidated).toHaveBeenCalledTimes(1);
  });

  it('B2 低置信不缓存：就绪过但 checker 全 timeout → 提交 lowConfidence、不写缓存、下轮重检', async () => {
    jest.useFakeTimers();
    // 就绪门通过（egress 成功），但所有 checker 请求超时（responder 返 status 0）→ all-timeout。
    const h = build({
      egress: () => res({ body: 'ip=9.9.9.9\nloc=HK\n' }),
      responder: () => res({ status: 0, error: 't' }),
    });
    const p1 = h.svc.run();
    await jest.advanceTimersByTimeAsync(
      SETTLE_RETRY_BACKOFF_MS * (SETTLE_RETRY_MAX_ROUNDS + 1) + 100
    ); // 放行 warmup 补测轮
    const snap1 = await p1;
    expect(snap1.lowConfidence).toBe(true);
    expect(snap1.checkedAt).not.toBeNull(); // 有 checkedAt（跑了 checker，如实显灰）
    expect(h.svc.getSnapshot()?.lowConfidence).toBe(true); // 提交 lastSnapshot（UI/mount 水合）
    const egressBefore = h.egressCalls();
    // 非 force run：lowConfidence 无 S-gate（有 checkedAt，走缓存查询）——但未写 cache → 重新跑一轮（非命中缓存短路）。
    const p2 = h.svc.run();
    await jest.advanceTimersByTimeAsync(
      READINESS_TOTAL_BACKOFF_MS + SETTLE_RETRY_BACKOFF_MS * (SETTLE_RETRY_MAX_ROUNDS + 1) + 100
    );
    await p2;
    expect(h.egressCalls()).toBeGreaterThan(egressBefore); // 未缓存 → 重检（证明不锁 30min）
  });
});

describe('warmup 定向补测（settle-retry）', () => {
  const flushMicrotasks = async (n = 12): Promise<void> => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };

  it('首轮个别 timeout → 退避补测恢复；仅重打灰的（blocked/ok 不补测）', async () => {
    jest.useFakeTimers();
    let g = 0;
    let spot = 0;
    const h = build({
      responder: (url) => {
        if (url === GEMINI.homeUrl) {
          g++;
          // 首轮网络失败（timeout），补测轮返回可用 marker（ok）。
          return g === 1
            ? res({ status: 0, error: 'x' })
            : res({ status: 200, body: GEMINI.availableMarker });
        }
        if (url === SPOTIFY.signupUrl) {
          spot++;
          return res({ status: 200, body: '{"status":320}' }); // blocked（非 timeout）
        }
        return okBody(url);
      },
    });
    const p = h.svc.run();
    await jest.advanceTimersByTimeAsync(SETTLE_RETRY_BACKOFF_MS); // 放行补测轮1退避
    const snap = await p;
    expect(snap.results.gemini.status).toBe('ok'); // 补测后恢复
    expect(g).toBe(2); // 首轮失败 + 补测 1 次
    expect(spot).toBe(1); // blocked 未被补测
    expect(h.netflixCalls()).toBe(1); // 其余非 timeout 服务未重打
    const gemProg = h.onProgress.mock.calls
      .filter((c) => c[0].serviceId === 'gemini')
      .map((c) => c[0].result.status);
    expect(gemProg).toEqual(['timeout', 'checking', 'ok']); // 灰 → spinner → 终值
  });

  it('快路径：首轮无 timeout → 不补测、无 checking 二次广播、无退避（真实定时器直完成）', async () => {
    const h = build(); // 默认 okBody：6 服务皆非 timeout
    const snap = await h.svc.run(); // 若误进补测退避，真实定时器下会挂（测试超时暴露）
    expect(h.netflixCalls()).toBe(1);
    expect(snap.results.gemini.status).not.toBe('timeout');
    const checkingBroadcasts = h.onProgress.mock.calls.filter(
      (c) => c[0].result.status === 'checking'
    );
    expect(checkingBroadcasts).toHaveLength(0); // 无补测 → 无 checking 广播
    expect(h.onProgress).toHaveBeenCalledTimes(SERVICE_IDS.length); // 每服务仅一次
  });

  it('补测耗尽（恒失败）→ 落定 timeout + 提交缓存；重打轮数 = 1 + MAX_ROUNDS', async () => {
    jest.useFakeTimers();
    let g = 0;
    const h = build({
      responder: (url) => {
        if (url === GEMINI.homeUrl) {
          g++;
          return res({ status: 0, error: 'x' }); // 恒失败
        }
        return okBody(url);
      },
    });
    const p = h.svc.run();
    // 推满 2 轮退避（2s + 4s）。
    let total = 0;
    for (let round = 1; round <= SETTLE_RETRY_MAX_ROUNDS; round++) {
      total += SETTLE_RETRY_BACKOFF_MS * round;
    }
    await jest.advanceTimersByTimeAsync(total);
    const snap = await p;
    expect(snap.results.gemini.status).toBe('timeout'); // 补测耗尽 → 落定
    expect(g).toBe(1 + SETTLE_RETRY_MAX_ROUNDS); // 首轮 + 2 补测轮
    expect(h.svc.getSnapshot()).not.toBeNull(); // 已提交（收敛快照入缓存）
  });

  it('补测退避期 invalidate → 放弃本轮、不悬挂定时器、不提交', async () => {
    jest.useFakeTimers();
    const h = build({
      responder: (url) => (url === GEMINI.homeUrl ? res({ status: 0, error: 'x' }) : okBody(url)),
    });
    const p = h.svc.run();
    await flushMicrotasks(80); // 穿透首轮 6-checker allSettled + checking 广播，进入补测轮1退避 sleep
    expect(jest.getTimerCount()).toBeGreaterThan(0); // 补测退避定时器在跑

    h.svc.invalidate(); // epoch++ → 唤醒退避 sleep + 清定时器
    expect(jest.getTimerCount()).toBe(0); // 不悬挂

    const snap = await p; // 若未 abort，fake timer 下永挂（测试超时暴露）
    expect(Object.keys(snap.results)).toHaveLength(0); // 陈旧轮 commit 守卫丢弃 → 空 results
    expect(h.svc.getSnapshot()).toBeNull(); // 不提交 lastSnapshot
    expect(h.onInvalidated).toHaveBeenCalledTimes(1);
  });
});

describe('invalidate', () => {
  it('清缓存 + 快照，广播 onInvalidated', async () => {
    const h = build();
    await h.svc.run();
    expect(h.svc.getSnapshot()).not.toBeNull();
    h.svc.invalidate();
    expect(h.onInvalidated).toHaveBeenCalledTimes(1);
    expect(h.svc.getSnapshot()).toBeNull();
    h.setTime(1_000_000 + 1_000);
    await h.svc.run(); // 缓存已清 → 重打
    expect(h.netflixCalls()).toBe(2);
  });
});

describe('session pin', () => {
  it('端口变才重 pin（同端口复用会话）', async () => {
    const h = build();
    await h.svc.run();
    expect(h.sess.setProxy).toHaveBeenCalledWith({ proxyRules: 'socks5://127.0.0.1:7890' });
    expect(h.sess.setProxy).toHaveBeenCalledTimes(1);
    h.setPort(7891);
    h.setTime(1_000_000 + 20_000);
    await h.svc.run(true);
    expect(h.sess.setProxy).toHaveBeenLastCalledWith({ proxyRules: 'socks5://127.0.0.1:7891' });
    expect(h.sess.setProxy).toHaveBeenCalledTimes(2);
    expect(mockFromPartition).toHaveBeenCalledTimes(1); // 会话复用，仅建一次
  });

  it('setProxy reject → 本轮全 timeout，绝不落 default session（transport 零调用）', async () => {
    const h = build({ setProxy: jest.fn().mockRejectedValue(new Error('boom')) });
    const snap = await h.svc.run();
    expect(h.transport).not.toHaveBeenCalled(); // 未走任何会话发请求
    expect(snap.egress).toBeNull();
    for (const id of SERVICE_IDS) expect(snap.results[id]).toEqual({ status: 'timeout' });
    expect(h.onProgress).toHaveBeenCalledTimes(SERVICE_IDS.length);
  });

  it('端口 <=0（未分配）→ 全 timeout，不建会话', async () => {
    const h = build();
    h.setPort(0);
    const snap = await h.svc.run();
    expect(mockFromPartition).not.toHaveBeenCalled();
    expect(snap.egress).toBeNull();
    for (const id of SERVICE_IDS) expect(snap.results[id]).toEqual({ status: 'timeout' });
  });
});

describe('H1 invalidate 在飞竞态（epoch 闸）', () => {
  it('在飞轮被 invalidate → 陈旧 progress 不广播/不写快照；后续 run 链在其后重跑新鲜轮', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let phase = 0; // 0=第一轮 checker 挂起；1=第二轮立即返回
    const onProgress = jest.fn();
    const onInvalidated = jest.fn();
    const sess = { setProxy: jest.fn().mockResolvedValue(undefined) };
    mockFromPartition.mockReturnValue(sess);
    const t = 1_000_000;
    const transport = jest.fn(async (_s: unknown, req: { url: string }) => {
      if (req.url === EGRESS_TRACE_URL) return res({ body: 'ip=9.9.9.9\nloc=HK\n' });
      if (phase === 0) await gate; // 第一轮 checker 请求挂起，制造在飞窗口
      return okBody(req.url); // 非 timeout（否则 disney/spotify 空 body 会触发补测退避污染本测）
    });
    const svc = new UnlockDetectionService({
      getMixedPort: () => 7890,
      isRunning: () => true,
      onProgress,
      onInvalidated,
      transport: transport as unknown as UnlockServiceDeps['transport'],
      now: () => t,
    });

    const run1 = svc.run(); // epoch 0，进入 checker 后挂起
    for (let i = 0; i < 6; i++) await Promise.resolve(); // 推进到 allSettled 挂起态

    svc.invalidate(); // epoch → 1，作废在飞轮
    expect(onInvalidated).toHaveBeenCalledTimes(1);

    const run2 = svc.run(); // 在飞 epoch 已陈旧 → 链在 run1 之后重跑新鲜轮
    phase = 1; // 第二轮 checker 立即返回
    release(); // 放行第一轮挂起的 checker

    const [snap1, snap2] = await Promise.all([run1, run2]);

    // 陈旧轮：不写快照（返回复位空快照），progress 全被 epoch 闸抑制。
    expect(Object.keys(snap1.results)).toHaveLength(0);
    // 新鲜轮：结果齐全 + egress。
    expect(snap2.egress).toEqual({ ip: '9.9.9.9', region: 'HK' });
    expect(Object.keys(snap2.results).sort()).toEqual([...SERVICE_IDS].sort());
    // 仅新鲜轮广播 progress（陈旧轮 6 个全抑制）。
    expect(onProgress).toHaveBeenCalledTimes(SERVICE_IDS.length);
    // checker 各跑两轮（陈旧 + 新鲜）→ 证明链式重跑而非 join 陈旧结果。
    const netflixCalls = transport.mock.calls.filter(
      (c) => (c[1] as { url: string }).url === NETFLIX.nonOriginalUrl
    ).length;
    expect(netflixCalls).toBe(2);
    // 最终快照 = 新鲜轮（非 null）。
    expect(svc.getSnapshot()).not.toBeNull();
  });
});

describe('Z1：陈旧链节头部零网络短路（§12.4.3 GAP①）', () => {
  const flushMicrotasks = async (n = 20): Promise<void> => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };

  it('chainRun 排队期间再 invalidate → 该链节 doRun 头部零就绪门 trace', async () => {
    jest.useFakeTimers();
    const h = build({ egress: () => res({ status: 0, error: 'x' }) }); // egress 恒失败 → 首探后进退避 sleep
    const p0 = h.svc.run(); // doRun#0（startEpoch=0）
    await flushMicrotasks(); // 推进过首探失败 → 进第一次退避 sleep（doRun#0 挂起）
    expect(h.egressCalls()).toBe(1); // 仅首探

    h.svc.invalidate(); // epoch→1：唤醒退避、doRun#0 本轮放弃
    const p1 = h.svc.run(); // inflightEpoch(0)!=epoch(1) → chainRun：doRun#1(startEpoch=1) 排 p0 后
    h.svc.invalidate(); // epoch→2：doRun#1 尚未执行 → 其 startEpoch(1) != epoch(2)

    await flushMicrotasks(); // 放行 p0 收口 + 链节 doRun#1 头部短路（同步，无 await ensureFetch）
    await Promise.all([p0, p1]);

    // Z1：陈旧链节零新增 trace（无 Z1 时 doRun#1 会再打 1 次就绪门首探 → egressCalls 变 2）。
    expect(h.egressCalls()).toBe(1);
    expect(h.netflixCalls()).toBe(0);
  });
});

describe('X2：per-leg 传输失败诊断日志（§12.2）', () => {
  it('checker 请求失败 → log 记 host/err/phase/bytes/elapsed（V36 分诊依赖，判定不变）', async () => {
    jest.useFakeTimers();
    const h = build({
      egress: () => res({ body: 'ip=9.9.9.9\nloc=HK\n' }), // 就绪门过
      responder: () => res({ status: 0, error: 'timeout', phase: 'connect', bytes: 0 }), // checker 全失败
    });
    const p = h.svc.run();
    await jest.advanceTimersByTimeAsync(
      SETTLE_RETRY_BACKOFF_MS * (SETTLE_RETRY_MAX_ROUNDS + 1) + 100
    );
    const snap = await p;
    const failLogs = h.log.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.startsWith('unlock leg fail'));
    expect(failLogs.length).toBeGreaterThan(0);
    expect(failLogs[0]).toMatch(/host=\S+ err=timeout phase=connect bytes=0 elapsed=\d+ms/);
    // 判定不变：全 timeout 仍走既有 lowConfidence 路径（X2 纯诊断，不改判定）。
    expect(snap.lowConfidence).toBe(true);
  });
});

// issue 1：整轮 wall-clock deadline（TOTAL_DETECTION_BUDGET_MS）贯穿就绪门 / checker 主轮 / settle-retry。now() 随每次
// 网络操作推进（模拟真实耗时），越过 deadline 即提前收口——替代旧「三段独立预算加法累加最坏 ~127s」。
describe('issue 1 总检测超时 deadline', () => {
  // build 变体：now() 读随每次网络操作推进的虚拟时钟（build 的 now 恒定 1_000_000，无法触发 deadline）。
  function buildAdvancing(opts: {
    perOpAdvanceMs: number;
    egress?: () => UnlockResponse;
    responder?: (url: string) => UnlockResponse;
  }) {
    const sess = { setProxy: jest.fn().mockResolvedValue(undefined) };
    mockFromPartition.mockReturnValue(sess);
    let clock = 1_000_000;
    const onProgress = jest.fn();
    const transport = jest.fn((_s: unknown, req: { url: string; timeoutMs?: number }) => {
      const resp =
        req.url === EGRESS_TRACE_URL
          ? (opts.egress?.() ?? res({ status: 0, error: 'x' }))
          : (opts.responder?.(req.url) ?? okBody(req.url));
      clock += opts.perOpAdvanceMs; // 每次网络操作后推进虚拟时钟
      return Promise.resolve(resp);
    });
    const svc = new UnlockDetectionService({
      getMixedPort: () => 7890,
      isRunning: () => true,
      onProgress,
      onInvalidated: jest.fn(),
      transport: transport as unknown as UnlockServiceDeps['transport'],
      now: () => clock,
    });
    const egressCalls = () => transport.mock.calls.filter((c) => c[1].url === EGRESS_TRACE_URL);
    return { svc, onProgress, transport, egressCalls };
  }

  it('就绪门恒失败 + now() 随探测推进越过 deadline → notReady 且探测次数 < 7（提前收口，非探满）', async () => {
    jest.useFakeTimers();
    // 每探推进 ⌈budget/3⌉：约 3 次探测即越 deadline → 提前收口，不探满 READINESS_MAX_ATTEMPTS。
    const h = buildAdvancing({
      perOpAdvanceMs: Math.ceil(TOTAL_DETECTION_BUDGET_MS / 3),
      egress: () => res({ status: 0, error: 'x' }),
    });
    const p = h.svc.run(false);
    await jest.advanceTimersByTimeAsync(
      READINESS_BACKOFF_SCHEDULE_MS.reduce((a, b) => a + b, 0) + 100
    );
    const snap = await p;
    expect(snap.notReady).toBe(true);
    expect(h.egressCalls().length).toBeLessThan(READINESS_MAX_ATTEMPTS); // 未探满 7 次
    // 单次探测按剩余预算收紧超时：末次探测 timeoutMs 收窄到 <默认 8s 且 >0（deadline 逼近）。
    const calls = h.egressCalls();
    const last = calls[calls.length - 1];
    expect(last?.[1].timeoutMs).toBeLessThan(8000);
    expect(last?.[1].timeoutMs).toBeGreaterThan(0);
  });

  it('就绪门快过 + checker 轮耗时越 deadline → settle-retry 跳过（无 checking 二次广播、timeout 落定）', async () => {
    jest.useFakeTimers();
    // egress 首探即成（clock 尚早）；此后每次 checker 网络操作 +3s，跑首轮即越 deadline → settle-retry 提前 break。
    const h = buildAdvancing({
      perOpAdvanceMs: 3000,
      egress: () => res({ status: 200, body: 'ip=9.9.9.9\nloc=HK\n' }),
      responder: (url) => (url === GEMINI.homeUrl ? res({ status: 0, error: 'x' }) : okBody(url)),
    });
    const p = h.svc.run(false);
    // 只推进 <RECHECK_DELAY_MS(5000)：验主轮 settle-retry 被 deadline 跳过（partial-timeout 的一次性 recheck 补测是
    // 另一机制、5s 后才触发，另有专项测；此处不让它 fire，隔离 settle-retry 断言）。
    await jest.advanceTimersByTimeAsync(200);
    const snap = await p;
    expect(snap.results.gemini.status).toBe('timeout'); // 首轮失败，deadline 跳过 settle-retry 补测 → 落定 timeout
    const gemChecking = h.onProgress.mock.calls.filter(
      (c) => c[0].serviceId === 'gemini' && c[0].result.status === 'checking'
    );
    expect(gemChecking).toHaveLength(0); // settle-retry 被 deadline 跳过 → 无「灰→spinner」二次广播（review#1 灰点不卡转）
  });
});

// whenIdle（W1 出口伴测 warm-gate 信号）：当前检测轮 settle（或无在飞轮）后 resolve；cap 兜底恒 resolve、绝不 reject。
describe('whenIdle', () => {
  it('无在飞轮 → 立即 resolve', async () => {
    const h = build();
    await expect(h.svc.whenIdle(1000)).resolves.toBeUndefined();
  });

  it('在飞轮正常 settle → cap 前 resolve（走 inflight settle 非 cap 兜底）', async () => {
    jest.useFakeTimers();
    const sess = { setProxy: jest.fn().mockResolvedValue(undefined) };
    mockFromPartition.mockReturnValue(sess);
    const svc = new UnlockDetectionService({
      getMixedPort: () => 7890,
      isRunning: () => true,
      onProgress: jest.fn(),
      onInvalidated: jest.fn(),
      transport: (() =>
        Promise.resolve(
          res({ status: 0, error: 'x' })
        )) as unknown as UnlockServiceDeps['transport'], // egress 恒失败 → 就绪门耗尽 notReady → 轮 settle
      now: () => 1_000_000,
    });
    const p = svc.run(false); // inflight（就绪门重试中）
    let resolved = false;
    void svc.whenIdle(100_000).then(() => (resolved = true)); // 大 cap（100s）：resolve 只能来自 inflight settle
    await jest.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(false); // 在飞未 settle
    await jest.advanceTimersByTimeAsync(READINESS_TOTAL_BACKOFF_MS + 100); // 就绪门耗尽 → notReady → inflight 清
    await p;
    await Promise.resolve();
    expect(resolved).toBe(true); // 轮 settle → whenIdle resolve（cap 100s 远未到 → 证明非 cap 路径）
  });

  it('在飞轮挂起（就绪门 transport 永挂）→ cap 到点兜底 resolve（不等在飞、不 reject）', async () => {
    jest.useFakeTimers();
    const sess = { setProxy: jest.fn().mockResolvedValue(undefined) };
    mockFromPartition.mockReturnValue(sess);
    const svc = new UnlockDetectionService({
      getMixedPort: () => 7890,
      isRunning: () => true,
      onProgress: jest.fn(),
      onInvalidated: jest.fn(),
      transport: (() => new Promise<UnlockResponse>(() => {})) as unknown as UnlockServiceDeps['transport'], // 永不 resolve
      now: () => 1_000_000,
    });
    void svc.run(false); // 起一轮 → 卡在就绪门 egress 探测（transport 永挂）→ inflight 不结束
    let resolved = false;
    void svc.whenIdle(500).then(() => (resolved = true));
    await jest.advanceTimersByTimeAsync(499);
    expect(resolved).toBe(false); // cap 未到
    await jest.advanceTimersByTimeAsync(2);
    expect(resolved).toBe(true); // cap 到 → 兜底 resolve
  });
});

// partial-timeout 一次性 warm 定向补测（R1/R2：NF 等个别 checker 冷启超时→settle-retry 不可达→需手动 的自愈）
describe('partial-timeout warm 补测', () => {
  const SETTLE_ALL = SETTLE_RETRY_BACKOFF_MS * (SETTLE_RETRY_MAX_ROUNDS + 1) + 100;

  it('partial（gemini 独超、其余 ok）→ 不锁 30min 缓存 + RECHECK_DELAY 后 warm 补测自愈', async () => {
    jest.useFakeTimers();
    let g = 0;
    const h = build({
      egress: () => res({ body: 'ip=9.9.9.9\nloc=HK\n' }), // 就绪门过
      // gemini 主轮+settle-retry 全失败（≤3 次）、补测轮成功。
      responder: (url) => {
        if (url === GEMINI.homeUrl) {
          g++;
          return g <= 3 ? res({ status: 0, error: 'x' }) : res({ status: 200, body: GEMINI.availableMarker });
        }
        return okBody(url);
      },
    });
    const p = h.svc.run();
    await jest.advanceTimersByTimeAsync(SETTLE_ALL); // 放行 settle-retry 退避
    const snap1 = await p;
    expect(snap1.results.gemini.status).toBe('timeout'); // 主轮+settle-retry 全失败 → partial
    // partial 未写 30min 缓存：补测触发前 run(false) 会重打（不命中缓存）——此处只验补测自愈。
    await jest.advanceTimersByTimeAsync(RECHECK_DELAY_MS + 100); // 触发一次性 warm 补测
    expect(g).toBe(4); // 主轮1 + settle-retry2 + 补测1
    expect(h.svc.getSnapshot()?.results.gemini.status).toBe('ok'); // 补测自愈，无需手动
  });

  it('invalidate 取消待触发的补测（切节点放弃）', async () => {
    jest.useFakeTimers();
    let g = 0;
    const h = build({
      egress: () => res({ body: 'ip=9.9.9.9\nloc=HK\n' }),
      responder: (url) => {
        if (url === GEMINI.homeUrl) {
          g++;
          return res({ status: 0, error: 'x' }); // 恒失败
        }
        return okBody(url);
      },
    });
    const p = h.svc.run();
    await jest.advanceTimersByTimeAsync(SETTLE_ALL);
    await p; // partial commit，补测已挂
    const gAfterMain = g;
    h.svc.invalidate(); // 切节点 → 取消补测
    await jest.advanceTimersByTimeAsync(RECHECK_DELAY_MS + 100);
    expect(g).toBe(gAfterMain); // 补测被取消 → gemini 未再打
  });

  it('补测仍 timeout → 写缓存但短 TTL（2min 内命中不重打、2min 后自然重检）', async () => {
    jest.useFakeTimers();
    let g = 0;
    const h = build({
      egress: () => res({ body: 'ip=9.9.9.9\nloc=HK\n' }),
      responder: (url) => {
        if (url === GEMINI.homeUrl) {
          g++;
          return res({ status: 0, error: 'x' }); // gemini 恒失败（补测也失败）
        }
        return okBody(url);
      },
    });
    const p = h.svc.run();
    await jest.advanceTimersByTimeAsync(SETTLE_ALL);
    await p;
    await jest.advanceTimersByTimeAsync(RECHECK_DELAY_MS + 100); // 补测仍失败 → 写缓存（含 timeout）
    const gAfterRecheck = g;
    expect(h.svc.getSnapshot()?.results.gemini.status).toBe('timeout');
    // 2min 内 run(false) → 命中短 TTL 缓存（不重打）
    h.setTime(1_000_000 + 60_000);
    await h.svc.run(false);
    expect(g).toBe(gAfterRecheck); // 缓存命中，gemini 未重打
    // 2min 后 run(false) → 缓存过期 → 重检（gemini 再打）
    h.setTime(1_000_000 + TIMEOUT_TTL_MS + 60_000);
    const p2 = h.svc.run(false);
    await jest.advanceTimersByTimeAsync(SETTLE_ALL);
    await p2;
    expect(g).toBeGreaterThan(gAfterRecheck); // 短 TTL 过期 → 自然重检
  });
});

// F-A/F-B 解锁污染根治：出口归属 bracket（轮首/轮尾 egress 比对）+ selector-settled 门控
describe('F-B 出口归属 bracket + F-A settled 门控', () => {
  it('bracket 不符（轮首 A、checker ok、轮尾 B）→ 丢弃 + invalidate、不 commit、快照空', async () => {
    let ec = 0;
    const h = build({
      // 就绪门探到 A，checker 走 okBody（成功），轮尾 bracket 复测探到 B（出口在轮中被契约外翻转）。
      egress: () =>
        ++ec === 1 ? res({ body: 'ip=1.1.1.1\nloc=A\n' }) : res({ body: 'ip=2.2.2.2\nloc=B\n' }),
    });
    const snap = await h.svc.run();
    expect(h.onInvalidated).toHaveBeenCalledTimes(1); // 不符 → invalidate（自动重跑正确出口）
    expect(snap.checkedAt).toBeNull(); // 未 commit 本轮结果（返回 invalidate 后的空快照）
    expect(h.svc.getSnapshot()).toBeNull(); // lastSnapshot 被 invalidate 清空 → 无污染
  });

  it('bracket confirm 失败(null)≠不符 → 照常 commit（网络瞬态不误触发 invalidate）', async () => {
    let ec = 0;
    const h = build({
      egress: () =>
        ++ec === 1 ? res({ body: 'ip=1.1.1.1\nloc=A\n' }) : res({ status: 0, error: 'x' }), // 轮尾 confirm 失败
    });
    const snap = await h.svc.run();
    expect(h.onInvalidated).not.toHaveBeenCalled(); // confirm null ≠ 不符 → 不触发
    expect(snap.egress?.ip).toBe('1.1.1.1'); // 照常 commit 轮首 egress 标签
    expect(h.netflixCalls()).toBe(1);
  });

  it('连续 2 次不符 → lowConfidence 落定（WARP 多 IP 出口轮换，防全量重打死循环）', async () => {
    let ec = 0;
    // 每次探测 A/B 交替：每轮就绪门(奇=A)、bracket(偶=B) 恒不符。
    const h = build({
      egress: () =>
        ++ec % 2 === 1 ? res({ body: 'ip=1.1.1.1\nloc=A\n' }) : res({ body: 'ip=2.2.2.2\nloc=B\n' }),
    });
    await h.svc.run(); // 第1次不符 → streak=1 → invalidate
    const snap2 = await h.svc.run(); // 第2次不符 → streak=2 → lowConfidence 落定
    expect(snap2.lowConfidence).toBe(true);
    expect(h.svc.getSnapshot()?.lowConfidence).toBe(true);
  });

  it('受限出口(loc=CN) 全 timeout → 不标 lowConfidence + 正常缓存（同 egress 二跑命中、零重打）', async () => {
    const h = build({
      egress: () => res({ body: 'ip=1.1.1.1\nloc=CN\n' }), // 大陆出口
      responder: () => res({ status: 0, error: 'x' }), // 所有 checker 结构性 timeout
    });
    const snap = await h.svc.run();
    expect(snap.lowConfidence).toBeUndefined(); // 受限 → 高置信终态，不标 lowConfidence
    expect(SERVICE_IDS.every((id) => snap.results[id]?.status === 'timeout')).toBe(true);
    // 缓存已写（非 lowConfidence 的 B2 不写路径）：同 egress 二跑命中缓存 → checker 零重打。
    const nf = h.netflixCalls();
    await h.svc.run();
    expect(h.netflixCalls()).toBe(nf); // 命中 30min 缓存（受限不走 2min churn）
  });

  it('受限出口(loc=CN) → settle-retry 跳过（无 checking 二次广播）', async () => {
    jest.useFakeTimers();
    const h = build({
      egress: () => res({ body: 'ip=1.1.1.1\nloc=CN\n' }),
      responder: (url) => (url === GEMINI.homeUrl ? res({ status: 0, error: 'x' }) : okBody(url)),
    });
    const p = h.svc.run();
    await jest.advanceTimersByTimeAsync(SETTLE_RETRY_BACKOFF_MS * (SETTLE_RETRY_MAX_ROUNDS + 1) + 100);
    await p;
    const checking = h.onProgress.mock.calls.filter((c) => c[0].result.status === 'checking');
    expect(checking).toHaveLength(0); // 受限 → settle-retry 整段跳过 → 无补测 spinner
  });

  it('受限出口(loc=CN) partial-timeout → 不挂 warm 补测（partialTimeout=false）', async () => {
    jest.useFakeTimers();
    let g = 0;
    const h = build({
      egress: () => res({ body: 'ip=1.1.1.1\nloc=CN\n' }),
      responder: (url) => {
        if (url === GEMINI.homeUrl) {
          g++;
          return res({ status: 0, error: 'x' });
        }
        return okBody(url);
      },
    });
    const p = h.svc.run();
    await jest.advanceTimersByTimeAsync(SETTLE_RETRY_BACKOFF_MS * (SETTLE_RETRY_MAX_ROUNDS + 1) + 100);
    await p;
    const gAfter = g;
    await jest.advanceTimersByTimeAsync(RECHECK_DELAY_MS + 100); // 补测本应在此触发
    expect(g).toBe(gAfter); // 受限 → 无 partial warm 补测
  });

  it('trace 无 loc（region 缺失）→ 非受限，行为原封（走 lowConfidence 路径）', async () => {
    jest.useFakeTimers(); // 非受限 → settle-retry 真跑退避（需推进）
    const h = build({
      egress: () => res({ body: 'ip=1.1.1.1\n' }), // 无 loc
      responder: () => res({ status: 0, error: 'x' }), // 全 timeout
    });
    const p = h.svc.run();
    await jest.advanceTimersByTimeAsync(SETTLE_RETRY_BACKOFF_MS * (SETTLE_RETRY_MAX_ROUNDS + 1) + 100);
    const snap = await p;
    expect(snap.lowConfidence).toBe(true); // region 缺失 → 非受限 → 全超仍走 lowConfidence
  });

  it('F-A whenExitSettled 未 resolve 前零探测；resolve 后正常检测', async () => {
    const sess = { setProxy: jest.fn().mockResolvedValue(undefined) };
    mockFromPartition.mockReturnValue(sess);
    let releaseSettle!: () => void;
    const transport = jest.fn((_s: unknown, req: { url: string }) =>
      Promise.resolve(
        req.url === EGRESS_TRACE_URL ? res({ body: 'ip=9.9.9.9\nloc=HK\n' }) : okBody(req.url)
      )
    );
    const svc = new UnlockDetectionService({
      getMixedPort: () => 7890,
      isRunning: () => true,
      whenExitSettled: () => new Promise<void>((r) => (releaseSettle = r)),
      onProgress: jest.fn(),
      onInvalidated: jest.fn(),
      transport: transport as unknown as UnlockServiceDeps['transport'],
      now: () => 1_000_000,
    });
    const p = svc.run(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(transport).not.toHaveBeenCalled(); // settled 未放行 → 零探测
    releaseSettle();
    const snap = await p;
    expect(transport).toHaveBeenCalled(); // 放行后正常探测 + checker
    expect(snap.egress).toEqual({ ip: '9.9.9.9', region: 'HK' });
  });
});
