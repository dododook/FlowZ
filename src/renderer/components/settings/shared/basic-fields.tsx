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
            onChange={(e) => {
              // 空串（退格删空）→ ''（**不是 undefined**）：RHF Controller 在 field.value===undefined 时会回退到
              // defaultValue，把刚清空的端口自动填回旧值（issue #294 复现：清空后又变回 443）。'' 是「已定义的空」，
              // Controller 不回退 → 真正清空、可重录。port 为必填 z.number()，'' 在提交时自然判无效（符合必填语义）。
              // 不用 `parseInt || 0`（0 触发 min(1) 校验挂）。非空按十进制解析，异常值 → '' 不硬塞 0。
              const raw = e.target.value;
              if (raw === '') {
                field.onChange('');
                return;
              }
              const n = Number.parseInt(raw, 10);
              field.onChange(Number.isNaN(n) ? '' : n);
            }}
          />
          <FormMessage className="fld-err" />
        </div>
      )}
    />
  );
}
