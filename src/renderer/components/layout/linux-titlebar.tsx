import { useEffect, useState } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { api } from '@/ipc/api-client';

/**
 * Linux 窗口控制按钮（frameless 自绘，绝对定位窗口右上角，替代系统 titleBarOverlay，与 Windows 嵌入式视觉统一）。
 *
 * Linux 无系统 titleBarOverlay API（Mac hiddenInset / Win titleBarOverlay 各有原生方案）→ 主进程对 Linux 设
 * frame:false，由此组件自绘 min/max/close：
 *  - 绝对定位 top-0 right-0（相对最外层 app-shell），固定在窗口右上、不随 main 内容滚动；32px 高对齐 Windows。
 *  - 嵌入卡片右上直角区（main-content-card 右上 border-radius=0），不与左侧圆角冲突、无突出全宽条。
 *  - 拖拽由 sidebar/main 顶部 32px app-region-drag 区提供（按钮区 no-drag 才可点）；双击拖拽区由 WM 自身切最大化。
 *  - max/restore 图标跟随最大化态：初次 isMaximized() 查询 + 监听 EVENT_WINDOW_MAXIMIZE_CHANGED
 *    （覆盖 WM 双击标题/拖顶等非按钮触发的最大化，图标不致与真实窗口态脱节）。
 */
export function LinuxWindowControls() {
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
  // 46×32 对齐 Windows 原生标题栏按钮尺寸；透明底融入卡片右上，hover 才显背景。
  const btn =
    'flex h-8 w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-foreground/10';

  return (
    <div className="app-region-no-drag absolute right-0 top-0 z-50 flex h-8 select-none rtl:right-auto rtl:left-0">
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
  );
}
