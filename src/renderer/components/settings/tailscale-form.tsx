import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { toast } from 'sonner';
import { Check } from 'lucide-react';
import { Form, FormField, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '@/ipc/api-client';
import { useAppStore } from '@/store/app-store';
import { runTailscaleLogin } from '../../lib/tailscale-login';
import { tailscaleLoginUiState } from './server-list-helpers';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import { SwitchField } from './shared/switch-field';
import { ExitNodeField } from './shared/exit-node-field';
import { AccessModeField, SubnetReachabilitySwitch } from './shared/mesh-fields';
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
  // 单例连接卡复用本表单作「设置」时传 true：隐藏内嵌登录区（连接/断开/重登已由卡片统一承载，避免双入口语义打架）。
  hideLoginSection?: boolean;
}

export function TailscaleForm({ serverConfig, onSubmit, hideLoginSection }: TailscaleFormProps) {
  const { t } = useTranslation();

  const form = useForm<TailscaleFormValues>({
    resolver: zodResolver(createTailscaleSchema()),
    defaultValues: {
      authKey: '',
      allowInternet: true,
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
        reverseMesh: ts?.reverseMesh === true,
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
        // allowInternet（TS 全隧道意图）由「是否选了出口节点」派生：选了=经 exit 全量出网；无=仅 mesh/子网。
        // exit_node≠0/0，与 reverseMesh(system) 正交（见 meshNodeCarriesFullTunnel 协议口径 + 设计 §3）。
        allowInternet: !!values.exitNode?.trim(),
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

  // 立即登录按钮（Phase 2）门控：填了 authKey → 走预授权、不需交互登录 → 隐藏按钮。
  const authKeyValue = form.watch('authKey');

  const exitNodeValue = form.watch('exitNode');

  // P4b：acceptDefaultResolvers 仅在按名解析开启时有意义 → 联动显隐 + 关闭时禁用。
  const resolveByName = form.watch('resolveByName');

  // 真实登录态（store 单一真值，与列表「需登录」角标同口径）：驱动登录区三态，替代纯静态 !authKey 门控。
  const serverId = serverConfig?.id;
  const loggedIn = useAppStore((s) => (serverId ? !!s.tailscaleLoginStates[serverId] : false));
  // 登录中：已产生 authUrl（点了登录、瞬态核在等浏览器授权 + STATUS 同步到 Running）且未登录成功。
  const hasAuthUrl = useAppStore((s) =>
    serverId ? s.tailscaleAuthUrls[serverId] !== undefined : false
  );
  const loggingIn = hasAuthUrl && !loggedIn;
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
      <form
        id="node-cfg-form"
        onSubmit={form.handleSubmit(handleSubmit)}
        onReset={(e) => {
          e.preventDefault();
          form.reset();
        }}
        className="flex flex-col gap-[13px]"
      >
        {/* 基础：仅出网必需项（账号 + 出口节点）。 */}
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
                <div className="nd-fld">
                  <span className="nd-fld-lbl inline-flex items-center gap-1.5">
                    {t('servers.tsAuthKey', 'Auth Key (optional)')}
                    <InfoTooltip content={t('servers.tsAuthKeyDescFull')} />
                  </span>
                  <Input type="password" placeholder="tskey-auth-..." {...field} className="mono" />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldSpan>
          {/* 登录区三态（读真实 loggedIn 替代纯静态 !authKey 门控）：
              已登录 → 「✓ 已登录」+ 退出登录 + 重新登录；需登录（编辑态未登录未填 key）→ 立即登录；
              新建态（无 id）→ 引导先保存，不显示。 */}
          {!hideLoginSection &&
            (loginUi === 'loggedIn' ? (
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
                    disabled={loggingIn}
                    onClick={() => void runTailscaleLogin(serverConfig)}
                  >
                    {loggingIn
                      ? t('servers.tsLoggingIn', '登录中…')
                      : t('servers.tsLoginNow', 'Log in now')}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {loggingIn
                      ? t(
                          'servers.tsLoggingInDesc',
                          '已打开浏览器，请完成授权；登录成功后会自动更新（无需重开）。'
                        )
                      : t(
                          'servers.tsLoginNowDesc',
                          'Open the browser now to complete Tailscale login (no auth key needed).'
                        )}
                  </p>
                </div>
              </FieldSpan>
            ) : null)}
        </FieldGrid>

        {/* 接入与出口（常显）：接入模式（用户态/System）+ 出口节点。出口两模式可用（exit_node≠0/0 不触发 F4），
            故不再受 reverseMesh/allowInternet 门控；allowInternet 由「是否选了出口」在 handleSubmit 派生。 */}
        <FormSection title={t('servers.accessAndExit', 'Access & exit')}>
          <AccessModeField control={form.control} />
          <FormField
            control={form.control}
            name="exitNode"
            render={({ field }) => (
              <div className="nd-fld">
                <span className="nd-fld-lbl">
                  {t('servers.tsExitNode', 'Exit node')}{' '}
                  <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                </span>
                <ExitNodeField
                  value={field.value || ''}
                  onChange={field.onChange}
                  serverId={serverConfig?.id}
                />
                <FormMessage className="fld-err" />
              </div>
            )}
          />
          {exitNodeValue?.trim() && (
            <SwitchField
              control={form.control}
              name="exitNodeAllowLanAccess"
              label={t('servers.tsExitNodeAllowLan', 'Allow LAN access via exit node')}
              tooltip={t(
                'servers.tsExitNodeAllowLanDesc',
                'When using an exit node, still reach the local LAN directly instead of routing it through the exit.'
              )}
            />
          )}
        </FormSection>

        {/* 子网路由（组网，折叠）：子网恒可达开关 + 接受/录入路由子网。 */}
        <FormSection
          title={t('servers.tsSubnetRouting', 'Subnet routing (mesh)')}
          collapsible
          defaultOpen={false}
        >
          <SubnetReachabilitySwitch control={form.control} protocol="tailscale" />
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
              <div className="nd-fld">
                <span className="nd-fld-lbl inline-flex items-center gap-1.5">
                  {t('servers.tsRoutes', 'Routed subnets')}
                  <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                  <InfoTooltip content={t('servers.tsRoutesDescFull')} />
                </span>
                <Input placeholder="192.168.50.0/24, 10.0.0.0/24" {...field} />
                <FormMessage className="fld-err" />
              </div>
            )}
          />
        </FormSection>

        <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
          <FieldGrid cols={2}>
            <FormField
              control={form.control}
              name="hostname"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    {t('servers.tsHostname', 'Hostname')}{' '}
                    <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                  </span>
                  <Input placeholder="my-device" {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FormField
              control={form.control}
              name="controlUrl"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    {t('servers.tsControlUrl', 'Control URL')}{' '}
                    <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                  </span>
                  <Input placeholder="https://controlplane.tailscale.com" {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FieldSpan>
              <FormField
                control={form.control}
                name="advertiseRoutes"
                render={({ field }) => (
                  <div className="nd-fld">
                    <span className="nd-fld-lbl">
                      {t('servers.tsAdvertiseRoutes', 'Advertise Routes')}{' '}
                      <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                    </span>
                    <Input placeholder="192.168.1.0/24, 10.0.0.0/24" {...field} />
                    <FormMessage className="fld-err" />
                  </div>
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
                  <div className="nd-fld">
                    <span className="nd-fld-lbl">
                      {t('servers.tsAdvertiseTags', 'Advertise tags')}{' '}
                      <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                    </span>
                    <Input placeholder="tag:server, tag:exit" {...field} />
                    <FormMessage className="fld-err" />
                  </div>
                )}
              />
            </FieldSpan>
            <FormField
              control={form.control}
              name="relayServerPort"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    {t('servers.tsRelayServerPort', 'Peer relay port')}{' '}
                    <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                  </span>
                  <Input type="number" min={1} max={65535} placeholder="0" {...field} />
                  <FormMessage className="fld-err" />
                </div>
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
      </form>
    </Form>
  );
}
