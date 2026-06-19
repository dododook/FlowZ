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
import { Loader2, Link as LinkIcon, Edit, Activity } from 'lucide-react';
import type { SubscriptionConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';
import { formatBytes } from '@/lib/format';
import { getVersionInfo } from '@/bridge/api-wrapper';

interface SubscriptionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscription?: SubscriptionConfig;
  onSave: (subscription: Omit<SubscriptionConfig, 'id' | 'createdAt'>) => Promise<void>;
}

export function SubscriptionDialog({
  open,
  onOpenChange,
  subscription,
  onSave,
}: SubscriptionDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [autoUpdate, setAutoUpdate] = useState(true); // 新增订阅默认开启自动更新（否则「启动自动更新」总开关无意义）
  const [userAgent, setUserAgent] = useState('');
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
      } else {
        setName('');
        setUrl('');
        setAutoUpdate(true); // 新增订阅默认开启自动更新（否则「启动自动更新」总开关无意义）
        setUserAgent('');
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
            <Label htmlFor="sub-user-agent">{t('sub.userAgent')}</Label>
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
