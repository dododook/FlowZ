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
import { Button } from '@/components/ui/button';
import { runTailscaleLogin } from '../../lib/tailscale-login';
import { FormButtons } from './shared/form-buttons';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import { SwitchField } from './shared/switch-field';
import { MeshOptionsSection } from './shared/mesh-fields';
import { InfoTooltip } from './shared/info-tooltip';
import { splitTextList } from './shared/parse-list';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

// Tailscale：账号制 mesh，无 address/port（连控制面）。无硬必填项——auth_key 可选（无则启动出登录 URL）。
const createTailscaleSchema = () =>
  z.object({
    authKey: z.string().optional(),
    allowInternet: z.boolean(),
    reverseMesh: z.boolean(),
    alwaysRouteSubnets: z.boolean(),
    exitNode: z.string().optional(),
    exitNodeAllowLanAccess: z.boolean(),
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
      reverseMesh: false, // Phase 2：反向 mesh（system_interface），默认关=userspace
      alwaysRouteSubnets: true, // 缺省开=tailnet/routes 恒可达(组网)；关=仅出网
      exitNode: '',
      exitNodeAllowLanAccess: false,
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
        reverseMesh: ts?.reverseMesh === true, // 缺省 false
        alwaysRouteSubnets: ts?.alwaysRouteSubnets !== false, // 缺省 true（向后兼容）
        exitNode: ts?.exitNode || '',
        exitNodeAllowLanAccess: ts?.exitNodeAllowLanAccess ?? false,
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
        reverseMesh: values.reverseMesh,
        alwaysRouteSubnets: values.alwaysRouteSubnets,
        exitNode: values.exitNode?.trim() || undefined,
        exitNodeAllowLanAccess: values.exitNodeAllowLanAccess || undefined,
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
  const reverseMesh = form.watch('reverseMesh');
  // 立即登录按钮（Phase 2）门控：填了 authKey → 走预授权、不需交互登录 → 隐藏按钮。
  const authKeyValue = form.watch('authKey');

  const exitNodeValue = form.watch('exitNode');

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        {/* 基础：仅出网必需项（账号 + 出口节点）。 */}
        <FormSection title={t('servers.basic', 'Basic')}>
          <p className="text-xs text-muted-foreground">
            {t(
              'servers.tsIntro',
              'Tailscale is account-based — no address/port. Paste an auth key, or start the node to get a login URL.'
            )}
          </p>
          <FieldGrid cols={2}>
            <FieldSpan>
              <FormField
                control={form.control}
                name="authKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-1.5">
                      {t('servers.tsAuthKey', 'Auth Key (optional)')}
                      <InfoTooltip content={t('servers.tsAuthKeyDescFull')} />
                    </FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="tskey-auth-..." {...field} />
                    </FormControl>
                    <FormDescription>{t('servers.tsAuthKeyDesc')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldSpan>
            {/* 立即登录（Phase 2）：仅编辑态（已保存、有 server.id）且未填 authKey（走交互登录）时点亮。
                点击拉起瞬态登录核（强制 info 级、零提权），主进程自动开浏览器 + 系统通知完成认证。
                新建态（无 id）无法登录 → 不显示，引导先保存。 */}
            {serverConfig?.id && !authKeyValue?.trim() && (
              <FieldSpan>
                <div className="flex flex-col gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full sm:w-auto"
                    onClick={() => void runTailscaleLogin(serverConfig)}
                  >
                    {t('servers.tsLoginNow', 'Log in now')}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      'servers.tsLoginNowDesc',
                      'Open the browser now to complete Tailscale login (no auth key needed).'
                    )}
                  </p>
                </div>
              </FieldSpan>
            )}
            <FieldSpan>
              <FormField
                control={form.control}
                name="exitNode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-1.5">
                      {t('servers.tsExitNode', 'Exit Node (optional)')}
                      <InfoTooltip content={t('servers.tsExitNodeDescFull')} />
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="100.x.y.z / hostname"
                        {...field}
                        disabled={!allowInternet || reverseMesh}
                      />
                    </FormControl>
                    <FormDescription>{t('servers.tsExitNodeDesc')}</FormDescription>
                    {(reverseMesh || !allowInternet) && (
                      <p className="text-sm text-amber-600 dark:text-amber-500">
                        {reverseMesh
                          ? t(
                              'servers.tsReverseMeshHint',
                              'Reverse-mesh (system) mode: exit node ignored; this node only reaches the tailnet / routed subnets and is reachable from peers (subnet router).'
                            )
                          : t(
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
          </FieldGrid>
        </FormSection>

        {/* 出口选项（默认展开）：经出口节点时是否直连本地 LAN。exitNode 非空才出现该开关。
            reverseMesh 下 exitNode 已失效 → 该开关同步禁用（!allowInternet 同理）。 */}
        {exitNodeValue?.trim() && (
          <FormSection
            title={t('servers.tsExitOptions', 'Exit node options')}
            collapsible
            defaultOpen
          >
            <SwitchField
              control={form.control}
              name="exitNodeAllowLanAccess"
              label={t('servers.tsExitNodeAllowLan', 'Allow LAN access via exit node')}
              tooltip={t(
                'servers.tsExitNodeAllowLanDesc',
                'When using an exit node, still reach the local LAN directly instead of routing it through the exit.'
              )}
              disabled={!allowInternet || reverseMesh}
            />
          </FormSection>
        )}

        {/* 子网路由（组网）：mesh 三开关（共享件）+ 接受/录入路由子网。 */}
        <FormSection
          title={t('servers.tsSubnetRouting', 'Subnet routing (mesh)')}
          collapsible
          defaultOpen={false}
        >
          <MeshOptionsSection
            control={form.control}
            protocol="tailscale"
            reverseMesh={reverseMesh}
          />
          <SwitchField
            control={form.control}
            name="acceptRoutes"
            label={t('servers.tsAcceptRoutes', 'Accept Routes')}
            tooltip={t(
              'servers.tsAcceptRoutesDesc',
              'Accept subnet routes advertised by other nodes (reach mesh subnets).'
            )}
          />
          <FormField
            control={form.control}
            name="routes"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="flex items-center gap-1.5">
                  {t('servers.tsRoutes', 'Routed subnets')}
                  <InfoTooltip content={t('servers.tsRoutesDescFull')} />
                </FormLabel>
                <FormControl>
                  <Input placeholder="192.168.50.0/24, 10.0.0.0/24" {...field} />
                </FormControl>
                <FormDescription>{t('servers.tsRoutesDesc')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
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
              <SwitchField
                control={form.control}
                name="ephemeral"
                label={t('servers.tsEphemeral', 'Ephemeral')}
                tooltip={t(
                  'servers.tsEphemeralDesc',
                  'Auto-remove this node from the tailnet when offline.'
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
