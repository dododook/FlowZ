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
import { MultiplexFields } from './shared/anti-censor-fields';
import { AddressField, PortField } from './shared/basic-fields';
import { TlsServerNameField, FingerprintField, TlsAdvancedFields } from './shared/tls-fields';
import { WsPathField, WsHostField, GrpcServiceNameField } from './shared/transport-fields';
import { RealityPublicKeyField, RealityShortIdField } from './shared/reality-fields';
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

const createVlessSchema = (t: any) =>
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
    encryption: z.string().optional(),
    flow: z.string().optional(),
    network: z.enum(['Tcp', 'Ws', 'Grpc', 'Http', 'HttpUpgrade']),
    security: z.enum(['None', 'Tls', 'Reality']),
    tlsServerName: z.string().optional(),
    tlsAllowInsecure: z.boolean(),
    tlsFingerprint: z.string().optional(),
    tlsEngine: z.string().optional(),
    realityPublicKey: z.string().optional(),
    realityShortId: z.string().optional(),
    wsPath: z.string().optional(),
    wsHost: z.string().optional(),
    grpcServiceName: z.string().optional(),
    ...echSchemaShape,
    ...multiplexSchemaShape,
    ...tlsSpoofSchemaShape,
  });

type VlessFormValues = z.infer<ReturnType<typeof createVlessSchema>>;

interface VlessFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function VlessForm({ serverConfig, onSubmit }: VlessFormProps) {
  const { t } = useTranslation();
  const vlessFormSchema = createVlessSchema(t);

  const normalizeSecurity = (s: string | undefined): 'None' | 'Tls' | 'Reality' => {
    const lower = (s || 'tls').toLowerCase();
    if (lower === 'none') return 'None';
    if (lower === 'reality') return 'Reality';
    return 'Tls';
  };

  const getDefaultValues = (): VlessFormValues => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'vless') {
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        uuid: serverConfig.uuid || '',
        encryption: serverConfig.encryption?.toLowerCase() || 'none',
        flow: (serverConfig.flow || '').toLowerCase(),
        network: normalizeNetworkUpper(serverConfig.network),
        security: normalizeSecurity(serverConfig.security),
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
        tlsFingerprint: (serverConfig.tlsSettings?.fingerprint || 'chrome').toLowerCase(),
        tlsEngine: serverConfig.tlsSettings?.engine || 'go',
        realityPublicKey: serverConfig.realitySettings?.publicKey || '',
        realityShortId: serverConfig.realitySettings?.shortId || '',
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
      encryption: 'none',
      flow: '',
      network: 'Tcp',
      security: 'Tls',
      tlsServerName: '',
      tlsAllowInsecure: false,
      tlsFingerprint: 'chrome',
      tlsEngine: 'go',
      realityPublicKey: '',
      realityShortId: '',
      ...readTransportDefaults(),
      ...echDefaults,
      ...multiplexDefaults,
      ...tlsSpoofDefaults,
    };
  };

  const form = useForm<VlessFormValues>({
    resolver: zodResolver(vlessFormSchema),
    defaultValues: getDefaultValues(),
  });

  const handleSubmit = async (values: VlessFormValues) => {
    const network = values.network.toLowerCase();
    const security = values.security.toLowerCase() as 'none' | 'tls' | 'reality';

    const serverConfig = {
      protocol: 'vless' as const,
      address: values.address,
      port: values.port,
      uuid: values.uuid,
      encryption: values.encryption || 'none',
      flow: values.flow || undefined,
      network,
      security,
      tlsSettings:
        security === 'tls' || security === 'reality'
          ? {
              serverName: values.tlsServerName?.trim() || null,
              allowInsecure: security === 'tls' ? values.tlsAllowInsecure : false,
              fingerprint: values.tlsFingerprint || 'chrome',
              engine:
                security === 'tls' && values.tlsEngine && values.tlsEngine !== 'go'
                  ? values.tlsEngine
                  : undefined,
              ech: values.ech ? true : undefined,
              echConfig: values.echConfig?.trim() || undefined,
              ...(security === 'tls' ? buildTlsSpoofSettings(values) : {}),
            }
          : null,
      realitySettings:
        security === 'reality'
          ? {
              publicKey: values.realityPublicKey?.trim() || '',
              shortId: values.realityShortId?.trim() || undefined,
            }
          : null,
      ...buildTransportSettings(network, values),
      multiplexSettings: buildMultiplexSettings(values, { skipVisionFlow: true }),
    };

    await onSubmit(serverConfig);
  };

  const isTlsEnabled = form.watch('security') === 'Tls';
  const isRealityEnabled = form.watch('security') === 'Reality';
  const watchedNetwork = form.watch('network');
  const showPathHostFields =
    watchedNetwork === 'Ws' || watchedNetwork === 'HttpUpgrade' || watchedNetwork === 'Http';
  const isGrpcEnabled = watchedNetwork === 'Grpc';

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
            name="encryption"
            render={({ field }) => (
              <div className="nd-fld">
                <span className="nd-fld-lbl">{t('servers.encryption')}</span>
                <Select onValueChange={field.onChange} value={field.value}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('servers.selectEncryption')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">none</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage className="fld-err" />
              </div>
            )}
          />
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
                    <SelectItem value="Reality">Reality</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage className="fld-err" />
              </div>
            )}
          />
        </FieldGrid>
        {/* Reality：security=Reality 时 publicKey 为条件必填 → 放基础(不入折叠高级)。 */}
        {isRealityEnabled && (
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
              <RealityShortIdField control={form.control} t={t} />
              <FormField
                control={form.control}
                name="flow"
                render={({ field }) => (
                  <div className="nd-fld">
                    <span className="nd-fld-lbl">
                      Flow{' '}
                      <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                    </span>
                    <Select
                      onValueChange={(v) => field.onChange(v === '_none' ? '' : v)}
                      value={field.value || '_none'}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t('servers.selectFlow', 'Select Flow')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_none">{t('servers.none')}</SelectItem>
                        <SelectItem value="xtls-rprx-vision">xtls-rprx-vision</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage className="fld-err" />
                  </div>
                )}
              />
            </FieldGrid>
          </div>
        )}

        <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
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

          <MultiplexFields
            control={form.control}
            t={t}
            disabled={form.watch('flow') === 'xtls-rprx-vision'}
            disabledReason={t(
              'servers.multiplexVisionConflict',
              'Multiplex 与 xtls-rprx-vision flow 不兼容，已禁用。'
            )}
          />
        </FormSection>
      </form>
    </Form>
  );
}
