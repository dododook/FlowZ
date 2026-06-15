import { useState, useEffect } from 'react';
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
import { ServerSelectGroups } from './server-select-groups';
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
  const { t } = useTranslation();
  const [serverName, setServerName] = useState('');
  const [selectedProtocol, setSelectedProtocol] = useState<ProtocolType>('vless');
  const [currentServerConfig, setCurrentServerConfig] = useState<any>(null);
  const [detour, setDetour] = useState<string | undefined>(undefined);

  const isEditing = !!server;

  useEffect(() => {
    if (open) {
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
    if (!serverName.trim()) {
      throw new Error(t('servers.addressRequired'));
    }

    const serverConfig = {
      name: serverName.trim(),
      detour: detour || undefined,
      ...protocolConfig,
    };

    await onSave(serverConfig);
    onOpenChange(false);
  };

  const handleProtocolChange = (protocol: ProtocolType) => {
    setSelectedProtocol(protocol);
    if (protocol !== currentServerConfig?.protocol) {
      setCurrentServerConfig(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
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
              'This node belongs to a subscription. Your edits will be overwritten on the next update — use "Clone to Manual Nodes" to keep a durable copy.'
            )}
          </div>
        )}

        <div className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="serverName">{t('servers.remarks')}</Label>
            <Input
              id="serverName"
              placeholder={t('servers.remarksPlaceholder')}
              value={serverName}
              onChange={(e) => setServerName(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">{t('servers.remarksDesc')}</p>
          </div>

          <div className="space-y-2">
            <Label>{t('servers.protocol')}</Label>
            <Select value={selectedProtocol} onValueChange={handleProtocolChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vless">VLESS</SelectItem>
                <SelectItem value="trojan">Trojan</SelectItem>
                <SelectItem value="hysteria2">Hysteria2</SelectItem>
                <SelectItem value="shadowsocks">Shadowsocks</SelectItem>
                <SelectItem value="anytls">AnyTLS</SelectItem>
                <SelectItem value="tuic">TUIC</SelectItem>
                <SelectItem value="vmess">VMess</SelectItem>
                <SelectItem value="naive">NaiveProxy</SelectItem>
                <SelectItem value="socks">SOCKS5</SelectItem>
                <SelectItem value="http">HTTP(S)</SelectItem>
                <SelectItem value="ssh">SSH</SelectItem>
                <SelectItem value="wireguard">WireGuard</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {t('servers.selectProtocol', 'Select your proxy server protocol')}
            </p>
          </div>

          <div className="space-y-2">
            <Label>{t('servers.detour', 'Proxy Chain (Detour)')}</Label>
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
                  excludeProtocols={['wireguard']}
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
          </div>

          <div className="border-t pt-6">
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
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
