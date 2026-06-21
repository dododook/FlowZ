import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { toast } from 'sonner';
import { Check } from 'lucide-react';
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
import { api } from '@/ipc/api-client';
import { useAppStore } from '@/store/app-store';
import { runTailscaleLogin } from '../../lib/tailscale-login';
import { tailscaleLoginUiState } from './server-list-helpers';
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
    // P4a endpoint 新字段（全可选）
    advertiseTags: z.string().optional(),
    sshServer: z.boolean(),
    relayServerPort: z.string().optional(),
    // P4b 按名解析（accept_search_domain + preferred_by 强联动；acceptDefaultResolvers 仅 resolveByName 开时有意义）
    resolveByName: z.boolean(),
    acceptDefaultResolvers: z.boolean(),
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
      advertiseTags: '',
      sshServer: false,
      relayServerPort: '',
      resolveByName: false,
      acceptDefaultResolvers: false,
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
        advertiseTags: (ts?.advertiseTags || []).join(', '),
        sshServer: ts?.sshServer ?? false,
        relayServerPort: ts?.relayServerPort ? String(ts.relayServerPort) : '',
        resolveByName: ts?.resolveByName ?? false,
        acceptDefaultResolvers: ts?.acceptDefaultResolvers ?? false,
      });
    }
  }, [serverConfig, form]);

  const handleSubmit = async (values: TailscaleFormValues) => {
    const routes = splitTextList(values.routes);
    // relayServerPort：数字串 → 正整数；非法/空 → undefined（不下发）。
    const relayPortNum = Number(values.relayServerPort?.trim());
    const relayServerPort =
      values.relayServerPort?.trim() && Number.isInteger(relayPortNum) && relayPortNum > 0
        ? relayPortNum
        : undefined;
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
        // P4a endpoint 新字段
        advertiseTags: splitTextList(values.advertiseTags),
        sshServer: values.sshServer || undefined,
        relayServerPort,
        // P4b 按名解析：acceptDefaultResolvers 仅 resolveByName 开时有意义，关时不下发避免无效残留
        resolveByName: values.resolveByName || undefined,
        acceptDefaultResolvers:
          (values.resolveByName && values.acceptDefaultResolvers) || undefined,
      },
    };
    await onSubmit(config);
  };

  const allowInternet = form.watch('allowInternet');
  const reverseMesh = form.watch('reverseMesh');
  // 立即登录按钮（Phase 2）门控：填了 authKey → 走预授权、不需交互登录 → 隐藏按钮。
  const authKeyValue = form.watch('authKey');

  const exitNodeValue = form.watch('exitNode');

  // P4b：acceptDefaultResolvers 仅在按名解析开启时有意义 → 联动显隐 + 关闭时禁用。
  const resolveByName = form.watch('resolveByName');

  // 真实登录态（store 单一真值，与列表「需登录」角标同口径）：驱动登录区三态，替代纯静态 !authKey 门控。
  const serverId = serverConfig?.id;
  const loggedIn = useAppStore((s) => (serverId ? !!s.tailscaleLoginStates[serverId] : false));
  const setTailscaleLoginState = useAppStore((s) => s.setTailscaleLoginState);
  const loginUi = tailscaleLoginUiState(!!serverId, loggedIn, !!authKeyValue?.trim());

  // 退出登录：清该节点持久会话（state 目录），UI 即时回「需登录」态；运行中节点提示需重启生效。
  const handleTsLogout = async () => {
    if (!serverId) return;
    try {
      const { runningNeedsRestart } = await api.server.tailscaleLogout(serverId);
      setTailscaleLoginState(serverId, false);
      if (runningNeedsRestart) toast.info(t('servers.tsLogoutRestartHint'));
    } catch {
      toast.error(t('errors.operationFailed'));
    }
  };

  // 重新登录 / 切换账号：先清 state（绕过 startTailscaleLogin 的「state 仍在就拒登」障碍）→ 再走交互登录。
  const handleTsReauth = async () => {
    if (!serverConfig?.id) return;
    try {
      await api.server.tailscaleLogout(serverConfig.id);
      setTailscaleLoginState(serverConfig.id, false);
      await runTailscaleLogin(serverConfig);
    } catch {
      toast.error(t('errors.operationFailed'));
    }
  };

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
                    <FormDescription>
                      {loggedIn ? t('servers.tsLoggedInNoKeyHint') : t('servers.tsAuthKeyDesc')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldSpan>
            {/* 登录区三态（读真实 loggedIn 替代纯静态 !authKey 门控）：
                已登录 → 「✓ 已登录」+ 退出登录 + 重新登录；需登录（编辑态未登录未填 key）→ 立即登录；
                新建态（无 id）→ 引导先保存，不显示。 */}
            {loginUi === 'loggedIn' ? (
              <FieldSpan>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-1.5 text-sm text-success">
                    <Check className="h-4 w-4" />
                    {t('servers.tsLoggedIn', 'Logged in')}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleTsLogout()}
                    >
                      {t('servers.tsLogout', 'Log out')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleTsReauth()}
                    >
                      {t('servers.tsReauth', 'Re-login · switch account')}
                    </Button>
                  </div>
                </div>
              </FieldSpan>
            ) : loginUi === 'needsLogin' && serverConfig ? (
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
            ) : null}
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
            {/* P4a：endpoint 新字段（advertise_tags / ssh_server / relay_server_port），全可选。 */}
            <FieldSpan>
              <FormField
                control={form.control}
                name="advertiseTags"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.tsAdvertiseTags', 'Advertise tags')}</FormLabel>
                    <FormControl>
                      <Input placeholder="tag:server, tag:exit" {...field} />
                    </FormControl>
                    <FormDescription>
                      {t(
                        'servers.tsAdvertiseTagsDesc',
                        'ACL tags this node advertises to the tailnet (tag:*). Comma-separated.'
                      )}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldSpan>
            <FormField
              control={form.control}
              name="relayServerPort"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.tsRelayServerPort', 'Peer relay port')}</FormLabel>
                  <FormControl>
                    <Input type="number" min={1} max={65535} placeholder="0" {...field} />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'servers.tsRelayServerPortDesc',
                      'Listen port to act as a peer relay (inbound relay). Empty = off.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FieldSpan>
              <SwitchField
                control={form.control}
                name="sshServer"
                label={t('servers.tsSshServer', 'Tailscale SSH server')}
                tooltip={t(
                  'servers.tsSshServerDesc',
                  'Run a Tailscale SSH server on this node (tailnet:22, access governed by ACLs).'
                )}
              />
            </FieldSpan>
            {/* P4b tailnet 按名解析并入「高级」：accept_search_domain + preferred_by 强联动，与 doh.pub/google
                并存（仅 tailnet 短名/MagicDNS 名走此节点），仅当此节点被选中为主出口时生效（见 dns-builder）。 */}
            <FieldSpan>
              <SwitchField
                control={form.control}
                name="resolveByName"
                label={t('servers.tsResolveByName', 'Resolve tailnet names')}
                tooltip={t(
                  'servers.tsResolveByNameDesc',
                  'Resolve tailnet short names / MagicDNS names via this node (accept_search_domain + preferred_by). Coexists with your normal DNS — only tailnet names use it. Effective only when this node is the selected exit.'
                )}
              />
            </FieldSpan>
            {resolveByName && (
              <FieldSpan>
                <SwitchField
                  control={form.control}
                  name="acceptDefaultResolvers"
                  label={t('servers.tsAcceptDefaultResolvers', 'Accept tailnet default resolvers')}
                  tooltip={t(
                    'servers.tsAcceptDefaultResolversDesc',
                    'Also accept the default DNS resolvers pushed by the tailnet (split-DNS). Optional.'
                  )}
                />
              </FieldSpan>
            )}
          </FieldGrid>
        </FormSection>

        <FormButtons isSubmitting={form.formState.isSubmitting} onReset={() => form.reset()} />
      </form>
    </Form>
  );
}
