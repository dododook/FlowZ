import {
  Home,
  Server,
  ListFilter,
  Settings,
  ChevronLeft,
  Sliders,
  Palette,
  Cpu,
  Info,
  Network,
  ScrollText,
  FolderDown,
  Activity,
} from 'lucide-react';

// 自定义的分流图标（完整连贯的 Y 型，不带断点）
function FlowSplitIcon(props: any) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M12 21v-7" />
      <path d="M12 14q0-6 9-11" />
      <path d="M12 14q0-6-9-11" />
      <path d="M8 3H3v5" />
      <path d="M16 3h5v5" />
    </svg>
  );
}
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';

interface SidebarProps {
  currentView: string;
  onViewChange: (view: string) => void;
  settingsSection: string;
  onSettingsSectionChange: (section: string) => void;
}

// 主导航分区（section label，非二级/折叠）：总览+节点无标签置顶；分流域、诊断域各带分区标题。
// 顺序按心智流：配置（节点）→ 策略（分流）→ 观测（诊断）。
const mainNavGroups: { label?: string; items: { id: string; icon: React.ElementType }[] }[] = [
  {
    items: [
      { id: 'home', icon: Home },
      { id: 'server', icon: Server },
    ],
  },
  {
    label: 'routing',
    items: [
      { id: 'appPolicy', icon: FlowSplitIcon },
      { id: 'rules', icon: ListFilter },
      { id: 'ruleResources', icon: FolderDown },
    ],
  },
  {
    label: 'diagnostics',
    items: [
      { id: 'connections', icon: Activity },
      { id: 'logs', icon: ScrollText },
    ],
  },
];

const settingsNavItems = [
  { id: 'general', icon: Sliders },
  { id: 'appearance', icon: Palette }, // 外观(主题/语言)前置：首次个性化、设一次即用，靠前更顺手
  { id: 'network', icon: Network },
  { id: 'advanced', icon: Cpu },
  { id: 'about', icon: Info },
];

const isMac = window.electron?.platform === 'darwin';

export function Sidebar({
  currentView,
  onViewChange,
  settingsSection,
  onSettingsSectionChange,
}: SidebarProps) {
  const { t } = useTranslation();
  // F27：设置页「返回」回到进入前的来源视图（默认 home）
  const settingsReturnView = useAppStore((s) => s.settingsReturnView);

  const isSettings = currentView === 'settings';

  const renderNavItem = (
    item: { id: string; icon: React.ElementType },
    onClick: () => void,
    isActive: boolean
  ) => {
    const Icon = item.icon;
    return (
      <button key={item.id} onClick={onClick} className={`nav-item${isActive ? ' active' : ''}`}>
        <span className="nav-item-indicator" />
        <Icon
          className="h-[16px] w-[16px] flex-shrink-0"
          strokeWidth={isActive ? 2.2 : 1.8}
          style={{ color: isActive ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' }}
        />
        <span>{isSettings ? t(`settings.nav.${item.id}`, item.id) : t(`sidebar.${item.id}`)}</span>
      </button>
    );
  };

  return (
    <div className="w-[240px] sidebar h-full flex flex-col relative z-20 select-none">
      {/* macOS traffic light spacer */}
      {isMac ? (
        <div className="h-[52px] flex-shrink-0 app-region-drag" />
      ) : (
        <div className="h-4 flex-shrink-0" />
      )}

      {isSettings ? (
        /* ── Settings sub-navigation ── */
        <>
          {/* Back button */}
          <div className="px-2 pb-2 app-region-no-drag">
            <button
              onClick={() => onViewChange(settingsReturnView)}
              className="nav-item"
              style={{ color: 'hsl(var(--muted-foreground))' }}
            >
              <ChevronLeft
                className="h-4 w-4 flex-shrink-0"
                style={{ color: 'hsl(var(--muted-foreground))' }}
              />
              <span style={{ color: 'hsl(var(--muted-foreground))' }}>
                {t('settings.nav.back', '返回应用')}
              </span>
            </button>
          </div>

          {/* Settings sub-nav items */}
          <nav className="flex-1 app-region-no-drag space-y-[6px] overflow-hidden">
            {settingsNavItems.map((item) =>
              renderNavItem(
                item,
                () => onSettingsSectionChange(item.id),
                settingsSection === item.id
              )
            )}
          </nav>
        </>
      ) : (
        /* ── Main navigation ── */
        <>
          <nav className="flex-1 pb-2 app-region-no-drag overflow-hidden">
            {mainNavGroups.map((group, gi) => (
              <div key={gi} className="space-y-[6px]">
                {group.label && (
                  <div className="px-3 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground select-none">
                    {t(`sidebar.group.${group.label}`)}
                  </div>
                )}
                {group.items.map((item) =>
                  renderNavItem(item, () => onViewChange(item.id), currentView === item.id)
                )}
              </div>
            ))}
          </nav>

          {/* Settings pinned to bottom */}
          <div className="pb-4 app-region-no-drag space-y-[6px]">
            {renderNavItem(
              { id: 'settings', icon: Settings },
              () => onViewChange('settings'),
              false
            )}
          </div>
        </>
      )}
    </div>
  );
}
