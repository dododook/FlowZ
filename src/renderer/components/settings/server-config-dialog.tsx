import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { VlessForm } from './vless-form';
import { TrojanForm } from './trojan-form';
import { Hysteria2Form } from './hysteria2-form';
import { SsForm } from './ss-form';
import { AnyTlsForm } from './anytls-form';
import { TuicForm } from './tuic-form';
import { NaiveForm } from './naive-form';
import { VmessForm } from './vmess-form';
import { SocksForm } from './socks-form';
import { HttpForm } from './http-form';
import { SshForm } from './ssh-form';
import { WireGuardForm } from './wireguard-form';
import { TailscaleForm } from './tailscale-form';
import { CustomForm } from './custom-form';
import { WarpPanel } from './warp-panel';
import { ServerSelectGroups } from './server-select-groups';
import { FormSection } from './shared/form-layout';
import { getSortedProtocolOptions } from './shared/protocol-options';
import { ENDPOINT_PROTOCOLS } from '../../../shared/endpoint-routes';
import type { ServerConfig, ProtocolType } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

type ServerConfigWithId = ServerConfig;

interface ServerConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server?: ServerConfigWithId;
  servers?: ServerConfigWithId[];
  onSave: (
    serverConfig: Omit<ServerConfigWithId, 'id' | 'createdAt' | 'updatedAt'>
  ) => Promise<void>;
}

export function ServerConfigDialog({
  open,
  onOpenChange,
  server,
  servers = [],
  onSave,
}: ServerConfigDialogProps) {
  const { t, i18n } = useTranslation();
  const [serverName, setServerName] = useState('');
  // 'warp' 是 UI 伪协议（仅新增流的一键 WARP 入口，不进 PROTOCOL_OPTIONS/协议枚举）；选它渲染 WarpPanel，
  // 实际保存的是普通 wireguard 节点。
  const [selectedProtocol, setSelectedProtocol] = useState<ProtocolType | 'warp'>('vless');
  const [currentServerConfig, setCurrentServerConfig] = useState<any>(null);
  const [detour, setDetour] = useState<string | undefined>(undefined);
  const [nameError, setNameError] = useState('');

  const isEditing = !!server;

  // 重名软检测（非阻塞）：与其它节点同名时给琥珀提示，但不拦保存——后端 generateSingBoxConfig 用
  // getUniqueTag 自动去重 tag（重名不破功能/切换），且订阅天然有同名节点，硬拦会误伤。排除自身（编辑不改名不报）。
  const trimmedName = serverName.trim();
  const isDuplicateName =
    !!trimmedName && servers.some((s) => s.id !== server?.id && s.name.trim() === trimmedName);

  useEffect(() => {
    if (open) {
      setNameError('');
      if (server) {
        setServerName(server.name);
        const normalizedProtocol = server.protocol.toLowerCase() as ProtocolType;
        setSelectedProtocol(normalizedProtocol);
        setCurrentServerConfig(server);
        setDetour(server.detour);
      } else {
        setServerName('');
        setSelectedProtocol('vless');
        setCurrentServerConfig(null);
        setDetour(undefined);
      }
    }
  }, [server, open]);

  const handleSave = async (protocolConfig: any) => {
    // 备注必填：协议表单字段由各自 zod 校验(红字)，但备注是 dialog 级 state、不在表单内——
    // 此处显式校验并就地报错(红框+红字)，杜绝「未填备注 → 保存静默失败、无任何提示」。
    if (!serverName.trim()) {
      setNameError(t('servers.nameRequired', 'Name is required'));
      return;
    }
    setNameError('');

    const serverConfig = {
      name: serverName.trim(),
      detour: detour || undefined,
      ...protocolConfig,
    };

    try {
      await onSave(serverConfig);
      onOpenChange(false);
    } catch (e) {
      // 后端保存失败也要可见（原先 throw 被表单 submit 吞掉、无提示）。
      toast.error(t('servers.saveFailed', 'Failed to save'), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleProtocolChange = (protocol: string) => {
    setSelectedProtocol(protocol as ProtocolType | 'warp');
    // WARP 一键入口：预填默认节点名（仅名称空时），使 WarpPanel 生成后 handleSave 不因缺名失败。
    if (protocol === 'warp') {
      if (!serverName.trim()) setServerName('Cloudflare WARP');
      setCurrentServerConfig(null);
      return;
    }
    if (protocol !== currentServerConfig?.protocol) {
      setCurrentServerConfig(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? t('servers.editServer', 'Edit Server Config')
              : t('servers.addServerConfig', 'Add Server Config')}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? t(
                  'servers.editServerDesc',
                  'Modify server configuration. Proxy will not restart automatically after saving.'
                )
              : t(
                  'servers.addServerDesc',
                  'Add a new proxy server. Supports VLESS, Trojan, Hysteria2, Shadowsocks, AnyTLS.'
                )}
          </DialogDescription>
        </DialogHeader>

        {isEditing && server?.subscriptionId && (
          <div className="rounded-md border border-amber-300/50 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-400">
            {t(
              'servers.subNodeEditHint',
              'This node belongs to a subscription; edits are overwritten on the next update. For lasting changes, use "Clone to Manual Nodes".'
            )}
          </div>
        )}

        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="serverName">{t('servers.remarks')}</Label>
              <Input
                id="serverName"
                placeholder={t('servers.remarksPlaceholder')}
                value={serverName}
                onChange={(e) => {
                  setServerName(e.target.value);
                  if (nameError) setNameError('');
                }}
                className={nameError ? 'border-destructive focus-visible:ring-destructive' : ''}
              />
              {nameError ? (
                <p className="text-sm text-destructive">{nameError}</p>
              ) : isDuplicateName ? (
                <p className="text-sm text-amber-600 dark:text-amber-500">
                  {t('servers.nameDuplicate', 'A node with this name already exists')}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">{t('servers.remarksDesc')}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>{t('servers.protocol')}</Label>
              <Select value={selectedProtocol} onValueChange={handleProtocolChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* WARP 一键入口置顶（仅新增）：用户想用 WARP 会在协议处找它，不必先懂「WARP=WireGuard」。 */}
                  {!isEditing && (
                    <SelectItem value="warp">
                      {t('servers.warpOption', 'Cloudflare WARP (one-click)')}
                    </SelectItem>
                  )}
                  {getSortedProtocolOptions(t, i18n.language).map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">
                {t('servers.selectProtocol', 'Select your proxy server protocol')}
              </p>
            </div>
          </div>

          <div className="border-t pt-6">
            {selectedProtocol === 'warp' && (
              <WarpPanel onSubmit={handleSave} nameMissing={!serverName.trim()} />
            )}
            {selectedProtocol === 'vless' && (
              <VlessForm
                key={currentServerConfig?.id || 'new'}
                serverConfig={
                  currentServerConfig?.protocol?.toLowerCase() === 'vless'
                    ? currentServerConfig
                    : undefined
                }
                onSubmit={handleSave}
              />
            )}
            {selectedProtocol === 'trojan' && (
              <TrojanForm
                key={currentServerConfig?.id || 'new'}
                serverConfig={
                  currentServerConfig?.protocol?.toLowerCase() === 'trojan'
                    ? currentServerConfig
                    : undefined
                }
                onSubmit={handleSave}
              />
            )}
            {selectedProtocol === 'hysteria2' && (
              <Hysteria2Form
                key={currentServerConfig?.id || 'new'}
                serverConfig={
                  currentServerConfig?.protocol?.toLowerCase() === 'hysteria2'
                    ? currentServerConfig
                    : undefined
                }
                onSubmit={handleSave}
              />
            )}
            {selectedProtocol === 'shadowsocks' && (
              <SsForm
                key={currentServerConfig?.id || 'new'}
                serverConfig={
                  currentServerConfig?.protocol?.toLowerCase() === 'shadowsocks'
                    ? currentServerConfig
                    : undefined
                }
                onSubmit={handleSave}
              />
            )}
            {selectedProtocol === 'anytls' && (
              <AnyTlsForm
                key={currentServerConfig?.id || 'new'}
                serverConfig={
                  currentServerConfig?.protocol?.toLowerCase() === 'anytls'
                    ? currentServerConfig
                    : undefined
                }
                onSubmit={handleSave}
              />
            )}
            {selectedProtocol === 'tuic' && (
              <TuicForm
                key={currentServerConfig?.id || 'new'}
                serverConfig={
                  currentServerConfig?.protocol?.toLowerCase() === 'tuic'
                    ? currentServerConfig
                    : undefined
                }
                onSubmit={handleSave}
              />
            )}
            {selectedProtocol === 'naive' && (
              <NaiveForm
                key={currentServerConfig?.id || 'new'}
                serverConfig={
                  currentServerConfig?.protocol?.toLowerCase() === 'naive'
                    ? currentServerConfig
                    : undefined
                }
                onSubmit={handleSave}
              />
            )}
            {selectedProtocol === 'vmess' && (
              <VmessForm
                key={currentServerConfig?.id || 'new'}
                serverConfig={
                  currentServerConfig?.protocol?.toLowerCase() === 'vmess'
                    ? currentServerConfig
                    : undefined
                }
                onSubmit={handleSave}
              />
            )}
            {selectedProtocol === 'socks' && (
              <SocksForm
                key={currentServerConfig?.id || 'new'}
                serverConfig={
                  currentServerConfig?.protocol?.toLowerCase() === 'socks'
                    ? currentServerConfig
                    : undefined
                }
                onSubmit={handleSave}
              />
            )}
            {selectedProtocol === 'http' && (
              <HttpForm
                key={currentServerConfig?.id || 'new'}
                serverConfig={
                  currentServerConfig?.protocol?.toLowerCase() === 'http'
                    ? currentServerConfig
                    : undefined
                }
                onSubmit={handleSave}
              />
            )}
            {selectedProtocol === 'ssh' && (
              <SshForm
                key={currentServerConfig?.id || 'new'}
                serverConfig={
                  currentServerConfig?.protocol?.toLowerCase() === 'ssh'
                    ? currentServerConfig
                    : undefined
                }
                onSubmit={handleSave}
              />
            )}
            {selectedProtocol === 'wireguard' && (
              <WireGuardForm
                key={currentServerConfig?.id || 'new'}
                serverConfig={
                  currentServerConfig?.protocol?.toLowerCase() === 'wireguard'
                    ? currentServerConfig
                    : undefined
                }
                onSubmit={handleSave}
              />
            )}
            {selectedProtocol === 'tailscale' && (
              <TailscaleForm
                key={currentServerConfig?.id || 'new'}
                serverConfig={
                  currentServerConfig?.protocol?.toLowerCase() === 'tailscale'
                    ? currentServerConfig
                    : undefined
                }
                onSubmit={handleSave}
              />
            )}
            {selectedProtocol === 'custom' && (
              <CustomForm
                key={currentServerConfig?.id || 'new'}
                serverConfig={
                  currentServerConfig?.protocol?.toLowerCase() === 'custom'
                    ? currentServerConfig
                    : undefined
                }
                onSubmit={handleSave}
              />
            )}
          </div>

          {/* 前置代理(detour) 收进折叠 opt-in 区：默认关，编辑已有 detour 的节点时默认展开；WG 不作 detour 目标。 */}
          <FormSection
            title={t('servers.detour', 'Proxy Chain (Detour)')}
            collapsible
            defaultOpen={!!server?.detour}
          >
            <Select
              value={detour || 'direct'}
              onValueChange={(v) => setDetour(v === 'direct' ? undefined : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('servers.directConnection', 'Direct (No Chain)')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="direct">
                  {t('servers.directConnection', 'Direct (No Chain)')}
                </SelectItem>
                <ServerSelectGroups
                  servers={servers}
                  excludeId={server?.id}
                  excludeProtocols={ENDPOINT_PROTOCOLS}
                  selectedId={detour}
                />
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {t(
                'servers.detourDesc',
                'Connect to this node through another proxy server (proxy chain)'
              )}
            </p>
          </FormSection>
        </div>
      </DialogContent>
    </Dialog>
  );
}
