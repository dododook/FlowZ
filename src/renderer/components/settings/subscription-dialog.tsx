import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Loader2, Link as LinkIcon, Edit, Activity, AlertTriangle } from 'lucide-react';
import type { SubscriptionConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';
import { formatBytes } from '@/lib/format';
import { getVersionInfo } from '@/bridge/api-wrapper';
import { InfoTooltip } from './shared/info-tooltip';

interface SubscriptionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscription?: SubscriptionConfig;
  onSave: (subscription: Omit<SubscriptionConfig, 'id' | 'createdAt'>) => Promise<void>;
  // 全局订阅代理策略：'follow' 时本 per-sub 开关可设；'proxy'/'direct' 时被全局覆盖、置灰。
  subscriptionProxyPolicy?: 'follow' | 'proxy' | 'direct';
}

export function SubscriptionDialog({
  open,
  onOpenChange,
  subscription,
  onSave,
  subscriptionProxyPolicy = 'follow',
}: SubscriptionDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [autoUpdate, setAutoUpdate] = useState(false); // 新增订阅默认【关闭】自动更新：避免订阅刷新带来节点变动触发重启断流，由用户按需手动开启（开启时下方提示重启代价）
  const [userAgent, setUserAgent] = useState('');
  const [updateViaProxy, setUpdateViaProxy] = useState(false); // per-sub 经代理更新（默认关）
  const [appVersion, setAppVersion] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // 取 app 版本以拼出默认 UA placeholder（FlowZ/<版本>），与主进程 defaultSubscriptionUserAgent() 保持一致。
  useEffect(() => {
    if (!open || appVersion) return;
    getVersionInfo()
      .then((res) => {
        if (res.success && res.data?.appVersion) setAppVersion(res.data.appVersion);
      })
      .catch(() => {
        /* 取版本失败：placeholder 退化为 FlowZ/<版本>，不影响保存 */
      });
  }, [open, appVersion]);

  // 默认 UA placeholder：拿到版本用 FlowZ/<版本>，否则占位提示
  const defaultUserAgent = appVersion ? `FlowZ/${appVersion}` : 'FlowZ/<版本>';

  useEffect(() => {
    if (open) {
      if (subscription) {
        setName(subscription.name);
        setUrl(subscription.url);
        setAutoUpdate(subscription.autoUpdate);
        setUserAgent(subscription.userAgent ?? '');
        setUpdateViaProxy(subscription.updateViaProxy ?? false);
      } else {
        setName('');
        setUrl('');
        setAutoUpdate(false); // 新增订阅默认【关闭】自动更新（见上：避免无谓重启断流，按需手动开启）
        setUserAgent('');
        setUpdateViaProxy(false);
      }
    }
  }, [open, subscription]);

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error(t('sub.requireName'));
      return;
    }
    if (!url.trim()) {
      toast.error(t('sub.requireUrl'));
      return;
    }

    try {
      setIsSaving(true);
      const trimmedUa = userAgent.trim();
      await onSave({
        name: name.trim(),
        url: url.trim(),
        autoUpdate,
        // 非空才写入 userAgent；空则不带该字段（落回全局/默认 UA）。
        ...(trimmedUa ? { userAgent: trimmedUa } : {}),
        // 仅 true 才写入（默认关 = 不带字段，落回直连）。
        ...(updateViaProxy ? { updateViaProxy: true } : {}),
      });
      onOpenChange(false);
    } catch {
      // Error is handled by api wrapper
    } finally {
      setIsSaving(false);
    }
  };

  const isEditing = !!subscription;

  // 格式化日期显示
  const formatDate = (timestamp?: number) => {
    if (!timestamp) return t('sub.unknown', 'Unknown');
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isEditing ? <Edit className="h-5 w-5" /> : <LinkIcon className="h-5 w-5" />}
            {isEditing ? t('sub.editTitle') : t('sub.addTitle')}
          </DialogTitle>
          <DialogDescription>{isEditing ? t('sub.editDesc') : t('sub.addDesc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="sub-name">{t('sub.nameLabel')}</Label>
            <Input
              id="sub-name"
              placeholder={t('sub.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sub-url">{t('sub.urlLabel')}</Label>
            <Input
              id="sub-url"
              placeholder="https://example.com/api/v1/client/subscribe?token=xxx"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor="sub-user-agent">{t('sub.userAgent')}</Label>
              <InfoTooltip content={t('sub.userAgentDescFull')} />
            </div>
            <Input
              id="sub-user-agent"
              placeholder={t('sub.userAgentPlaceholder', { ua: defaultUserAgent })}
              value={userAgent}
              onChange={(e) => setUserAgent(e.target.value)}
            />
            <div className="text-[0.8rem] text-muted-foreground">{t('sub.userAgentDesc')}</div>
          </div>

          {/* 流量和到期信息展示 */}
          {isEditing && subscription?.userInfo && (
            <div className="bg-muted/50 rounded-lg p-3 text-sm flex flex-col gap-1.5 border">
              <div className="flex items-center text-muted-foreground gap-1.5 mb-1">
                <Activity className="h-4 w-4" />
                <span className="font-medium text-foreground">{t('sub.planInfo')}</span>
              </div>
              <div className="flex justify-between">
                <span>{t('sub.usedTraffic')}</span>
                <span className="font-medium">
                  {formatBytes(
                    (subscription.userInfo.upload || 0) + (subscription.userInfo.download || 0)
                  )}
                </span>
              </div>
              <div className="flex justify-between">
                <span>{t('sub.totalTraffic')}</span>
                <span className="font-medium">
                  {subscription.userInfo.total === undefined
                    ? t('sub.unknown', 'Unknown')
                    : formatBytes(subscription.userInfo.total)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>{t('sub.expireTime')}</span>
                <span className="font-medium">{formatDate(subscription.userInfo.expire)}</span>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg border p-3 shadow-sm">
            <div className="space-y-0.5">
              <Label htmlFor="sub-auto-update">{t('sub.autoUpdate')}</Label>
              <div className="text-[0.8rem] text-muted-foreground">{t('sub.autoUpdateDesc')}</div>
            </div>
            <Switch id="sub-auto-update" checked={autoUpdate} onCheckedChange={setAutoUpdate} />
          </div>
          {/* 开启自动更新即提示重启代价（订阅刷新带来节点变动会重启代理、短暂断流） */}
          {autoUpdate && (
            <p className="flex items-start gap-1.5 px-1 text-[0.8rem] text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <span>{t('sub.autoUpdateRestartHint')}</span>
            </p>
          )}

          {/* 经代理更新（per-sub）：仅全局策略为「跟随订阅设置」(follow) 时可设；'proxy'/'direct' 被全局覆盖、置灰 */}
          <div className="flex items-center justify-between rounded-lg border p-3 shadow-sm">
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="sub-via-proxy">{t('sub.updateViaProxy', '经代理更新')}</Label>
                <InfoTooltip
                  content={t(
                    'sub.updateViaProxyDescFull',
                    '开启后该订阅经运行中的代理拉取（订阅地址被直连封锁时用）；代理未运行时本轮跳过、就绪后自动补更。仅当「更新与测速」的全局「订阅更新经代理」为「跟随订阅设置」时本开关生效。'
                  )}
                />
              </div>
              <div className="text-[0.8rem] text-muted-foreground">
                {subscriptionProxyPolicy === 'proxy'
                  ? t('sub.updateViaProxyOverrideProxy', '已由全局策略覆盖：全部订阅经代理')
                  : subscriptionProxyPolicy === 'direct'
                    ? t('sub.updateViaProxyOverrideDirect', '已由全局策略覆盖：全部订阅直连')
                    : t(
                        'sub.updateViaProxyDesc',
                        '该订阅经运行中的代理拉取（代理未运行则就绪后补更）'
                      )}
              </div>
            </div>
            <Switch
              id="sub-via-proxy"
              checked={updateViaProxy}
              onCheckedChange={setUpdateViaProxy}
              disabled={subscriptionProxyPolicy !== 'follow'}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t('sub.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {isEditing ? t('sub.saveChange') : t('sub.addAndUpdate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
