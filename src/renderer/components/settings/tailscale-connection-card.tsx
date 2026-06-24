/**
 * Tailscale 单例「连接」卡（组网 tab 顶部，批3）。
 *
 * 把 Tailscale 从「可添加多次的代理节点」抽离为组网里的单例连接区——TS 是账号制设备身份（登录即入网），
 * 不该套代理节点（地址/端口/保存/编辑）模型。数据层不变（仍是 servers[] 里的 ServerConfig），仅 UI 抽离。
 *
 * 状态用 shared/tailscale-conn-state.deriveTsCardState 派生（5 态，已单测）：
 *  - no-node / needs-login → 「连接 Tailscale」（无节点先 add 默认节点再 login；有节点直接 login）+「用 Auth Key」展开；
 *  - logging-in            → 「连接中…已开授权页」+ spinner +「取消」；
 *  - connected             → 「已连接 · 设备名 · 内网 IP（代理开时）」/「已登录（上次）」+「设置」+「断开」；
 *  - key-ready             → 「已配置 Auth Key · 代理启动即连」+「设置」+「删除」。
 *
 * 复用现成 api：连接=api.server.add(+runTailscaleLogin)、断开=tailscaleLogout、删除=tailscaleLogout+delete、
 * 取消=tailscaleLoginCancel。设置=复用 TailscaleForm（包进 Dialog），onSubmit 走 useServerActions().saveServer。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, Link as LinkIcon, KeyRound, Settings, Plug, Trash2 } from 'lucide-react';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { runTailscaleLogin } from '../../lib/tailscale-login';
import { TailscaleForm } from './tailscale-form';
import { useServerActions } from '../../pages/use-server-actions';
import { MeshInfoPopover } from './mesh-info-popover';

interface TailscaleConnectionCardProps {
  /** 当前唯一的 Tailscale 节点（单例硬限保证至多一个）；无则渲染「连接」入口态。 */
  tsNode: ServerConfig | undefined;
  /** 代理是否运行——决定副标题文案（已连接·实时 IP vs 已登录·上次），不进状态派生。 */
  proxyRunning: boolean;
}

export function TailscaleConnectionCard({ tsNode, proxyRunning }: TailscaleConnectionCardProps) {
  const { t } = useTranslation();
  const { saveServer, deleteServer, selectServer } = useServerActions();

  const serverId = tsNode?.id;
  // 综合登录态（缓存初值 + state 文件兜底 + STATUS 实时校正已在 app-store 融合，单一布尔即真值）。
  const loggedIn = useAppStore((s) => (serverId ? !!s.tailscaleLoginStates[serverId] : false));
  // 登录中：已产生 authUrl（瞬态核在等浏览器授权）且未登录成功。
  const hasAuthUrl = useAppStore((s) =>
    serverId ? s.tailscaleAuthUrls[serverId] !== undefined : false
  );
  const setTailscaleLoginState = useAppStore((s) => s.setTailscaleLoginState);
  // 当前主出口是否为本 TS 节点（selectedServerId 单一真值）：单例卡承载「设为出口/当前出口」——批3 把 TS 抽离
  // 列表后，这是登录后选 TS 作主出口的唯一入口（列表点击选中入口已随抽离丢失，否则登录了也用不上 TS 出口）。
  const selectedServerId = useAppStore((s) => s.config?.selectedServerId);
  const isSelectedExit = !!serverId && selectedServerId === serverId;

  const [showKeyForm, setShowKeyForm] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const state = deriveTsCardState(tsNode, loggedIn, hasAuthUrl);

  // 设置弹窗里编辑（含填 Auth Key）→ 复用 TailscaleForm，统一走 saveServer（editingServer=现有 TS 节点）。
  // config 形状由 TailscaleForm 产出（{protocol:'tailscale', tailscaleSettings}），name 由现有节点带或默认。
  const handleSaveSettings = async (config: { protocol: string; tailscaleSettings?: unknown }) => {
    await saveServer(
      { name: tsNode?.name || 'Tailscale', ...config } as Parameters<typeof saveServer>[0],
      tsNode
    );
    setSettingsOpen(false);
    setShowKeyForm(false);
  };

  // 「连接 Tailscale」：无节点先建默认 TS 节点拿 id，再交互登录；有节点直接交互登录。
  // 建节点必须走 saveServer（经 app-store saveConfig 刷新 renderer config，卡片 tsNode 才会出现、登录态对得上 id；
  // 且自带 tailscaleSlotTaken 闸门）——不能用 api.server.add（不刷新 renderer + handler 返回 void → node=undefined）。
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
            tailscaleSettings: { allowInternet: true, alwaysRouteSubnets: true },
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

  const handleCancel = async () => {
    if (!serverId) return;
    try {
      await api.server.tailscaleLoginCancel(serverId);
    } catch {
      /* 取消失败不阻断：authUrl 会随核退出被清，UI 自然回落 */
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

  // 设为主出口：把本 TS 节点设为 selectedServerId（全局出口）。出口语义（exit node / 回退 direct）在「设置」里配。
  const handleSelectExit = async () => {
    if (!serverId) return;
    await selectServer(serverId);
  };

  // 「设为出口 / 当前出口」片段（connected 与 key-ready 态共用）：已是主出口显徽章，否则给「设为出口」按钮。
  const exitAction = isSelectedExit ? (
    <span className="inline-flex items-center gap-1 rounded-md bg-success/15 px-2.5 py-1 text-sm text-success">
      <Check className="h-4 w-4" />
      {t('servers.tsConnCardCurrentExit', '当前出口')}
    </span>
  ) : (
    <Button size="sm" variant="outline" onClick={() => void handleSelectExit()}>
      {t('servers.tsConnCardSetExit', '设为出口')}
    </Button>
  );

  return (
    <Card className="border-primary/20">
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <LinkIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 font-medium">
              Tailscale
              {state === 'connected' && (
                <span className="inline-flex items-center gap-1 text-sm text-success">
                  <Check className="h-4 w-4" />
                  {proxyRunning
                    ? t('servers.tsConnCardConnected', '已连接')
                    : t('servers.tsConnCardLoggedInPast', '已登录（上次）')}
                </span>
              )}
              {state === 'key-ready' && (
                <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                  <KeyRound className="h-3.5 w-3.5" />
                  {t('servers.tsConnCardKeyReady', '已配置 Auth Key')}
                </span>
              )}
            </p>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <span className="truncate">
                {state === 'connected' && tsNode
                  ? tsNode.name
                  : state === 'key-ready'
                    ? t('servers.tsConnCardKeyReadyDesc', '代理启动即自动连接，无需登录')
                    : state === 'logging-in'
                      ? t('servers.tsConnCardLoggingInDesc', '已在浏览器打开授权页，完成后自动连接')
                      : t('servers.tsConnCardIntro', '账号制组网：登录后本机即加入你的 tailnet')}
              </span>
              {/* 组网信息收进 ⓘ（与列表节点同款，hover 弹内网 IP/路由/出口节点/接受子网路由），卡片不被信息撑大。 */}
              {(state === 'connected' || state === 'key-ready') && tsNode && (
                <MeshInfoPopover server={tsNode} />
              )}
            </p>
          </div>
        </div>

        <div className="flex flex-shrink-0 flex-col items-stretch gap-2 sm:items-end">
          {(state === 'no-node' || state === 'needs-login') && (
            <div className="flex flex-wrap gap-2 sm:justify-end">
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
            </div>
          )}

          {state === 'logging-in' && (
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('servers.tsConnCardLoggingIn', '连接中…')}
              </span>
              <Button size="sm" variant="outline" onClick={() => void handleCancel()}>
                {t('servers.tsConnCardCancel', '取消')}
              </Button>
            </div>
          )}

          {state === 'connected' && (
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {exitAction}
              <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
                <Settings className="me-2 h-4 w-4" />
                {t('servers.tsConnCardSettings', '设置')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void handleDisconnect()}>
                <Plug className="me-2 h-4 w-4" />
                {t('servers.tsConnCardDisconnect', '断开')}
              </Button>
            </div>
          )}

          {state === 'key-ready' && (
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {exitAction}
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
            </div>
          )}
        </div>
      </CardContent>

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
    </Card>
  );
}
