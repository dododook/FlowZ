import { useEffect, useState } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { api } from '@/ipc/api-client';

/**
 * Linux 嵌入式标题栏（frameless 窗口自绘，与 Mac 红绿灯 / Win titleBarOverlay 对齐）。
 *
 * Linux 无系统 titleBarOverlay API，故主进程对 Linux 设 frame:false、由此组件自绘：
 *  - 整条为拖拽区（app-region-drag）+ 双击切换最大化（WM 习惯）；右侧 min/max/close 按钮置 no-drag 才可点。
 *  - max/restore 图标跟随最大化态：初次 isMaximized() 查询 + 监听 EVENT_WINDOW_MAXIMIZE_CHANGED
 *    （覆盖 WM 双击标题/拖顶等非按钮触发的最大化，按钮图标不致与真实窗口态脱节）。
 */
export function LinuxTitlebar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let mounted = true;
    api.window
      .isMaximized()
      .then((m) => {
        if (mounted) setMaximized(m); // 守卫：IPC 往返期间组件卸载则不再 setState
      })
      .catch(() => {});
    // onMaximizeChange 返回取消订阅函数，卸载时清理避免重复监听累积。
    const unsub = api.window.onMaximizeChange(setMaximized);
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  const toggle = () =>
    api.window
      .maximizeToggle()
      .then(setMaximized)
      .catch(() => {});
  const btn =
    'app-region-no-drag flex h-full w-12 items-center justify-center text-muted-foreground transition-colors hover:bg-foreground/10';

  return (
    <div
      className="app-region-drag flex h-8 flex-shrink-0 select-none items-center justify-between"
      onDoubleClick={toggle}
    >
      <span className="px-3 text-xs font-medium text-muted-foreground">FlowZ</span>
      {/* 按钮区双击不冒泡到容器 onDoubleClick=toggle（否则双击 max 按钮净 3 次 toggle）；仅拖拽区裸双击才最大化。 */}
      <div className="flex h-full" onDoubleClick={(e) => e.stopPropagation()}>
        <button className={btn} onClick={() => api.window.minimize()} aria-label="Minimize">
          <Minus className="h-4 w-4" />
        </button>
        <button className={btn} onClick={toggle} aria-label={maximized ? 'Restore' : 'Maximize'}>
          {maximized ? (
            <Copy className="h-3.5 w-3.5 -scale-x-100" />
          ) : (
            <Square className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          className={`${btn} hover:bg-destructive hover:text-destructive-foreground`}
          onClick={() => api.window.close()}
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
