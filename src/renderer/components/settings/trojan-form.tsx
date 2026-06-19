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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EchField, MultiplexFields } from './shared/anti-censor-fields';
import { AddressField, PortField } from './shared/basic-fields';
import {
  TlsServerNameField,
  FingerprintField,
  AllowInsecureField,
  AlpnField,
} from './shared/tls-fields';
import { WsPathField, WsHostField, GrpcServiceNameField } from './shared/transport-fields';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import { FormButtons } from './shared/form-buttons';
import {
  echSchemaShape,
  multiplexSchemaShape,
  echDefaults,
  multiplexDefaults,
  readEchDefault,
  readMultiplexDefaults,
  buildMultiplexSettings,
  readTransportDefaults,
  buildTransportSettings,
} from './shared/field-schemas';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

const createTrojanSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    password: z.string().min(1, t('servers.passwordRequired')),
    network: z.enum(['tcp', 'ws', 'grpc', 'http', 'httpupgrade']),
    security: z.enum(['none', 'tls']),
    tlsServerName: z.string().optional(),
    tlsAllowInsecure: z.boolean(),
    tlsFingerprint: z.string().optional(),
    alpn: z.string().optional(),
    wsPath: z.string().optional(),
    wsHost: z.string().optional(),
    grpcServiceName: z.string().optional(),
    ...echSchemaShape,
    ...multiplexSchemaShape,
  });

type TrojanFormValues = z.infer<ReturnType<typeof createTrojanSchema>>;

interface TrojanFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function TrojanForm({ serverConfig, onSubmit }: TrojanFormProps) {
  const { t } = useTranslation();
  const trojanFormSchema = createTrojanSchema(t);

  const form = useForm<TrojanFormValues>({
    resolver: zodResolver(trojanFormSchema),
    defaultValues: {
      address: '',
      port: 443,
      password: '',
      network: 'tcp',
      security: 'tls',
      tlsServerName: '',
      tlsAllowInsecure: false,
      tlsFingerprint: 'none',
      alpn: '',
      ...readTransportDefaults(),
      ...echDefaults,
      ...multiplexDefaults,
    },
  });

  useEffect(() => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'trojan') {
      // 标准化 network 和 security 值（转为全小写以匹配 schema）
      const normalizeNetwork = (
        n: string | undefined
      ): 'tcp' | 'ws' | 'grpc' | 'http' | 'httpupgrade' => {
        const lower = (n || 'tcp').toLowerCase();
        if (lower === 'ws' || lower === 'websocket') return 'ws';
        if (lower === 'httpupgrade') return 'httpupgrade';
        if (lower === 'grpc') return 'grpc';
        if (lower === 'h2' || lower === 'http' || lower === 'http2') return 'http';
        return 'tcp';
      };
      const normalizeSecurity = (s: string | undefined): 'none' | 'tls' => {
        const lower = (s || 'tls').toLowerCase();
        return lower === 'none' ? 'none' : 'tls';
      };

      const formData = {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        password: serverConfig.password || '',
        network: normalizeNetwork(serverConfig.network),
        security: normalizeSecurity(serverConfig.security),
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
        tlsFingerprint: serverConfig.tlsSettings?.fingerprint || 'none',
        alpn: serverConfig.tlsSettings?.alpn?.join(',') || '',
        ...readTransportDefaults(serverConfig),
        ...readEchDefault(serverConfig),
        ...readMultiplexDefaults(serverConfig),
      };
      form.reset(formData);
    }
  }, [serverConfig, form]);

  const handleSubmit = async (values: TrojanFormValues) => {
    const network = values.network;
    const config = {
      protocol: 'trojan',
      address: values.address,
      port: values.port,
      password: values.password,
      network,
      security: values.security,
      tlsSettings:
        values.security === 'tls'
          ? {
              serverName: values.tlsServerName || null,
              allowInsecure: values.tlsAllowInsecure,
              fingerprint: values.tlsFingerprint || 'none',
              alpn: values.alpn ? values.alpn.split(',').map((s) => s.trim()) : undefined,
              ech: values.ech ? true : undefined,
              echConfig: values.echConfig?.trim() || undefined,
            }
          : null,
      ...buildTransportSettings(network, values),
      multiplexSettings: buildMultiplexSettings(values),
    };

    await onSubmit(config);
  };

  const isTlsEnabled = form.watch('security') === 'tls';
  const watchedNetwork = form.watch('network');
  const showPathHostFields =
    watchedNetwork === 'ws' || watchedNetwork === 'httpupgrade' || watchedNetwork === 'http';
  const isGrpcEnabled = watchedNetwork === 'grpc';

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
                    <FormDescription>{t('servers.trojanPasswordDesc')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldSpan>
            <FormField
              control={form.control}
              name="network"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.transport')}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={t('servers.selectTransport')} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="tcp">TCP</SelectItem>
                      <SelectItem value="ws">WebSocket</SelectItem>
                      <SelectItem value="grpc">gRPC</SelectItem>
                      <SelectItem value="httpupgrade">HTTPUpgrade</SelectItem>
                      <SelectItem value="http">HTTP/2</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>{t('servers.transportDesc')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="security"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.security')}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={t('servers.selectSecurity')} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">{t('servers.none')}</SelectItem>
                      <SelectItem value="tls">TLS</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>{t('servers.securityDesc')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </FieldGrid>
        </FormSection>

        <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
          {isTlsEnabled && (
            <FieldGrid cols={2}>
              <TlsServerNameField control={form.control} t={t} />
              <AlpnField control={form.control} t={t} placeholder="http/1.1" />
              <FingerprintField control={form.control} t={t} />
              <FieldSpan>
                <AllowInsecureField control={form.control} t={t} />
              </FieldSpan>
              <FieldSpan>
                <EchField control={form.control} t={t} />
              </FieldSpan>
            </FieldGrid>
          )}

          {showPathHostFields && (
            <FieldGrid cols={2}>
              <WsPathField control={form.control} t={t} />
              <WsHostField control={form.control} t={t} />
            </FieldGrid>
          )}

          {isGrpcEnabled && (
            <FieldGrid cols={2}>
              <GrpcServiceNameField control={form.control} t={t} />
            </FieldGrid>
          )}

          <MultiplexFields control={form.control} t={t} disabled={false} />
        </FormSection>

        <FormButtons isSubmitting={form.formState.isSubmitting} onReset={() => form.reset()} />
      </form>
    </Form>
  );
}
