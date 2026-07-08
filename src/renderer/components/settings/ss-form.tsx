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
import { Switch } from '@/components/ui/switch';
import { Shield } from 'lucide-react';
import { FormButtons } from './shared/form-buttons';
import { MultiplexFields } from './shared/anti-censor-fields';
import { AddressField, PortField } from './shared/basic-fields';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import {
  multiplexSchemaShape,
  multiplexDefaults,
  readMultiplexDefaults,
  buildMultiplexSettings,
} from './shared/field-schemas';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

const createSsSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    method: z.string().min(1, t('servers.methodRequired')),
    password: z.string().min(1, t('servers.passwordRequired')),
    plugin: z.string().optional(),
    pluginOptions: z.string().optional(),
    remarks: z.string().optional(),
    // Shadow-TLS v3
    enableShadowTls: z.boolean(),
    shadowTlsPassword: z.string().optional(),
    shadowTlsSni: z.string().optional(),
    shadowTlsFingerprint: z.string().optional(),
    shadowTlsPort: z.number().optional(),
    ...multiplexSchemaShape,
  });

type SsFormValues = z.infer<ReturnType<typeof createSsSchema>>;

interface SsFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

const COMMON_METHODS = [
  'aes-128-gcm',
  'aes-256-gcm',
  'chacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
  'aes-128-cfb',
  'aes-192-cfb',
  'aes-256-cfb',
  'aes-128-ctr',
  'aes-192-ctr',
  'aes-256-ctr',
  'rc4-md5',
  'chacha20-ietf',
  'xchacha20-ietf-poly1305',
];

const CIPHER_ALIASES: Record<string, string> = {
  'chacha20-poly1305': 'chacha20-ietf-poly1305',
  'xchacha20-poly1305': 'xchacha20-ietf-poly1305',
};

function normalizeMethod(raw: string | undefined): string {
  if (!raw) return 'aes-256-gcm';
  const lower = raw.toLowerCase().trim();
  const aliased = CIPHER_ALIASES[lower] ?? lower;
  return COMMON_METHODS.find((m) => m === aliased) ?? aliased;
}

export function SsForm({ serverConfig, onSubmit }: SsFormProps) {
  const { t } = useTranslation();
  const ssFormSchema = createSsSchema(t);

  const isSs = serverConfig?.protocol?.toLowerCase() === 'shadowsocks';
  const hasShadowTls = isSs && !!serverConfig?.shadowTlsSettings;

  const form = useForm<SsFormValues>({
    resolver: zodResolver(ssFormSchema),
    defaultValues: {
      address: isSs ? (serverConfig?.address ?? '') : '',
      port: isSs ? (serverConfig?.port ?? 8388) : 8388,
      method: normalizeMethod(isSs ? serverConfig?.shadowsocksSettings?.method : undefined),
      password: isSs ? (serverConfig?.shadowsocksSettings?.password ?? '') : '',
      plugin: isSs ? (serverConfig?.shadowsocksSettings?.plugin ?? '') : '',
      pluginOptions: isSs ? (serverConfig?.shadowsocksSettings?.pluginOptions ?? '') : '',
      remarks: isSs ? (serverConfig?.name ?? '') : '',
      enableShadowTls: hasShadowTls,
      shadowTlsPassword: hasShadowTls ? (serverConfig?.shadowTlsSettings?.password ?? '') : '',
      shadowTlsSni: hasShadowTls ? (serverConfig?.shadowTlsSettings?.sni ?? '') : '',
      shadowTlsFingerprint: hasShadowTls
        ? (serverConfig?.shadowTlsSettings?.fingerprint ?? 'chrome')
        : 'chrome',
      shadowTlsPort: hasShadowTls
        ? (serverConfig?.shadowTlsSettings?.port ?? undefined)
        : undefined,
      ...(isSs && serverConfig ? readMultiplexDefaults(serverConfig) : multiplexDefaults),
    },
  });

  const enableShadowTls = form.watch('enableShadowTls');

  const handleSubmit = async (values: SsFormValues) => {
    const config: any = {
      protocol: 'shadowsocks' as const,
      address: values.address,
      port: values.port,
      name: values.remarks || `${values.address}:${values.port}`,
      shadowsocksSettings: {
        method: values.method,
        password: values.password,
        plugin: values.plugin || undefined,
        pluginOptions: values.pluginOptions || undefined,
      },
      multiplexSettings: buildMultiplexSettings(values),
    };

    if (values.enableShadowTls && values.shadowTlsPassword && values.shadowTlsSni) {
      config.shadowTlsSettings = {
        password: values.shadowTlsPassword,
        sni: values.shadowTlsSni,
        fingerprint: values.shadowTlsFingerprint || 'chrome',
        port: values.shadowTlsPort || undefined,
      };
    }

    await onSubmit(config);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="flex flex-col gap-[13px]">
        <FieldGrid cols={2}>
          <FieldSpan>
            <FormField
              control={form.control}
              name="remarks"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.remarks')}</span>
                  <Input placeholder={t('servers.remarksPlaceholder')} {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldSpan>
          <AddressField control={form.control} t={t} />
          <PortField control={form.control} t={t} placeholder="8388" />
          <FieldSpan>
            <FormField
              control={form.control}
              name="method"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.encryption')}</span>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger>
                      <SelectValue placeholder={t('servers.selectEncryption')} />
                    </SelectTrigger>
                    <SelectContent>
                      {(() => {
                        const sortedMethods = [...COMMON_METHODS];
                        if (field.value && !COMMON_METHODS.includes(field.value)) {
                          sortedMethods.unshift(field.value);
                        }
                        return sortedMethods.map((method) => (
                          <SelectItem key={method} value={method}>
                            {method}
                          </SelectItem>
                        ));
                      })()}
                    </SelectContent>
                  </Select>
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
              name="plugin"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    {t('servers.plugin')}{' '}
                    <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                  </span>
                  <Input placeholder="obfs-local" {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FormField
              control={form.control}
              name="pluginOptions"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">
                    {t('servers.pluginOptions')}{' '}
                    <small className="font-medium text-fg-faint">{t('servers.optional')}</small>
                  </span>
                  <Input placeholder="obfs=http;obfs-host=..." {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldGrid>

          {/* Shadow-TLS v3 */}
          <div className="nd-fset">
            <FormField
              control={form.control}
              name="enableShadowTls"
              render={({ field }) => (
                <div className="nd-fset-h">
                  <span className="inline-flex items-center gap-1.5">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    {t('servers.enableShadowTls', 'Enable Shadow-TLS v3')}
                  </span>
                  <Switch
                    className="ml-auto"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </div>
              )}
            />

            {enableShadowTls && (
              <>
                <FormField
                  control={form.control}
                  name="shadowTlsPassword"
                  render={({ field }) => (
                    <div className="nd-fld">
                      <span className="nd-fld-lbl">{t('servers.shadowTlsPassword')}</span>
                      <Input
                        type="password"
                        className="mono"
                        placeholder={t('servers.shadowTlsPasswordPlaceholder')}
                        {...field}
                      />
                      <FormMessage className="fld-err" />
                    </div>
                  )}
                />

                <FieldGrid cols={2}>
                  <FormField
                    control={form.control}
                    name="shadowTlsSni"
                    render={({ field }) => (
                      <div className="nd-fld">
                        <span className="nd-fld-lbl">{t('servers.sniValue')}</span>
                        <Input placeholder="www.microsoft.com" {...field} />
                        <FormMessage className="fld-err" />
                      </div>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="shadowTlsPort"
                    render={({ field }) => (
                      <div className="nd-fld">
                        <span className="nd-fld-lbl">
                          {t('servers.realPort')}{' '}
                          <small className="font-medium text-fg-faint">
                            {t('servers.optional')}
                          </small>
                        </span>
                        <Input
                          type="number"
                          placeholder={t('servers.realPortPlaceholder')}
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

                <FormField
                  control={form.control}
                  name="shadowTlsFingerprint"
                  render={({ field }) => (
                    <div className="nd-fld">
                      <span className="nd-fld-lbl">{t('servers.fingerprint')}</span>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="chrome">Chrome</SelectItem>
                          <SelectItem value="firefox">Firefox</SelectItem>
                          <SelectItem value="safari">Safari</SelectItem>
                          <SelectItem value="edge">Edge</SelectItem>
                          <SelectItem value="ios">iOS</SelectItem>
                          <SelectItem value="android">Android</SelectItem>
                          <SelectItem value="random">{t('servers.random')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage className="fld-err" />
                    </div>
                  )}
                />
              </>
            )}
          </div>

          <MultiplexFields control={form.control} t={t} disabled={false} />
        </FormSection>

        <FormButtons isSubmitting={form.formState.isSubmitting} onReset={() => form.reset()} />
      </form>
    </Form>
  );
}
