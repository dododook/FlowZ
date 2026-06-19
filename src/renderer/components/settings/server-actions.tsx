/**
 * 节点操作按钮组（测速/延迟徽标/复制分享/克隆/编辑/删除）—— 卡片视图与列表视图共用。
 * 从 server-list.tsx 的 renderActions 抽出（审计 §1 Tier-1），JSX 字节级保留；
 * 原闭包引用的 handler 经 props 注入，调用点逐字不变。
 */
import { Button } from '@/components/ui/button';
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
import {
  hasShareLink,
  getLatencyColor,
  getLatencyBg,
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
  latencyMap,
  onSingleSpeedTest,
  onCopyShareUrl,
  onCloneServer,
  onEditServer,
  onDelete,
}: ServerActionsProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1 flex-shrink-0">
      <Button
        variant="ghost"
        size="sm"
        title={t('servers.speedTest')}
        className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
        disabled={testingServerIds.has(server.id) || isTestingSpeed}
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          onSingleSpeedTest(server.id, e);
        }}
      >
        <Zap
          className={`h-3.5 w-3.5 ${testingServerIds.has(server.id) ? 'animate-pulse text-primary fill-primary/20' : ''}`}
        />
      </Button>

      {latencyMap[server.id] !== undefined && (
        <span
          className={`text-xs font-medium mr-1 px-1.5 py-0.5 rounded ${getLatencyColor(latencyMap[server.id])} ${getLatencyBg(latencyMap[server.id])}`}
        >
          {latencyMap[server.id] === -1 ? t('servers.timeout') : `${latencyMap[server.id]} ms`}
        </span>
      )}
      {/* 无分享链接的协议(ProtocolParser.generateUrl 无对应分支)隐藏复制按钮 */}
      {hasShareLink(server.protocol) && (
        <Button
          variant="ghost"
          size="sm"
          title={t('servers.copyShareUrl')}
          className="h-7 w-7 p-0"
          onClick={(e) => onCopyShareUrl(server, e)}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
      )}
      {onCloneServer && (
        <Button
          variant="ghost"
          size="sm"
          title={t('servers.cloneToManual', 'Clone to Manual Nodes')}
          className="h-7 w-7 p-0"
          onClick={(e) => {
            if (stopPropagation) e.stopPropagation();
            onCloneServer(server);
          }}
        >
          <CopyPlus className="h-3.5 w-3.5" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        title={t('common.edit')}
        className="h-7 w-7 p-0"
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          onEditServer(server);
        }}
      >
        <Edit className="h-3.5 w-3.5" />
      </Button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={!!server.subscriptionId}
            onClick={(e) => {
              if (stopPropagation) e.stopPropagation();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
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
    </div>
  );
}
