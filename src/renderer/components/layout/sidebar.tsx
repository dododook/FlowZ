import { ChevronLeft, Sliders, Palette, Cpu, Info, Network, PanelLeft } from 'lucide-react';

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
import { api } from '@/ipc/api-client';
import { useAppStore } from '@/store/app-store';
import { useSidebarStore } from './use-sidebar-store';

// 侧栏导航图标：1:1 复刻设计稿原型内联 SVG（viewBox 24、stroke 1.9、currentColor）。appPolicy 用上方 FlowSplitIcon（已与原型 Y 型一致）。
type NavIconProps = { className?: string; strokeWidth?: number | string };
function svgProps(p: NavIconProps) {
  return {
    className: p.className,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: p.strokeWidth ?? 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
}
function HomeIcon(p: NavIconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M3 11l9-8 9 8M5 10v10h14V10" />
    </svg>
  );
}
function NodesIcon(p: NavIconProps) {
  return (
    <svg {...svgProps(p)}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <rect x="3" y="10" width="18" height="4" rx="1" />
      <rect x="3" y="16" width="18" height="4" rx="1" />
    </svg>
  );
}
function RulesIcon(p: NavIconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}
function ResourcesIcon(p: NavIconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M4 7l8-3 8 3-8 3zM4 7v10l8 3 8-3V7" />
    </svg>
  );
}
function ConnsIcon(p: NavIconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M3 12h4l3 8 4-16 3 8h4" />
    </svg>
  );
}
function LogsIcon(p: NavIconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}
function SettingsIcon(p: NavIconProps) {
  return (
    <svg {...svgProps(p)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
    </svg>
  );
}

interface SidebarProps {
  currentView: string;
  onViewChange: (view: string) => void;
  settingsSection: string;
  onSettingsSectionChange: (section: string) => void;
}

// 主导航分区（section label，非二级/折叠）：主页+节点无标签置顶；分流域、诊断域各带分区标题。
// 顺序按心智流：配置（节点）→ 策略（分流）→ 观测（诊断）。
const mainNavGroups: { label?: string; items: { id: string; icon: React.ElementType }[] }[] = [
  {
    items: [
      { id: 'home', icon: HomeIcon },
      { id: 'server', icon: NodesIcon },
    ],
  },
  {
    label: 'routing',
    items: [
      // 顺序对齐设计稿原型：规则 → 应用分流 → 规则资源
      { id: 'rules', icon: RulesIcon },
      { id: 'appPolicy', icon: FlowSplitIcon },
      { id: 'ruleResources', icon: ResourcesIcon },
    ],
  },
  {
    label: 'diagnostics',
    items: [
      { id: 'connections', icon: ConnsIcon },
      { id: 'logs', icon: LogsIcon },
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
const isLinux = window.electron?.platform === 'linux';

// 折叠 icon-rail 分隔线（toggle↓导航 + routing/diagnostics 分组前共用）：bg-muted-foreground/40
// 跨浅(#e9eef3)/深(#1f252e)主题对比适中、不刺眼；旧 bg-border/50 因 border 色贴近两主题背景、再砍半透明 → 几乎隐形。
const RAIL_DIVIDER_CLASS = 'mx-auto my-1.5 h-px w-5 bg-muted-foreground/40';

export function Sidebar({
  currentView,
  onViewChange,
  settingsSection,
  onSettingsSectionChange,
}: SidebarProps) {
  const { t } = useTranslation();
  // F27：设置页「返回」回到进入前的来源视图（默认 home）
  const settingsReturnView = useAppStore((s) => s.settingsReturnView);
  // 折叠态(icon-rail)：收起仅图标 + hover tooltip；持久化见 use-sidebar-store。
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);

  const isSettings = currentView === 'settings';

  // 收起宽度：Mac 取 80px —— 红绿灯约 72px 宽，留 ~8px 余量避免绿灯顶到内容边；Win/Linux 无此约束 → 更紧凑 56px。
  const railWidth = isMac ? 'w-[80px]' : 'w-[56px]';

  const renderNavItem = (
    item: { id: string; icon: React.ElementType },
    onClick: () => void,
    isActive: boolean
  ) => {
    const Icon = item.icon;
    const label = isSettings ? t(`settings.nav.${item.id}`, item.id) : t(`sidebar.${item.id}`);
    return (
      <button
        key={item.id}
        onClick={onClick}
        title={collapsed ? label : undefined}
        className={`nav-item${isActive ? ' active' : ''}${collapsed ? ' collapsed' : ''}`}
      >
        <span className="nav-item-indicator" />
        <Icon
          className={`${collapsed ? (isMac ? 'h-[26px] w-[26px]' : 'h-[22px] w-[22px]') : 'h-[16px] w-[16px]'} flex-shrink-0`}
          strokeWidth={isActive ? 2.2 : 1.8}
        />
        {!collapsed && <span>{label}</span>}
      </button>
    );
  };

  return (
    <div
      className={`${collapsed ? railWidth : 'w-[158px]'} sidebar h-full flex flex-col relative z-20 select-none transition-[width] duration-300 ease-out`}
    >
      {/* 集成标题栏顶部条：Mac 让出红绿灯(52)、Windows/Linux 让出右上窗口控制按钮(32)、可拖窗。 */}
      {isMac ? (
        <div className="h-[36px] flex-shrink-0 app-region-drag" />
      ) : (
        <div
          className="h-[32px] flex-shrink-0 app-region-drag"
          // Linux frameless：拖拽区双击最大化由显式 IPC 保证（与 main 顶部对称，覆盖侧栏顶部双击）。
          onDoubleClick={
            isLinux ? () => void api.window.maximizeToggle().catch(() => {}) : undefined
          }
        />
      )}

      {/* 折叠 toggle 置顶（首页上方，用户反馈）：紧接拖拽区、与红绿灯小间距（无上 padding + drag 36）。
          展开左对齐（齐导航项）、收起居中方块。 */}
      <div
        className={`flex px-2 pb-1 app-region-no-drag ${collapsed ? 'justify-center' : 'justify-start'}`}
      >
        <button
          onClick={toggleCollapsed}
          title={collapsed ? t('sidebar.expand', '展开侧栏') : t('sidebar.collapse', '收起侧栏')}
          className={`sidebar-toggle flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground ${
            collapsed ? (isMac ? 'h-[52px] w-[52px]' : 'h-[44px] w-[44px]') : 'h-7 w-7'
          }`}
        >
          <PanelLeft
            className={`${collapsed ? (isMac ? 'h-[26px] w-[26px]' : 'h-[22px] w-[22px]') : 'h-[18px] w-[18px]'} rtl-mirror`}
            strokeWidth={1.8}
          />
        </button>
      </div>
      {collapsed && <div className={RAIL_DIVIDER_CLASS} />}

      {isSettings ? (
        /* ── Settings sub-navigation ── */
        <>
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

          {/* 返回应用：置底——镜像主导航「设置」置底（同款 pb-4 + space-y-[6px] 无 px，按钮宽度/位置与「设置」对齐）。 */}
          <div className="pb-4 app-region-no-drag space-y-[6px]">
            <button
              onClick={() => onViewChange(settingsReturnView)}
              title={collapsed ? t('settings.nav.back', '返回应用') : undefined}
              className={`nav-item${collapsed ? ' collapsed' : ''}`}
              style={{ color: 'hsl(var(--muted-foreground))' }}
            >
              <ChevronLeft
                className={`${collapsed ? (isMac ? 'h-[26px] w-[26px]' : 'h-[22px] w-[22px]') : 'h-4 w-4'} flex-shrink-0 rtl-mirror`}
                style={{ color: 'hsl(var(--muted-foreground))' }}
              />
              {!collapsed && (
                <span style={{ color: 'hsl(var(--muted-foreground))' }}>
                  {t('settings.nav.back', '返回应用')}
                </span>
              )}
            </button>
          </div>
        </>
      ) : (
        /* ── Main navigation ── */
        <>
          <nav className="flex-1 pb-2 app-region-no-drag overflow-hidden">
            {mainNavGroups.map((group, gi) => (
              <div key={gi} className="space-y-[6px]">
                {group.label &&
                  (collapsed ? (
                    /* 收起态：分区标题转居中短分隔线，保留分组视觉、不显凌乱 */
                    <div className={RAIL_DIVIDER_CLASS} />
                  ) : (
                    <div className="whitespace-nowrap px-[11px] pb-[6px] pt-[15px] text-[10px] font-[660] uppercase tracking-[0.09em] text-fg-faint select-none">
                      {t(`sidebar.group.${group.label}`)}
                    </div>
                  ))}
                {group.items.map((item) =>
                  renderNavItem(item, () => onViewChange(item.id), currentView === item.id)
                )}
              </div>
            ))}
          </nav>

          {/* Settings pinned to bottom */}
          <div className="pb-4 app-region-no-drag space-y-[6px]">
            {renderNavItem(
              { id: 'settings', icon: SettingsIcon },
              () => onViewChange('settings'),
              false
            )}
          </div>
        </>
      )}
    </div>
  );
}
