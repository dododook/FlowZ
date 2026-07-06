import { useEffect, useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormButtons } from './shared/form-buttons';
import { AddressField, PortField } from './shared/basic-fields';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import { SwitchField } from './shared/switch-field';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';
import { api } from '@/ipc';
import { compareSemver } from '../../../shared/version';
import { comparableCoreVersion } from '../../../shared/core-build';

/** 官方 snell outbound 的最低内核版本（sing-box 1.14.0-alpha.38 落地，此前仅 fork 核）。 */
const SNELL_MIN_CORE = '1.14.0-alpha.38';

// Snell（sing-box 1.14.0-alpha.38+ 官方 outbound）：psk 进通用 password（同 trojan/hysteria2 惯例），
// version 4|6 为主开关——obfs*（仅 v4）与 mode（仅 v6）互斥，按 version 条件渲染，提交时 normalize
// 只保留当前 version 对应字段，防脏字段下发。分享链/订阅解析（snell:// 事实形态 + Clash + sing-box JSON）
// 见 ProtocolParser.parseSnell / ClashSubscriptionParser / SubscriptionService.parseSingboxOutbounds。
const createSnellSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    password: z.string().min(1, t('servers.snell.pskRequired', 'PSK is required')),
    version: z.enum(['4', '6']),
    obfsMode: z.enum(['none', 'http']),
    obfsHost: z.string().optional(),
    mode: z.enum(['default', 'unshaped', 'unsafe-raw']),
    reuse: z.boolean(),
    network: z.enum(['both', 'tcp', 'udp']),
    userkey: z.string().optional(),
  });

type SnellFormValues = z.infer<ReturnType<typeof createSnellSchema>>;

interface SnellFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function SnellForm({ serverConfig, onSubmit }: SnellFormProps) {
  const { t } = useTranslation();
  const snellFormSchema = createSnellSchema(t);

  // 软提示（非阻塞）：当前核 < alpha.38（无官方 snell）→ 表单顶部提示更新内核，仍允许保存（配置在启动
  // sing-box check gate 被拒时有既有报错兜底）。版本经 comparableCoreVersion 规范化再比（fork/dev 完整
  // token 直喂 compareSemver 会误判，见 core-build 注释）；取不到/不可解析（'未知' 等）→ 不提示，不误报。
  const [coreLacksSnell, setCoreLacksSnell] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.coreUpdate
      .getVersionInfo()
      .then((info) => {
        if (cancelled) return;
        const cur = comparableCoreVersion(info.currentVersion);
        if (/^\d+\.\d+/.test(cur) && compareSemver(cur, SNELL_MIN_CORE) < 0) {
          setCoreLacksSnell(true);
        }
      })
      .catch(() => {
        /* 拿不到版本信息 → 不提示 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const getDefaultValues = (): SnellFormValues => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'snell') {
      const s = serverConfig.snellSettings;
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        password: serverConfig.password || '',
        version: s?.version === 6 ? '6' : '4',
        obfsMode: s?.obfsMode === 'http' ? 'http' : 'none',
        obfsHost: s?.obfsHost || '',
        mode: s?.mode || 'default',
        reuse: s?.reuse || false,
        network: s?.network || 'both',
        userkey: s?.userkey || '',
      };
    }
    return {
      address: '',
      port: 443,
      password: '',
      version: '4',
      obfsMode: 'none',
      obfsHost: '',
      mode: 'default',
      reuse: false,
      network: 'both',
      userkey: '',
    };
  };

  const form = useForm<SnellFormValues>({
    resolver: zodResolver(snellFormSchema),
    defaultValues: getDefaultValues(),
  });

  const handleSubmit = async (values: SnellFormValues) => {
    const version = values.version === '6' ? 6 : 4;
    // normalize：按 version 只保留对应互斥字段（v4 清 mode / v6 清 obfs_*），切换 version 后旧值不脏下发。
    const snellSettings: any = { version };
    if (version === 4) {
      if (values.obfsMode === 'http') {
        snellSettings.obfsMode = 'http';
        snellSettings.obfsHost = values.obfsHost?.trim() || undefined; // 空 = 构建侧默认 bing.com
      }
    } else if (values.mode !== 'default') {
      snellSettings.mode = values.mode;
    }
    if (values.reuse) snellSettings.reuse = true;
    if (values.network !== 'both') snellSettings.network = values.network;
    if (values.userkey?.trim()) snellSettings.userkey = values.userkey.trim();

    await onSubmit({
      protocol: 'snell' as const,
      address: values.address,
      port: values.port,
      password: values.password,
      snellSettings,
    });
  };

  const isV4 = form.watch('version') === '4';
  const isObfsHttp = form.watch('obfsMode') === 'http';

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        {coreLacksSnell && (
          <div className="rounded-md border border-amber-300/50 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-400">
            {t(
              'servers.snell.coreTooOld',
              'Current core does not include Snell (requires sing-box 1.14.0-alpha.38+). Update the core before connecting.'
            )}
          </div>
        )}
        <FormSection title={t('servers.basic', 'Basic')}>
          <FieldGrid cols={2}>
            <AddressField control={form.control} t={t} />
            <PortField control={form.control} t={t} placeholder="443" />
            <FieldSpan>
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.snell.psk', 'PSK')}</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        placeholder={t('servers.snell.pskPlaceholder', 'Pre-shared key')}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      {t('servers.snell.pskDesc', 'Pre-shared key of the Snell server.')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldSpan>
            <FormField
              control={form.control}
              name="version"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.snell.version', 'Version')}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="4">v4</SelectItem>
                      <SelectItem value="6">v6</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {t(
                      'servers.snell.versionDesc',
                      'Protocol version; must match the server. v4 supports HTTP obfuscation, v6 supports transfer modes.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            {/* v4：obfs 分支（none|http）；http 时显 Host。v6：mode 分支。互斥，按 version 条件渲染。 */}
            {isV4 ? (
              <FormField
                control={form.control}
                name="obfsMode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.snell.obfsMode', 'Obfuscation')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">{t('servers.snell.obfsNone', 'None')}</SelectItem>
                        <SelectItem value="http">HTTP</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      {t('servers.snell.obfsModeDesc', 'v4 only. Must match the server config.')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <FormField
                control={form.control}
                name="mode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.snell.mode', 'Mode')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="default">default</SelectItem>
                        <SelectItem value="unshaped">unshaped</SelectItem>
                        <SelectItem value="unsafe-raw">unsafe-raw</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      {t('servers.snell.modeDesc', 'v6 only transfer mode; leave default unless the server requires otherwise.')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {isV4 && isObfsHttp && (
              <FieldSpan>
                <FormField
                  control={form.control}
                  name="obfsHost"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('servers.snell.obfsHost', 'Obfuscation Host')}</FormLabel>
                      <FormControl>
                        <Input placeholder="bing.com" {...field} />
                      </FormControl>
                      <FormDescription>
                        {t(
                          'servers.snell.obfsHostDesc',
                          'HTTP Host header for obfuscation. Defaults to bing.com.'
                        )}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </FieldSpan>
            )}
          </FieldGrid>
        </FormSection>

        <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
          <FieldGrid cols={2}>
            <FormField
              control={form.control}
              name="network"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.snell.network', 'Network')}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="both">{t('servers.snell.networkBoth', 'TCP + UDP')}</SelectItem>
                      <SelectItem value="tcp">TCP</SelectItem>
                      <SelectItem value="udp">UDP</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {t('servers.snell.networkDesc', 'Enabled transport; default both.')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="userkey"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.snell.userkey', 'User Key')}</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder={t('servers.snell.userkeyPlaceholder', 'Optional')}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'servers.snell.userkeyDesc',
                      'Authentication key on multi-user servers; leave empty otherwise.'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FieldSpan>
              <SwitchField
                control={form.control}
                name="reuse"
                label={t('servers.snell.reuse', 'Connection reuse')}
                tooltip={t('servers.snell.reuseDesc', 'Reuse connections (v2 CONNECT). Default off.')}
              />
            </FieldSpan>
          </FieldGrid>
        </FormSection>

        <FormButtons isSubmitting={form.formState.isSubmitting} onReset={() => form.reset()} />
      </form>
    </Form>
  );
}
