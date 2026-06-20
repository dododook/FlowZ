import * as z from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { AddressField, PortField } from './shared/basic-fields';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import { FormButtons } from './shared/form-buttons';
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
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        <FormSection title={t('servers.basic', 'Basic')}>
          <FieldGrid cols={2}>
            <AddressField control={form.control} t={t} />
            <PortField control={form.control} t={t} placeholder="443" />
            <FormField
              control={form.control}
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.username', 'Username')}</FormLabel>
                  <FormControl>
                    <Input placeholder="Enter username" {...field} />
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
                  <FormLabel>{t('servers.password', 'Password')}</FormLabel>
                  <FormControl>
                    <Input type="password" placeholder="Enter password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </FieldGrid>
        </FormSection>

        <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
          <FieldGrid cols={2}>
            <FieldSpan>
              <FormField
                control={form.control}
                name="tlsServerName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.sni')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('servers.sniPlaceholder')} {...field} />
                    </FormControl>
                    <FormDescription>{t('servers.sniDesc')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldSpan>
            <FieldSpan>
              <FormField
                control={form.control}
                name="useHttp3"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                    <div className="space-y-0.5">
                      <FormLabel className="flex items-center gap-1.5">
                        {t('servers.naive.useHttp3', 'HTTP/3 (QUIC)')}
                        <InfoTooltip content={t('servers.naive.useHttp3DescFull')} />
                      </FormLabel>
                      <FormDescription>{t('servers.naive.useHttp3Desc')}</FormDescription>
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
