import { useState } from 'react';
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
import { Badge } from '@/components/ui/badge';
import { Loader2, Server, Trash2, Pencil, ExternalLink, Plug } from 'lucide-react';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc/api-client';
import type { RemoteInstance, UserConfig } from '@shared/types';
import { useTranslation } from 'react-i18next';
import { SettingsRow } from './settings-row';

/**
 * 远程实例管理（sing-box 1.14 远程控制，P5 Phase2）：增删改 + 连通测试 + 打开远端面板。
 * secret 渲染端只写不读——列表只显「已设置/未设置」(hasSecret)；编辑时 secret 输入留空 = 保持原值，填新值 = 更新。
 * 保存经 saveConfig→CONFIG_SAVE：main 合并回已存 secret（防被清零）+ validateConfig sanitize 非法实例。
 */
type DraftInstance = {
  id: string;
  name: string;
  host: string;
  port: string; // 输入态用字符串，保存时转 number
  secret: string;
  tlsEnabled: boolean;
  skipVerify: boolean;
  ca: string;
  dashboardUrl: string;
  hasSecret: boolean; // 编辑既有实例时 main 给的占位，决定 secret 输入 placeholder
};

function emptyDraft(): DraftInstance {
  return {
    id: crypto.randomUUID(),
    name: '',
    host: '',
    port: '',
    secret: '',
    tlsEnabled: true, // 远程强制 TLS（默认开，见 dashboard-remote.md §2.4）
    skipVerify: false,
    ca: '',
    dashboardUrl: '',
    hasSecret: false,
  };
}

function instanceToDraft(inst: RemoteInstance): DraftInstance {
  return {
    id: inst.id,
    name: inst.name,
    host: inst.host,
    port: String(inst.port),
    secret: '', // 永不回填明文：留空=保持原值
    tlsEnabled: inst.tls !== undefined,
    skipVerify: inst.tls?.skipVerify === true,
    ca: inst.tls?.ca || '',
    dashboardUrl: inst.dashboardUrl || '',
    hasSecret: inst.hasSecret === true,
  };
}

export function RemoteInstancesSection() {
  const config = useAppStore((s) => s.config);
  const saveConfig = useAppStore((s) => s.saveConfig);
  const { t } = useTranslation();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<DraftInstance>(emptyDraft());
  const [editing, setEditing] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  if (!config) return null;
  const instances = config.remoteInstances || [];

  const openAdd = () => {
    setDraft(emptyDraft());
    setEditing(false);
    setDialogOpen(true);
  };

  const openEdit = (inst: RemoteInstance) => {
    setDraft(instanceToDraft(inst));
    setEditing(true);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const name = draft.name.trim();
    const host = draft.host.trim();
    const port = Number(draft.port);
    if (!name || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
      toast.error(t('settings.remoteInstances.invalidFields'));
      return;
    }
    const inst: RemoteInstance = {
      id: draft.id,
      name,
      host,
      port,
      dashboardUrl: draft.dashboardUrl.trim() || undefined,
    };
    if (draft.tlsEnabled) {
      inst.tls = {
        ca: draft.ca.trim() || undefined,
        skipVerify: draft.skipVerify || undefined,
      };
    }
    // secret：填了新值 → 带上（main 用新值）；留空 → 不带（main 沿用已存 secret，新增则免认证）。
    if (draft.secret !== '') inst.secret = draft.secret;

    const list = instances.filter((i) => i.id !== draft.id);
    const next: UserConfig = { ...config, remoteInstances: [...list, inst] };
    try {
      await saveConfig(next);
      setDialogOpen(false);
      toast.success(t('settings.remoteInstances.saved'));
    } catch {
      toast.error(t('common.saveFailed'));
    }
  };

  const handleDelete = async (id: string) => {
    const next: UserConfig = {
      ...config,
      remoteInstances: instances.filter((i) => i.id !== id),
      activeInstanceId: config.activeInstanceId === id ? undefined : config.activeInstanceId,
    };
    try {
      await saveConfig(next);
      toast.success(t('settings.remoteInstances.saved'));
    } catch {
      toast.error(t('common.saveFailed'));
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const r = await api.app.testRemoteInstance(id);
      if (r.ok) toast.success(t('settings.remoteInstances.testOk'));
      else toast.error(t('settings.remoteInstances.testFail', { error: r.error || '' }));
    } catch (e) {
      toast.error(
        t('settings.remoteInstances.testFail', {
          error: e instanceof Error ? e.message : String(e),
        })
      );
    } finally {
      setTestingId(null);
    }
  };

  const handleOpenDashboard = async (id: string) => {
    const r = await api.app.openRemoteDashboard(id).catch(() => ({ ok: false }));
    if (!r.ok) toast.error(t('settings.remoteInstances.openFail'));
  };

  return (
    <>
      <SettingsRow heading label={t('settings.remoteInstances.title')} />
      <SettingsRow
        label={t('settings.remoteInstances.title')}
        description={t('settings.remoteInstances.desc')}
        tooltip={t('settings.remoteInstances.tooltip')}
      >
        <Button variant="outline" size="sm" onClick={openAdd}>
          {t('settings.remoteInstances.add')}
        </Button>
      </SettingsRow>

      {instances.length > 0 && (
        <div className="space-y-2 py-3">
          {instances.map((inst) => (
            <div
              key={inst.id}
              className="flex items-center gap-2 rounded-md border bg-muted/30 p-2"
            >
              <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{inst.name}</span>
                  {inst.tls && (
                    <Badge variant="outline" className="text-xs">
                      TLS
                    </Badge>
                  )}
                  {!inst.hasSecret && (
                    <Badge variant="secondary" className="text-xs">
                      {t('settings.remoteInstances.noSecret')}
                    </Badge>
                  )}
                </div>
                <span className="font-mono text-xs text-muted-foreground">
                  {inst.host}:{inst.port}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 shrink-0 p-0"
                title={t('settings.remoteInstances.test')}
                disabled={testingId === inst.id}
                onClick={() => handleTest(inst.id)}
              >
                {testingId === inst.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plug className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 shrink-0 p-0"
                title={t('settings.remoteInstances.openDashboard')}
                onClick={() => handleOpenDashboard(inst.id)}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 shrink-0 p-0"
                title={t('common.edit')}
                onClick={() => openEdit(inst)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 shrink-0 p-0 text-destructive hover:text-destructive"
                title={t('common.delete')}
                onClick={() => handleDelete(inst.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t('settings.remoteInstances.editTitle')
                : t('settings.remoteInstances.addTitle')}
            </DialogTitle>
            <DialogDescription>{t('settings.remoteInstances.dialogDesc')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ri-name">{t('settings.remoteInstances.name')}</Label>
              <Input
                id="ri-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2 space-y-2">
                <Label htmlFor="ri-host">{t('settings.remoteInstances.host')}</Label>
                <Input
                  id="ri-host"
                  placeholder="example.com"
                  value={draft.host}
                  onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ri-port">{t('settings.remoteInstances.port')}</Label>
                <Input
                  id="ri-port"
                  inputMode="numeric"
                  placeholder="9090"
                  value={draft.port}
                  onChange={(e) => setDraft({ ...draft, port: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ri-secret">{t('settings.remoteInstances.secret')}</Label>
              <Input
                id="ri-secret"
                type="password"
                autoComplete="new-password"
                placeholder={
                  draft.hasSecret
                    ? t('settings.remoteInstances.secretKeepPlaceholder')
                    : t('settings.remoteInstances.secretPlaceholder')
                }
                value={draft.secret}
                onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label>{t('settings.remoteInstances.tls')}</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t('settings.remoteInstances.tlsDesc')}
                </p>
              </div>
              <Switch
                checked={draft.tlsEnabled}
                onCheckedChange={(v) => setDraft({ ...draft, tlsEnabled: v })}
              />
            </div>

            {draft.tlsEnabled && (
              <>
                <div className="flex items-center justify-between">
                  <div>
                    <Label>{t('settings.remoteInstances.skipVerify')}</Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t('settings.remoteInstances.skipVerifyDesc')}
                    </p>
                  </div>
                  <Switch
                    checked={draft.skipVerify}
                    onCheckedChange={(v) => setDraft({ ...draft, skipVerify: v })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ri-ca">{t('settings.remoteInstances.ca')}</Label>
                  <Input
                    id="ri-ca"
                    placeholder={t('settings.remoteInstances.caPlaceholder')}
                    value={draft.ca}
                    onChange={(e) => setDraft({ ...draft, ca: e.target.value })}
                  />
                </div>
              </>
            )}

            <div className="space-y-2">
              <Label htmlFor="ri-dashboard">{t('settings.remoteInstances.dashboardUrl')}</Label>
              <Input
                id="ri-dashboard"
                placeholder={t('settings.remoteInstances.dashboardUrlPlaceholder')}
                value={draft.dashboardUrl}
                onChange={(e) => setDraft({ ...draft, dashboardUrl: e.target.value })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSave}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
