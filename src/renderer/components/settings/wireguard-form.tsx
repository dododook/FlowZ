import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Form, FormField, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { AddressField, PortField } from './shared/basic-fields';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import { AccessModeField, SubnetReachabilitySwitch } from './shared/mesh-fields';
import { SwitchField } from './shared/switch-field';
import { InfoTooltip } from './shared/info-tooltip';
import { splitTextList } from './shared/parse-list';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';
import { parseWgQuickConf } from '../../../shared/wg-quick';
import { isWarpServer } from '../../../shared/warp';
import { toast } from 'sonner';
import { api } from '@/ipc/api-client';
import { Loader2 } from 'lucide-react';
// 全网段由「允许访问外网」开关接管，列表只显示/录入具体段——剥离/判定复用 shared 单一真值，避免字面量漂移。
import { stripCatchAll, hasCatchAll } from '../../../shared/endpoint-routes';

const createWireGuardSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    privateKey: z.string().min(1, t('servers.wgPrivateKeyRequired', 'Private key is required')),
    localAddress: z
      .string()
      .min(1, t('servers.wgLocalAddressRequired', 'Interface address is required')),
    peerPublicKey: z
      .string()
      .min(1, t('servers.wgPeerPublicKeyRequired', 'Peer public key is required')),
    preSharedKey: z.string().optional(),
    allowInternet: z.boolean(),
    reverseMesh: z.boolean(),
    alwaysRouteSubnets: z.boolean(),
    allowedIPs: z.string().optional(),
    persistentKeepalive: z.number().min(0).max(65535),
    // 允许 ''（清空态）：清空数字输入用 '' 作空哨兵（避免 Controller 回退 defaultValue），提交时 `mtu || undefined` 归一。
    mtu: z.number().min(0).max(9000).optional().or(z.literal('')),
    reserved: z.string().optional(),
  });

type WireGuardFormValues = z.infer<ReturnType<typeof createWireGuardSchema>>;

interface WireGuardFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

/** "1,2,3" → [1,2,3]（恰 3 个有效字节）；否则 undefined（reserved 仅 Cloudflare WARP 等需要）。 */
const parseReserved = (v: string | undefined): number[] | undefined => {
  const nums = splitTextList(v)
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  return nums.length === 3 ? nums : undefined;
};

export function WireGuardForm({ serverConfig, onSubmit }: WireGuardFormProps) {
  const { t } = useTranslation();
  const wireguardFormSchema = createWireGuardSchema(t);
  const [confText, setConfText] = useState('');
  const [confError, setConfError] = useState('');
  const [licenseInput, setLicenseInput] = useState('');
  const [applyingLicense, setApplyingLicense] = useState(false);

  const form = useForm<WireGuardFormValues>({
    resolver: zodResolver(wireguardFormSchema),
    defaultValues: {
      address: '',
      port: 51820,
      privateKey: '',
      localAddress: '',
      peerPublicKey: '',
      preSharedKey: '',
      allowInternet: true, // 新建默认开（全隧道）
      reverseMesh: false, // Phase 2：反向 mesh（system 内核接口），默认关=userspace
      alwaysRouteSubnets: true, // 缺省开=网段恒可达(组网)；关=仅出网(选中/规则指向时才路由网段)
      // 仅录入「具体路由段」（对端内网/子网）；全网段 0/0,::/0 由 allowInternet 开关接管，不在此预填。
      allowedIPs: '',
      persistentKeepalive: 25, // 默认 25s：避免 NAT 空闲断连（WireGuard 无连接 UDP）
      mtu: 1408,
      reserved: '',
    },
  });

  useEffect(() => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'wireguard') {
      const wg = serverConfig.wireguardSettings;
      form.reset({
        address: serverConfig.address || '',
        port: serverConfig.port || 51820,
        privateKey: wg?.privateKey || '',
        localAddress: (wg?.localAddress || []).join(', '),
        peerPublicKey: wg?.peerPublicKey || '',
        preSharedKey: wg?.preSharedKey || '',
        allowInternet: wg?.allowInternet !== false, // 缺省 true（向后兼容）
        reverseMesh: wg?.reverseMesh === true, // 缺省 false
        alwaysRouteSubnets: wg?.alwaysRouteSubnets !== false, // 缺省 true（向后兼容）
        // 全网段由开关接管，列表仅显示具体段（剥离存量 allowedIPs 里的 catch-all）。
        allowedIPs: stripCatchAll(wg?.allowedIPs).join(', '),
        persistentKeepalive: wg?.persistentKeepalive ?? 25,
        mtu: wg?.mtu ?? 1408,
        reserved: (wg?.reserved || []).join(', '),
      });
    }
  }, [serverConfig, form]);

  // 粘贴 wg-quick .conf → 解析并填充同一套表单字段（解析失败提示改手填）。
  const handleParseConf = () => {
    const parsed = parseWgQuickConf(confText);
    if (!parsed) {
      setConfError(
        t(
          'servers.wgConfParseFailed',
          'Could not parse the .conf — please fill the fields manually'
        )
      );
      return;
    }
    setConfError('');
    form.reset({
      address: parsed.address,
      port: parsed.port,
      privateKey: parsed.settings.privateKey,
      localAddress: parsed.settings.localAddress.join(', '),
      peerPublicKey: parsed.settings.peerPublicKey,
      preSharedKey: parsed.settings.preSharedKey || '',
      // 忠实 wg-quick 语义：AllowedIPs 含 0/0,::/0=全隧道→开关开；缺则默认全隧道。列表仅留具体段。
      allowInternet: parsed.settings.allowedIPs ? hasCatchAll(parsed.settings.allowedIPs) : true,
      reverseMesh: false, // wg-quick .conf 无 system 概念，导入恒 userspace
      alwaysRouteSubnets: true, // 导入默认开（忠实 wg-quick：AllowedIPs 段即应路由）
      allowedIPs: stripCatchAll(parsed.settings.allowedIPs).join(', '),
      persistentKeepalive: parsed.settings.persistentKeepalive ?? 25,
      mtu: parsed.settings.mtu ?? 1408,
      reserved: '',
    });
  };

  const handleSubmit = async (values: WireGuardFormValues) => {
    const config: any = {
      protocol: 'wireguard' as const,
      address: values.address,
      port: values.port,
      wireguardSettings: {
        privateKey: values.privateKey.trim(),
        localAddress: splitTextList(values.localAddress),
        peerPublicKey: values.peerPublicKey.trim(),
        preSharedKey: values.preSharedKey?.trim() || undefined,
        allowInternet: values.allowInternet,
        reverseMesh: values.reverseMesh,
        alwaysRouteSubnets: values.alwaysRouteSubnets,
        // 仅保存具体路由段；全网段 0/0,::/0 由 allowInternet=on 在生成期注入 peer.allowed_ips。
        allowedIPs: stripCatchAll(splitTextList(values.allowedIPs)),
        persistentKeepalive: values.persistentKeepalive,
        mtu: values.mtu || undefined,
        reserved: parseReserved(values.reserved),
        // WARP 自删凭据非表单字段：编辑保存时原样透传既有值，否则编辑过 WARP 节点后凭据丢失 → 删除时无从注销。
        warpDevice: serverConfig?.wireguardSettings?.warpDevice,
      },
    };
    await onSubmit(config);
  };

  const allowInternet = form.watch('allowInternet');
  // WARP 节点：接口参数由注册返回，仅展示不可改；鲁棒判定（含旧无 warpDevice 标记的 WARP，按端点域名兜底）。
  const isWarp = serverConfig ? isWarpServer(serverConfig) : false;
  // 原地升级 WARP+ 需注册时落盘的 deviceId+token（Bearer）：旧节点无 warpDevice → 无凭据，置灰提示重建。
  const hasWarpCreds = !!serverConfig?.wireguardSettings?.warpDevice?.token;
  const handleApplyLicense = async () => {
    if (!serverConfig?.id || !licenseInput.trim()) return;
    setApplyingLicense(true);
    try {
      const res = await api.server.applyWarpLicense(serverConfig.id, licenseInput.trim());
      if (res.ok) {
        toast.success(
          res.warpPlus
            ? t('servers.warpPlusApplied', 'WARP+ applied')
            : t(
                'servers.warpPlusMaybeFree',
                'License submitted, but still free — check the license key.'
              )
        );
        if (res.warpPlus) setLicenseInput('');
      } else {
        toast.error(
          `${t('servers.warpPlusApplyFailed', 'Failed to apply WARP+')}${res.error ? `: ${res.error}` : ''}`
        );
      }
    } catch (e) {
      toast.error(
        `${t('servers.warpPlusApplyFailed', 'Failed to apply WARP+')}: ${e instanceof Error ? e.message : e}`
      );
    } finally {
      setApplyingLicense(false);
    }
  };
  const hasSpecificRoutes = stripCatchAll(splitTextList(form.watch('allowedIPs'))).length > 0;
  // 路由范围提示，仅在「关外网（不承载全隧道）」时渲染。System(reverseMesh) 现也能承载全隧道——保留 0/0 且出口路由
  // 经接口作用域路由托管（macOS ifscope / Linux 独立表，非主表）→ 故不再因 reverseMesh 报「绝不承载全隧道」。
  const meshRoutesHint = !hasSpecificRoutes
    ? t(
        'servers.allowInternetOffNoRoutes',
        '⚠ This node currently carries no traffic (no subnets listed). Add a subnet, or turn on internet access.'
      )
    : t(
        'servers.allowInternetOffHint',
        'Internet access off: this node only routes the subnets listed above.'
      );

  return (
    <Form {...form}>
      <form
        id="node-cfg-form"
        onSubmit={form.handleSubmit(handleSubmit)}
        onReset={(e) => {
          e.preventDefault();
          form.reset();
        }}
        className="flex flex-col gap-[13px]"
      >
        {/* 组网概要：降低 WG/组网概念门槛（与 Tailscale tsIntro 对齐） */}
        <p className="text-xs text-muted-foreground">
          {t('servers.wgIntro', 'WireGuard node: reach a peer LAN, or act as an internet exit.')}
        </p>

        {/* 基础：仅连接必填（地址/端口/私钥/对端公钥/本地地址）。 */}
        <FieldGrid cols={2}>
          {/* WARP 的服务器地址/端口可改（Cloudflare 端点可换：engage / 162.159.x、备用端口 2408/500/1701/4500）；
              密钥/接口地址/reserved 才是注册身份，保持只读。 */}
          <AddressField control={form.control} t={t} />
          <PortField control={form.control} t={t} placeholder="51820" />
          <FieldSpan>
            <FormField
              control={form.control}
              name="privateKey"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    {t('servers.wgPrivateKey', 'Private Key')} <span className="nd-req">*</span>
                  </span>
                  <Input
                    type="password"
                    placeholder="base64 private key"
                    {...field}
                    readOnly={isWarp}
                    className={isWarp ? 'mono cursor-default opacity-70' : 'mono'}
                  />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldSpan>
          <FormField
            control={form.control}
            name="peerPublicKey"
            render={({ field }) => (
              <div className="nd-fld">
                <span className="nd-fld-lbl">
                  {t('servers.wgPeerPublicKey', 'Peer Public Key')}{' '}
                  <span className="nd-req">*</span>
                </span>
                <Input
                  placeholder="base64 peer public key"
                  {...field}
                  readOnly={isWarp}
                  className={isWarp ? 'mono cursor-default opacity-70' : 'mono'}
                />
                <FormMessage className="fld-err" />
              </div>
            )}
          />
          <FormField
            control={form.control}
            name="localAddress"
            render={({ field }) => (
              <div className="nd-fld">
                <span className="nd-fld-lbl">
                  {t('servers.wgLocalAddress', 'Interface Address')}{' '}
                  <span className="nd-req">*</span>
                </span>
                <Input
                  placeholder="10.0.0.2/32, fd00::2/128"
                  {...field}
                  readOnly={isWarp}
                  className={isWarp ? 'mono cursor-default opacity-70' : 'mono'}
                />
                <FormMessage className="fld-err" />
              </div>
            )}
          />
        </FieldGrid>

        {/* 接入与出口（常显）：接入模式选择器 + 全隧道出口开关。WARP=Cloudflare anycast 出口，恒 gVisor 全隧道、
            不可作子网路由器 → 隐藏接入模式选择器（无 System 选项）。 */}
        <FormSection title={t('servers.accessAndExit', 'Access & exit')}>
          {!isWarp && <AccessModeField control={form.control} />}
          <SwitchField
            control={form.control}
            name="allowInternet"
            label={t('servers.wgFullTunnel', 'Route all internet via this node')}
            tooltip={t(
              'servers.wgFullTunnelDesc',
              'All internet egresses via this WireGuard node (this node is the exit); off = only route the subnets below.'
            )}
          />
        </FormSection>

        {/* WARP+（仅 WARP 节点）：原地应用 license 升级（PUT /reg/{id}/account），免重新注册。需注册时落盘的
            warpDevice 凭据（token）；旧节点无凭据 → 置灰提示重建。降级无干净接口，走「删节点 + 重加免费版」。 */}
        {isWarp && (
          <FormSection title="WARP+">
            {hasWarpCreds ? (
              <div className="space-y-2">
                <Input
                  placeholder={t('servers.warpLicense', 'WARP+ license key')}
                  value={licenseInput}
                  onChange={(e) => setLicenseInput(e.target.value)}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={applyingLicense || !licenseInput.trim()}
                  onClick={handleApplyLicense}
                >
                  {applyingLicense && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                  {t('servers.warpApplyPlus', 'Apply WARP+')}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'servers.warpApplyPlusDesc',
                    'Upgrade in place (no re-register). To downgrade, delete this node and add a free one.'
                  )}
                </p>
              </div>
            ) : (
              <p className="text-sm text-amber-600 dark:text-amber-500">
                {t(
                  'servers.warpPlusLegacyHint',
                  'This WARP node has no stored credentials (legacy) — to use WARP+, delete it and re-create.'
                )}
              </p>
            )}
          </FormSection>
        )}

        {/* 子网路由（默认折叠）：子网恒可达开关 + 路由子网（Allowed IPs）。WARP=anycast 出口、无内网段、不可作
            子网路由器 → 整段隐藏。 */}
        {!isWarp && (
          <FormSection
            title={t('servers.wgMeshOptions', 'Subnet routing')}
            collapsible
            defaultOpen={false}
          >
            <SubnetReachabilitySwitch control={form.control} protocol="wireguard" />
            <FormField
              control={form.control}
              name="allowedIPs"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl inline-flex items-center gap-1.5">
                    {t('servers.wgAllowedIPs', 'Routed subnets')}
                    <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                    <InfoTooltip content={t('servers.wgAllowedIPsDescFull')} />
                  </span>
                  <Input
                    placeholder={t(
                      'servers.wgAllowedIPsPlaceholder',
                      '留空=全隧道；或 10.8.0.0/24'
                    )}
                    {...field}
                  />
                  {!allowInternet && (
                    <p className="text-sm text-amber-600 dark:text-amber-500">{meshRoutesHint}</p>
                  )}
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FormSection>
        )}

        <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
          {/* 粘贴 wg-quick .conf 自动填充（可选；手写为主）——解析会覆盖私钥/对端公钥/接口地址/AllowedIPs 等全部字段。
              WARP 节点参数是 Cloudflare 注册产出（含自删凭据），导入 .conf 会冲掉其身份 → 对 WARP 隐藏此入口。 */}
          {!isWarp && (
            <div className="space-y-2 rounded-md border border-dashed p-3">
              <span className="nd-fld-lbl">
                {t('servers.wgImportConf', 'Import from wg-quick .conf (optional)')}
              </span>
              <textarea
                className="nd-textarea"
                placeholder={
                  '[Interface]\nPrivateKey = ...\nAddress = 10.0.0.2/32\n[Peer]\nPublicKey = ...\nEndpoint = host:51820\nAllowedIPs = 0.0.0.0/0, ::/0'
                }
                value={confText}
                onChange={(e) => setConfText(e.target.value)}
              />
              {confError && <p className="text-sm text-destructive">{confError}</p>}
              <Button type="button" variant="outline" size="sm" onClick={handleParseConf}>
                {t('servers.wgParseAndFill', 'Parse & fill')}
              </Button>
            </div>
          )}
          <FormField
            control={form.control}
            name="preSharedKey"
            render={({ field }) => (
              <div className="nd-fld">
                <span className="nd-fld-lbl">
                  {t('servers.wgPreSharedKey', 'Pre-Shared Key (optional)')}
                </span>
                <Input
                  type="password"
                  placeholder="base64 pre-shared key"
                  {...field}
                  className="mono"
                />
                <FormMessage className="fld-err" />
              </div>
            )}
          />
          <FieldGrid cols={3}>
            <FormField
              control={form.control}
              name="persistentKeepalive"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    {t('servers.wgKeepalive', 'Keepalive (s)')} <span className="nd-req">*</span>
                  </span>
                  <Input
                    type="number"
                    {...field}
                    value={field.value ?? ''}
                    onChange={(e) => {
                      // 空串（退格删空）→ ''（**不是 undefined**）：RHF Controller 在 value===undefined 时回退
                      // defaultValue，把清空的字段自动填回旧值（issue #294 同类回归）。'' 是「已定义的空」不触发回退。
                      // 不用 Number(e.target.value)（`Number('')===0` 卡成 0）。异常值 → '' 不硬塞 0。
                      const raw = e.target.value;
                      if (raw === '') {
                        field.onChange('');
                        return;
                      }
                      const n = Number.parseInt(raw, 10);
                      field.onChange(Number.isNaN(n) ? '' : n);
                    }}
                  />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FormField
              control={form.control}
              name="mtu"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    MTU <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                  </span>
                  <Input
                    type="number"
                    {...field}
                    value={field.value ?? ''}
                    onChange={(e) => {
                      // 空串（退格删空）→ ''（**不是 undefined**）：RHF Controller 在 value===undefined 时回退
                      // defaultValue，把清空的字段自动填回旧值（issue #294 同类回归）。'' 是「已定义的空」不触发回退。
                      // 不用 Number(e.target.value)（`Number('')===0` 卡成 0）。异常值 → '' 不硬塞 0。
                      const raw = e.target.value;
                      if (raw === '') {
                        field.onChange('');
                        return;
                      }
                      const n = Number.parseInt(raw, 10);
                      field.onChange(Number.isNaN(n) ? '' : n);
                    }}
                  />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FormField
              control={form.control}
              name="reserved"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    {t('servers.wgReserved', 'Reserved')}{' '}
                    <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                  </span>
                  <Input placeholder="1,2,3" {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldGrid>
        </FormSection>
      </form>
    </Form>
  );
}
