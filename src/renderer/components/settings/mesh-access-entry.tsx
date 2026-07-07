/**
 * 「接入组网」区（组网 tab 顶部）。批3b：统一节点模型 + 各协议按接入态分流。
 *
 * 三协议按「是否已接入」派生入口（见 tailscale-connection-redesign 设计）：
 *  - Tailscale：账号制单例——委托 MeshTailscaleControl（连接/AuthKey/打开登录页/取消/登出/切换/设置的完整登录状态机）；
 *  - WireGuard：节点制多实例——恒「新增」，轻量 Dialog 包 WireGuardForm（.conf 导入已内置）；
 *  - WARP：**单例**（行为变更，用户签核）——未注册→「接入」；已注册→「已接入·管理」{ 重新注册 / 注销 }，不再允许多个。
 *
 * 单例守卫（TS=tailscaleSlotTaken 硬闸门 + 本区不给「再加」；WARP=warpSlotTaken + 本区「已接入·管理」）均纯函数、可离线单测。
 * WARP「注销」=删节点（主进程据 warpDevice 凭据后台注销远端匿名设备，防孤儿计费）；「重新注册」=先注销旧、再注册新替换。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Plus, Zap, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { ServerConfig } from '@/bridge/types';
import { WireGuardForm } from './wireguard-form';
import { WarpPanel } from './warp-panel';
import { MeshTailscaleControl } from './mesh-tailscale-control';
import { useServerActions } from '../../pages/use-server-actions';

type ProtocolConfig = { protocol: string } & Record<string, unknown>;

interface MeshAccessEntryProps {
  /** 当前唯一的 Tailscale 节点（单例硬限保证至多一个）；委托 MeshTailscaleControl 承载登录状态机。 */
  tsNode: ServerConfig | undefined;
  /** 当前已注册的 WARP 节点（单例）；有则「已接入·管理」，无则「接入」。 */
  warpNode: ServerConfig | undefined;
  /** 代理是否运行——透传给 TS 控件决定副标题文案。 */
  proxyRunning: boolean;
  /** §H：一次性外部指令——首页「选择出口设备」导航进来时自动打开 TS 设置弹窗。透传给 TS 控件。 */
  autoOpenSettings?: boolean;
  onAutoOpenConsumed?: () => void;
}

export function MeshAccessEntry({
  tsNode,
  warpNode,
  proxyRunning,
  autoOpenSettings,
  onAutoOpenConsumed,
}: MeshAccessEntryProps) {
  const { t } = useTranslation();
  const { saveServer, deleteServer } = useServerActions();

  const [wgOpen, setWgOpen] = useState(false);
  const [warpOpen, setWarpOpen] = useState(false);
  const [warpReRegisterOpen, setWarpReRegisterOpen] = useState(false);
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

  // 「注销」WARP：删节点即触发主进程按 warpDevice 凭据后台注销远端匿名设备（防孤儿计费）。
  const handleWarpDeregister = async () => {
    if (!warpNode) return;
    await deleteServer(warpNode.id);
  };

  // 「重新注册」WARP：先注销旧设备（避免孤儿），再打开注册弹窗建新的替换（单例：注册时已无旧 WARP 节点）。
  const handleWarpReRegister = async () => {
    if (warpNode) await deleteServer(warpNode.id);
    setWarpReRegisterOpen(false);
    setWarpName('Cloudflare WARP');
    setWarpOpen(true);
  };

  return (
    <div className="space-y-3 rounded-xl border bg-muted/30 p-4">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">{t('servers.meshAccessTitle', '接入组网')}</p>
        <p className="text-xs text-muted-foreground">
          {t(
            'servers.meshAccessDesc',
            '把本机加入组网：账号制 Tailscale 或节点制 WireGuard / WARP'
          )}
        </p>
      </div>

      <div className="space-y-2">
        {/* Tailscale：账号制单例，完整登录状态机委托给 MeshTailscaleControl。 */}
        <MeshTailscaleControl
          tsNode={tsNode}
          proxyRunning={proxyRunning}
          autoOpenSettings={autoOpenSettings}
          onAutoOpenConsumed={onAutoOpenConsumed}
        />

        {/* WireGuard：节点制多实例，恒「新增」。 */}
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-background/60 p-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-badge-cyan/15 text-badge-cyan">
              <Plus className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">WireGuard</p>
              <p className="truncate text-xs text-muted-foreground">
                {t('servers.meshAccessAddWgDesc', '手动填写或粘贴 wg-quick .conf 导入。')}
              </p>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => setWgOpen(true)}>
            <Plus className="me-2 h-4 w-4" />
            {t('servers.meshAddWireguard', '新增 WireGuard')}
          </Button>
        </div>

        {/* WARP：单例。未注册→接入；已注册→已接入·管理{ 重新注册 / 注销 }。 */}
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-background/60 p-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-badge-sky/15 text-badge-sky">
              <Zap className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                WARP
                {warpNode && (
                  <Badge
                    variant="outline"
                    className="h-4 border-success/30 bg-success/15 px-1 text-[10px] text-success"
                  >
                    {t('servers.meshWarpJoined', '已接入 WARP')}
                  </Badge>
                )}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {warpNode
                  ? warpNode.name
                  : t(
                      'servers.meshAccessAddWarpDesc',
                      '一键注册匿名 WARP 设备并加入为 WireGuard 节点。'
                    )}
              </p>
            </div>
          </div>
          {warpNode ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  {t('servers.meshManage', '管理')}
                  <ChevronDown className="ms-1 h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setWarpReRegisterOpen(true)}>
                  <Zap className="me-2 h-4 w-4" />
                  {t('servers.meshWarpReRegister', '重新注册')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => void handleWarpDeregister()}
                  className="text-destructive focus:text-destructive"
                >
                  {t('servers.meshWarpDeregister', '注销')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setWarpOpen(true)}>
              <Zap className="me-2 h-4 w-4" />
              WARP
            </Button>
          )}
        </div>
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

      {/* WARP 重新注册确认：先注销当前设备再注册新的替换。 */}
      <AlertDialog open={warpReRegisterOpen} onOpenChange={setWarpReRegisterOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('servers.meshWarpReRegisterTitle', '重新注册 WARP？')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'servers.meshWarpReRegisterDesc',
                '将先注销当前 WARP 设备，再注册一台全新的匿名设备替换它。'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleWarpReRegister()}>
              {t('servers.meshWarpReRegister', '重新注册')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
