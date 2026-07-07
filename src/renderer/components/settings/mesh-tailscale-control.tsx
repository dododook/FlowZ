/**
 * Tailscale 组网接入控件（批3b：退役单例连接卡，TS 融入统一节点模型）。
 *
 * 状态**显示**已由列表里的统一 ServerCard 承载（needs-login→Log in 角标、logging-in→登录中角标、
 * connected/key-ready→常规卡 + current ring + ⓘ；点卡=选为出口）。本控件只承载**连接生命周期动作**——
 * 那些放不进卡片角标的入口，从退役的 TailscaleConnectionCard 逐字迁入，护住 #174/#254 可靠性不变量：
 *  - no-node / needs-login → 「连接 Tailscale」（无节点先 saveServer 建默认节点再 login；有节点直接 login）+「用 Auth Key」；
 *  - logging-in            → spinner +「打开登录页」(#174-I2 可靠重开) +「取消」(#174-I1 乐观清)；
 *  - connected             → 「管理」▾{ 设置 / 切换账号 / 登出 } + ⓘ；
 *  - key-ready             → 「管理」▾{ 设置 / 删除 } + ⓘ。
 *
 * 状态派生复用 shared/tailscale-conn-state.deriveTsCardState（5 态，已单测，登录态门控 loginActive 保 #174-I3）。
 * 「设为出口」不再在此（点卡=选出口）；§H auto-open 设置弹窗入口（#254）从卡片迁入本控件。
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Loader2,
  Link as LinkIcon,
  KeyRound,
  Settings,
  Plug,
  Trash2,
  RefreshCw,
  ChevronDown,
} from 'lucide-react';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc/api-client';
import { Button } from '@/components/ui/button';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import type { ServerConfig } from '@/bridge/types';
import { deriveTsCardState } from '../../../shared/tailscale-conn-state';
import { runTailscaleLogin, openTailscaleLogin } from '../../lib/tailscale-login';
import { TailscaleForm } from './tailscale-form';
import { useServerActions } from '../../pages/use-server-actions';
import { MeshInfoPopover } from './mesh-info-popover';

interface MeshTailscaleControlProps {
  /** 当前唯一的 Tailscale 节点（单例硬限保证至多一个）；无则渲染「连接」入口态。 */
  tsNode: ServerConfig | undefined;
  /** 代理是否运行——决定副标题文案（已连接·实时 IP vs 已登录·上次），不进状态派生。 */
  proxyRunning: boolean;
  /** §H：一次性外部指令——首页「选择出口设备」导航进来时自动打开设置弹窗（内含出口设备选择）。消费后回调清除。 */
  autoOpenSettings?: boolean;
  onAutoOpenConsumed?: () => void;
}

export function MeshTailscaleControl({
  tsNode,
  proxyRunning,
  autoOpenSettings,
  onAutoOpenConsumed,
}: MeshTailscaleControlProps) {
  const { t } = useTranslation();
  const { saveServer, deleteServer } = useServerActions();

  const serverId = tsNode?.id;
  // 综合登录态（缓存初值 + state 文件兜底 + STATUS 实时校正已在 app-store 融合，单一布尔即真值）。
  const loggedIn = useAppStore((s) => (serverId ? !!s.tailscaleLoginStates[serverId] : false));
  // 登录中：已产生 authUrl（瞬态核在等浏览器授权）且未登录成功。
  const hasAuthUrl = useAppStore((s) =>
    serverId ? s.tailscaleAuthUrls[serverId] !== undefined : false
  );
  // 缓存的登录 URL（供「打开登录页」重开；缺失时 openTailscaleLogin 回落 runTailscaleLogin → main 兜底取 live URL）。
  const authUrl = useAppStore((s) => (serverId ? s.tailscaleAuthUrls[serverId] : undefined));
  // 用户是否显式发起了本节点登录（区分主核 always-emit 的 URL）——决定卡片是否进「连接中」态。
  const loginInitiated = useAppStore((s) =>
    serverId ? !!s.tailscaleLoginInitiated[serverId] : false
  );
  const setTailscaleLoginState = useAppStore((s) => s.setTailscaleLoginState);
  const setTailscaleAuthUrl = useAppStore((s) => s.setTailscaleAuthUrl);
  const setTailscaleLoginInitiated = useAppStore((s) => s.setTailscaleLoginInitiated);
  // 当前主出口是否为本 TS 节点（selectedServerId 单一真值）：驱动 loginActive（选中出口=自动连接=登录进行中），
  // 并给「已接入」行一个「当前出口」只读指示（选出口动作已移到点卡）。
  const selectedServerId = useAppStore((s) => s.config?.selectedServerId);
  const isSelectedExit = !!serverId && selectedServerId === serverId;

  const [showKeyForm, setShowKeyForm] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);

  // §H：首页「选择出口设备」导航进来 → 自动打开设置弹窗（TailscaleForm 内含 ExitNodeField），消费后清除一次性指令。
  useEffect(() => {
    if (autoOpenSettings) {
      setShowKeyForm(false);
      setSettingsOpen(true);
      onAutoOpenConsumed?.();
    }
  }, [autoOpenSettings, onAutoOpenConsumed]);

  // 登录进行中判据：用户显式发起 OR 该 TS 是当前选中出口（app 自动连接它=登录进行中，首页会弹登录）→ 显「连接中」，
  // 而非被 always-emit 的非活跃 URL 误判/漏判（#174-I3）。
  const loginActive = loginInitiated || isSelectedExit;
  const state = deriveTsCardState(tsNode, loggedIn, hasAuthUrl, loginActive);

  // 设置弹窗里编辑（含填 Auth Key）→ 复用 TailscaleForm，统一走 saveServer（editingServer=现有 TS 节点）。
  const handleSaveSettings = async (config: { protocol: string; tailscaleSettings?: unknown }) => {
    await saveServer(
      { name: tsNode?.name || 'Tailscale', ...config } as Parameters<typeof saveServer>[0],
      tsNode
    );
    setSettingsOpen(false);
    setShowKeyForm(false);
  };

  // 「连接 Tailscale」：无节点先建默认 TS 节点拿 id，再交互登录；有节点直接交互登录（#174-I5：走 saveServer 非 api.server.add）。
  const handleConnect = async () => {
    setConnecting(true);
    try {
      let node = tsNode;
      if (!node) {
        node = await saveServer(
          {
            name: 'Tailscale',
            protocol: 'tailscale',
            address: '',
            port: 0,
            tailscaleSettings: { alwaysRouteSubnets: true },
          } as Parameters<typeof saveServer>[0],
          undefined
        );
        if (!node) return; // slotTaken 拦下 / 保存失败 → saveServer 已 toast，不继续登录
      }
      await runTailscaleLogin(node);
    } catch {
      toast.error(t('errors.operationFailed'));
    } finally {
      setConnecting(false);
    }
  };

  // 「切换账号」= 对已接入节点重新发起交互登录（re-auth 即换账号）；runTailscaleLogin 起手置 initiated → 进「连接中」。
  const handleSwitchAccount = () => {
    if (tsNode) void runTailscaleLogin(tsNode);
  };

  // 「取消」#174-I1：立即本地退出「连接中」态（乐观清）——主核路径 endpoint 在主核里、无瞬态核可杀，
  // 若等 IPC 回执才清 UI，卡片会一直卡「连接中」。清 URL + initiated 双管，当即回落「需登录」。
  const handleCancel = async () => {
    if (!serverId) return;
    setTailscaleAuthUrl(serverId, '');
    setTailscaleLoginInitiated(serverId, false);
    try {
      await api.server.tailscaleLoginCancel(serverId);
    } catch {
      /* 取消失败不阻断：UI 已乐观回落，瞬态核（若有）也会随核退出被清 */
    }
  };

  const handleDisconnect = async () => {
    if (!serverId) return;
    try {
      const { runningNeedsRestart } = await api.server.tailscaleLogout(serverId);
      setTailscaleLoginState(serverId, false);
      if (runningNeedsRestart) toast.info(t('servers.tsLogoutRestartHint'));
    } catch {
      toast.error(t('errors.operationFailed'));
    }
  };

  const handleDelete = async () => {
    if (!serverId) return;
    try {
      await api.server.tailscaleLogout(serverId);
    } catch {
      /* 登出失败不阻断删除：删节点本就清配置，残留 state 目录无害 */
    }
    await deleteServer(serverId);
  };

  // 左侧：图标 + 「Tailscale」+ 状态副标题（+ ⓘ）。
  const header = (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <LinkIcon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          Tailscale
          {state === 'connected' && (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" />
              {proxyRunning
                ? t('servers.tsConnCardConnected', '已连接')
                : t('servers.tsConnCardLoggedInPast', '已登录（上次）')}
            </span>
          )}
          {state === 'key-ready' && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <KeyRound className="h-3 w-3" />
              {t('servers.tsConnCardKeyReady', '已配置 Auth Key')}
            </span>
          )}
          {isSelectedExit && (state === 'connected' || state === 'key-ready') && (
            <span className="inline-flex items-center gap-1 rounded bg-success/15 px-1.5 py-0.5 text-[10px] text-success">
              <Check className="h-3 w-3" />
              {t('servers.tsConnCardCurrentExit', '当前出口')}
            </span>
          )}
        </p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">
            {state === 'connected' && tsNode
              ? tsNode.name
              : state === 'key-ready'
                ? t('servers.tsConnCardKeyReadyDesc', '代理启动即自动连接，无需登录')
                : state === 'logging-in'
                  ? t(
                      'servers.tsConnCardLoggingInDesc',
                      '等待浏览器完成登录授权，可点「打开登录页」，授权后自动连接'
                    )
                  : t('servers.tsConnCardIntro', '账号制组网：登录后本机即加入你的 tailnet')}
          </span>
          {(state === 'connected' || state === 'key-ready') && tsNode && (
            <MeshInfoPopover server={tsNode} />
          )}
        </p>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-background/60 p-3 sm:flex-row sm:items-center sm:justify-between">
      {header}

      <div className="flex flex-shrink-0 flex-wrap gap-2 sm:justify-end">
        {(state === 'no-node' || state === 'needs-login') && (
          <>
            <Button size="sm" onClick={() => void handleConnect()} disabled={connecting}>
              {connecting && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t('servers.tsConnCardConnect', '连接 Tailscale')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setShowKeyForm(true);
                setSettingsOpen(true);
              }}
            >
              <KeyRound className="me-2 h-4 w-4" />
              {t('servers.tsConnCardUseAuthKey', '用 Auth Key')}
            </Button>
          </>
        )}

        {state === 'logging-in' && (
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('servers.tsConnCardLoggingIn', '连接中…')}
            </span>
            {/* 「打开登录页」#174-I2：可靠重开当前授权页（有缓存 URL 直开，无则回落 runTailscaleLogin 走 main 兜底）。 */}
            {tsNode && (
              <Button size="sm" onClick={() => openTailscaleLogin(tsNode, authUrl)}>
                {t('servers.tsConnCardOpenLogin', '打开登录页')}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => void handleCancel()}>
              {t('servers.tsConnCardCancel', '取消')}
            </Button>
          </div>
        )}

        {state === 'connected' && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <Settings className="me-2 h-4 w-4" />
                {t('servers.meshManage', '管理')}
                <ChevronDown className="ms-1 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
                <Settings className="me-2 h-4 w-4" />
                {t('servers.tsConnCardSettings', '设置')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleSwitchAccount}>
                <RefreshCw className="me-2 h-4 w-4" />
                {t('servers.tsReauth', '重新登录 / 切换账号')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void handleDisconnect()}>
                <Plug className="me-2 h-4 w-4" />
                {t('servers.tsConnCardDisconnect', '断开')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {state === 'key-ready' && (
          <>
            <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
              <Settings className="me-2 h-4 w-4" />
              {t('servers.tsConnCardSettings', '设置')}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline">
                  <Trash2 className="me-2 h-4 w-4" />
                  {t('servers.tsConnCardDelete', '删除')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t('servers.tsConnCardDeleteTitle', '删除 Tailscale 连接？')}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t(
                      'servers.tsConnCardDeleteDesc',
                      '将退出登录并移除此 Tailscale 节点配置，可随时重新连接。'
                    )}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => void handleDelete()}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {t('common.delete')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </div>

      {/* 设置 / 用 Auth Key：复用 TailscaleForm（账号制无地址端口，连后配置）。onSubmit 统一 saveServer。 */}
      <Dialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) setShowKeyForm(false);
        }}
      >
        <DialogContent className="w-[92vw] max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {showKeyForm
                ? t('servers.tsConnCardUseAuthKey', '用 Auth Key')
                : t('servers.tsConnCardSettingsTitle', 'Tailscale 设置')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'servers.tsConnCardSettingsDesc',
                '出口节点、子网路由与高级选项。代理运行中保存会自动重连以生效。'
              )}
            </DialogDescription>
          </DialogHeader>
          <TailscaleForm
            key={tsNode?.id || 'new-key'}
            serverConfig={tsNode}
            onSubmit={handleSaveSettings}
            hideLoginSection
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
