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
import { MultiplexFields } from './shared/anti-censor-fields';
import { AddressField, PortField } from './shared/basic-fields';
import { TlsAdvancedFields } from './shared/tls-fields';
import { WsPathField, WsHostField, GrpcServiceNameField } from './shared/transport-fields';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import { normalizeNetworkUpper } from './shared/normalize-network';
import {
  echSchemaShape,
  multiplexSchemaShape,
  tlsSpoofSchemaShape,
  echDefaults,
  multiplexDefaults,
  tlsSpoofDefaults,
  readEchDefault,
  readMultiplexDefaults,
  readTlsSpoofDefault,
  buildMultiplexSettings,
  buildTlsSpoofSettings,
  readTransportDefaults,
  buildTransportSettings,
} from './shared/field-schemas';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

const createVmessSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    uuid: z
      .string()
      .min(1, t('servers.uuidRequired'))
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        t('servers.uuidInvalid')
      ),
    alterId: z.number().default(0),
    vmessSecurity: z.string().default('auto'),
    network: z.enum(['Tcp', 'Ws', 'Grpc', 'Http', 'HttpUpgrade']),
    security: z.enum(['None', 'Tls']),
    tlsServerName: z.string().optional().or(z.literal('')),
    tlsAllowInsecure: z.boolean(),
    tlsFingerprint: z.string().optional().or(z.literal('')),
    tlsEngine: z.string().optional(),
    wsPath: z.string().optional().or(z.literal('')),
    wsHost: z.string().optional().or(z.literal('')),
    grpcServiceName: z.string().optional().or(z.literal('')),
    ...echSchemaShape,
    ...multiplexSchemaShape,
    ...tlsSpoofSchemaShape,
  });

type VmessFormValues = z.infer<ReturnType<typeof createVmessSchema>>;

interface VmessFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function VmessForm({ serverConfig, onSubmit }: VmessFormProps) {
  const { t } = useTranslation();
  const vmessFormSchema = createVmessSchema(t);

  const normalizeSecurity = (s: string | undefined): 'None' | 'Tls' => {
    const lower = (s || 'none').toLowerCase();
    if (lower === 'tls') return 'Tls';
    return 'None';
  };

  const getDefaultValues = (): VmessFormValues => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'vmess') {
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        uuid: serverConfig.uuid || '',
        alterId: serverConfig.alterId ?? 0,
        vmessSecurity: serverConfig.vmessSecurity || 'auto',
        network: normalizeNetworkUpper(serverConfig.network),
        security: normalizeSecurity(serverConfig.security),
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
        tlsFingerprint: serverConfig.tlsSettings?.fingerprint || 'chrome',
        tlsEngine: serverConfig.tlsSettings?.engine || 'go',
        ...readTransportDefaults(serverConfig),
        ...readEchDefault(serverConfig),
        ...readMultiplexDefaults(serverConfig),
        ...readTlsSpoofDefault(serverConfig),
      };
    }
    return {
      address: '',
      port: 443,
      uuid: '',
      alterId: 0,
      vmessSecurity: 'auto',
      network: 'Tcp',
      security: 'None',
      tlsServerName: '',
      tlsAllowInsecure: false,
      tlsFingerprint: 'chrome',
      tlsEngine: 'go',
      ...readTransportDefaults(),
      ...echDefaults,
      ...multiplexDefaults,
      ...tlsSpoofDefaults,
    };
  };

  const form = useForm<any>({
    resolver: zodResolver(vmessFormSchema),
    defaultValues: getDefaultValues(),
  });

  const handleSubmit = async (values: VmessFormValues) => {
    const network = values.network.toLowerCase();
    const security = values.security.toLowerCase() as 'none' | 'tls';

    const serverConfig = {
      protocol: 'vmess' as const,
      address: values.address,
      port: values.port,
      uuid: values.uuid,
      alterId: values.alterId,
      vmessSecurity: values.vmessSecurity,
      network,
      security,
      tlsSettings:
        security === 'tls'
          ? {
              serverName: values.tlsServerName?.trim() || null,
              allowInsecure: values.tlsAllowInsecure,
              fingerprint: values.tlsFingerprint || 'chrome',
              engine: values.tlsEngine && values.tlsEngine !== 'go' ? values.tlsEngine : undefined,
              ech: values.ech ? true : undefined,
              echConfig: values.echConfig?.trim() || undefined,
              ...buildTlsSpoofSettings(values),
            }
          : null,
      ...buildTransportSettings(network, values),
      multiplexSettings: buildMultiplexSettings(values),
    };

    await onSubmit(serverConfig);
  };

  const isTlsEnabled = form.watch('security') === 'Tls';
  const watchedNetwork = form.watch('network');
  const showPathHostFields =
    watchedNetwork === 'Ws' || watchedNetwork === 'HttpUpgrade' || watchedNetwork === 'Http';
  const isGrpcEnabled = watchedNetwork === 'Grpc';

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="flex flex-col gap-[13px]">
        <FieldGrid cols={2}>
          <AddressField control={form.control} t={t} />
          <PortField control={form.control} t={t} placeholder="443" />
          <FieldSpan>
            <FormField
              control={form.control}
              name="uuid"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    {t('servers.uuid', 'UUID')} <span className="nd-req">*</span>
                  </span>
                  <Input className="mono" placeholder={t('servers.uuidPlaceholder')} {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldSpan>
          <FormField
            control={form.control}
            name="alterId"
            render={({ field }) => (
              <div className="nd-fld">
                <span className="nd-fld-lbl">AlterID</span>
                <Input
                  type="number"
                  placeholder="0"
                  {...field}
                  onChange={(e) => field.onChange(parseInt(e.target.value) || 0)}
                />
                <FormMessage className="fld-err" />
              </div>
            )}
          />
          <FormField
            control={form.control}
            name="vmessSecurity"
            render={({ field }) => (
              <div className="nd-fld">
                <span className="nd-fld-lbl">{t('servers.encryption')}</span>
                <Select onValueChange={field.onChange} value={field.value}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('servers.selectEncryption')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">auto</SelectItem>
                    <SelectItem value="aes-128-gcm">aes-128-gcm</SelectItem>
                    <SelectItem value="chacha20-poly1305">chacha20-poly1305</SelectItem>
                    <SelectItem value="none">none</SelectItem>
                    <SelectItem value="zero">zero</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage className="fld-err" />
              </div>
            )}
          />
        </FieldGrid>

        <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
          <FieldGrid cols={2}>
            <FormField
              control={form.control}
              name="network"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.transport')}</span>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('servers.selectTransport')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Tcp">TCP</SelectItem>
                      <SelectItem value="Ws">WebSocket</SelectItem>
                      <SelectItem value="Grpc">gRPC</SelectItem>
                      <SelectItem value="HttpUpgrade">HTTPUpgrade</SelectItem>
                      <SelectItem value="Http">HTTP/2</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FormField
              control={form.control}
              name="security"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.security')}</span>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('servers.selectSecurity')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="None">{t('servers.none')}</SelectItem>
                      <SelectItem value="Tls">TLS</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldGrid>

          {isTlsEnabled && <TlsAdvancedFields control={form.control} t={t} />}

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
