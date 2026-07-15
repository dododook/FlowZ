import * as z from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { Form, FormField, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { AddressField, PortField } from './shared/basic-fields';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import { InfoTooltip } from './shared/info-tooltip';
import type { ServerConfig } from '@/bridge/types';

const createNaiveSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.serverAddressRequired', 'Address is required')),
    port: z.number().min(1).max(65535),
    username: z.string().min(1, t('servers.usernameRequired', 'Username is required')),
    password: z.string().min(1, t('servers.passwordRequired')),
    tlsServerName: z.string().optional(),
    useHttp3: z.boolean().optional(),
  });

type NaiveFormValues = z.infer<ReturnType<typeof createNaiveSchema>>;

interface NaiveFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: Partial<ServerConfig>) => Promise<void>;
}

export function NaiveForm({ serverConfig, onSubmit }: NaiveFormProps) {
  const { t } = useTranslation();
  const naiveFormSchema = createNaiveSchema(t);

  const getDefaultValues = (): NaiveFormValues => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'naive') {
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        username: serverConfig.username || '',
        password: serverConfig.password || '',
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        useHttp3: serverConfig.naiveSettings?.useHttp3 ?? false,
      };
    }
    return {
      address: '',
      port: 443,
      username: '',
      password: '',
      tlsServerName: '',
      useHttp3: false,
    };
  };

  const form = useForm<NaiveFormValues>({
    resolver: zodResolver(naiveFormSchema),
    defaultValues: getDefaultValues(),
  });

  const handleSubmit = async (values: NaiveFormValues) => {
    const config: Partial<ServerConfig> = {
      protocol: 'naive',
      address: values.address,
      port: values.port,
      username: values.username,
      password: values.password,
      network: 'tcp',
      security: 'tls',
      tlsSettings: {
        serverName: values.tlsServerName?.trim() || undefined,
        allowInsecure: false,
      },
      naiveSettings: values.useHttp3 ? { useHttp3: true } : undefined,
    };
    await onSubmit(config);
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
        <FieldGrid cols={2}>
          <AddressField control={form.control} t={t} />
          <PortField control={form.control} t={t} placeholder="443" />
          <FormField
            control={form.control}
            name="username"
            render={({ field }) => (
              <div className="nd-fld">
                <span className="nd-fld-lbl">
                  {t('servers.username', 'Username')} <span className="nd-req">*</span>
                </span>
                <Input placeholder="Enter username" {...field} />
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
                  {t('servers.password', 'Password')} <span className="nd-req">*</span>
                </span>
                <Input type="password" className="mono" placeholder="Enter password" {...field} />
                <FormMessage className="fld-err" />
              </div>
            )}
          />
        </FieldGrid>

        <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
          <FieldGrid cols={2}>
            <FieldSpan>
              <FormField
                control={form.control}
                name="tlsServerName"
                render={({ field }) => (
                  <div className="nd-fld">
                    <span className="nd-fld-lbl">{t('servers.sni')}</span>
                    <Input placeholder={t('servers.sniPlaceholder')} {...field} />
                    <FormMessage className="fld-err" />
                  </div>
                )}
              />
            </FieldSpan>
            <FieldSpan>
              <FormField
                control={form.control}
                name="useHttp3"
                render={({ field }) => (
                  <div className="nd-swrow">
                    <div className="nd-swrow-main">
                      <div className="nd-swrow-t inline-flex items-center gap-1.5">
                        {t('servers.naive.useHttp3', 'HTTP/3 (QUIC)')}
                        <InfoTooltip content={t('servers.naive.useHttp3DescFull')} />
                      </div>
                      <div className="nd-swrow-d">{t('servers.naive.useHttp3Desc')}</div>
                    </div>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </div>
                )}
              />
            </FieldSpan>
          </FieldGrid>
        </FormSection>
      </form>
    </Form>
  );
}
