/**
 * 「接入组网」区（组网 tab 内，节点网格下方）：统一节点模型 + 各协议按接入态分流。
 *
 * 三协议按「是否已接入」派生入口（见 tailscale-connection-redesign 设计）：
 *  - Tailscale：账号制单例——委托 MeshTailscaleControl（连接/AuthKey/打开登录页/取消/登出/切换/设置的完整登录状态机）；
 *  - WireGuard：节点制多实例——恒「新增」，轻量 Dialog 包 WireGuardForm（.conf 导入已内置）；
 *  - WARP：**单例**（行为变更，用户签核）——未注册→「接入」；已注册→「已接入·管理」{ 重新注册 / 注销 }，不再允许多个。
 *
 * 单例守卫（TS=tailscaleSlotTaken 硬闸门 + 本区不给「再加」；WARP=warpSlotTaken + 本区「已接入·管理」）均纯函数、可离线单测。
 * WARP「注销」=删节点（主进程据 warpDevice 凭据后台注销远端匿名设备，防孤儿计费）；「重新注册」=先注销旧、再注册新替换。
 *
 * Conduit 1:1 移植：整区改为原型 `.field-lbl.nd-mesh-lbl` 标签 + `.nd-mesh`（3 列网格）承载三个 `.nd-mesh-btn`。
 * 单例已接入的 WARP 管理走 radix DropdownMenu（a11y 保留，触发器即 `.nd-mesh-btn.is-joined`）；弹窗保 radix（chrome 归 ui/*）。
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
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
import { NodeFormDialog } from './node-form-dialog';
import { MeshTailscaleControl } from './mesh-tailscale-control';
import { useServerActions } from '../../pages/use-server-actions';

type ProtocolConfig = { protocol: string } & Record<string, unknown>;

interface MeshAccessEntryProps {
  /** 当前唯一的 Tailscale 节点（单例硬限保证至多一个）；委托 MeshTailscaleControl 承载登录状态机。 */
  tsNode: ServerConfig | undefined;
  /** 当前已注册的 WARP 节点（单例）；有则「已接入·管理」，无则「接入」。 */
  warpNode: ServerConfig | undefined;
  /** 代理是否运行——透传给 TS 控件（其状态文案已相位到节点卡）。 */
  proxyRunning: boolean;
  /** §H：一次性外部指令——首页「选择出口设备」导航进来时自动打开 TS 设置弹窗。透传给 TS 控件。 */
  autoOpenSettings?: boolean;
  onAutoOpenConsumed?: () => void;
}

// 原型接入入口图标：WireGuard 盾牌 / WARP 地球。
const WG_ICON = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
  </svg>
);

const WARP_ICON = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 000 18M12 3a14 14 0 010 18" />
  </svg>
);

const JOINED_CHECK = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

const MESH_CHEV = (
  <svg
    className="nd-mesh-chev"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

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
  const [warpDeregisterOpen, setWarpDeregisterOpen] = useState(false);
  const [wgName, setWgName] = useState('');
  const [wgNameError, setWgNameError] = useState(false);
  const wgNameInputRef = useRef<HTMLInputElement>(null);
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
      // 名称必填（内联红框 + 聚焦，与 §6 表单校验一致）：空名 saveServer 会以空名落库，故提交 gate 在此拦下。
      setWgNameError(true);
      wgNameInputRef.current?.focus();
      wgNameInputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    await submitNew(wgName, config);
    setWgOpen(false);
    setWgName('');
    setWgNameError(false);
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
    <div className="flex flex-col gap-2.5">
      <div className="field-lbl nd-mesh-lbl">
        {t('servers.meshAccessTitle', '接入组网')}
        <small>
          {t(
            'servers.meshAccessEntryHint',
            'Tailscale / WARP 已接入可在此管理，WireGuard 可继续新增'
          )}
        </small>
      </div>

      <div className="nd-mesh">
        {/* Tailscale：账号制单例，完整登录状态机委托给 MeshTailscaleControl（渲染为单个 .nd-mesh-btn）。 */}
        <MeshTailscaleControl
          tsNode={tsNode}
          proxyRunning={proxyRunning}
          autoOpenSettings={autoOpenSettings}
          onAutoOpenConsumed={onAutoOpenConsumed}
        />

        {/* WARP：单例。未注册→接入（新增态）；已注册→已接入·管理{ 重新注册 / 注销 }（DropdownMenu）。
            顺序：Tailscale → WARP → WireGuard（用户定：WARP 第二、WireGuard 第三）。 */}
        {warpNode ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="nd-mesh-btn is-joined"
                title={t('servers.meshWarpManageTitle', 'WARP 账户管理')}
              >
                <span className="nd-mesh-ic">{WARP_ICON}</span>
                <span className="nd-mesh-tx">
                  <span className="nd-mesh-hd">
                    <span className="nd-mesh-nm">WARP</span>
                    <span className="nd-mesh-joined-tag">
                      {JOINED_CHECK}
                      {t('servers.meshJoinedTag', '已接入')}
                    </span>
                  </span>
                  <span className="nd-mesh-sub">
                    {t('servers.meshWarpManageSub', '重新注册 / 注销设备')}
                  </span>
                </span>
                {MESH_CHEV}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setWarpReRegisterOpen(true)}>
                <Zap className="me-2 h-4 w-4" />
                {t('servers.meshWarpReRegister', '重新注册')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setWarpDeregisterOpen(true)}
                className="text-destructive focus:text-destructive"
              >
                {t('servers.meshWarpDeregister', '注销')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <button type="button" className="nd-mesh-btn" onClick={() => setWarpOpen(true)}>
            <span className="nd-mesh-ic">{WARP_ICON}</span>
            <span className="nd-mesh-tx">
              <span className="nd-mesh-hd">
                <span className="nd-mesh-nm">WARP</span>
              </span>
              <span className="nd-mesh-sub">{t('servers.meshWarpAddSub', '注册匿名设备接入')}</span>
            </span>
          </button>
        )}

        {/* WireGuard：节点制多实例，恒「新增」态（第三位）。 */}
        <button type="button" className="nd-mesh-btn" onClick={() => setWgOpen(true)}>
          <span className="nd-mesh-ic">{WG_ICON}</span>
          <span className="nd-mesh-tx">
            <span className="nd-mesh-hd">
              <span className="nd-mesh-nm">WireGuard</span>
            </span>
            <span className="nd-mesh-sub">
              {t('servers.meshWgAddSub', '.conf 导入 / 手动填写')}
            </span>
          </span>
        </button>
      </div>

      {/* WireGuard 接入：名称（dialog 级）+ WireGuardForm（.conf 导入已内置）。页脚由外壳渲染（#350）。 */}
      <NodeFormDialog
        open={wgOpen}
        onOpenChange={(open) => {
          setWgOpen(open);
          if (!open) {
            setWgName('');
            setWgNameError(false);
          }
        }}
        title={t('servers.meshAccessAddWg', '添加 WireGuard 节点')}
        description={t('servers.meshAccessAddWgDesc', '手动填写或粘贴 wg-quick .conf 导入。')}
        onSubmit={handleWgSubmit}
        submitLabel={t('servers.add')}
      >
        {(submit) => (
          <>
            {/* 说明文案作为正文首段（外壳的 description 是 sr-only 的 a11y 描述，不上屏）。 */}
            <p className="text-xs text-muted-foreground">
              {t('servers.meshAccessAddWgDesc', '手动填写或粘贴 wg-quick .conf 导入。')}
            </p>
            <div className="field">
              <label className="field-lbl" htmlFor="meshWgName">
                {t('servers.remarks')}
              </label>
              <input
                ref={wgNameInputRef}
                id="meshWgName"
                className={cn('input', wgNameError && 'err')}
                placeholder={t('servers.remarksPlaceholder')}
                value={wgName}
                onChange={(e) => {
                  setWgName(e.target.value);
                  if (wgNameError) setWgNameError(false);
                }}
                aria-invalid={wgNameError}
              />
              {wgNameError && (
                <p className="text-[11px] text-[hsl(var(--err))]">
                  {t('servers.meshAccessNameFirst', '请先填写节点名称')}
                </p>
              )}
            </div>
            <WireGuardForm onSubmit={submit} />
          </>
        )}
      </NodeFormDialog>

      {/* WARP 接入：名称（预填）+ WarpPanel（一键注册→WG 节点）。WarpPanel 自带按钮，故不套页脚。 */}
      <NodeFormDialog
        open={warpOpen}
        onOpenChange={setWarpOpen}
        title={t('servers.meshAccessAddWarp', '添加 Cloudflare WARP')}
        description={t(
          'servers.meshAccessAddWarpDesc',
          '一键注册匿名 WARP 设备并加入为 WireGuard 节点。'
        )}
        onSubmit={handleWarpSubmit}
        submitLabel={t('servers.add')}
        hideFooter
      >
        {(submit) => (
          <>
            <p className="text-xs text-muted-foreground">
              {t(
                'servers.meshAccessAddWarpDesc',
                '一键注册匿名 WARP 设备并加入为 WireGuard 节点。'
              )}
            </p>
            <div className="field">
              <label className="field-lbl" htmlFor="meshWarpName">
                {t('servers.remarks')}
              </label>
              <input
                id="meshWarpName"
                className="input"
                placeholder={t('servers.remarksPlaceholder')}
                value={warpName}
                onChange={(e) => setWarpName(e.target.value)}
              />
            </div>
            <WarpPanel onSubmit={submit} nameMissing={!warpName.trim()} />
          </>
        )}
      </NodeFormDialog>

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
                '确认后将立即注销当前 WARP 设备，再注册一台全新的匿名设备替换它。若随后取消注册，已注销的设备不会恢复。'
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

      {/* WARP 注销确认：删节点即触发主进程后台注销远端匿名设备（防孤儿计费），高危故二次确认。 */}
      <AlertDialog open={warpDeregisterOpen} onOpenChange={setWarpDeregisterOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('servers.meshWarpDeregisterTitle', '注销 WARP？')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'servers.meshWarpDeregisterDesc',
                '将移除此 WARP 节点并在后台注销远端匿名设备，可随时重新接入。'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setWarpDeregisterOpen(false);
                void handleWarpDeregister();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('servers.meshWarpDeregister', '注销')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
