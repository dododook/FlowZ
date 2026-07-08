import { ReactNode, useRef, useEffect } from 'react';
import { Sidebar } from './sidebar';
import { LinuxWindowControls } from './linux-titlebar';
// 状态栏固化为窗口级底栏（1:1 原型 .statusbar，全页常驻实心）——非首页专属。
import { HomeStatusBar as StatusBar } from '@/components/home/home-status-bar';
import { api } from '@/ipc/api-client';

interface MainLayoutProps {
  currentView: string;
  onViewChange: (view: string) => void;
  settingsSection: string;
  onSettingsSectionChange: (section: string) => void;
  children: ReactNode;
}

const isMac = window.electron?.platform === 'darwin';
const isWindows = window.electron?.platform === 'win32';
const isLinux = !isMac && !isWindows; // Linux frameless → 右上自绘窗口控制按钮（替代系统 titleBarOverlay）

// hero 页（单卡填满 + 卡内滚动）：.container 用 h-full（height:100%，对定高 scroller 解析）而非 min-h-full。
// min-h-full 是 height:auto，内容 intrinsic 高经 flex-basis:0 链成为地板 → 卡片缩不回、卡内 overflow-y 失效（高度棘轮）。
// h-full 让 .container 高与内容解耦、纯视口驱动、双向跟窗；卡 min-height 地板超视口时溢出并入页级 scroller 兜底滚动。
const HERO_VIEWS = new Set(['connections', 'logs']);

export function MainLayout({
  currentView,
  onViewChange,
  settingsSection,
  onSettingsSectionChange,
  children,
}: MainLayoutProps) {
  // 切换导航即新页面：滚动位置复位到顶部（用户反馈：切页不应停留在上一页滚动位）。含设置子导航切换。
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [currentView, settingsSection]);

  return (
    <div className="flex h-screen w-full overflow-hidden app-shell relative">
      <Sidebar
        currentView={currentView}
        onViewChange={onViewChange}
        settingsSection={settingsSection}
        onSettingsSectionChange={onSettingsSectionChange}
      />
      <main className="flex-1 min-w-0 flex flex-col relative z-10 main-content-card transition-all duration-300">
        {/* 集成标题栏拖拽区：Mac(hiddenInset) h-9；Windows(titleBarOverlay)/Linux(右上自绘按钮) 同高 32px。 */}
        {isMac && <div className="h-9 flex-shrink-0 app-region-drag" />}
        {(isWindows || isLinux) && (
          <div
            className="h-[32px] flex-shrink-0 app-region-drag"
            // Linux frameless：拖拽区双击最大化由显式 IPC 保证（不赌 WM 原生处理 app-region 双击）；
            // Windows 由系统 titleBarOverlay 处理，不加 handler 避免双重触发。
            onDoubleClick={
              isLinux ? () => void api.window.maximizeToggle().catch(() => {}) : undefined
            }
          />
        )}
        {/* 内容区滚动，状态栏固定在卡片底部（flex-none）——全页常驻实心底栏。 */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto app-region-no-drag">
          {/* hero 页（conns/logs）用 h-full 断高度棘轮（见上 HERO_VIEWS 注）；其余页 min-h-full 自然增长。
              home 保 min-h-full：拓扑卡已由 connection-topology 的 [contain:size] 单独定高，不进 hero 集合（最小 blast radius）。 */}
          <div
            className={`container mx-auto flex ${
              HERO_VIEWS.has(currentView) ? 'h-full' : 'min-h-full'
            } max-w-[1400px] flex-col px-6 pb-6`}
          >
            {children}
          </div>
        </div>
        <StatusBar />
      </main>
      {/* Linux 无系统 titleBarOverlay → 自绘窗口控制按钮，绝对定位窗口右上角（与 Windows 系统按钮同位、同 32px 高），
          相对 app-shell 固定不随内容滚动；嵌入卡片右上直角区，与 Windows 嵌入式视觉统一（不再全宽标题条）。 */}
      {isLinux && <LinuxWindowControls />}
    </div>
  );
}
