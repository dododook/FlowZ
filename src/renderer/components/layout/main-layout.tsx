import { ReactNode } from 'react';
import { Sidebar } from './sidebar';
import { LinuxWindowControls } from './linux-titlebar';
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

export function MainLayout({
  currentView,
  onViewChange,
  settingsSection,
  onSettingsSectionChange,
  children,
}: MainLayoutProps) {
  return (
    <div className="flex h-screen w-full overflow-hidden app-shell relative">
      <Sidebar
        currentView={currentView}
        onViewChange={onViewChange}
        settingsSection={settingsSection}
        onSettingsSectionChange={onSettingsSectionChange}
      />
      <main className="flex-1 overflow-auto flex flex-col relative z-10 main-content-card transition-all duration-300">
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
        <div className="container mx-auto px-6 pb-6 app-region-no-drag max-w-[1400px]">
          {children}
        </div>
      </main>
      {/* Linux 无系统 titleBarOverlay → 自绘窗口控制按钮，绝对定位窗口右上角（与 Windows 系统按钮同位、同 32px 高），
          相对 app-shell 固定不随内容滚动；嵌入卡片右上直角区，与 Windows 嵌入式视觉统一（不再全宽标题条）。 */}
      {isLinux && <LinuxWindowControls />}
    </div>
  );
}
