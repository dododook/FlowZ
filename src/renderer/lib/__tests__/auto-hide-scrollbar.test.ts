/**
 * attachAutoHideScrollbar 单测（issue #154 自动隐藏滚动条）。
 * node 环境 + mock 元素 + fake timers，不依赖 jsdom：验「滚动加 is-scrolling / idle 后移除 / 防抖只留一个定时器 /
 * 清理移监听+清定时器+移类」。
 */
import { attachAutoHideScrollbar, type ScrollableEl } from '../auto-hide-scrollbar';

function mockEl() {
  let scrollHandler: (() => void) | null = null;
  const el: ScrollableEl & {
    fire: () => void;
    add: jest.Mock;
    remove: jest.Mock;
    addEventListener: jest.Mock;
    removeEventListener: jest.Mock;
  } = {
    addEventListener: jest.fn((type: string, h: unknown) => {
      if (type === 'scroll') scrollHandler = h as () => void;
    }) as unknown as jest.Mock,
    removeEventListener: jest.fn() as unknown as jest.Mock,
    classList: { add: jest.fn(), remove: jest.fn() },
    fire: () => scrollHandler?.(),
    get add() {
      return this.classList.add as jest.Mock;
    },
    get remove() {
      return this.classList.remove as jest.Mock;
    },
  };
  return el;
}

describe('attachAutoHideScrollbar', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('滚动 → 加 is-scrolling；idle 后 → 移除', () => {
    const el = mockEl();
    attachAutoHideScrollbar(el, 900);
    el.fire();
    expect(el.classList.add).toHaveBeenCalledWith('is-scrolling');
    expect(el.classList.remove).not.toHaveBeenCalled();

    jest.advanceTimersByTime(900);
    expect(el.classList.remove).toHaveBeenCalledWith('is-scrolling');
  });

  it('连续滚动防抖：只保留最后一个定时器，未到 idle 不移除', () => {
    const el = mockEl();
    attachAutoHideScrollbar(el, 900);
    el.fire();
    jest.advanceTimersByTime(500);
    el.fire(); // 重置定时器
    jest.advanceTimersByTime(500); // 距上次滚动仅 500 < 900
    expect(el.classList.remove).not.toHaveBeenCalled();
    jest.advanceTimersByTime(400); // 累计 900 自上次滚动
    expect(el.classList.remove).toHaveBeenCalledTimes(1);
  });

  it('清理函数：移监听 + 清未触发的定时器（不再移除类） + 立即移除类一次', () => {
    const el = mockEl();
    const cleanup = attachAutoHideScrollbar(el, 900);
    el.fire(); // 起一个定时器
    cleanup();
    expect(el.removeEventListener).toHaveBeenCalled();
    // 清理时立即移一次类（收尾）
    expect(el.classList.remove).toHaveBeenCalledWith('is-scrolling');
    const removeCallsAfterCleanup = (el.classList.remove as jest.Mock).mock.calls.length;
    // 定时器已被清，推进时间不再触发额外移除
    jest.advanceTimersByTime(2000);
    expect((el.classList.remove as jest.Mock).mock.calls.length).toBe(removeCallsAfterCleanup);
  });

  it('默认 idleMs=900', () => {
    const el = mockEl();
    attachAutoHideScrollbar(el);
    el.fire();
    jest.advanceTimersByTime(899);
    expect(el.classList.remove).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(el.classList.remove).toHaveBeenCalledWith('is-scrolling');
  });
});
