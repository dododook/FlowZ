import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
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
import { AddressField, PortField } from './shared/basic-fields';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import { splitTextList } from './shared/parse-list';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { parseWgQuickConf } from '../../../shared/wg-quick';
import { api } from '@/ipc/api-client';

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
    allowedIPs: z.string().optional(),
    persistentKeepalive: z.number().min(0).max(65535),
    mtu: z.number().min(0).max(9000).optional(),
    reserved: z.string().optional(),
  });

type WireGuardFormValues = z.infer<ReturnType<typeof createWireGuardSchema>>;

interface WireGuardFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
  /** WARP 生成时回填一个建议节点名（仅当 dialog 名称为空时采用）。 */
  onSuggestName?: (name: string) => void;
}

/** "1,2,3" → [1,2,3]（恰 3 个有效字节）；否则 undefined（reserved 仅 Cloudflare WARP 等需要）。 */
const parseReserved = (v: string | undefined): number[] | undefined => {
  const nums = splitTextList(v)
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  return nums.length === 3 ? nums : undefined;
};

export function WireGuardForm({ serverConfig, onSubmit, onSuggestName }: WireGuardFormProps) {
  const { t } = useTranslation();
  const wireguardFormSchema = createWireGuardSchema(t);
  const [confText, setConfText] = useState('');
  const [confError, setConfError] = useState('');
  const [warpLicense, setWarpLicense] = useState('');
  const [warpLoading, setWarpLoading] = useState(false);

  const form = useForm<WireGuardFormValues>({
    resolver: zodResolver(wireguardFormSchema),
    defaultValues: {
      address: '',
      port: 51820,
      privateKey: '',
      localAddress: '',
      peerPublicKey: '',
      preSharedKey: '',
      allowedIPs: '0.0.0.0/0, ::/0',
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
        allowedIPs: (wg?.allowedIPs || ['0.0.0.0/0', '::/0']).join(', '),
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
      allowedIPs: (parsed.settings.allowedIPs || ['0.0.0.0/0', '::/0']).join(', '),
      persistentKeepalive: parsed.settings.persistentKeepalive ?? 25,
      mtu: parsed.settings.mtu ?? 1408,
      reserved: '',
    });
  };

  // 一键生成 Cloudflare WARP：主进程注册匿名设备 → 回填同一套 WG 表单字段（用户确认后按普通 WG 节点保存）。
  const handleGenerateWarp = async () => {
    setWarpLoading(true);
    try {
      const draft = await api.server.registerWarp(warpLicense.trim() || undefined);
      form.reset({
        address: draft.address,
        port: draft.port,
        privateKey: draft.privateKey,
        localAddress: draft.localAddress.join(', '),
        peerPublicKey: draft.peerPublicKey,
        preSharedKey: '',
        allowedIPs: (draft.allowedIPs.length ? draft.allowedIPs : ['0.0.0.0/0', '::/0']).join(', '),
        persistentKeepalive: 25,
        mtu: draft.mtu || 1280,
        reserved: (draft.reserved || []).join(', '),
      });
      onSuggestName?.(draft.meta.warpPlus ? 'Cloudflare WARP+' : 'Cloudflare WARP');
      toast.success(
        t('servers.warpGenerated', 'WARP config generated — review and save') +
          (draft.meta.warpPlus ? ' (WARP+)' : '')
      );
    } catch (e: any) {
      toast.error(`${t('servers.warpFailed', 'WARP registration failed')}: ${e?.message ?? e}`);
    } finally {
      setWarpLoading(false);
    }
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
        allowedIPs: splitTextList(values.allowedIPs),
        persistentKeepalive: values.persistentKeepalive,
        mtu: values.mtu || undefined,
        reserved: parseReserved(values.reserved),
      },
    };
    await onSubmit(config);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
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

        {/* 一键生成 Cloudflare WARP（匿名注册 → 填充本表单；WARP+ license 可选） */}
        <div className="space-y-2 rounded-md border border-dashed p-3">
          <FormLabel>{t('servers.warpGenerate', 'Generate Cloudflare WARP (optional)')}</FormLabel>
          <p className="text-xs text-muted-foreground">
            {t(
              'servers.warpGenerateDesc',
              'Registers an anonymous WARP device and fills the fields below. Optionally paste a WARP+ license key.'
            )}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder={t('servers.warpLicense', 'WARP+ license key (optional)')}
              value={warpLicense}
              onChange={(e) => setWarpLicense(e.target.value)}
              className="font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleGenerateWarp}
              disabled={warpLoading}
              className="w-full sm:w-auto sm:flex-shrink-0"
            >
              {warpLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('servers.warpGenerateBtn', 'Generate WARP')}
            </Button>
          </div>
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
                name="allowedIPs"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.wgAllowedIPs', 'Allowed IPs')}</FormLabel>
                    <FormControl>
                      <Input placeholder="0.0.0.0/0, ::/0" {...field} />
                    </FormControl>
                    <FormDescription>
                      {t(
                        'servers.wgAllowedIPsDesc',
                        'Default 0.0.0.0/0, ::/0 routes all traffic; required to reach the peer'
                      )}
                    </FormDescription>
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

        <div className="flex gap-4">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('common.save')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => form.reset()}
            disabled={form.formState.isSubmitting}
          >
            {t('common.reset')}
          </Button>
        </div>
      </form>
    </Form>
  );
}
