import { ReactNode } from 'react';
import { Sidebar } from './sidebar';
import { LinuxTitlebar } from './linux-titlebar';

interface MainLayoutProps {
  currentView: string;
  onViewChange: (view: string) => void;
  settingsSection: string;
  onSettingsSectionChange: (section: string) => void;
  children: ReactNode;
}

const isMac = window.electron?.platform === 'darwin';
const isWindows = window.electron?.platform === 'win32';
const isLinux = !isMac && !isWindows; // Linux frameless → 自绘 LinuxTitlebar（替代原生标题栏）

export function MainLayout({
  currentView,
  onViewChange,
  settingsSection,
  onSettingsSectionChange,
  children,
}: MainLayoutProps) {
  return (
    <div className="flex flex-col h-screen w-full overflow-hidden app-shell">
      {/* Linux frameless：整窗顶部**全宽**自绘标题栏（在 sidebar+内容之上），脱离内容卡的 border/圆角，
          避免窗口控制按钮背景与卡角重叠；Mac/Win 不走此分支（用各自原生标题栏方案）。 */}
      {isLinux && <LinuxTitlebar />}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          currentView={currentView}
          onViewChange={onViewChange}
          settingsSection={settingsSection}
          onSettingsSectionChange={onSettingsSectionChange}
        />
        <main className="flex-1 overflow-auto flex flex-col relative z-10 main-content-card transition-all duration-300">
          {/* 集成标题栏拖拽区：Mac(hiddenInset) h-9；Windows(titleBarOverlay 按钮在右上) 32px。Linux 已在顶部全宽条。 */}
          {isMac && <div className="h-9 flex-shrink-0 app-region-drag" />}
          {isWindows && <div className="h-[32px] flex-shrink-0 app-region-drag" />}
          <div
            className="container mx-auto px-6 pb-6 app-region-no-drag max-w-[1400px]"
            style={{ paddingTop: isLinux ? '24px' : '0' }}
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
