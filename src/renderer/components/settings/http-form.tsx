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
import { Checkbox } from '@/components/ui/checkbox';
import { FormButtons } from './shared/form-buttons';
import { AddressField, PortField } from './shared/basic-fields';
import {
  TlsServerNameField,
  AllowInsecureField,
  TlsEngineField,
  TlsSpoofField,
} from './shared/tls-fields';
import { FormSection, FieldGrid } from './shared/form-layout';
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
      const isHttps = serverConfig.security === 'tls';
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
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        <FormSection title={t('servers.basic', 'Basic')}>
          <FieldGrid cols={2}>
            <AddressField control={form.control} t={t} />
            <PortField control={form.control} t={t} placeholder={isHttps ? '443' : '80'} />
            <FormField
              control={form.control}
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {t('servers.username')} ({t('servers.optional', 'Optional')})
                  </FormLabel>
                  <FormControl>
                    <Input placeholder={t('servers.usernamePlaceholder', 'Username')} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {t('servers.password')} ({t('servers.optional', 'Optional')})
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder={t('servers.passwordPlaceholder', 'Password')}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="isHttps"
              render={({ field }) => (
                <FormItem className="flex flex-row items-start space-x-3 rtl:space-x-reverse space-y-0">
                  <FormControl>
                    <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <div className="space-y-1 leading-none">
                    <FormLabel>{t('servers.httpsEnable', 'HTTPS/TLS')}</FormLabel>
                    <FormDescription>{t('servers.httpsEnableDesc')}</FormDescription>
                  </div>
                </FormItem>
              )}
            />
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
        </FormSection>

        <FormButtons isSubmitting={form.formState.isSubmitting} onReset={() => form.reset()} />
      </form>
    </Form>
  );
}
