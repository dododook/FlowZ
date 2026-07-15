import { BackupRestoreSection } from './backup-restore-section';
import { CoreVersionBanner } from './core-version-banner';
import { CoreManagementCard } from './core-management-card';
import { SingboxDashboardSection } from './singbox-dashboard-section';

/**
 * 内核管理从「关于」迁入并置顶（C9/M3：破坏性运维不藏在只读关于页，且是高频运维入口）；数据备份置末（低频）；
 * 日志/诊断在「日志」页。
 */
export function AdvancedSettings() {
  return (
    <div className="set-panel" data-set-panel="advanced">
      <CoreVersionBanner />
      <CoreManagementCard />
      <SingboxDashboardSection />
      <BackupRestoreSection />
    </div>
  );
}
