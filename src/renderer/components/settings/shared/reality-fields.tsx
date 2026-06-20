/**
 * Reality 字段的共享渲染组件（publicKey / shortId）。
 *
 * 各协议表单的 RHF schema / 默认值 / submit 仍各自维护，渲染统一走这里。
 * 约定字段名：realityPublicKey?: string，realityShortId?: string。
 */
import type { Control } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

type AnyControl = Control<any>;
type TFn = (key: string, fallback?: any) => string;

/** Reality Public Key。 */
export function RealityPublicKeyField({ control, t }: { control: AnyControl; t: TFn }) {
  return (
    <FormField
      control={control}
      name="realityPublicKey"
      render={({ field }) => (
        <FormItem>
          <FormLabel>{t('servers.realityPublicKey', 'Public Key')}</FormLabel>
          <FormControl>
            <Input placeholder={t('servers.publicKeyPlaceholder')} {...field} />
          </FormControl>
          <FormDescription>{t('servers.publicKeyDesc')}</FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** Reality short ID。 */
export function RealityShortIdField({ control, t }: { control: AnyControl; t: TFn }) {
  return (
    <FormField
      control={control}
      name="realityShortId"
      render={({ field }) => (
        <FormItem>
          <FormLabel>{t('servers.shortId')}</FormLabel>
          <FormControl>
            <Input placeholder={t('servers.shortIdPlaceholder')} {...field} />
          </FormControl>
          <FormDescription>{t('servers.shortIdDesc')}</FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
