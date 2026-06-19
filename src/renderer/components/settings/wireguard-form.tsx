import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { FormButtons } from './shared/form-buttons';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { AddressField, PortField } from './shared/basic-fields';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import { splitTextList } from './shared/parse-list';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';
import { parseWgQuickConf } from '../../../shared/wg-quick';
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
    mtu: z.number().min(0).max(9000).optional(),
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
  const reverseMesh = form.watch('reverseMesh');
  const hasSpecificRoutes = stripCatchAll(splitTextList(form.watch('allowedIPs'))).length > 0;
  // 「不承载全隧道」时的网段提示文案（仅在 reverseMesh || !allowInternet 时渲染）：无具体段=警告无流量；
  // system=反向 mesh 说明；否则=关外网说明。选择移出 JSX 保渲染体扁平。
  const meshRoutesHint = !hasSpecificRoutes
    ? t(
        'servers.allowInternetOffNoRoutes',
        '⚠ This node currently carries no traffic (no subnets listed). Add a subnet, or turn internet access on (non-system mode).'
      )
    : reverseMesh
      ? t(
          'servers.reverseMeshRoutesHint',
          'Reverse-mesh (system) mode: routes only the subnets above and is reachable from peers; never carries the full tunnel.'
        )
      : t(
          'servers.allowInternetOffHint',
          'Internet access off: this node only routes the subnets listed above.'
        );

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        {/* 组网概要：降低 WG/组网概念门槛（与 Tailscale tsIntro 对齐） */}
        <p className="text-xs text-muted-foreground">
          {t(
            'servers.wgIntro',
            'WireGuard node: reach a peer LAN, or act as an internet exit. "Allow internet access" controls whether it carries default outbound traffic (off = only routes the subnets below). When several mesh nodes list the same subnet, the first in the list wins; override with a custom rule.'
          )}
        </p>
        {/* 粘贴 wg-quick .conf 自动填充（可选；手写为主） */}
        <div className="space-y-2 rounded-md border border-dashed p-3">
          <FormLabel>
            {t('servers.wgImportConf', 'Import from wg-quick .conf (optional)')}
          </FormLabel>
          <Textarea
            rows={4}
            placeholder={
              '[Interface]\nPrivateKey = ...\nAddress = 10.0.0.2/32\n[Peer]\nPublicKey = ...\nEndpoint = host:51820\nAllowedIPs = 0.0.0.0/0, ::/0'
            }
            value={confText}
            onChange={(e) => setConfText(e.target.value)}
            className="font-mono text-xs"
          />
          {confError && <p className="text-sm text-destructive">{confError}</p>}
          <Button type="button" variant="outline" size="sm" onClick={handleParseConf}>
            {t('servers.wgParseAndFill', 'Parse & fill')}
          </Button>
        </div>

        <FormSection title={t('servers.basic', 'Basic')}>
          <FieldGrid cols={2}>
            <AddressField control={form.control} t={t} />
            <PortField control={form.control} t={t} placeholder="51820" />
            <FieldSpan>
              <FormField
                control={form.control}
                name="privateKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.wgPrivateKey', 'Private Key')}</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="base64 private key" {...field} />
                    </FormControl>
                    <FormDescription>
                      {t('servers.wgPrivateKeyDesc', 'Local interface private key (base64)')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldSpan>
            <FormField
              control={form.control}
              name="peerPublicKey"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.wgPeerPublicKey', 'Peer Public Key')}</FormLabel>
                  <FormControl>
                    <Input placeholder="base64 peer public key" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="localAddress"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.wgLocalAddress', 'Interface Address')}</FormLabel>
                  <FormControl>
                    <Input placeholder="10.0.0.2/32, fd00::2/128" {...field} />
                  </FormControl>
                  <FormDescription>
                    {t('servers.wgLocalAddressDesc', 'Local tunnel address(es), comma-separated')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FieldSpan>
              <FormField
                control={form.control}
                name="allowInternet"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5 pe-3">
                      <FormLabel>{t('servers.allowInternet', 'Allow internet access')}</FormLabel>
                      <FormDescription>
                        {reverseMesh
                          ? t(
                              'servers.allowInternetSystemDisabled',
                              'Disabled in reverse-mesh mode: a kernel-interface node only carries the listed subnets and never acts as the full-tunnel exit. Turn off reverse mesh to use this node as an exit.'
                            )
                          : t(
                              'servers.allowInternetDesc',
                              'When off, this node only routes the subnets listed below (e.g. peer LAN); it will not carry your default outbound traffic.'
                            )}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={reverseMesh ? false : field.value}
                        disabled={reverseMesh}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </FieldSpan>
            <FieldSpan>
              <FormField
                control={form.control}
                name="alwaysRouteSubnets"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5 pe-3">
                      <FormLabel>
                        {t('servers.alwaysRouteSubnets', 'Always route its subnets (mesh)')}
                      </FormLabel>
                      <FormDescription>
                        {t(
                          'servers.alwaysRouteSubnetsDesc',
                          'On: the subnets below are always reachable through this node, regardless of which node is active. Off (egress-only): routed only when this node is the active exit or a rule/app explicitly targets it.'
                        )}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </FieldSpan>
            <FieldSpan>
              <FormField
                control={form.control}
                name="reverseMesh"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5 pe-3">
                      <FormLabel>
                        {t('servers.reverseMesh', 'Reverse mesh (be reachable)')}
                      </FormLabel>
                      <FormDescription>
                        {t(
                          'servers.reverseMeshDesc',
                          'Create a real kernel interface so peers can reach this device or use it as a subnet router. Requires the privileged helper and TUN mode.'
                        )}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </FieldSpan>
            <FieldSpan>
              <FormField
                control={form.control}
                name="allowedIPs"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {t('servers.wgAllowedIPs', 'Routed subnets (Allowed IPs)')}
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder={t(
                          'servers.wgAllowedIPsPlaceholder',
                          '留空=全隧道；或 10.8.0.0/24'
                        )}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      {t(
                        'servers.wgAllowedIPsDesc',
                        "Subnets (CIDR) to route through this node, comma/newline-separated. For peer LAN only, list specific CIDRs like 10.8.0.0/24. Empty = full tunnel (all traffic) — only when 'Allow internet access' is on."
                      )}
                    </FormDescription>
                    {(reverseMesh || !allowInternet) && (
                      <p className="text-sm text-amber-600 dark:text-amber-500">{meshRoutesHint}</p>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldSpan>
          </FieldGrid>
        </FormSection>

        <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
          <FormField
            control={form.control}
            name="preSharedKey"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('servers.wgPreSharedKey', 'Pre-Shared Key (optional)')}</FormLabel>
                <FormControl>
                  <Input type="password" placeholder="base64 pre-shared key" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FieldGrid cols={3}>
            <FormField
              control={form.control}
              name="persistentKeepalive"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.wgKeepalive', 'Keepalive (s)')}</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      {...field}
                      onChange={(e) => field.onChange(Number(e.target.value))}
                    />
                  </FormControl>
                  <FormDescription>
                    {t('servers.wgKeepaliveDesc', '25s recommended to avoid NAT disconnects')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="mtu"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>MTU</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      {...field}
                      onChange={(e) => field.onChange(Number(e.target.value))}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="reserved"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.wgReserved', 'Reserved')}</FormLabel>
                  <FormControl>
                    <Input placeholder="1,2,3" {...field} />
                  </FormControl>
                  <FormDescription>
                    {t('servers.wgReservedDesc', 'WARP only, 3 bytes')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </FieldGrid>
        </FormSection>

        <FormButtons isSubmitting={form.formState.isSubmitting} onReset={() => form.reset()} />
      </form>
    </Form>
  );
}
