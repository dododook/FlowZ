/**
 * Reality 字段的共享渲染组件（publicKey / shortId）—— Conduit `.nd-fld` 版。
 *
 * 各协议表单的 RHF schema / 默认值 / submit 仍各自维护，渲染统一走这里。
 * 约定字段名：realityPublicKey?: string，realityShortId?: string。
 */
import type { Control } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { FormField, FormMessage } from '@/components/ui/form';

type AnyControl = Control<any>;
type TFn = (key: string, fallback?: any) => string;

export function RealityPublicKeyField({ control, t }: { control: AnyControl; t: TFn }) {
  return (
    <FormField
      control={control}
      name="realityPublicKey"
      render={({ field }) => (
        <div className="nd-fld">
          <span className="nd-fld-lbl">{t('servers.realityPublicKey', 'Public Key')}</span>
          <Input className="mono" placeholder={t('servers.publicKeyPlaceholder')} {...field} />
          <FormMessage className="fld-err" />
        </div>
      )}
    />
  );
}

export function RealityShortIdField({ control, t }: { control: AnyControl; t: TFn }) {
  return (
    <FormField
      control={control}
      name="realityShortId"
      render={({ field }) => (
        <div className="nd-fld">
          <span className="nd-fld-lbl">{t('servers.shortId')}</span>
          <Input className="mono" placeholder={t('servers.shortIdPlaceholder')} {...field} />
          <FormMessage className="fld-err" />
        </div>
      )}
    />
  );
}
