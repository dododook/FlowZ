import { Card, CardContent } from '@/components/ui/card';
import { BackupRestoreSection } from './backup-restore-section';
import { CoreVersionBanner } from './core-version-banner';
import { CoreManagementCard } from './core-management-card';
import { SingboxDashboardSection } from './singbox-dashboard-section';

/**
 * 设置「高级」节：内核管理（置顶）+ sing-box 官方面板（opt-in 逃生舱）+ 数据备份（末位）。
 * 内核管理从「关于」迁入（C9/M3：破坏性运维不藏在只读关于页）并置顶（高频运维入口，不埋在底部）；
 * 数据备份置末（低频）；日志/诊断在「日志」页；clash API/终端在「网络」节。
 */
export function AdvancedSettings() {
  return (
    <div className="space-y-6">
      {/* 系统运维：内核管理（含回滚/重置出厂/完全卸载）。置顶——高频运维入口，不埋在底部。 */}
      <CoreVersionBanner />
      <CoreManagementCard />

      {/* sing-box 官方面板（opt-in）：高级用户/调试逃生舱，开关 + 打开按钮 */}
      <Card>
        <CardContent className="divide-y divide-border/60 pt-2">
          <SingboxDashboardSection />
        </CardContent>
      </Card>

      {/* 数据备份与恢复 —— 末位 */}
      <Card>
        <CardContent className="pt-6">
          <BackupRestoreSection />
        </CardContent>
      </Card>
    </div>
  );
}
