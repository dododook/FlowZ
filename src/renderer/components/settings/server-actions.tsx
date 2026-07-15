/**
 * 节点操作按钮组（测速 / 复制分享 / 克隆 / 编辑 / 删除）—— Conduit `.nd-acts` / `.nd-act` 形态，
 * 卡片视图与列表视图共用，默认常显，避免用户需要 hover 才能发现操作入口。
 * handler 经 props 注入，调用点逐字不变；删除仍走 radix AlertDialog 二次确认（行为保留）。
 */
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
import { Edit, Trash2, Copy, CopyPlus, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isSpeedTestable, isEndpointProtocol } from '../../../shared/endpoint-routes';
import { ActionTip } from '../ui/tooltip';
import { useAppStore } from '../../store/app-store';
import {
  hasShareLink,
  type ServerConfigWithId,
  type ServerActionsContext,
} from './server-list-helpers';

interface ServerActionsProps extends ServerActionsContext {
  server: ServerConfigWithId;
  stopPropagation?: boolean;
}

export function ServerActions({
  server,
  stopPropagation = true,
  testingServerIds,
  isTestingSpeed,
  onSingleSpeedTest,
  onCopyShareUrl,
  onCloneServer,
  onEditServer,
  onDelete,
}: ServerActionsProps) {
  const { t } = useTranslation();
  // 不可测节点（reverseMesh / 自定义 endpoint / 无 exitNode 或未登录 TS）：**隐藏 ⚡** + 测速徽标显「不支持测速」，与
  // 后端口径同（isSpeedTestable path-aware 单一真值）。§16.1：TS-exit 仅代理运行（主核池可用）时可 ⚡。
  const proxyRunning = useAppStore((s) => !!s.connectionStatus?.proxyCore?.running);
  const testable = isSpeedTestable(server, { mainCorePool: proxyRunning });
  return (
    <div className="nd-acts">
      {testable && (
        <ActionTip label={t('servers.speedTest')}>
          {/* disabled 按钮不派发 pointer 事件 → tooltip 不弹；用 inline-flex span 承接 hover（参 unlock-inline.tsx:117）。 */}
          <span className="inline-flex">
            <button
              type="button"
              className="nd-act speed"
              aria-label={t('servers.speedTest')}
              disabled={testingServerIds.has(server.id) || isTestingSpeed}
              onClick={(e) => {
                if (stopPropagation) e.stopPropagation();
                onSingleSpeedTest(server.id, e);
              }}
            >
              <Zap
                className={testingServerIds.has(server.id) ? 'animate-pulse fill-primary/20' : ''}
              />
            </button>
          </span>
        </ActionTip>
      )}
      {/* 无分享链接的协议(ProtocolParser.generateUrl 无对应分支)隐藏复制按钮 */}
      {hasShareLink(server.protocol) && (
        <ActionTip label={t('servers.copyShareUrl')}>
          <button
            type="button"
            className="nd-act"
            aria-label={t('servers.copyShareUrl')}
            onClick={(e) => onCopyShareUrl(server, e)}
          >
            <Copy />
          </button>
        </ActionTip>
      )}
      {/* 组网节点（tailscale/warp/wg endpoint）不显克隆：由 mesh 登录管理、克隆到手动无意义（用户反馈）。 */}
      {onCloneServer && !isEndpointProtocol(server.protocol) && (
        <ActionTip label={t('servers.cloneToManual', 'Clone to Manual Nodes')}>
          <button
            type="button"
            className="nd-act"
            aria-label={t('servers.cloneToManual', 'Clone to Manual Nodes')}
            onClick={(e) => {
              if (stopPropagation) e.stopPropagation();
              onCloneServer(server);
            }}
          >
            <CopyPlus />
          </button>
        </ActionTip>
      )}
      <ActionTip label={t('common.edit')}>
        <button
          type="button"
          className="nd-act"
          aria-label={t('common.edit')}
          onClick={(e) => {
            if (stopPropagation) e.stopPropagation();
            onEditServer(server);
          }}
        >
          <Edit />
        </button>
      </ActionTip>
      {/* 订阅节点不可单独删除（随订阅更新/「删除订阅」统一管理）→ 直接隐藏删除按钮，而非置灰。 */}
      {!server.subscriptionId && (
        <AlertDialog>
          <ActionTip label={t('common.delete')}>
            <AlertDialogTrigger asChild>
              <button
                type="button"
                className="nd-act del"
                aria-label={t('common.delete')}
                onClick={(e) => {
                  if (stopPropagation) e.stopPropagation();
                }}
              >
                <Trash2 />
              </button>
            </AlertDialogTrigger>
          </ActionTip>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('servers.deleteServerTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('servers.deleteServerDesc', { name: server.name })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={(e) => e.stopPropagation()}>
                {t('common.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(server.id);
                }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {t('common.delete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
