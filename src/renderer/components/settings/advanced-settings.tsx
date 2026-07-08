import { BackupRestoreSection } from './backup-restore-section';
import { CoreVersionBanner } from './core-version-banner';
import { CoreManagementCard } from './core-management-card';
import { SingboxDashboardSection } from './singbox-dashboard-section';

/**
 * 设置「高级」节（Conduit `.set-panel data-set-panel="advanced"`）：内核管理（置顶）+ 控制面板（sing-box 原生
 * 控制 API，opt-in 逃生舱）+ 数据备份（末位）。各子组件自渲染 `.card.set-card`。
 * 内核管理从「关于」迁入（C9/M3：破坏性运维不藏在只读关于页）并置顶（高频运维入口）；数据备份置末（低频）；
 * 日志/诊断在「日志」页。
 */
export function AdvancedSettings() {
  return (
    <div className="set-panel" data-set-panel="advanced">
      {/* 更新横幅（发现新内核时常驻提示，agent D 共享件） */}
      <CoreVersionBanner />

      {/* 系统运维：内核管理（含回滚/重置出厂/完全卸载）。置顶——高频运维入口。 */}
      <CoreManagementCard />

      {/* 控制面板：sing-box 原生控制 API（opt-in 逃生舱） */}
      <SingboxDashboardSection />

      {/* 数据备份与恢复 —— 末位 */}
      <BackupRestoreSection />
    </div>
  );
}
