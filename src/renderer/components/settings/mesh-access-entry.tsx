/**
 * 「接入组网」入口区（组网 tab 顶部，批3）。
 *
 * 三入口统一收口：[Tailscale] [WireGuard] [WARP]——取代过去混进通用「添加节点」下拉的零散入口。
 * 差异化交互（见 docs/design/tailscale-connection-redesign.md「组网三协议全景」）：
 *  - Tailscale：账号制单例，不弹表单——点击交给上方单例卡（已接入则禁用，引导看卡片）；
 *  - WireGuard：节点制多实例，轻量 Dialog 包 WireGuardForm（.conf 导入已内置）；
 *  - WARP：WG 的一键生成入口，轻量 Dialog 包 WarpPanel（注册→WG 草稿）。
 *
 * 复用三表单零改动（props 契约 {serverConfig?, onSubmit} / {onSubmit, nameMissing} 已独立）；name 是 dialog 级
 * 字段（表单内不含），故 WG/WARP Dialog 自带名称输入，onSubmit 拼 name 后统一走 useServerActions().saveServer。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Link as LinkIcon, Plus, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { WireGuardForm } from './wireguard-form';
import { WarpPanel } from './warp-panel';
import { useServerActions } from '../../pages/use-server-actions';

type ProtocolConfig = { protocol: string } & Record<string, unknown>;

interface MeshAccessEntryProps {
  /** 已存在 Tailscale 节点 → Tailscale 入口禁用，引导用户看上方单例卡（单例硬限的 UI 表达）。 */
  hasTailscale: boolean;
  /** 点 Tailscale 入口（无 TS 节点时）：交给上方单例卡的连接流程（父组件聚焦/触发）。 */
  onTailscaleClick: () => void;
}

export function MeshAccessEntry({ hasTailscale, onTailscaleClick }: MeshAccessEntryProps) {
  const { t } = useTranslation();
  const { saveServer } = useServerActions();

  const [wgOpen, setWgOpen] = useState(false);
  const [warpOpen, setWarpOpen] = useState(false);
  const [wgName, setWgName] = useState('');
  const [warpName, setWarpName] = useState('Cloudflare WARP');

  // 新建节点（无 editingServer）：name 由 dialog 名称字段提供，拼入表单产出的协议配置后保存。
  const submitNew = async (name: string, config: ProtocolConfig) => {
    await saveServer(
      { name: name.trim(), ...config } as Parameters<typeof saveServer>[0],
      undefined
    );
  };

  const handleWgSubmit = async (config: ProtocolConfig) => {
    if (!wgName.trim()) {
      // 名称必填：空名 saveServer 会以空名落库。除上方常驻琥珀提示外，提交时再 toast 一次，避免点表单保存「无反应」。
      toast.error(t('servers.meshAccessNameFirst', '请先填写节点名称'));
      return;
    }
    await submitNew(wgName, config);
    setWgOpen(false);
    setWgName('');
  };

  const handleWarpSubmit = async (config: ProtocolConfig) => {
    await submitNew(warpName || 'Cloudflare WARP', config);
    setWarpOpen(false);
    setWarpName('Cloudflare WARP');
  };

  return (
    <div className="rounded-xl border bg-muted/30 p-4">
      <div className="mb-3 flex items-center gap-2">
        <p className="text-sm font-medium">{t('servers.meshAccessTitle', '接入组网')}</p>
        <p className="text-xs text-muted-foreground">
          {t(
            'servers.meshAccessDesc',
            '把本机加入组网：账号制 Tailscale 或节点制 WireGuard / WARP'
          )}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onTailscaleClick}
          disabled={hasTailscale}
          title={
            hasTailscale
              ? t('servers.meshAccessTsExists', '已接入 Tailscale，见上方卡片')
              : undefined
          }
        >
          <LinkIcon className="me-2 h-4 w-4" />
          Tailscale
        </Button>
        <Button size="sm" variant="outline" onClick={() => setWgOpen(true)}>
          <Plus className="me-2 h-4 w-4" />
          WireGuard
        </Button>
        <Button size="sm" variant="outline" onClick={() => setWarpOpen(true)}>
          <Zap className="me-2 h-4 w-4" />
          WARP
        </Button>
      </div>

      {/* WireGuard 接入：名称（dialog 级）+ WireGuardForm（.conf 导入已内置）。 */}
      <Dialog
        open={wgOpen}
        onOpenChange={(open) => {
          setWgOpen(open);
          if (!open) setWgName('');
        }}
      >
        <DialogContent className="w-[92vw] max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('servers.meshAccessAddWg', '添加 WireGuard 节点')}</DialogTitle>
            <DialogDescription>
              {t('servers.meshAccessAddWgDesc', '手动填写或粘贴 wg-quick .conf 导入。')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="meshWgName">{t('servers.remarks')}</Label>
              <Input
                id="meshWgName"
                placeholder={t('servers.remarksPlaceholder')}
                value={wgName}
                onChange={(e) => setWgName(e.target.value)}
              />
              {!wgName.trim() && (
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  {t('servers.meshAccessNameFirst', '请先填写节点名称')}
                </p>
              )}
            </div>
            <WireGuardForm onSubmit={handleWgSubmit} />
          </div>
        </DialogContent>
      </Dialog>

      {/* WARP 接入：名称（预填）+ WarpPanel（一键注册→WG 节点）。 */}
      <Dialog open={warpOpen} onOpenChange={setWarpOpen}>
        <DialogContent className="w-[92vw] max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('servers.meshAccessAddWarp', '添加 Cloudflare WARP')}</DialogTitle>
            <DialogDescription>
              {t(
                'servers.meshAccessAddWarpDesc',
                '一键注册匿名 WARP 设备并加入为 WireGuard 节点。'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="meshWarpName">{t('servers.remarks')}</Label>
              <Input
                id="meshWarpName"
                placeholder={t('servers.remarksPlaceholder')}
                value={warpName}
                onChange={(e) => setWarpName(e.target.value)}
              />
            </div>
            <WarpPanel onSubmit={handleWarpSubmit} nameMissing={!warpName.trim()} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
