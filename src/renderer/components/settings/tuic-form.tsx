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
import { EchField } from './shared/anti-censor-fields';
import { AddressField, PortField } from './shared/basic-fields';
import { TlsServerNameField, AllowInsecureField, AlpnField } from './shared/tls-fields';
import { FormButtons } from './shared/form-buttons';
import { echSchemaShape, echDefaults, readEchDefault } from './shared/field-schemas';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import { SwitchField } from './shared/switch-field';
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

  // 拥塞控制 / UDP 中继模式读取归一：存量/导入值大小写或别名不一（BBR / newreno）严格灌 z.enum 会挂或显占位符。
  const normalizeCongestion = (c: string | undefined): 'bbr' | 'cubic' | 'new_reno' => {
    const l = (c || 'bbr').toLowerCase();
    if (l === 'cubic') return 'cubic';
    if (l === 'new_reno' || l === 'newreno' || l === 'reno') return 'new_reno';
    return 'bbr';
  };
  const normalizeUdpRelay = (u: string | undefined): 'native' | 'quic' =>
    (u || 'native').toLowerCase() === 'quic' ? 'quic' : 'native';

  // 同步 defaultValues（对齐 vless/vmess/trojan）：编辑态直接由 serverConfig 算初值。此前用挂载后
  // useEffect(form.reset) + 非受控 defaultValue Select，Select 在 reset 前挂载、捕获初始默认值（bbr/native），
  // reset 改的是 RHF 值而非 Select 显示 → 编辑已有 tuic 节点时拥塞/中继下拉显错值。改同步初值 + 受控 value 修复。
  const getDefaultValues = (): TuicFormValues => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'tuic') {
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        uuid: serverConfig.uuid || '',
        password: serverConfig.password || '',
        congestionControl: normalizeCongestion(serverConfig.tuicSettings?.congestionControl),
        udpRelayMode: normalizeUdpRelay(serverConfig.tuicSettings?.udpRelayMode),
        zeroRttHandshake: serverConfig.tuicSettings?.zeroRttHandshake ?? false,
        heartbeat: serverConfig.tuicSettings?.heartbeat || '',
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
        alpn: serverConfig.tlsSettings?.alpn?.join(',') || 'h3',
        ...readEchDefault(serverConfig),
      };
    }
    return {
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
    };
  };

  const form = useForm<TuicFormValues>({
    resolver: zodResolver(tuicFormSchema),
    defaultValues: getDefaultValues(),
  });

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
                  <Input placeholder={t('servers.uuidPlaceholder')} {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldSpan>
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
        </FieldGrid>

        <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
          <FieldGrid cols={2}>
            <FormField
              control={form.control}
              name="congestionControl"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.congestionControl')}</span>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger>
                      <SelectValue placeholder="bbr" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bbr">bbr</SelectItem>
                      <SelectItem value="cubic">cubic</SelectItem>
                      <SelectItem value="new_reno">new_reno</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FormField
              control={form.control}
              name="udpRelayMode"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.udpRelayMode')}</span>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger>
                      <SelectValue placeholder="native" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="native">native</SelectItem>
                      <SelectItem value="quic">quic</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FormField
              control={form.control}
              name="heartbeat"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.tuicHeartbeat')}</span>
                  <Input placeholder="10s" {...field} />
                  <FormMessage className="fld-err" />
                </div>
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
              <SwitchField
                control={form.control}
                name="zeroRttHandshake"
                label={t('servers.tuicZeroRtt')}
                tooltip={t('servers.tuicZeroRttDesc')}
              />
            </FieldSpan>
          </FieldGrid>
        </FormSection>

        <FormButtons isSubmitting={form.formState.isSubmitting} onReset={() => form.reset()} />
      </form>
    </Form>
  );
}
