import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Form, FormField, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormButtons } from './shared/form-buttons';
import { EchField } from './shared/anti-censor-fields';
import { AddressField, PortField } from './shared/basic-fields';
import { TlsServerNameField, AllowInsecureField } from './shared/tls-fields';
import { echSchemaShape, echDefaults, readEchDefault } from './shared/field-schemas';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

const createHysteria2Schema = (t: any) =>
  z
    .object({
      address: z.string().min(1, t('servers.addressRequired')),
      port: z.number().min(1).max(65535),
      password: z.string().min(1, t('servers.passwordRequired')),
      // 带宽限制
      upMbps: z.number().optional(),
      downMbps: z.number().optional(),
      // 混淆设置
      obfsEnabled: z.boolean(),
      obfsType: z.enum(['salamander', 'gecko']),
      obfsPassword: z.string().optional(),
      obfsMinPacketSize: z.number().optional(),
      obfsMaxPacketSize: z.number().optional(),
      // 拥塞控制
      bbrProfile: z.string().optional(),
      // TLS 设置
      tlsServerName: z.string().optional(),
      tlsAllowInsecure: z.boolean(),
      // ECH
      ...echSchemaShape,
      // 端口跳跃
      serverPorts: z.string().optional(),
      hopInterval: z.string().optional(),
    })
    .refine(
      // A-1：gecko obfs 的 min/max 包长仅各自 >0 校验，可 min>max 下发致核 FATAL。前置拦 min≤max
      // （仅 gecko obfs 启用且两值均填时；任一缺省由「仅 gecko 有意义」下发逻辑兜底，不在此约束）。
      // A-1 后继：obfs 实际下发还要求 obfsPassword 非空（见 singbox-outbound-builder），
      // 故仅在 obfs 真会下发（含密码非空）时才校验包长顺序，避免空密码场景误拦保存。
      (v) =>
        !(
          v.obfsEnabled &&
          v.obfsType === 'gecko' &&
          !!v.obfsPassword &&
          typeof v.obfsMinPacketSize === 'number' &&
          typeof v.obfsMaxPacketSize === 'number'
        ) || v.obfsMinPacketSize <= v.obfsMaxPacketSize,
      {
        path: ['obfsMaxPacketSize'],
        message: t('servers.obfsPacketSizeOrder', '最大包长须 ≥ 最小包长'),
      }
    );

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
      obfsType: 'salamander',
      obfsPassword: '',
      obfsMinPacketSize: undefined,
      obfsMaxPacketSize: undefined,
      bbrProfile: '',
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
        obfsType: serverConfig.hysteria2Settings?.obfs?.type || 'salamander',
        obfsPassword: serverConfig.hysteria2Settings?.obfs?.password || '',
        obfsMinPacketSize: serverConfig.hysteria2Settings?.obfs?.minPacketSize ?? undefined,
        obfsMaxPacketSize: serverConfig.hysteria2Settings?.obfs?.maxPacketSize ?? undefined,
        bbrProfile: serverConfig.hysteria2Settings?.bbrProfile || '',
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
                type: values.obfsType,
                password: values.obfsPassword,
                // min/max_packet_size 仅 gecko 有意义；salamander 不下发
                minPacketSize:
                  values.obfsType === 'gecko' ? values.obfsMinPacketSize || undefined : undefined,
                maxPacketSize:
                  values.obfsType === 'gecko' ? values.obfsMaxPacketSize || undefined : undefined,
              }
            : undefined,
        // 'default'/空 = 不下发（用核心默认拥塞控制）；仅 standard/aggressive/conservative 落 bbr_profile
        bbrProfile:
          values.bbrProfile && values.bbrProfile !== 'default'
            ? (values.bbrProfile as any)
            : undefined,
        serverPorts: values.serverPorts?.trim() || undefined,
        hopInterval: values.hopInterval?.trim() || undefined,
      },
    };

    await onSubmit(serverConfig);
  };

  const isObfsEnabled = form.watch('obfsEnabled');
  const obfsType = form.watch('obfsType');

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="flex flex-col gap-[13px]">
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
                    className="mono"
                    type="password"
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
              name="upMbps"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.upMbps')}</span>
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
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FormField
              control={form.control}
              name="downMbps"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.downMbps')}</span>
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
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FieldSpan>
              <div className="nd-fset">
                <FormField
                  control={form.control}
                  name="obfsEnabled"
                  render={({ field }) => (
                    <div className="nd-fset-h">
                      {t('servers.obfsEnabled')}
                      <Switch
                        className="ml-auto"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </div>
                  )}
                />
                {isObfsEnabled && (
                  <>
                    <FormField
                      control={form.control}
                      name="obfsType"
                      render={({ field }) => (
                        <div className="nd-fld">
                          <span className="nd-fld-lbl">{t('servers.obfsType', '混淆类型')}</span>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="salamander">Salamander</SelectItem>
                              <SelectItem value="gecko">Gecko</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage className="fld-err" />
                        </div>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="obfsPassword"
                      render={({ field }) => (
                        <div className="nd-fld">
                          <span className="nd-fld-lbl">{t('servers.obfsPassword')}</span>
                          <Input
                            className="mono"
                            type="password"
                            placeholder={t('servers.obfsPasswordPlaceholder')}
                            {...field}
                          />
                          <FormMessage className="fld-err" />
                        </div>
                      )}
                    />
                    {obfsType === 'gecko' && (
                      <FieldGrid cols={2}>
                        <FormField
                          control={form.control}
                          name="obfsMinPacketSize"
                          render={({ field }) => (
                            <div className="nd-fld">
                              <span className="nd-fld-lbl">
                                {t('servers.obfsMinPacketSize', '最小包长')}
                              </span>
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
                              <FormMessage className="fld-err" />
                            </div>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="obfsMaxPacketSize"
                          render={({ field }) => (
                            <div className="nd-fld">
                              <span className="nd-fld-lbl">
                                {t('servers.obfsMaxPacketSize', '最大包长')}
                              </span>
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
                              <FormMessage className="fld-err" />
                            </div>
                          )}
                        />
                      </FieldGrid>
                    )}
                  </>
                )}
              </div>
            </FieldSpan>
            <FormField
              control={form.control}
              name="bbrProfile"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.bbrProfile', 'BBR Profile')}</span>
                  <Select onValueChange={field.onChange} value={field.value || 'default'}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">
                        {t('servers.bbrProfileDefault', '默认')}
                      </SelectItem>
                      <SelectItem value="standard">
                        {t('servers.bbrProfileStandard', 'Standard')}
                      </SelectItem>
                      <SelectItem value="aggressive">
                        {t('servers.bbrProfileAggressive', 'Aggressive')}
                      </SelectItem>
                      <SelectItem value="conservative">
                        {t('servers.bbrProfileConservative', 'Conservative')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
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
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.hopPorts', 'Port Hopping Range')}</span>
                  <Input placeholder="20000:30000,40000:50000" {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FormField
              control={form.control}
              name="hopInterval"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.hopInterval', '跳跃间隔')}</span>
                  <Input placeholder="30s" {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldGrid>
        </FormSection>

        <FormButtons isSubmitting={form.formState.isSubmitting} onReset={() => form.reset()} />
      </form>
    </Form>
  );
}
