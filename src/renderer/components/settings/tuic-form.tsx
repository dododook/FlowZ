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
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EchField } from './shared/anti-censor-fields';
import { AddressField, PortField } from './shared/basic-fields';
import { TlsServerNameField, AllowInsecureField, AlpnField } from './shared/tls-fields';
import { FormButtons } from './shared/form-buttons';
import { echSchemaShape, echDefaults, readEchDefault } from './shared/field-schemas';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

const createTuicSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    uuid: z.string().min(1, t('servers.uuidRequired')),
    password: z.string().min(1, t('servers.passwordRequired')),
    congestionControl: z.enum(['bbr', 'cubic', 'new_reno']).optional(),
    udpRelayMode: z.enum(['native', 'quic']).optional(),
    zeroRttHandshake: z.boolean().optional(),
    heartbeat: z.string().optional(),
    tlsServerName: z.string().optional(),
    tlsAllowInsecure: z.boolean(),
    alpn: z.string().optional(),
    ...echSchemaShape,
  });

type TuicFormValues = z.infer<ReturnType<typeof createTuicSchema>>;

interface TuicFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function TuicForm({ serverConfig, onSubmit }: TuicFormProps) {
  const { t } = useTranslation();
  const tuicFormSchema = createTuicSchema(t);

  const form = useForm<TuicFormValues>({
    resolver: zodResolver(tuicFormSchema),
    defaultValues: {
      address: '',
      port: 443,
      uuid: '',
      password: '',
      congestionControl: 'bbr',
      udpRelayMode: 'native',
      zeroRttHandshake: false,
      heartbeat: '',
      tlsServerName: '',
      tlsAllowInsecure: false,
      alpn: 'h3',
      ...echDefaults,
    },
  });

  useEffect(() => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'tuic') {
      const formData: TuicFormValues = {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        uuid: serverConfig.uuid || '',
        password: serverConfig.password || '',
        congestionControl: serverConfig.tuicSettings?.congestionControl || 'bbr',
        udpRelayMode: serverConfig.tuicSettings?.udpRelayMode || 'native',
        zeroRttHandshake: serverConfig.tuicSettings?.zeroRttHandshake ?? false,
        heartbeat: serverConfig.tuicSettings?.heartbeat || '',
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
        alpn: serverConfig.tlsSettings?.alpn?.join(',') || 'h3',
        ...readEchDefault(serverConfig),
      };
      form.reset(formData);
    }
  }, [serverConfig, form]);

  const handleSubmit = async (values: TuicFormValues) => {
    const config: any = {
      protocol: 'tuic' as const,
      address: values.address,
      port: values.port,
      uuid: values.uuid,
      password: values.password,
      security: 'tls',
      tlsSettings: {
        serverName: values.tlsServerName || undefined,
        allowInsecure: values.tlsAllowInsecure,
        alpn: values.alpn ? values.alpn.split(',').map((s) => s.trim()) : undefined,
        ech: values.ech ? true : undefined,
        echConfig: values.echConfig?.trim() || undefined,
      },
      tuicSettings: {
        congestionControl: values.congestionControl || undefined,
        udpRelayMode: values.udpRelayMode || undefined,
        zeroRttHandshake: values.zeroRttHandshake || undefined,
        heartbeat: values.heartbeat?.trim() || undefined,
      },
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
            <FieldSpan>
              <FormField
                control={form.control}
                name="uuid"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>UUID</FormLabel>
                    <FormControl>
                      <Input placeholder="Enter UUID" {...field} />
                    </FormControl>
                    <FormDescription>{t('servers.tuicUuidDesc')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldSpan>
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
              name="congestionControl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.congestionControl')}</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="bbr" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="bbr">bbr</SelectItem>
                      <SelectItem value="cubic">cubic</SelectItem>
                      <SelectItem value="new_reno">new_reno</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="udpRelayMode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.udpRelayMode')}</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="native" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="native">native</SelectItem>
                      <SelectItem value="quic">quic</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="heartbeat"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.tuicHeartbeat')}</FormLabel>
                  <FormControl>
                    <Input placeholder="10s" {...field} />
                  </FormControl>
                  <FormDescription>{t('servers.tuicHeartbeatDesc')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <TlsServerNameField control={form.control} t={t} />
            <AlpnField control={form.control} t={t} placeholder="h3" />
            <FieldSpan>
              <AllowInsecureField control={form.control} t={t} />
            </FieldSpan>
            <FieldSpan>
              <EchField control={form.control} t={t} />
            </FieldSpan>
            <FieldSpan>
              <FormField
                control={form.control}
                name="zeroRttHandshake"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5 pr-3">
                      <FormLabel>{t('servers.tuicZeroRtt')}</FormLabel>
                      <FormDescription>{t('servers.tuicZeroRttDesc')}</FormDescription>
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
