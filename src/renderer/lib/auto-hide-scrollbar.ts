/**
 * 自动隐藏滚动条（issue #154）：滚动时给容器加 `is-scrolling` 类、停止滚动 idleMs 后移除。
 * 配合 index.css 的 `.main-content-card.is-scrolling::-webkit-scrollbar-thumb`：默认 thumb 透明（不突兀），
 * 仅在悬停或正在滚动时显示细淡滚动条，停止交互即隐藏。
 *
 * 形状最小化（非硬绑 HTMLElement）以便在 node 测试环境下用 mock + fake timers 单测，不依赖 jsdom。
 */

export interface ScrollableEl {
  addEventListener: HTMLElement['addEventListener'];
  removeEventListener: HTMLElement['removeEventListener'];
  classList: Pick<DOMTokenList, 'add' | 'remove'>;
}

const CLASS = 'is-scrolling';
const DEFAULT_IDLE_MS = 900;

/**
 * 给可滚动元素挂上「滚动即显、停滚 idleMs 后隐」的自动隐藏行为。返回清理函数（移除监听 + 清定时器）。
 * @param el      滚动容器（HTMLElement 兼容本接口）
 * @param idleMs  停止滚动后保留显示的毫秒数（默认 900ms）
 */
export function attachAutoHideScrollbar(
  el: ScrollableEl,
  idleMs: number = DEFAULT_IDLE_MS
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onScroll = (): void => {
    el.classList.add(CLASS);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      el.classList.remove(CLASS);
      timer = null;
    }, idleMs);
  };
  // passive：仅读不阻断滚动，避免影响滚动性能
  el.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    el.removeEventListener('scroll', onScroll);
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    el.classList.remove(CLASS);
  };
}
