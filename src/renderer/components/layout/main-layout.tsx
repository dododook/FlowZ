import { ReactNode, useEffect, useRef } from 'react';
import { Sidebar } from './sidebar';
import { attachAutoHideScrollbar } from '../../lib/auto-hide-scrollbar';

interface MainLayoutProps {
  currentView: string;
  onViewChange: (view: string) => void;
  settingsSection: string;
  onSettingsSectionChange: (section: string) => void;
  children: ReactNode;
}

const isMac = window.electron?.platform === 'darwin';
const isWindows = window.electron?.platform === 'win32';

export function MainLayout({
  currentView,
  onViewChange,
  settingsSection,
  onSettingsSectionChange,
  children,
}: MainLayoutProps) {
  // 自动隐藏滚动条（issue #154）：滚动时给主内容容器加 is-scrolling，停滚后移除；配合 index.css 的
  // .main-content-card 滚动条样式（默认透明、悬停/滚动时显细淡 thumb），非突兀且自动隐藏。
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    return attachAutoHideScrollbar(el);
  }, []);
  return (
    <div className="flex h-screen w-full overflow-hidden app-shell">
      <Sidebar
        currentView={currentView}
        onViewChange={onViewChange}
        settingsSection={settingsSection}
        onSettingsSectionChange={onSettingsSectionChange}
      />
      <main
        ref={mainRef}
        className="flex-1 overflow-auto flex flex-col relative z-10 main-content-card transition-all duration-300"
      >
        {/* 集成标题栏拖拽区：Mac(hiddenInset) h-9；Windows(titleBarOverlay 按钮在右上) 32px 与覆盖层等高、给按钮让位。 */}
        {isMac && <div className="h-9 flex-shrink-0 app-region-drag" />}
        {isWindows && <div className="h-[32px] flex-shrink-0 app-region-drag" />}
        <div
          className="container mx-auto px-6 pb-6 app-region-no-drag max-w-[1400px]"
          style={{ paddingTop: isMac || isWindows ? '0' : '24px' }}
        >
          {children}
        </div>
      </main>
    </div>
  );
}
