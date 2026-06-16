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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import { EchField } from './shared/anti-censor-fields';
import { AddressField, PortField } from './shared/basic-fields';
import { TlsServerNameField, FingerprintField, AllowInsecureField } from './shared/tls-fields';
import { RealityPublicKeyField, RealityShortIdField } from './shared/reality-fields';
import { echSchemaShape, echDefaults, readEchDefault } from './shared/field-schemas';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

// 注意：zod schema 在组件外，我们需要在组件内使用 useTranslation 或者保留这里，并在渲染时翻译错误。
// 为了简单起见，这里我们保持默认中文，并在下面使用 t() 覆盖，或者直接在 FormMessage 处处理（比较复杂）。
// 更好的做法是将 schema 的构建移到组件内部，或者接受 t 函数。
// 这里我们将 schema 的构建移到组件内部，以便使用 t()。
// 所以我们移除外部定义的 schema。
// 我们可以创建一个动态创建 schema 的函数
const createAnyTlsSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    password: z.string().min(1, t('servers.passwordRequired')),
    security: z.enum(['tls', 'reality']),
    tlsServerName: z.string().optional(),
    tlsFingerprint: z.string().optional(),
    tlsAllowInsecure: z.boolean(),
    realityPublicKey: z.string().optional(),
    realityShortId: z.string().optional(),
    ...echSchemaShape,
  });

type AnyTlsFormValues = z.infer<ReturnType<typeof createAnyTlsSchema>>;

interface AnyTlsFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function AnyTlsForm({ serverConfig, onSubmit }: AnyTlsFormProps) {
  const { t } = useTranslation();
  const anyTlsFormSchema = createAnyTlsSchema(t);

  const getDefaultValues = (): AnyTlsFormValues => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'anytls') {
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        password: serverConfig.password || '',
        security: (serverConfig.security === 'reality' ? 'reality' : 'tls') as 'tls' | 'reality',
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsFingerprint: serverConfig.tlsSettings?.fingerprint || 'chrome',
        tlsAllowInsecure: serverConfig.tlsSettings?.allowInsecure || false,
        realityPublicKey: serverConfig.realitySettings?.publicKey || '',
        realityShortId: serverConfig.realitySettings?.shortId || '',
        ...readEchDefault(serverConfig),
      };
    }
    return {
      address: '',
      port: 443,
      password: '',
      security: 'tls',
      tlsServerName: '',
      tlsFingerprint: 'chrome',
      tlsAllowInsecure: false,
      realityPublicKey: '',
      realityShortId: '',
      ...echDefaults,
    };
  };

  const form = useForm<AnyTlsFormValues>({
    resolver: zodResolver(anyTlsFormSchema),
    defaultValues: getDefaultValues(),
  });

  useEffect(() => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'anytls') {
      form.reset(getDefaultValues());
    }
  }, [serverConfig]);

  const handleSubmit = async (values: AnyTlsFormValues) => {
    const config: any = {
      protocol: 'anytls' as const,
      address: values.address,
      port: values.port,
      password: values.password,
      security: values.security,
      tlsSettings: {
        serverName: values.tlsServerName?.trim() || undefined,
        fingerprint: values.tlsFingerprint || 'chrome',
        allowInsecure: values.security === 'tls' ? values.tlsAllowInsecure : false,
        ech: values.ech ? true : undefined,
        echConfig: values.echConfig?.trim() || undefined,
      },
    };

    if (values.security === 'reality') {
      config.realitySettings = {
        publicKey: values.realityPublicKey?.trim() || '',
        shortId: values.realityShortId?.trim() || undefined,
      };
    }

    await onSubmit(config);
  };

  const isTls = form.watch('security') === 'tls';
  const isReality = form.watch('security') === 'reality';

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
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldSpan>
            <FieldSpan>
              <FormField
                control={form.control}
                name="security"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.securityType')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="tls">TLS</SelectItem>
                        <SelectItem value="reality">Reality</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription>{t('servers.securityTypeDesc')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldSpan>
          </FieldGrid>
          {/* Reality：security=reality 时 publicKey 为条件必填 → 放基础（不入折叠高级）。 */}
          {isReality && (
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
              <FieldSpan>
                <RealityShortIdField control={form.control} t={t} />
              </FieldSpan>
            </FieldGrid>
          )}
        </FormSection>

        {/* 高级仅 TLS 模式有可选项（SNI/指纹/insecure/ECH）；Reality 模式全为基础项，故无高级区。 */}
        {isTls && (
          <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
            <FieldGrid cols={2}>
              <TlsServerNameField
                control={form.control}
                t={t}
                labelKey="servers.sni"
                descKey="servers.sniDesc"
                optional
              />
              <FingerprintField control={form.control} t={t} />
              <FieldSpan>
                <AllowInsecureField control={form.control} t={t} />
              </FieldSpan>
              <FieldSpan>
                <EchField control={form.control} t={t} />
              </FieldSpan>
            </FieldGrid>
          </FormSection>
        )}

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
