import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
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
import { Loader2 } from 'lucide-react';
import { EchField } from './shared/anti-censor-fields';
import { AddressField, PortField } from './shared/basic-fields';
import { TlsServerNameField, AllowInsecureField } from './shared/tls-fields';
import { echSchemaShape, echDefaults, readEchDefault } from './shared/field-schemas';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

const createHysteria2Schema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    password: z.string().min(1, t('servers.passwordRequired')),
    // 带宽限制
    upMbps: z.number().optional(),
    downMbps: z.number().optional(),
    // 混淆设置
    obfsEnabled: z.boolean(),
    obfsPassword: z.string().optional(),
    // TLS 设置
    tlsServerName: z.string().optional(),
    tlsAllowInsecure: z.boolean(),
    // ECH
    ...echSchemaShape,
    // 端口跳跃
    serverPorts: z.string().optional(),
    hopInterval: z.string().optional(),
  });

type Hysteria2FormValues = z.infer<ReturnType<typeof createHysteria2Schema>>;

interface Hysteria2FormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function Hysteria2Form({ serverConfig, onSubmit }: Hysteria2FormProps) {
  const { t } = useTranslation();
  const hysteria2FormSchema = createHysteria2Schema(t);

  const form = useForm<Hysteria2FormValues>({
    resolver: zodResolver(hysteria2FormSchema),
    defaultValues: {
      address: '',
      port: 443,
      password: '',
      upMbps: undefined,
      downMbps: undefined,
      obfsEnabled: false,
      obfsPassword: '',
      tlsServerName: '',
      tlsAllowInsecure: false,
      ...echDefaults,
      serverPorts: '',
      hopInterval: '',
    },
  });

  useEffect(() => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'hysteria2') {
      const formData = {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        password: serverConfig.password || '',
        upMbps: serverConfig.hysteria2Settings?.upMbps ?? undefined,
        downMbps: serverConfig.hysteria2Settings?.downMbps ?? undefined,
        obfsEnabled: !!serverConfig.hysteria2Settings?.obfs?.type,
        obfsPassword: serverConfig.hysteria2Settings?.obfs?.password || '',
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
        ...readEchDefault(serverConfig),
        serverPorts: serverConfig.hysteria2Settings?.serverPorts || '',
        hopInterval: serverConfig.hysteria2Settings?.hopInterval || '',
      };
      form.reset(formData);
    }
  }, [serverConfig, form]);

  const handleSubmit = async (values: Hysteria2FormValues) => {
    const serverConfig: any = {
      protocol: 'hysteria2' as const,
      address: values.address,
      port: values.port,
      password: values.password,
      // Hysteria2 总是使用 TLS
      security: 'tls',
      tlsSettings: {
        serverName: values.tlsServerName || undefined,
        allowInsecure: values.tlsAllowInsecure,
        ech: values.ech ? true : undefined,
        echConfig: values.echConfig?.trim() || undefined,
      },
      hysteria2Settings: {
        upMbps: values.upMbps || undefined,
        downMbps: values.downMbps || undefined,
        obfs:
          values.obfsEnabled && values.obfsPassword
            ? {
                type: 'salamander',
                password: values.obfsPassword,
              }
            : undefined,
        serverPorts: values.serverPorts?.trim() || undefined,
        hopInterval: values.hopInterval?.trim() || undefined,
      },
    };

    await onSubmit(serverConfig);
  };

  const isObfsEnabled = form.watch('obfsEnabled');

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
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
                    <FormLabel>{t('servers.password')}</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        placeholder={t('servers.passwordPlaceholder')}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>{t('servers.passwordDesc')}</FormDescription>
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
              name="upMbps"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.upMbps')}</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder={t('servers.optional')}
                      {...field}
                      value={field.value ?? ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        field.onChange(val ? parseInt(val) : undefined);
                      }}
                    />
                  </FormControl>
                  <FormDescription>{t('servers.bbrDesc')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="downMbps"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.downMbps')}</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder={t('servers.optional')}
                      {...field}
                      value={field.value ?? ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        field.onChange(val ? parseInt(val) : undefined);
                      }}
                    />
                  </FormControl>
                  <FormDescription>{t('servers.bbrDesc')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FieldSpan>
              <FormField
                control={form.control}
                name="obfsEnabled"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                    <FormControl>
                      <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel>{t('servers.obfsEnabled')}</FormLabel>
                      <FormDescription>{t('servers.obfsEnabledDesc')}</FormDescription>
                    </div>
                  </FormItem>
                )}
              />
            </FieldSpan>
            {isObfsEnabled && (
              <FieldSpan>
                <FormField
                  control={form.control}
                  name="obfsPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('servers.obfsPassword')}</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder={t('servers.obfsPasswordPlaceholder')}
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>{t('servers.obfsPasswordDesc')}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </FieldSpan>
            )}
            <TlsServerNameField control={form.control} t={t} />
            <FieldSpan>
              <AllowInsecureField control={form.control} t={t} />
            </FieldSpan>
            <FieldSpan>
              <EchField control={form.control} t={t} />
            </FieldSpan>
            <FormField
              control={form.control}
              name="serverPorts"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.hopPorts', '端口跳跃范围')}</FormLabel>
                  <FormControl>
                    <Input placeholder="20000:30000,40000:50000" {...field} />
                  </FormControl>
                  <FormDescription>
                    {t(
                      'servers.hopPortsDesc',
                      '逗号分隔的端口范围，如 20000:30000,40000:50000。留空则不启用。'
                    )}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="hopInterval"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.hopInterval', '跳跃间隔')}</FormLabel>
                  <FormControl>
                    <Input placeholder="30s" {...field} />
                  </FormControl>
                  <FormDescription>
                    {t('servers.hopIntervalDesc', '端口跳跃的时间间隔，如 30s。留空使用默认值。')}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </FieldGrid>
        </FormSection>

        <div className="flex gap-4">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('common.save')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => form.reset()}
            disabled={form.formState.isSubmitting}
          >
            {t('common.reset')}
          </Button>
        </div>
      </form>
    </Form>
  );
}
