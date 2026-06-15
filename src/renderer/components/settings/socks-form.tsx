import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Loader2 } from 'lucide-react';
import { AddressField, PortField } from './shared/basic-fields';
import { FormSection, FieldGrid } from './shared/form-layout';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

const createSocksSchema = (t: any) =>
  z.object({
    address: z.string().min(1, t('servers.addressRequired')),
    port: z.number().min(1).max(65535),
    username: z.string().optional(),
    password: z.string().optional(),
  });

type SocksFormValues = z.infer<ReturnType<typeof createSocksSchema>>;

interface SocksFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

export function SocksForm({ serverConfig, onSubmit }: SocksFormProps) {
  const { t } = useTranslation();
  const socksFormSchema = createSocksSchema(t);

  const getDefaultValues = (): SocksFormValues => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'socks') {
      return {
        address: serverConfig.address || '',
        port: serverConfig.port || 1080,
        username: serverConfig.username || '',
        password: serverConfig.password || '',
      };
    }
    return {
      address: '',
      port: 1080,
      username: '',
      password: '',
    };
  };

  const form = useForm<SocksFormValues>({
    resolver: zodResolver(socksFormSchema),
    defaultValues: getDefaultValues(),
  });

  useEffect(() => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'socks') {
      form.reset(getDefaultValues());
    }
  }, [serverConfig]);

  const handleSubmit = async (values: SocksFormValues) => {
    const config: any = {
      protocol: 'socks' as const,
      address: values.address,
      port: values.port,
      username: values.username || undefined,
      password: values.password || undefined,
      network: 'tcp',
      security: 'none',
    };

    await onSubmit(config);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
        <FormSection title={t('servers.basic', 'Basic')}>
          <FieldGrid cols={2}>
            <AddressField control={form.control} t={t} />
            <PortField control={form.control} t={t} placeholder="1080" />
            <FormField
              control={form.control}
              name="username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {t('servers.username')} ({t('servers.optional', 'Optional')})
                  </FormLabel>
                  <FormControl>
                    <Input placeholder={t('servers.usernamePlaceholder', 'Username')} {...field} />
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
                  <FormLabel>
                    {t('servers.password')} ({t('servers.optional', 'Optional')})
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder={t('servers.passwordPlaceholder', 'Password')}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
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
