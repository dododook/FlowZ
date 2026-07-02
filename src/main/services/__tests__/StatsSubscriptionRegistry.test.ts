/**
 * StatsSubscriptionRegistry 单测（batch3 §3.7 订阅驱动数据面）：订阅/退订、订阅即回初始帧、broadcast 只发对应
 * 订阅者、destroyed 自动清全部 topic、hasSubscribers、subscribersOf 过滤 destroyed、同 wc 多 topic 只挂一次
 * destroyed 监听、demand 变化回调。纯逻辑，wc 用最小 mock（{id,send,once,isDestroyed}），无 electron 运行期依赖。
 */
import { StatsSubscriptionRegistry } from '../StatsSubscriptionRegistry';
import { STATS_TOPIC_EVENT } from '../../../shared/ipc-channels';
import type { WebContents } from 'electron';

interface FakeWc {
  id: number;
  send: jest.Mock;
  once: jest.Mock;
  isDestroyed: jest.Mock;
  /** once 捕获的 destroyed 回调（手动触发模拟 renderer 销毁）。 */
  fireDestroyed?: () => void;
}

function makeWc(id: number): FakeWc {
  const wc: FakeWc = {
    id,
    send: jest.fn(),
    once: jest.fn((_evt: string, cb: () => void) => {
      wc.fireDestroyed = cb;
    }),
    isDestroyed: jest.fn(() => false),
  };
  return wc;
}
/** 最小 mock 结构性替身 → WebContents（registry 只碰 id/send/once/isDestroyed）。 */
const asWc = (w: FakeWc): WebContents => w as unknown as WebContents;

function makeRegistry(frames: Record<string, unknown> = {}) {
  const getInitialFrame = jest.fn((topic: string) => frames[topic] ?? { topic });
  const onDemandChange = jest.fn();
  const registry = new StatsSubscriptionRegistry({ getInitialFrame, onDemandChange });
  return { registry, getInitialFrame, onDemandChange };
}

describe('StatsSubscriptionRegistry', () => {
  it('subscribe：加订阅 + 即回初始帧（对应 topic 通道）+ 驱动 demand', () => {
    const { registry, onDemandChange } = makeRegistry({ aggregate: { total: 5 } });
    const wc = makeWc(1);
    registry.subscribe(asWc(wc), 'aggregate');
    expect(registry.hasSubscribers('aggregate')).toBe(true);
    expect(wc.send).toHaveBeenCalledWith(STATS_TOPIC_EVENT.aggregate, { total: 5 });
    expect(onDemandChange).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe：移除订阅 + 驱动 demand', () => {
    const { registry, onDemandChange } = makeRegistry();
    const wc = makeWc(1);
    registry.subscribe(asWc(wc), 'detail');
    onDemandChange.mockClear();
    registry.unsubscribe(asWc(wc), 'detail');
    expect(registry.hasSubscribers('detail')).toBe(false);
    expect(onDemandChange).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe 未订阅的 topic → 幂等、不驱动 demand', () => {
    const { registry, onDemandChange } = makeRegistry();
    const wc = makeWc(1);
    registry.unsubscribe(asWc(wc), 'detail');
    expect(onDemandChange).not.toHaveBeenCalled();
  });

  it('subscribersOf / hasSubscribers 过滤已 destroyed 的 wc', () => {
    const { registry } = makeRegistry();
    const a = makeWc(1);
    const b = makeWc(2);
    registry.subscribe(asWc(a), 'stats');
    registry.subscribe(asWc(b), 'stats');
    expect(registry.subscribersOf('stats')).toHaveLength(2);

    b.isDestroyed.mockReturnValue(true); // b 销毁但 destroyed 监听未及触发
    const live = registry.subscribersOf('stats');
    expect(live).toHaveLength(1);
    expect(live[0]).toBe(a);
    expect(registry.hasSubscribers('stats')).toBe(true); // a 仍在
  });

  it('broadcast：只发给该 topic 存活订阅者（对应通道）', () => {
    const { registry } = makeRegistry();
    const a = makeWc(1);
    const b = makeWc(2);
    registry.subscribe(asWc(a), 'aggregate');
    registry.subscribe(asWc(b), 'detail');
    a.send.mockClear();
    b.send.mockClear();
    registry.broadcast('aggregate', { total: 9 });
    expect(a.send).toHaveBeenCalledWith(STATS_TOPIC_EVENT.aggregate, { total: 9 });
    expect(b.send).not.toHaveBeenCalled(); // detail 订阅者不收 aggregate
  });

  it('wc destroyed → 一次性监听清其全部 topic + 驱动 demand', () => {
    const { registry, onDemandChange } = makeRegistry();
    const wc = makeWc(1);
    registry.subscribe(asWc(wc), 'aggregate');
    registry.subscribe(asWc(wc), 'detail');
    expect(registry.hasSubscribers('aggregate')).toBe(true);
    expect(registry.hasSubscribers('detail')).toBe(true);
    onDemandChange.mockClear();

    wc.fireDestroyed!(); // 模拟 renderer 崩溃/重载
    expect(registry.hasSubscribers('aggregate')).toBe(false);
    expect(registry.hasSubscribers('detail')).toBe(false);
    expect(onDemandChange).toHaveBeenCalledTimes(1); // 清理驱动一次 demand 重算
  });

  it('同 wc 多 topic 订阅只挂一次 destroyed 监听（不重复挂）', () => {
    const { registry } = makeRegistry();
    const wc = makeWc(1);
    registry.subscribe(asWc(wc), 'stats');
    registry.subscribe(asWc(wc), 'aggregate');
    registry.subscribe(asWc(wc), 'detail');
    expect(wc.once).toHaveBeenCalledTimes(1);
  });

  it('已 destroyed 的 wc subscribe 被忽略（不入表、不回初始帧、不驱动 demand）', () => {
    const { registry, onDemandChange } = makeRegistry();
    const wc = makeWc(1);
    wc.isDestroyed.mockReturnValue(true);
    registry.subscribe(asWc(wc), 'stats');
    expect(registry.hasSubscribers('stats')).toBe(false);
    expect(wc.send).not.toHaveBeenCalled();
    expect(onDemandChange).not.toHaveBeenCalled();
  });
});
