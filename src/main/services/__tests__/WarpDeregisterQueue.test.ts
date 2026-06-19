/**
 * WarpDeregisterQueue 单测（注入式，不触网/不碰真实 FS）。
 * unregister / readQueue / writeQueue / now 全注入；验 drain 的 done/drop/retry 出入队、超龄 expire、
 * MAX_PER_DRAIN 截断、并发重入保护、enqueue 护栏，及「队列无变化跳过写」。
 * 纯阈值/分流逻辑在 shared/warp.test.ts，此处只验服务编排。
 */
import { WarpDeregisterQueue } from '../WarpDeregisterQueue';
import {
  WARP_DEREGISTER_MAX_AGE_MS,
  WARP_DEREGISTER_MAX_PER_DRAIN,
  type PendingDeregisterEntry,
  type DeregisterResult,
} from '../../../shared/warp';

const NOW = 2_000_000_000_000;
const mk = (id: string, ageMs = 1000): PendingDeregisterEntry => ({
  deviceId: id,
  token: `t-${id}`,
  enqueuedAt: NOW - ageMs,
});

/** 构造一个注入式队列：内存队列 + 可编排的 unregister 结果。 */
function makeQueue(
  initial: PendingDeregisterEntry[],
  results: Record<string, DeregisterResult> | ((id: string) => DeregisterResult)
) {
  let store = [...initial];
  const writes: PendingDeregisterEntry[][] = [];
  const unregistered: string[] = [];
  const q = new WarpDeregisterQueue({
    unregister: async (deviceId: string) => {
      unregistered.push(deviceId);
      return typeof results === 'function' ? results(deviceId) : (results[deviceId] ?? 'retry');
    },
    now: () => NOW,
    readQueue: async () => [...store],
    writeQueue: async (queue) => {
      store = [...queue];
      writes.push([...queue]);
    },
  });
  return { q, getStore: () => store, writes, unregistered };
}

describe('WarpDeregisterQueue.drain', () => {
  it('done → 出队；retry → 留队', async () => {
    const { q, getStore, unregistered } = makeQueue([mk('a'), mk('b')], { a: 'done', b: 'retry' });
    const stats = await q.drain();
    expect(stats).toMatchObject({ done: 1, retried: 1 });
    expect(unregistered.sort()).toEqual(['a', 'b']);
    expect(getStore().map((e) => e.deviceId)).toEqual(['b']); // a 出队，b 留队
  });

  it('drop → 出队（凭据死，不再重试）', async () => {
    const { q, getStore } = makeQueue([mk('a')], { a: 'drop' });
    const stats = await q.drain();
    expect(stats).toMatchObject({ dropped: 1 });
    expect(getStore()).toEqual([]);
  });

  it('超 7 天 → expire 出队，且不调 unregister（不调网络）', async () => {
    const { q, getStore, unregistered } = makeQueue(
      [mk('old', WARP_DEREGISTER_MAX_AGE_MS + 5000), mk('fresh', 1000)],
      { fresh: 'done' }
    );
    const stats = await q.drain();
    expect(stats).toMatchObject({ expired: 1, done: 1 });
    expect(unregistered).toEqual(['fresh']); // old 未调网络
    expect(getStore()).toEqual([]); // 都出队
  });

  it('单次至多 MAX_PER_DRAIN 条，余下留队等下次', async () => {
    const entries = Array.from({ length: WARP_DEREGISTER_MAX_PER_DRAIN + 4 }, (_, i) =>
      mk(`e${i}`, 1000)
    );
    const { q, getStore, unregistered } = makeQueue(entries, () => 'retry');
    await q.drain();
    expect(unregistered.length).toBe(WARP_DEREGISTER_MAX_PER_DRAIN); // 只处理前 N 条
    expect(getStore().length).toBe(entries.length); // 全 retry → 全留队（无变化）
  });

  it('空队列 → no-op，不写回', async () => {
    const { q, writes, unregistered } = makeQueue([], {});
    const stats = await q.drain();
    expect(stats).toEqual({ done: 0, dropped: 0, retried: 0, expired: 0 });
    expect(writes).toEqual([]);
    expect(unregistered).toEqual([]);
  });

  it('全 retry 且无 expire/done/drop → 跳过写回（省 IO）', async () => {
    const { q, writes } = makeQueue([mk('a'), mk('b')], { a: 'retry', b: 'retry' });
    await q.drain();
    expect(writes).toEqual([]); // 队列内容未变，不写
  });

  it('有出队（done）→ 写回新队列', async () => {
    const { q, writes } = makeQueue([mk('a'), mk('b')], { a: 'done', b: 'retry' });
    await q.drain();
    expect(writes.length).toBe(1);
    expect(writes[0].map((e) => e.deviceId)).toEqual(['b']);
  });

  it('unregister 抛异常 → 当 retry 兜底（留队，不崩 drain）', async () => {
    let store = [mk('a')];
    const q = new WarpDeregisterQueue({
      unregister: async () => {
        throw new Error('boom');
      },
      now: () => NOW,
      readQueue: async () => [...store],
      writeQueue: async (next) => {
        store = [...next];
      },
    });
    const stats = await q.drain();
    expect(stats).toMatchObject({ retried: 1 });
    expect(store.map((e) => e.deviceId)).toEqual(['a']); // 留队
  });

  it('并发重入保护：第二次 drain 在第一次进行中直接返回零', async () => {
    let resolveUnreg: (r: DeregisterResult) => void = () => {};
    let store = [mk('a')];
    const q = new WarpDeregisterQueue({
      unregister: () =>
        new Promise<DeregisterResult>((res) => {
          resolveUnreg = res;
        }),
      now: () => NOW,
      readQueue: async () => [...store],
      writeQueue: async (next) => {
        store = [...next];
      },
    });
    const p1 = q.drain();
    // p1 卡在 unregister；此时第二次 drain 应被重入保护直接返回零。
    const stats2 = await q.drain();
    expect(stats2).toEqual({ done: 0, dropped: 0, retried: 0, expired: 0 });
    resolveUnreg('done');
    await p1;
    expect(store).toEqual([]); // 第一次正常完成出队
  });

  it('lost-update 回归：drain 网络往返期间 enqueue 新条目，写回不抹掉新条目（重读-剔除-合并）', async () => {
    // 修复前：drain 读旧快照 [a] → await unregister 期间 enqueue(b) → drain 用旧 keep 覆盖 → b 丢失（永久孤儿）。
    // 修复后：drain 写回前重读最新磁盘队列，仅剔除本次处理掉的 deviceId（a），保留 enqueue 新增的 b。
    let resolveUnreg: (r: DeregisterResult) => void = () => {};
    let store = [mk('a')];
    const q = new WarpDeregisterQueue({
      unregister: () =>
        new Promise<DeregisterResult>((res) => {
          resolveUnreg = res;
        }),
      now: () => NOW,
      readQueue: async () => [...store],
      writeQueue: async (next) => {
        store = [...next];
      },
    });
    const p1 = q.drain(); // 读快照 [a]，卡在 unregister('a')
    await Promise.resolve(); // 让 drain 推进到 await unregister
    await q.enqueue(mk('b')); // 网络往返期间删新节点入队 → store=[a,b]
    expect(store.map((e) => e.deviceId)).toEqual(['a', 'b']);
    resolveUnreg('done'); // a 注销成功
    await p1;
    // a 出队（done），b 保留（未被旧快照覆盖）。这是核心断言：新凭据没丢。
    expect(store.map((e) => e.deviceId)).toEqual(['b']);
  });

  // #86-122 复审 #6：drain 进行中再次触发不丢——置补跑标志，当前 drain 结束后补跑一次。
  it('补跑：drain 进行中再次触发被合并到补跑，当前 drain 结束后补跑处理在途新条目', async () => {
    let store = [mk('a')];
    const unregistered: string[] = [];
    // a 的 unregister 用受控 promise 卡住（造在途 drain 窗口）；b（补跑时处理）立即 done。
    let resolveA: (r: DeregisterResult) => void = () => {};
    const q = new WarpDeregisterQueue({
      unregister: (deviceId) => {
        unregistered.push(deviceId);
        if (deviceId === 'a') {
          return new Promise<DeregisterResult>((res) => {
            resolveA = res;
          });
        }
        return Promise.resolve('done'); // b：补跑里立即注销成功
      },
      now: () => NOW,
      readQueue: async () => [...store],
      writeQueue: async (next) => {
        store = [...next];
      },
    });

    const p1 = q.drain(); // 读快照 [a]，卡在 unregister('a')
    await Promise.resolve();
    await q.enqueue(mk('b')); // 在途入队 b → store=[a,b]
    // 第二次触发：撞 draining → 返回零 + 置补跑标志（不立即处理 b）。
    const stats2 = await q.drain();
    expect(stats2).toEqual({ done: 0, dropped: 0, retried: 0, expired: 0 });
    expect(unregistered).toEqual(['a']); // 此刻仅 a 被处理过，b 尚未

    resolveA('done'); // a 完成 → 第一次 drain 收尾 → finally 触发补跑
    await p1;
    // 补跑是 fire-and-forget；刷若干 microtask 让其跑完（含 unregister('b') + 写回）。
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // 补跑处理了在途的 b（不再等下次启动）；队列清空。
    expect(unregistered).toContain('b');
    expect(store.map((e) => e.deviceId)).toEqual([]);
  });
});

describe('WarpDeregisterQueue.enqueue', () => {
  it('追加新条目并写回', async () => {
    const { q, getStore } = makeQueue([mk('a')], {});
    await q.enqueue(mk('new'));
    expect(getStore().map((e) => e.deviceId)).toEqual(['a', 'new']);
  });
});
