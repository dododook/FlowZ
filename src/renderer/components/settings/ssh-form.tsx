import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Form, FormField, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { AddressField, PortField } from './shared/basic-fields';
import { FormSection, FieldGrid, FieldSpan } from './shared/form-layout';
import { splitTextList } from './shared/parse-list';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

const createSshSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    user: z.string().optional(),
    password: z.string().optional(),
    privateKey: z.string().optional(),
    privateKeyPath: z.string().optional(),
    privateKeyPassphrase: z.string().optional(),
    hostKey: z.string().optional(),
    hostKeyAlgorithms: z.string().optional(),
    clientVersion: z.string().optional(),
    // 算法协商（可选；逗号/换行分隔）
    cipher: z.string().optional(),
    mac: z.string().optional(),
    kexAlgorithm: z.string().optional(),
  });

type SshFormValues = z.infer<ReturnType<typeof createSshSchema>>;

interface SshFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function SshForm({ serverConfig, onSubmit }: SshFormProps) {
  const { t } = useTranslation();
  const sshSchema = createSshSchema(t);
  // 认证方式初值从已保存配置派生（lazy init；父组件 key 重挂载会在切换节点时重算）。
  // 不在 getDefaultValues 内 setState——那是 render 期副作用反模式。
  const [authMode, setAuthMode] = useState<'password' | 'privatekey'>(() => {
    const ssh = serverConfig?.sshSettings;
    return serverConfig?.protocol?.toLowerCase() === 'ssh' &&
      (ssh?.privateKey || ssh?.privateKeyPath)
      ? 'privatekey'
      : 'password';
  });

  const getDefaultValues = (): SshFormValues => {
    const ssh = serverConfig?.sshSettings;
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'ssh') {
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 22,
        user: ssh?.user || 'root',
        password: ssh?.password || '',
        privateKey: ssh?.privateKey || '',
        privateKeyPath: ssh?.privateKeyPath || '',
        privateKeyPassphrase: ssh?.privateKeyPassphrase || '',
        hostKey: ssh?.hostKey?.join('\n') || '',
        hostKeyAlgorithms: ssh?.hostKeyAlgorithms?.join(', ') || '',
        clientVersion: ssh?.clientVersion || '',
        cipher: ssh?.cipher?.join(', ') || '',
        mac: ssh?.mac?.join(', ') || '',
        kexAlgorithm: ssh?.kexAlgorithm?.join(', ') || '',
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
      hostKeyAlgorithms: '',
      clientVersion: '',
      cipher: '',
      mac: '',
      kexAlgorithm: '',
    };
  };

  const form = useForm<SshFormValues>({
    resolver: zodResolver(sshSchema),
    defaultValues: getDefaultValues(),
  });

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

    if (values.hostKeyAlgorithms?.trim()) {
      sshSettings.hostKeyAlgorithms = values.hostKeyAlgorithms
        .split(/[\n,]/)
        .map((k: string) => k.trim())
        .filter(Boolean);
    }

    if (values.clientVersion?.trim()) {
      sshSettings.clientVersion = values.clientVersion.trim();
    }

    // 算法协商可选项（逗号/空白/换行分隔）→ sing-box cipher / mac / kex_algorithm。复用 splitTextList 单一真值。
    const cipher = splitTextList(values.cipher);
    if (cipher.length) sshSettings.cipher = cipher;
    const mac = splitTextList(values.mac);
    if (mac.length) sshSettings.mac = mac;
    const kexAlgorithm = splitTextList(values.kexAlgorithm);
    if (kexAlgorithm.length) sshSettings.kexAlgorithm = kexAlgorithm;

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
          <PortField control={form.control} t={t} placeholder="22" />
          <FieldSpan>
            <FormField
              control={form.control}
              name="user"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.ssh.user')}</span>
                  <Input placeholder="root" {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldSpan>
        </FieldGrid>

        <div className="nd-fld">
          <span className="nd-fld-lbl">{t('servers.ssh.authMethod')}</span>
          <div className="seg2">
            <button
              type="button"
              className={authMode === 'password' ? 'on' : ''}
              onClick={() => setAuthMode('password')}
            >
              {t('servers.ssh.passwordAuth')}
            </button>
            <button
              type="button"
              className={authMode === 'privatekey' ? 'on' : ''}
              onClick={() => setAuthMode('privatekey')}
            >
              {t('servers.ssh.privateKeyAuth')}
            </button>
          </div>
        </div>

        {authMode === 'password' && (
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <div className="nd-fld">
                <span className="nd-fld-lbl">{t('servers.ssh.password')}</span>
                <Input
                  type="password"
                  className="mono"
                  placeholder={t('servers.ssh.passwordPlaceholder')}
                  {...field}
                />
                <FormMessage className="fld-err" />
              </div>
            )}
          />
        )}

        {authMode === 'privatekey' && (
          <div className="nd-fset">
            <div className="nd-fset-h">{t('servers.ssh.privateKeyAuth')}</div>
            <FormField
              control={form.control}
              name="privateKeyPath"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.ssh.privateKeyPath')}</span>
                  <Input placeholder="$HOME/.ssh/id_rsa" {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />

            <FormField
              control={form.control}
              name="privateKey"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.ssh.privateKey')}</span>
                  <textarea
                    className="nd-textarea"
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
                    {...field}
                  />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />

            <FormField
              control={form.control}
              name="privateKeyPassphrase"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.ssh.passphrase')}</span>
                  <Input
                    type="password"
                    className="mono"
                    placeholder={t('servers.ssh.passphrasePlaceholder')}
                    {...field}
                  />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </div>
        )}

        <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
          <FormField
            control={form.control}
            name="hostKey"
            render={({ field }) => (
              <div className="nd-fld">
                <span className="nd-fld-lbl">{t('servers.ssh.hostKey')}</span>
                <textarea
                  className="nd-textarea"
                  placeholder={t('servers.ssh.hostKeyPlaceholder')}
                  {...field}
                />
                <FormMessage className="fld-err" />
              </div>
            )}
          />
          <FieldGrid cols={2}>
            <FormField
              control={form.control}
              name="hostKeyAlgorithms"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.ssh.hostKeyAlgorithms')}</span>
                  <Input placeholder="ssh-ed25519, rsa-sha2-256" {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FormField
              control={form.control}
              name="clientVersion"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.ssh.clientVersion')}</span>
                  <Input placeholder="SSH-2.0-OpenSSH_9.0" {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FormField
              control={form.control}
              name="cipher"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.ssh.cipher')}</span>
                  <Input
                    placeholder="aes128-gcm@openssh.com, chacha20-poly1305@openssh.com"
                    {...field}
                  />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FormField
              control={form.control}
              name="mac"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.ssh.mac')}</span>
                  <Input placeholder="hmac-sha2-256, hmac-sha2-512" {...field} />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FormField
              control={form.control}
              name="kexAlgorithm"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.ssh.kexAlgorithm')}</span>
                  <Input
                    placeholder="curve25519-sha256, diffie-hellman-group14-sha256"
                    {...field}
                  />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </FieldGrid>
        </FormSection>
      </form>
    </Form>
  );
}
