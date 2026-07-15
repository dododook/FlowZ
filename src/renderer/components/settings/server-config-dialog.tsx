import { useState, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { X, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { VlessForm } from './vless-form';
import { TrojanForm } from './trojan-form';
import { Hysteria2Form } from './hysteria2-form';
import { SsForm } from './ss-form';
import { AnyTlsForm } from './anytls-form';
import { TuicForm } from './tuic-form';
import { SnellForm } from './snell-form';
import { NaiveForm } from './naive-form';
import { VmessForm } from './vmess-form';
import { SocksForm } from './socks-form';
import { HttpForm } from './http-form';
import { SshForm } from './ssh-form';
import { WireGuardForm } from './wireguard-form';
import { TailscaleForm } from './tailscale-form';
import { CustomForm } from './custom-form';
import { WarpPanel } from './warp-panel';
import { FormSection } from './shared/form-layout';
import { getSortedProtocolOptions } from './shared/protocol-options';
import { isEndpointProtocol } from '../../../shared/endpoint-routes';
import { isWarpServer } from '../../../shared/warp';
import { NodePicker } from '@/components/ui/node-picker';
import { buildServerPickerModel, isPickerCandidate } from '@/components/ui/server-picker-items';
import { useAppStore } from '@/store/app-store';
import type { ServerConfig, ProtocolType } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

type ServerConfigWithId = ServerConfig;

// detour「直连（无链）」哨兵：不与任何节点 uuid 撞；选中即 detour=undefined。
const DETOUR_DIRECT = 'direct';

/**
 * 前置代理(detour)节点选择：直连哨兵置顶+按订阅/自建分组+延迟徽标；排除自身与组网协议(WireGuard/Tailscale 不作前置代理目标)。
 * 独立子组件隔离 latencyMap 订阅，测速期只重渲本下拉、不牵动整弹窗。
 */
function DetourPicker({
  servers,
  excludeId,
  value,
  onSelect,
}: {
  servers: ServerConfig[];
  excludeId?: string;
  value?: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const subscriptions = useAppStore((s) => s.config?.subscriptions || []);
  const latencyMap = useAppStore((s) => s.latencyMap);

  // memo 对齐 rule-dialog / app-rules-card 口径：测速广播只重渲本下拉、输入不变不空跑。
  const { items, groups: pickerGroups } = useMemo(
    () =>
      buildServerPickerModel({
        servers,
        subscriptions,
        latencyMap,
        meshLabel: t('servers.meshNodes', '组网'),
        manualLabel: t('servers.manualNodes', '自建节点'),
        sentinel: {
          id: DETOUR_DIRECT,
          name: t('servers.directConnection', 'Direct (No Chain)'),
          role: 'direct',
        },
        excludeId,
        excludeEndpoint: true,
        withAddress: true,
      }),
    [servers, subscriptions, latencyMap, excludeId, t]
  );

  return (
    <NodePicker
      items={items}
      groups={pickerGroups}
      value={value ?? DETOUR_DIRECT}
      onSelect={onSelect}
      placeholder={t('servers.directConnection', 'Direct (No Chain)')}
      searchPlaceholder={t('common.search', '搜索')}
      ariaLabel={t('servers.detour', 'Proxy Chain (Detour)')}
    />
  );
}

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
  // 保存态：footer 的保存按钮固定在 dialog 底部（不随表单主体滚动），isSubmitting 不再由各表单内按钮承载，
  // 故 dialog 层自持保存态驱动按钮 loading/禁用。
  const [saving, setSaving] = useState(false);

  const isEditing = !!server;
  // 锁协议只针对组网节点（WireGuard/WARP/Tailscale）：协议=组网身份不可变，换协议=删了重建，防止误改成代理协议；
  // 代理/自定义节点编辑时仍可改协议（导入填错等需修正）。
  const isMeshEdit = isEditing && isEndpointProtocol(server?.protocol);
  // WARP 节点底层协议是 wireguard，但触发器显示「Cloudflare WARP」而非「WireGuard」（鲁棒判定，含旧无标记节点）。
  const isWarp = !!server && isWarpServer(server);
  // 组网节点锁定态触发器显示的标签（不依赖 SelectValue/选项项——下拉已不含组网协议）：WARP / Tailscale / WireGuard。
  const meshLockedLabel = isWarp
    ? 'Cloudflare WARP'
    : server?.protocol?.toLowerCase() === 'tailscale'
      ? 'Tailscale'
      : 'WireGuard';

  // 重名软检测（非阻塞）：后端 generateSingBoxConfig 用 getUniqueTag 自动去重 tag，硬拦会误伤订阅天然重名的节点；排除自身。
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

    // 悬挂 detour 防回写：detour state 可能指向已删除/被 excludeEndpoint 过滤掉的节点（UI 显「直连」但 state 仍持旧 id）；
    // 用与 DetourPicker 同一候选谓词（isPickerCandidate）校验，不在有效候选则视为直连，避免 UI 与持久化不一致。
    const detourValid =
      !!detour && servers.some((s) => s.id === detour && isPickerCandidate(s, server?.id, true));

    const serverConfig = {
      name: serverName.trim(),
      detour: detourValid ? detour : undefined,
      ...protocolConfig,
    };

    setSaving(true);
    try {
      await onSave(serverConfig);
      onOpenChange(false);
    } catch (e) {
      // 后端保存失败也要可见（原先 throw 被表单 submit 吞掉、无提示）。
      toast.error(t('servers.saveFailed', 'Failed to save'), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
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
      <DialogContent className="[&>button]:hidden flex max-h-[90vh] w-[min(452px,94vw)] max-w-none flex-col gap-0 overflow-hidden rounded-[12px] border-line bg-surface p-0">
        {/* a11y：radix 需 Title/Description；视觉标题另在 `.nd-dlg-h`，此处仅供辅助技术。 */}
        <DialogTitle className="sr-only">
          {isEditing
            ? t('servers.editServer', 'Edit Server Config')
            : t('servers.addServerConfig', 'Add Server Config')}
        </DialogTitle>
        <DialogDescription className="sr-only">
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

        <div className="nd-dlg-h">
          <span className="nd-dlg-title">
            {isEditing
              ? t('servers.editServer', 'Edit Server Config')
              : t('servers.addServerConfig', 'Add Server Config')}
          </span>
          <button
            type="button"
            className="nd-dlg-x"
            aria-label={t('common.cancel', 'Cancel')}
            onClick={() => onOpenChange(false)}
          >
            <X />
          </button>
        </div>

        <div className="nd-dlg-body">
          {isEditing && server?.subscriptionId && (
            <div className="nd-amber">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4M12 16h.01" />
              </svg>
              <span>
                {t(
                  'servers.subNodeEditHint',
                  'This node belongs to a subscription; edits are overwritten on the next update. For lasting changes, use "Clone to Manual Nodes".'
                )}
              </span>
            </div>
          )}

          <div className="nd-fld">
            <span className="nd-fld-lbl">
              {t('servers.protocol')}
              {!isMeshEdit && (
                <small className="font-medium text-fg-faint">
                  {t('servers.selectProtocol', 'Select your proxy server protocol')}
                </small>
              )}
            </span>
            <Select
              value={selectedProtocol}
              onValueChange={handleProtocolChange}
              disabled={isMeshEdit}
            >
              <SelectTrigger>
                {isMeshEdit ? <span>{meshLockedLabel}</span> : <SelectValue />}
              </SelectTrigger>
              <SelectContent>
                {/* 组网协议（WireGuard/WARP/Tailscale）始终不进下拉：新增走组网 tab 顶部入口，编辑锁定协议。 */}
                {getSortedProtocolOptions(t, i18n.language, (v) => v !== 'wireguard').map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isMeshEdit && (
              <div className="nd-swrow-d">
                {t(
                  'servers.protocolLockedOnEdit',
                  'Protocol cannot be changed when editing — delete and re-add to switch.'
                )}
              </div>
            )}
          </div>

          <div className="nd-fld">
            <span className="nd-fld-lbl">
              {t('servers.remarks')} <span className="nd-req">*</span>
            </span>
            <Input
              id="serverName"
              placeholder={t('servers.remarksPlaceholder')}
              value={serverName}
              onChange={(e) => {
                setServerName(e.target.value);
                if (nameError) setNameError('');
              }}
              className={
                nameError ? 'border-destructive focus-visible:ring-destructive' : undefined
              }
            />
            {nameError ? (
              <div className="fld-err">{nameError}</div>
            ) : isDuplicateName ? (
              <div className="nd-swrow-d text-amber-600 dark:text-amber-500">
                {t('servers.nameDuplicate', 'A node with this name already exists')}
              </div>
            ) : null}
          </div>

          <div className="contents">
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
            {selectedProtocol === 'snell' && (
              <SnellForm
                key={currentServerConfig?.id || 'new'}
                serverConfig={
                  currentServerConfig?.protocol?.toLowerCase() === 'snell'
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

          <FormSection
            title={t('servers.detour', 'Proxy Chain (Detour)')}
            collapsible
            defaultOpen={!!server?.detour}
          >
            <DetourPicker
              servers={servers}
              excludeId={server?.id}
              value={detour}
              onSelect={(id) => setDetour(id === DETOUR_DIRECT ? undefined : id)}
            />
            <div className="nd-swrow-d">
              {t(
                'servers.detourDesc',
                'Connect to this node through another proxy server (proxy chain)'
              )}
            </div>
          </FormSection>
        </div>

        {/* 固定底部操作区：保存/重置贴 dialog 底、不随表单主体滚动。经 HTML form= 关联当前挂载的
            协议表单（id="node-cfg-form"）——submit 触发其 RHF 校验+提交，reset 经表单 onReset 走 form.reset()。
            warp（一键生成）/custom（JSON）自带按钮、不套用本 footer。 */}
        {selectedProtocol !== 'warp' && selectedProtocol !== 'custom' && (
          <div className="nd-dlg-foot">
            <button type="reset" form="node-cfg-form" className="btn ghost sm" disabled={saving}>
              {t('common.reset')}
            </button>
            <button type="submit" form="node-cfg-form" className="btn flow sm" disabled={saving}>
              {saving && <Loader2 className="animate-spin" size={14} />}
              {t('common.save')}
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
