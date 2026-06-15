import { useState, useEffect } from 'react';
import * as z from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { encodeMajorMinor } from '@shared/version';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
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
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import type { ServerConfig } from '@/bridge/types';
import { api } from '@/ipc';

const createNaiveSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.serverAddressRequired', 'Address is required')),
    port: z.number().min(1).max(65535),
    username: z.string().min(1, t('servers.usernameRequired', 'Username is required')),
    password: z.string().min(1, t('servers.passwordRequired')),
    tlsServerName: z.string().optional(),
    tlsFingerprint: z.string().optional(),
    useHttp3: z.boolean().optional(),
  });

type NaiveFormValues = z.infer<ReturnType<typeof createNaiveSchema>>;

interface NaiveFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: Partial<ServerConfig>) => Promise<void>;
}

export function NaiveForm({ serverConfig, onSubmit }: NaiveFormProps) {
  const { t } = useTranslation();
  const naiveFormSchema = createNaiveSchema(t);
  const setCurrentView = useAppStore((s) => s.setCurrentView);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);

  // naive 需 sing-box ≥1.13。仅当实测核心 <1.13 才提示更新；已支持则不打扰（修旧版无条件提示）。
  const [needsCoreUpgrade, setNeedsCoreUpgrade] = useState(false);
  useEffect(() => {
    api.coreUpdate
      .getVersionInfo()
      .then((info) => {
        // 与 ProxyManager/CoreUpdateService 统一用 shared 的整数编码解析；NaN<1013=false 保持原「未知则不提示」语义
        setNeedsCoreUpgrade(encodeMajorMinor(info.currentVersion || '') < 1013);
      })
      .catch(() => {});
  }, []);

  const getDefaultValues = (): NaiveFormValues => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'naive') {
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 443,
        username: serverConfig.username || '',
        password: serverConfig.password || '',
        tlsServerName: serverConfig.tlsSettings?.serverName || '',
        tlsFingerprint: serverConfig.tlsSettings?.fingerprint || 'none',
        useHttp3: serverConfig.naiveSettings?.useHttp3 ?? false,
      };
    }
    return {
      address: '',
      port: 443,
      username: '',
      password: '',
      tlsServerName: '',
      tlsFingerprint: 'none',
      useHttp3: false,
    };
  };

  const form = useForm<NaiveFormValues>({
    resolver: zodResolver(naiveFormSchema),
    defaultValues: getDefaultValues(),
  });

  const handleSubmit = async (values: NaiveFormValues) => {
    const config: Partial<ServerConfig> = {
      protocol: 'naive',
      address: values.address,
      port: values.port,
      username: values.username,
      password: values.password,
      network: 'tcp',
      security: 'tls',
      tlsSettings: {
        serverName: values.tlsServerName?.trim() || undefined,
        allowInsecure: false,
        fingerprint: values.tlsFingerprint || 'none',
      },
      naiveSettings: values.useHttp3 ? { useHttp3: true } : undefined,
    };
    await onSubmit(config);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        {needsCoreUpgrade && (
          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 space-y-2">
            <p className="text-sm text-amber-800 dark:text-amber-200 font-medium">
              {t('servers.naive.versionWarning')}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-amber-300 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/40 text-amber-900 dark:text-amber-100"
              onClick={() => {
                setSettingsSection('about');
                setCurrentView('settings');
              }}
            >
              {t('servers.naive.goUpdate')}
            </Button>
          </div>
        )}

        <FormSection title={t('servers.basic', 'Basic')}>
          <FieldGrid cols={2}>
            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.serverAddress')}</FormLabel>
                  <FormControl>
                    <Input placeholder="example.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="port"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.port')}</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder="443"
                      {...field}
                      onChange={(e) => field.onChange(parseInt(e.target.value, 10))}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.username', 'Username')}</FormLabel>
                  <FormControl>
                    <Input placeholder="Enter username" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('servers.password', 'Password')}</FormLabel>
                  <FormControl>
                    <Input type="password" placeholder="Enter password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </FieldGrid>
        </FormSection>

        <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
          <FieldGrid cols={2}>
            <FieldSpan>
              <FormField
                control={form.control}
                name="tlsServerName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.sni')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('servers.sniPlaceholder')} {...field} />
                    </FormControl>
                    <FormDescription>{t('servers.sniDesc')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldSpan>
            <FieldSpan>
              <FormField
                control={form.control}
                name="tlsFingerprint"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.fingerprint')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue
                            placeholder={t('servers.selectFingerprint', 'Select TLS Fingerprint')}
                          />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">{t('servers.none', 'None')}</SelectItem>
                        <SelectItem value="chrome">Chrome</SelectItem>
                        <SelectItem value="firefox">Firefox</SelectItem>
                        <SelectItem value="safari">Safari</SelectItem>
                        <SelectItem value="edge">Edge</SelectItem>
                        <SelectItem value="ios">iOS</SelectItem>
                        <SelectItem value="android">Android</SelectItem>
                        <SelectItem value="random">{t('servers.random')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription>{t('servers.fingerprintDesc')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldSpan>
            <FieldSpan>
              <FormField
                control={form.control}
                name="useHttp3"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                    <div className="space-y-0.5">
                      <FormLabel>{t('servers.naive.useHttp3', 'HTTP/3 (QUIC)')}</FormLabel>
                      <FormDescription>{t('servers.naive.useHttp3Desc')}</FormDescription>
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
