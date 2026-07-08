/**
 * 基础连接字段的共享渲染组件（地址 / 端口）—— Conduit `.nd-fld` 版。
 *
 * 各协议表单的 RHF schema / 默认值 / submit 仍各自维护，渲染统一走这里。
 * 约定字段名：address?: string，port?: number。
 *
 * 端口默认占位符各协议不同（443/8388/1080/...），故 placeholder 为必传 prop。
 */
import type { Control } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { FormField, FormMessage } from '@/components/ui/form';

type AnyControl = Control<any>;
type TFn = (key: string, fallback?: any) => string;

/** 服务器地址（host/IP）。readOnly：WARP 等注册生成的连接参数只展示不可改。 */
export function AddressField({
  control,
  t,
  readOnly,
}: {
  control: AnyControl;
  t: TFn;
  readOnly?: boolean;
}) {
  return (
    <FormField
      control={control}
      name="address"
      render={({ field }) => (
        <div className="nd-fld">
          <span className="nd-fld-lbl">
            {t('servers.serverAddress')} <span className="nd-req">*</span>
          </span>
          <Input
            placeholder="example.com"
            {...field}
            readOnly={readOnly}
            className={readOnly ? 'cursor-default opacity-70' : undefined}
          />
          <FormMessage className="fld-err" />
        </div>
      )}
    />
  );
}

/**
 * 端口字段。
 * @param placeholder 占位符（各协议默认端口不同，必传）
 */
export function PortField({
  control,
  t,
  placeholder,
  readOnly,
}: {
  control: AnyControl;
  t: TFn;
  placeholder: string;
  readOnly?: boolean;
}) {
  return (
    <FormField
      control={control}
      name="port"
      render={({ field }) => (
        <div className="nd-fld">
          <span className="nd-fld-lbl">
            {t('servers.port')} <span className="nd-req">*</span>
          </span>
          <Input
            type="number"
            placeholder={placeholder}
            {...field}
            value={field.value ?? ''}
            readOnly={readOnly}
            className={readOnly ? 'cursor-default opacity-70' : undefined}
            onChange={(e) =>
              field.onChange(e.target.value === '' ? undefined : parseInt(e.target.value, 10) || 0)
            }
          />
          <FormMessage className="fld-err" />
        </div>
      )}
    />
  );
}
