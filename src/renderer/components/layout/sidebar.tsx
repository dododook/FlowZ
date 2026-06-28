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
  PanelLeft,
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
import { useSidebarStore } from './use-sidebar-store';

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
const isWindows = window.electron?.platform === 'win32';

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
          style={{ color: isActive ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' }}
        />
        {!collapsed && <span>{label}</span>}
      </button>
    );
  };

  return (
    <div
      className={`${collapsed ? railWidth : 'w-[184px]'} sidebar h-full flex flex-col relative z-20 select-none transition-[width] duration-300 ease-out`}
    >
      {/* 集成标题栏顶部条：Mac 让出红绿灯(52)、Windows 让出覆盖层按钮(32)、可拖窗；Linux 默认边框。 */}
      {isMac ? (
        <div className="h-[52px] flex-shrink-0 app-region-drag" />
      ) : isWindows ? (
        <div className="h-[32px] flex-shrink-0 app-region-drag" />
      ) : (
        <div className="h-4 flex-shrink-0" />
      )}

      {/* 折叠 toggle：独立一行置于顶部条下方。
          —— 不放进顶部条：Mac 收起栏被窗口锚定的红绿灯(~72px)几乎占满，toggle 在栏内会飘出到内容区（布局奇怪）；
          —— 不放进拖拽区：下方是普通 no-drag 内容，天然可点（无需 Electron drag/no-drag 兜底）。
          展开左对齐(齐导航项)、收起居中。 */}
      <div
        className={`flex px-2 py-1 app-region-no-drag ${collapsed ? 'justify-center' : 'justify-start'}`}
      >
        <button
          onClick={toggleCollapsed}
          title={collapsed ? t('sidebar.expand', '展开侧栏') : t('sidebar.collapse', '收起侧栏')}
          className={`sidebar-toggle flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground ${
            collapsed ? (isMac ? 'h-[52px] w-[52px]' : 'h-[44px] w-[44px]') : 'h-7 w-7'
          }`}
        >
          {/* 折叠态与导航项(.nav-item.collapsed)同尺寸方块+图标，使 icon-rail 顶部 toggle 与下方导航整齐对齐
              （Mac 52/26、Win·Linux 44/22）；展开态保持 28/18 小巧 toggle。 */}
          <PanelLeft
            className={`${collapsed ? (isMac ? 'h-[26px] w-[26px]' : 'h-[22px] w-[22px]') : 'h-[18px] w-[18px]'} rtl-mirror`}
            strokeWidth={1.8}
          />
        </button>
      </div>

      {/* 折叠态：toggle(控制) 与下方导航(目标) 之间补一条边界线，与组间分隔同款。
          收起后 toggle 被放大成与导航项同尺寸方块，易被误读为首个导航项 → 分隔澄清「控制≠导航」、
          并使顶部分组节奏与中段(routing/diagnostics 组前分隔)一致。
          展开态 toggle 为 28px 小按钮、形态已区分，不渲染。 */}
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
                    <div className="px-3 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground select-none">
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
