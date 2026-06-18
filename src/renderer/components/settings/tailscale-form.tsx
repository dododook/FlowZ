import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
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
import { Switch } from '@/components/ui/switch';
import { FormButtons } from './shared/form-buttons';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import { splitTextList } from './shared/parse-list';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

// Tailscale：账号制 mesh，无 address/port（连控制面）。无硬必填项——auth_key 可选（无则启动出登录 URL）。
const createTailscaleSchema = () =>
  z.object({
    authKey: z.string().optional(),
    allowInternet: z.boolean(),
    exitNode: z.string().optional(),
    acceptRoutes: z.boolean(),
    routes: z.string().optional(),
    controlUrl: z.string().optional(),
    hostname: z.string().optional(),
    ephemeral: z.boolean(),
    advertiseRoutes: z.string().optional(),
  });

type TailscaleFormValues = z.infer<ReturnType<typeof createTailscaleSchema>>;

interface TailscaleFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function TailscaleForm({ serverConfig, onSubmit }: TailscaleFormProps) {
  const { t } = useTranslation();

  const form = useForm<TailscaleFormValues>({
    resolver: zodResolver(createTailscaleSchema()),
    defaultValues: {
      authKey: '',
      allowInternet: true, // 新建默认开
      exitNode: '',
      acceptRoutes: false,
      routes: '',
      controlUrl: '',
      hostname: '',
      ephemeral: false,
      advertiseRoutes: '',
    },
  });

  useEffect(() => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'tailscale') {
      const ts = serverConfig.tailscaleSettings;
      form.reset({
        authKey: ts?.authKey || '',
        allowInternet: ts?.allowInternet !== false, // 缺省 true（向后兼容）
        exitNode: ts?.exitNode || '',
        acceptRoutes: ts?.acceptRoutes ?? false,
        routes: (ts?.routes || []).join(', '),
        controlUrl: ts?.controlUrl || '',
        hostname: ts?.hostname || '',
        ephemeral: ts?.ephemeral ?? false,
        advertiseRoutes: (ts?.advertiseRoutes || []).join(', '),
      });
    }
  }, [serverConfig, form]);

  const handleSubmit = async (values: TailscaleFormValues) => {
    const routes = splitTextList(values.routes);
    const config: any = {
      protocol: 'tailscale' as const,
      tailscaleSettings: {
        authKey: values.authKey?.trim() || undefined,
        allowInternet: values.allowInternet,
        exitNode: values.exitNode?.trim() || undefined,
        // 填了 routes 自动开 acceptRoutes（否则 tsnet 不接收这些 advertised 子网，路由白配）
        acceptRoutes: values.acceptRoutes || routes.length > 0,
        routes,
        controlUrl: values.controlUrl?.trim() || undefined,
        hostname: values.hostname?.trim() || undefined,
        ephemeral: values.ephemeral,
        advertiseRoutes: splitTextList(values.advertiseRoutes),
      },
    };
    await onSubmit(config);
  };

  const allowInternet = form.watch('allowInternet');

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        <FormSection title={t('servers.basic', 'Basic')}>
          <p className="text-xs text-muted-foreground">
            {t(
              'servers.tsIntro',
              'Tailscale is account-based — no address/port. Paste an auth key, or start the node to get a login URL.'
            )}
          </p>
          <FieldGrid cols={1}>
            <FieldSpan>
              <FormField
                control={form.control}
                name="authKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.tsAuthKey', 'Auth Key (optional)')}</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="tskey-auth-..." {...field} />
                    </FormControl>
                    <FormDescription>
                      {t(
                        'servers.tsAuthKeyDesc',
                        'Pre-auth key for non-interactive login. Leave empty to log in via URL on start.'
                      )}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldSpan>
            <FieldSpan>
              <FormField
                control={form.control}
                name="allowInternet"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5 pr-3">
                      <FormLabel>{t('servers.allowInternet', 'Allow internet access')}</FormLabel>
                      <FormDescription>
                        {t(
                          'servers.tsAllowInternetDesc',
                          'When off, this node never acts as a full-tunnel exit (the exit node below is ignored); it only reaches the tailnet and routed subnets.'
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
                name="exitNode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.tsExitNode', 'Exit Node (optional)')}</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="100.x.y.z / hostname"
                        {...field}
                        disabled={!allowInternet}
                      />
                    </FormControl>
                    <FormDescription>
                      {t(
                        'servers.tsExitNodeDesc',
                        'Route all traffic through this tailnet node (full-tunnel). Empty = only reach tailnet / accepted routes.'
                      )}
                    </FormDescription>
                    {!allowInternet && (
                      <p className="text-sm text-amber-600 dark:text-amber-500">
                        {t(
                          'servers.tsAllowInternetOffHint',
                          'Internet access off: exit node ignored; this node only reaches the tailnet / routed subnets.'
                        )}
                      </p>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldSpan>
            <FieldSpan>
              <FormField
                control={form.control}
                name="acceptRoutes"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5 pr-3">
                      <FormLabel>{t('servers.tsAcceptRoutes', 'Accept Routes')}</FormLabel>
                      <FormDescription>
                        {t(
                          'servers.tsAcceptRoutesDesc',
                          'Accept subnet routes advertised by other nodes (reach mesh subnets).'
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
                name="routes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.tsRoutes', 'Routed subnets')}</FormLabel>
                    <FormControl>
                      <Input placeholder="192.168.50.0/24, 10.0.0.0/24" {...field} />
                    </FormControl>
                    <FormDescription>
                      {t(
                        'servers.tsRoutesDesc',
                        'Send these subnets through this node; tailnet 100.64.0.0/10 is auto-included.'
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
          <FieldGrid cols={2}>
            <FormField
              control={form.control}
              name="hostname"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.tsHostname', 'Hostname')}</FormLabel>
                  <FormControl>
                    <Input placeholder="my-device" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="controlUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.tsControlUrl', 'Control URL')}</FormLabel>
                  <FormControl>
                    <Input placeholder="https://controlplane.tailscale.com" {...field} />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'servers.tsControlUrlDesc',
                      'Custom control server (Headscale). Empty = Tailscale default.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FieldSpan>
              <FormField
                control={form.control}
                name="advertiseRoutes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.tsAdvertiseRoutes', 'Advertise Routes')}</FormLabel>
                    <FormControl>
                      <Input placeholder="192.168.1.0/24, 10.0.0.0/24" {...field} />
                    </FormControl>
                    <FormDescription>
                      {t(
                        'servers.tsAdvertiseRoutesDesc',
                        'Subnets this node makes reachable to the tailnet (subnet router). Comma-separated.'
                      )}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldSpan>
            <FieldSpan>
              <FormField
                control={form.control}
                name="ephemeral"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5 pr-3">
                      <FormLabel>{t('servers.tsEphemeral', 'Ephemeral')}</FormLabel>
                      <FormDescription>
                        {t(
                          'servers.tsEphemeralDesc',
                          'Auto-remove this node from the tailnet when offline.'
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
          </FieldGrid>
        </FormSection>

        <FormButtons isSubmitting={form.formState.isSubmitting} onReset={() => form.reset()} />
      </form>
    </Form>
  );
}
