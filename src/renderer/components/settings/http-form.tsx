import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Form, FormField, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { AddressField, PortField } from './shared/basic-fields';
import {
  TlsServerNameField,
  AllowInsecureField,
  TlsEngineField,
  TlsSpoofField,
} from './shared/tls-fields';
import { FieldGrid, FieldSpan } from './shared/form-layout';
import {
  tlsSpoofSchemaShape,
  tlsSpoofDefaults,
  readTlsSpoofDefault,
  buildTlsSpoofSettings,
} from './shared/field-schemas';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

const createHttpSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    username: z.string().optional(),
    password: z.string().optional(),
    isHttps: z.boolean(),
    tlsAllowInsecure: z.boolean(),
    tlsServerName: z.string().optional(),
    tlsEngine: z.string().optional(),
    ...tlsSpoofSchemaShape,
  });

type HttpFormValues = z.infer<ReturnType<typeof createHttpSchema>>;

interface HttpFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function HttpForm({ serverConfig, onSubmit }: HttpFormProps) {
  const { t } = useTranslation();
  const httpFormSchema = createHttpSchema(t);

  const getDefaultValues = (): HttpFormValues => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'http') {
      // 大小写归一：存量/导入 security 可能是 'TLS'——严格 === 'tls' 会误判 isHttps=false、隐藏 TLS 段。
      const isHttps = (serverConfig.security || '').toLowerCase() === 'tls';
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 80,
        username: serverConfig.username || '',
        password: serverConfig.password || '',
        isHttps,
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsEngine: serverConfig.tlsSettings?.engine || 'go',
        ...readTlsSpoofDefault(serverConfig),
      };
    }
    return {
      address: '',
      port: 80,
      username: '',
      password: '',
      isHttps: false,
      tlsAllowInsecure: false,
      tlsServerName: '',
      tlsEngine: 'go',
      ...tlsSpoofDefaults,
    };
  };

  const form = useForm<HttpFormValues>({
    resolver: zodResolver(httpFormSchema),
    defaultValues: getDefaultValues(),
  });

  const handleSubmit = async (values: HttpFormValues) => {
    const config: any = {
      protocol: 'http' as const,
      address: values.address,
      port: values.port,
      username: values.username || undefined,
      password: values.password || undefined,
      network: 'tcp',
      security: values.isHttps ? 'tls' : 'none',
    };

    if (values.isHttps) {
      config.tlsSettings = {
        serverName: values.tlsServerName?.trim() || undefined,
        allowInsecure: values.tlsAllowInsecure,
        engine: values.tlsEngine && values.tlsEngine !== 'go' ? values.tlsEngine : undefined,
        ...buildTlsSpoofSettings(values),
      };
    }

    await onSubmit(config);
  };

  const isHttps = form.watch('isHttps');

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
        <FieldGrid cols={2}>
          <AddressField control={form.control} t={t} />
          <PortField control={form.control} t={t} placeholder={isHttps ? '443' : '80'} />
          <FormField
            control={form.control}
            name="username"
            render={({ field }) => (
              <div className="nd-fld">
                <span className="nd-fld-lbl">
                  {t('servers.username')}{' '}
                  <small className="font-medium text-fg-faint">
                    {t('servers.optional', 'Optional')}
                  </small>
                </span>
                <Input placeholder={t('servers.usernamePlaceholder', 'Username')} {...field} />
                <FormMessage className="fld-err" />
              </div>
            )}
          />
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <div className="nd-fld">
                <span className="nd-fld-lbl">
                  {t('servers.password')}{' '}
                  <small className="font-medium text-fg-faint">
                    {t('servers.optional', 'Optional')}
                  </small>
                </span>
                <Input
                  type="password"
                  className="mono"
                  placeholder={t('servers.passwordPlaceholder', 'Password')}
                  {...field}
                />
                <FormMessage className="fld-err" />
              </div>
            )}
          />
          <FieldSpan>
            <FormField
              control={form.control}
              name="isHttps"
              render={({ field }) => (
                <div className="nd-swrow">
                  <div className="nd-swrow-main">
                    <div className="nd-swrow-t">{t('servers.httpsEnable', 'HTTPS/TLS')}</div>
                    <div className="nd-swrow-d">{t('servers.httpsEnableDesc')}</div>
                  </div>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </div>
              )}
            />
          </FieldSpan>
        </FieldGrid>

        {isHttps && (
          <FieldGrid cols={2}>
            <TlsServerNameField
              control={form.control}
              t={t}
              labelKey="servers.sni"
              descKey="servers.sniDesc"
              optional
            />
            <AllowInsecureField control={form.control} t={t} />
            <TlsEngineField control={form.control} t={t} />
            <TlsSpoofField control={form.control} t={t} />
          </FieldGrid>
        )}
      </form>
    </Form>
  );
}
