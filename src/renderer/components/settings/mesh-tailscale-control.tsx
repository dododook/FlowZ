/**
 * Tailscale 组网接入控件（批3b：退役单例连接卡，TS 融入统一节点模型）。
 *
 * 状态**显示**由列表里的统一 ServerCard（`.nd-card.mesh`：dot / `.nd-login` 登录角标 / `.nd-cur` 当前 / ⓘ）承载。
 * 本控件是「接入组网」入口区里的 **Tailscale 账户级管理入口**（Conduit `.nd-mesh-btn`）——只承载放不进节点卡的
 * **连接生命周期动作**，从退役的 TailscaleConnectionCard 逐字迁入，护住 #174/#254 可靠性不变量：
 *  - no-node / needs-login → 新增态：「连接 Tailscale」（无节点先 saveServer 建默认节点再 login；有节点直接 login）+「用 Auth Key」；
 *  - logging-in            → spinner +「打开登录页」(#174-I2 可靠重开) +「取消」(#174-I1 乐观清)；
 *  - connected             → 管理态：「设置 / 切换账号 / 登出」；
 *  - key-ready             → 管理态：「设置 / 删除」。
 *
 * 状态派生复用 shared/tailscale-conn-state.deriveTsCardState（5 态，已单测，登录态门控 loginActive 保 #174-I3）。
 * 「设为出口」不在此（点节点卡=选出口）；§H auto-open 设置弹窗入口（#254）从卡片迁入本控件。
 *
 * Conduit 1:1 移植：整行改为单个 `.nd-mesh-btn`（管理态 `.is-joined` 实线 + `.nd-mesh-joined-tag`；新增态虚线「+」）。
 * 多分支动作经 radix DropdownMenu 承载（a11y/键盘保留），弹窗保 radix。状态显示（在线/延迟/ⓘ/当前出口）已相位到节点卡。
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
  Loader2,
  KeyRound,
  Settings,
  Plug,
  Trash2,
  RefreshCw,
  Link as LinkIcon,
} from 'lucide-react';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc/api-client';
import { cn } from '@/lib/utils';
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
import { deriveTsCardState } from '../../../shared/tailscale-conn-state';
import { runTailscaleLogin, openTailscaleLogin } from '../../lib/tailscale-login';
import { TailscaleForm } from './tailscale-form';
import { useServerActions } from '../../pages/use-server-actions';

interface MeshTailscaleControlProps {
  /** 当前唯一的 Tailscale 节点（单例硬限保证至多一个）；无则渲染「新增」入口态。 */
  tsNode: ServerConfig | undefined;
  /** 代理是否运行——保留在接口供调用方透传（状态文案已相位到节点卡，本入口不再据此渲染副标题）。 */
  proxyRunning?: boolean;
  /** §H：一次性外部指令——首页「选择出口设备」导航进来时自动打开设置弹窗（内含出口设备选择）。消费后回调清除。 */
  autoOpenSettings?: boolean;
  onAutoOpenConsumed?: () => void;
}

// 原型 Tailscale mesh 图标（三节点网状）：与节点卡 / 接入入口一致。
const TS_ICON = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="5" r="2.2" />
    <circle cx="5" cy="19" r="2.2" />
    <circle cx="19" cy="19" r="2.2" />
    <path d="M12 7.2v3.3M11 12l-4.5 5M13 12l4.5 5" />
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

export function MeshTailscaleControl({
  tsNode,
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
  // 当前主出口是否为本 TS 节点（selectedServerId 单一真值）：驱动 loginActive（选中出口=自动连接=登录进行中）。
  const selectedServerId = useAppStore((s) => s.config?.selectedServerId);
  const isSelectedExit = !!serverId && selectedServerId === serverId;

  const [showKeyForm, setShowKeyForm] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
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

  // ── 单个 `.nd-mesh-btn` 触发器：按态渲染 is-joined / joined-tag / 副标 / spinner。多分支动作走下方 DropdownMenu。──
  const isJoined = state === 'connected' || state === 'key-ready';
  const spinning = state === 'logging-in' || connecting;
  const joinedTag =
    state === 'connected' ? (
      <span className="nd-mesh-joined-tag">
        {JOINED_CHECK}
        {t('servers.meshJoinedTag', '已接入')}
      </span>
    ) : state === 'key-ready' ? (
      <span className="nd-mesh-joined-tag">
        <KeyRound />
        {t('servers.tsConnCardKeyReady', '已配置 Auth Key')}
      </span>
    ) : null;
  const sub = spinning
    ? t('servers.tsConnCardLoggingIn', '连接中…')
    : state === 'connected'
      ? t('servers.meshTsManageSub', '设置 · 登出 / 切换账户')
      : state === 'key-ready'
        ? t('servers.meshTsKeyReadySub', '设置 · 删除')
        : t('servers.meshTsAddSub', '交互登录 / AuthKey');

  const trigger = (
    <button
      type="button"
      className={cn('nd-mesh-btn', isJoined && 'is-joined')}
      title={t('servers.meshTsEntryTitle', 'Tailscale 组网接入与账户管理')}
    >
      <span className="nd-mesh-ic">
        {spinning ? <Loader2 className="h-[17px] w-[17px] animate-spin" /> : TS_ICON}
      </span>
      <span className="nd-mesh-tx">
        <span className="nd-mesh-hd">
          <span className="nd-mesh-nm">Tailscale</span>
          {joinedTag}
        </span>
        <span className="nd-mesh-sub">{sub}</span>
      </span>
      {MESH_CHEV}
    </button>
  );

  // 按态给出 DropdownMenu 项：新增 / 登录中 / 已连接 / key-ready 各自的动作集，全部逐字保留。
  const menuItems =
    state === 'no-node' || state === 'needs-login' ? (
      <>
        <DropdownMenuItem disabled={connecting} onClick={() => void handleConnect()}>
          <LinkIcon className="me-2 h-4 w-4" />
          {t('servers.tsConnCardConnect', '连接 Tailscale')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            setShowKeyForm(true);
            setSettingsOpen(true);
          }}
        >
          <KeyRound className="me-2 h-4 w-4" />
          {t('servers.tsConnCardUseAuthKey', '用 Auth Key')}
        </DropdownMenuItem>
      </>
    ) : state === 'logging-in' ? (
      <>
        {tsNode && (
          <DropdownMenuItem onClick={() => openTailscaleLogin(tsNode, authUrl)}>
            <LinkIcon className="me-2 h-4 w-4" />
            {t('servers.tsConnCardOpenLogin', '打开登录页')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => void handleCancel()}>
          {t('servers.tsConnCardCancel', '取消')}
        </DropdownMenuItem>
      </>
    ) : state === 'connected' ? (
      <>
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
      </>
    ) : (
      // key-ready
      <>
        <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
          <Settings className="me-2 h-4 w-4" />
          {t('servers.tsConnCardSettings', '设置')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setDeleteOpen(true)}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="me-2 h-4 w-4" />
          {t('servers.tsConnCardDelete', '删除')}
        </DropdownMenuItem>
      </>
    );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align="end">{menuItems}</DropdownMenuContent>
      </DropdownMenu>

      {/* 设置 / 用 Auth Key：复用 TailscaleForm（账号制无地址端口，连后配置）。onSubmit 统一 saveServer。 */}
      <Dialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) setShowKeyForm(false);
        }}
      >
        {/* 宽度对齐「节点编辑」窗（server-config-dialog 的 w-[min(452px,94vw)]）：出口设备/子网/高级均单列窄字段，
            原 max-w-3xl(768) 一倍宽显空旷（用户反馈过大）。max-h/overflow/标准 padding 保留。 */}
        <DialogContent className="w-[min(452px,94vw)] max-w-none max-h-[90vh] overflow-y-auto">
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

      {/* key-ready 删除确认：先登出再删节点，高危故二次确认（受控，从下拉菜单项触发）。 */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
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
              onClick={() => {
                setDeleteOpen(false);
                void handleDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
