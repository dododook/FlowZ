/**
 * 节点操作按钮组（测速 / 复制分享 / 克隆 / 编辑 / 删除）—— Conduit `.nd-acts` / `.nd-act` 形态，
 * 卡片视图与列表视图共用，hover/focus 显现（CSS `.nd-card:hover .nd-acts`）。
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
import {
  hasShareLink,
  type ServerConfigWithId,
  type ServerActionsContext,
} from './server-list-helpers';

interface ServerActionsProps extends ServerActionsContext {
  server: ServerConfigWithId;
  stopPropagation?: boolean;
}

// 操作按钮（卡片和列表模式共用）
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
  // 不可测节点（Tailscale / 自定义 endpoint / reverseMesh）：**隐藏 ⚡**（不再 disabled 占位致歧义）+ 测速徽标显
  // 「不支持测速」，与后端 buildSpeedTestOutbound / 统一测速排除同口径（isSpeedTestable 单一真值）。
  const testable = isSpeedTestable(server);
  return (
    <div className="nd-acts">
      {testable && (
        <button
          type="button"
          className="nd-act speed"
          title={t('servers.speedTest')}
          disabled={testingServerIds.has(server.id) || isTestingSpeed}
          onClick={(e) => {
            if (stopPropagation) e.stopPropagation();
            onSingleSpeedTest(server.id, e);
          }}
        >
          <Zap className={testingServerIds.has(server.id) ? 'animate-pulse fill-primary/20' : ''} />
        </button>
      )}
      {/* 无分享链接的协议(ProtocolParser.generateUrl 无对应分支)隐藏复制按钮 */}
      {hasShareLink(server.protocol) && (
        <button
          type="button"
          className="nd-act"
          title={t('servers.copyShareUrl')}
          onClick={(e) => onCopyShareUrl(server, e)}
        >
          <Copy />
        </button>
      )}
      {/* 组网节点（tailscale/warp/wg endpoint）不显克隆：由 mesh 登录管理、克隆到手动无意义（用户反馈）。 */}
      {onCloneServer && !isEndpointProtocol(server.protocol) && (
        <button
          type="button"
          className="nd-act"
          title={t('servers.cloneToManual', 'Clone to Manual Nodes')}
          onClick={(e) => {
            if (stopPropagation) e.stopPropagation();
            onCloneServer(server);
          }}
        >
          <CopyPlus />
        </button>
      )}
      <button
        type="button"
        className="nd-act"
        title={t('common.edit')}
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          onEditServer(server);
        }}
      >
        <Edit />
      </button>
      {/* 订阅节点不可单独删除（随订阅更新/「删除订阅」统一管理）→ 直接隐藏删除按钮，而非置灰。 */}
      {!server.subscriptionId && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button
              type="button"
              className="nd-act del"
              title={t('common.delete')}
              onClick={(e) => {
                if (stopPropagation) e.stopPropagation();
              }}
            >
              <Trash2 />
            </button>
          </AlertDialogTrigger>
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
