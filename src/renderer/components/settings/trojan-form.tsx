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
import { TlsAdvancedFields } from './shared/tls-fields';
import { WsPathField, WsHostField, GrpcServiceNameField } from './shared/transport-fields';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import { normalizeNetworkLower } from './shared/normalize-network';
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
    tlsEngine: z.string().optional(),
    alpn: z.string().optional(),
    wsPath: z.string().optional(),
    wsHost: z.string().optional(),
    grpcServiceName: z.string().optional(),
    ...echSchemaShape,
    ...multiplexSchemaShape,
    ...tlsSpoofSchemaShape,
  });

type TrojanFormValues = z.infer<ReturnType<typeof createTrojanSchema>>;

interface TrojanFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function TrojanForm({ serverConfig, onSubmit }: TrojanFormProps) {
  const { t } = useTranslation();
  const trojanFormSchema = createTrojanSchema(t);

  // 标准化 security（转小写匹配 schema）。
  const normalizeSecurity = (s: string | undefined): 'none' | 'tls' => {
    const lower = (s || 'tls').toLowerCase();
    return lower === 'none' ? 'none' : 'tls';
  };

  // 同步 defaultValues（对齐 vless/vmess）：编辑态直接由 serverConfig 算初值，表单按 key={id} 挂载即正确。
  // 不走挂载后 useEffect(form.reset)——radix Select 受控 value 被编程改写会触发伪 onValueChange 打回空态
  // （传输显「选择传输协议」+ 保存 invalid input，issue #294）；同步初值让 Select 挂载即带正确值，结构性免疫。
  const getDefaultValues = (): TrojanFormValues => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'trojan') {
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        password: serverConfig.password || '',
        network: normalizeNetworkLower(serverConfig.network),
        security: normalizeSecurity(serverConfig.security),
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
        tlsFingerprint: (serverConfig.tlsSettings?.fingerprint || 'none').toLowerCase(),
        tlsEngine: serverConfig.tlsSettings?.engine || 'go',
        alpn: serverConfig.tlsSettings?.alpn?.join(',') || '',
        ...readTransportDefaults(serverConfig),
        ...readEchDefault(serverConfig),
        ...readMultiplexDefaults(serverConfig),
        ...readTlsSpoofDefault(serverConfig),
      };
    }
    return {
      address: '',
      port: 443,
      password: '',
      network: 'tcp',
      security: 'tls',
      tlsServerName: '',
      tlsAllowInsecure: false,
      tlsFingerprint: 'none',
      tlsEngine: 'go',
      alpn: '',
      ...readTransportDefaults(),
      ...echDefaults,
      ...multiplexDefaults,
      ...tlsSpoofDefaults,
    };
  };

  const form = useForm<TrojanFormValues>({
    resolver: zodResolver(trojanFormSchema),
    defaultValues: getDefaultValues(),
  });

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
              engine: values.tlsEngine && values.tlsEngine !== 'go' ? values.tlsEngine : undefined,
              alpn: values.alpn ? values.alpn.split(',').map((s) => s.trim()) : undefined,
              ech: values.ech ? true : undefined,
              echConfig: values.echConfig?.trim() || undefined,
              ...buildTlsSpoofSettings(values),
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
                    <SelectItem value="tcp">TCP</SelectItem>
                    <SelectItem value="ws">WebSocket</SelectItem>
                    <SelectItem value="grpc">gRPC</SelectItem>
                    <SelectItem value="httpupgrade">HTTPUpgrade</SelectItem>
                    <SelectItem value="http">HTTP/2</SelectItem>
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
                    <SelectItem value="none">{t('servers.none')}</SelectItem>
                    <SelectItem value="tls">TLS</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage className="fld-err" />
              </div>
            )}
          />
        </FieldGrid>

        <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
          {isTlsEnabled && <TlsAdvancedFields control={form.control} t={t} alpn="http/1.1" />}

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
      </form>
    </Form>
  );
}
