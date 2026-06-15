import { useEffect, useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2 } from 'lucide-react';
import { AddressField, PortField } from './shared/basic-fields';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation, Trans } from 'react-i18next';

const createSshSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    user: z.string().optional(),
    // 密码认证
    password: z.string().optional(),
    // 私钥认证
    privateKey: z.string().optional(),
    privateKeyPath: z.string().optional(),
    privateKeyPassphrase: z.string().optional(),
    // 主机密钥（可选）
    hostKey: z.string().optional(),
  });

type SshFormValues = z.infer<ReturnType<typeof createSshSchema>>;

interface SshFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function SshForm({ serverConfig, onSubmit }: SshFormProps) {
  const { t } = useTranslation();
  const sshSchema = createSshSchema(t);
  const [authMode, setAuthMode] = useState<'password' | 'privatekey'>('password');

  const getDefaultValues = (): SshFormValues => {
    const ssh = serverConfig?.sshSettings;
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'ssh') {
      // 根据已保存的认证方式决定默认 tab
      if (ssh?.privateKey || ssh?.privateKeyPath) {
        setAuthMode('privatekey');
      }
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 22,
        user: ssh?.user || 'root',
        password: ssh?.password || '',
        privateKey: ssh?.privateKey || '',
        privateKeyPath: ssh?.privateKeyPath || '',
        privateKeyPassphrase: ssh?.privateKeyPassphrase || '',
        hostKey: ssh?.hostKey?.join('\n') || '',
      };
    }
    return {
      address: '',
      port: 22,
      user: 'root',
      password: '',
      privateKey: '',
      privateKeyPath: '',
      privateKeyPassphrase: '',
      hostKey: '',
    };
  };

  const form = useForm<SshFormValues>({
    resolver: zodResolver(sshSchema),
    defaultValues: getDefaultValues(),
  });

  useEffect(() => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'ssh') {
      form.reset(getDefaultValues());
    }
  }, [serverConfig]);

  const handleSubmit = async (values: SshFormValues) => {
    const sshSettings: any = {
      user: values.user || 'root',
    };

    if (authMode === 'password') {
      if (values.password) sshSettings.password = values.password;
    } else {
      if (values.privateKey) sshSettings.privateKey = values.privateKey;
      if (values.privateKeyPath) sshSettings.privateKeyPath = values.privateKeyPath;
      if (values.privateKeyPassphrase)
        sshSettings.privateKeyPassphrase = values.privateKeyPassphrase;
    }

    // 主机公钥（可选，留空则接受所有）
    if (values.hostKey?.trim()) {
      sshSettings.hostKey = values.hostKey
        .split('\n')
        .map((k: string) => k.trim())
        .filter(Boolean);
    }

    const config: any = {
      protocol: 'ssh' as const,
      address: values.address,
      port: values.port,
      sshSettings,
    };

    await onSubmit(config);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        <FormSection title={t('servers.basic', 'Basic')}>
          <FieldGrid cols={2}>
            <AddressField control={form.control} t={t} />
            <PortField control={form.control} t={t} placeholder="22" />
            <FieldSpan>
              <FormField
                control={form.control}
                name="user"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('servers.ssh.user')}</FormLabel>
                    <FormControl>
                      <Input placeholder="root" {...field} />
                    </FormControl>
                    <FormDescription>{t('servers.ssh.userDesc')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </FieldSpan>
          </FieldGrid>

          {/* 认证方式 Tabs */}
          <div className="space-y-3">
            <p className="text-sm font-medium">{t('servers.ssh.authMethod')}</p>
            <Tabs
              value={authMode}
              onValueChange={(v) => setAuthMode(v as 'password' | 'privatekey')}
            >
              <TabsList className="w-full">
                <TabsTrigger value="password" className="flex-1">
                  {t('servers.ssh.passwordAuth')}
                </TabsTrigger>
                <TabsTrigger value="privatekey" className="flex-1">
                  {t('servers.ssh.privateKeyAuth')}
                </TabsTrigger>
              </TabsList>

              {/* 密码认证 */}
              <TabsContent value="password" className="mt-4 space-y-4">
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('servers.ssh.password')}</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder={t('servers.ssh.passwordPlaceholder')}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </TabsContent>

              {/* 私钥认证 */}
              <TabsContent value="privatekey" className="mt-4 space-y-4">
                <FormField
                  control={form.control}
                  name="privateKeyPath"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('servers.ssh.privateKeyPath')}</FormLabel>
                      <FormControl>
                        <Input placeholder="$HOME/.ssh/id_rsa" {...field} />
                      </FormControl>
                      <FormDescription>{t('servers.ssh.privateKeyPathDesc')}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="privateKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('servers.ssh.privateKey')}</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
                          className="font-mono text-xs min-h-[120px] resize-y"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>{t('servers.ssh.privateKeyDesc')}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="privateKeyPassphrase"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('servers.ssh.passphrase')}</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder={t('servers.ssh.passphrasePlaceholder')}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </TabsContent>
            </Tabs>
          </div>
        </FormSection>

        {/* 主机公钥（高级选项） */}
        <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
          <FormField
            control={form.control}
            name="hostKey"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('servers.ssh.hostKey')}</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder={t('servers.ssh.hostKeyPlaceholder')}
                    className="font-mono text-xs min-h-[60px] resize-y"
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  <Trans
                    i18nKey="servers.ssh.hostKeyDesc"
                    components={{
                      code: <code className="rounded bg-muted px-1 py-0.5 text-xs" />,
                    }}
                  />
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
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
