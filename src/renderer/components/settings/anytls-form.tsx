import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Form, FormField, FormMessage } from '@/components/ui/form';
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
import { TlsServerNameField, FingerprintField, TlsAdvancedFields } from './shared/tls-fields';
import { RealityPublicKeyField, RealityShortIdField } from './shared/reality-fields';
import {
  echSchemaShape,
  echDefaults,
  readEchDefault,
  tlsSpoofSchemaShape,
  tlsSpoofDefaults,
  readTlsSpoofDefault,
  buildTlsSpoofSettings,
} from './shared/field-schemas';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

// 注意：zod schema 在组件外，我们需要在组件内使用 useTranslation 或者保留这里，并在渲染时翻译错误。
// 为了简单起见，这里我们保持默认中文，并在下面使用 t() 覆盖，或者直接在 FormMessage 处处理（比较复杂）。
// 更好的做法是将 schema 的构建移到组件内部，或者接受 t 函数。
// 这里我们将 schema 的构建移到组件内部，以便使用 t()。
// 所以我们移除外部定义的 schema。
// 我们可以创建一个动态创建 schema 的函数
const createAnyTlsSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    password: z.string().min(1, t('servers.passwordRequired')),
    security: z.enum(['tls', 'reality']),
    tlsServerName: z.string().optional(),
    tlsFingerprint: z.string().optional(),
    tlsEngine: z.string().optional(),
    tlsAllowInsecure: z.boolean(),
    realityPublicKey: z.string().optional(),
    realityShortId: z.string().optional(),
    idleSessionCheckInterval: z.string().optional(),
    idleSessionTimeout: z.string().optional(),
    minIdleSession: z.number().int().min(0).optional(),
    ...echSchemaShape,
    ...tlsSpoofSchemaShape,
  });

type AnyTlsFormValues = z.infer<ReturnType<typeof createAnyTlsSchema>>;

interface AnyTlsFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function AnyTlsForm({ serverConfig, onSubmit }: AnyTlsFormProps) {
  const { t } = useTranslation();
  const anyTlsFormSchema = createAnyTlsSchema(t);

  const getDefaultValues = (): AnyTlsFormValues => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'anytls') {
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        password: serverConfig.password || '',
        security: (serverConfig.security === 'reality' ? 'reality' : 'tls') as 'tls' | 'reality',
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsFingerprint: serverConfig.tlsSettings?.fingerprint || 'chrome',
        tlsEngine: serverConfig.tlsSettings?.engine || 'go',
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
        realityPublicKey: serverConfig.realitySettings?.publicKey || '',
        realityShortId: serverConfig.realitySettings?.shortId || '',
        idleSessionCheckInterval: serverConfig.anyTlsSettings?.idleSessionCheckInterval || '',
        idleSessionTimeout: serverConfig.anyTlsSettings?.idleSessionTimeout || '',
        minIdleSession: serverConfig.anyTlsSettings?.minIdleSession ?? undefined,
        ...readEchDefault(serverConfig),
        ...readTlsSpoofDefault(serverConfig),
      };
    }
    return {
      address: '',
      port: 443,
      password: '',
      security: 'tls',
      tlsServerName: '',
      tlsFingerprint: 'chrome',
      tlsEngine: 'go',
      tlsAllowInsecure: false,
      realityPublicKey: '',
      realityShortId: '',
      idleSessionCheckInterval: '',
      idleSessionTimeout: '',
      minIdleSession: undefined,
      ...echDefaults,
      ...tlsSpoofDefaults,
    };
  };

  const form = useForm<AnyTlsFormValues>({
    resolver: zodResolver(anyTlsFormSchema),
    defaultValues: getDefaultValues(),
  });

  const handleSubmit = async (values: AnyTlsFormValues) => {
    const config: any = {
      protocol: 'anytls' as const,
      address: values.address,
      port: values.port,
      password: values.password,
      security: values.security,
      tlsSettings: {
        serverName: values.tlsServerName?.trim() || undefined,
        fingerprint: values.tlsFingerprint || 'chrome',
        engine:
          values.security === 'tls' && values.tlsEngine && values.tlsEngine !== 'go'
            ? values.tlsEngine
            : undefined,
        allowInsecure: values.security === 'tls' ? values.tlsAllowInsecure : false,
        ech: values.ech ? true : undefined,
        echConfig: values.echConfig?.trim() || undefined,
        ...(values.security === 'tls' ? buildTlsSpoofSettings(values) : {}),
      },
    };

    if (values.security === 'reality') {
      config.realitySettings = {
        publicKey: values.realityPublicKey?.trim() || '',
        shortId: values.realityShortId?.trim() || undefined,
      };
    }

    // 会话保活（全可选；任一填写才下发 anyTlsSettings）
    const anyTlsSettings: any = {};
    if (values.idleSessionCheckInterval?.trim())
      anyTlsSettings.idleSessionCheckInterval = values.idleSessionCheckInterval.trim();
    if (values.idleSessionTimeout?.trim())
      anyTlsSettings.idleSessionTimeout = values.idleSessionTimeout.trim();
    if (values.minIdleSession != null) anyTlsSettings.minIdleSession = values.minIdleSession;
    if (Object.keys(anyTlsSettings).length > 0) config.anyTlsSettings = anyTlsSettings;

    await onSubmit(config);
  };

  const isTls = form.watch('security') === 'tls';
  const isReality = form.watch('security') === 'reality';

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="flex flex-col gap-[13px]">
        <FieldGrid cols={2}>
          <AddressField control={form.control} t={t} />
          <PortField control={form.control} t={t} placeholder="443" />
          <FieldSpan>
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    {t('servers.password')} <span className="nd-req">*</span>
                  </span>
                  <Input
                    type="password"
                    className="mono"
                    placeholder={t('servers.passwordPlaceholder')}
                    {...field}
                  />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldSpan>
          <FieldSpan>
            <FormField
              control={form.control}
              name="security"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.securityType')}</span>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tls">TLS</SelectItem>
                      <SelectItem value="reality">Reality</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldSpan>
        </FieldGrid>
        {/* Reality：security=reality 时 publicKey 为条件必填 → 放基础（不入折叠高级）。 */}
        {isReality && (
          <div className="nd-fset">
            <div className="nd-fset-h">
              Reality{' '}
              <span className="nd-badge">
                {t('servers.realityRequiredWhen', 'security=Reality')}
              </span>
            </div>
            <FieldGrid cols={2}>
              <TlsServerNameField
                control={form.control}
                t={t}
                labelKey="servers.realityTarget"
                descKey="servers.realityTargetDesc"
                placeholder="www.microsoft.com"
              />
              <FingerprintField control={form.control} t={t} />
              <FieldSpan>
                <RealityPublicKeyField control={form.control} t={t} />
              </FieldSpan>
              <FieldSpan>
                <RealityShortIdField control={form.control} t={t} />
              </FieldSpan>
            </FieldGrid>
          </div>
        )}

        {/* 高级仅 TLS 模式有可选项（SNI/指纹/insecure/ECH）；Reality 模式全为基础项，故无高级区。 */}
        {isTls && (
          <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
            <TlsAdvancedFields
              control={form.control}
              t={t}
              sniLabelKey="servers.sni"
              sniDescKey="servers.sniDesc"
              sniOptional
            />
          </FormSection>
        )}

        <FormSection
          title={t('servers.anytls.sessionTitle', 'Session keep-alive')}
          collapsible
          defaultOpen={false}
        >
          <FieldGrid cols={2}>
            <FormField
              control={form.control}
              name="idleSessionCheckInterval"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    {t('servers.anytls.idleCheckInterval', 'Idle check interval')}
                  </span>
                  <Input placeholder="30s" {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FormField
              control={form.control}
              name="idleSessionTimeout"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    {t('servers.anytls.idleTimeout', 'Idle session timeout')}
                  </span>
                  <Input placeholder="30s" {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FormField
              control={form.control}
              name="minIdleSession"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    {t('servers.anytls.minIdleSession', 'Min idle sessions')}
                  </span>
                  <Input
                    type="number"
                    min={0}
                    placeholder="0"
                    {...field}
                    value={field.value ?? ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      field.onChange(val ? parseInt(val) : undefined);
                    }}
                  />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldGrid>
        </FormSection>

        <FormButtons isSubmitting={form.formState.isSubmitting} onReset={() => form.reset()} />
      </form>
    </Form>
  );
}
