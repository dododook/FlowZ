/**
 * 抗封增强字段的共享渲染组件（人工配置用）—— Conduit `.nd-swrow` / `.nd-fset` / `.nd-textarea` 版。
 *
 * 各协议表单（vless/trojan/vmess/ss/tuic/hysteria2/anytls）的 RHF schema / 默认值 / submit
 * 映射仍各自维护（react-hook-form 限制），但渲染部分统一走这里，避免在多表单里重复 JSX。
 *
 * 约定的标准字段名（各表单 schema 需包含对应可选字段）：
 *   ECH:       ech?: boolean, echConfig?: string
 *   Multiplex: muxEnabled?: boolean, muxProtocol?: 'h2mux'|'smux'|'yamux',
 *              muxMaxConnections?: number, muxMinStreams?: number, muxPadding?: boolean
 *
 * 这些字段最终由 ProxyManager.applyAntiCensorshipOptions 消费（tls.ech / multiplex）。
 */
import type { Control } from 'react-hook-form';
import { useFormContext } from 'react-hook-form';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormField, FormMessage } from '@/components/ui/form';
import { InfoTooltip } from './info-tooltip';

type AnyControl = Control<any>;
type TFn = (key: string, fallback?: any) => string;

/**
 * ECH（Encrypted Client Hello）开关行 + 可选 ECHConfigList —— 隐藏 SNI、抗 SNI 阻断。适用于带 TLS 的协议。
 * 勾选后展开可选 config 文本框：留空 = sing-box 从 DNS(HTTPS RR) 自取；填 PEM = 下发 tls.ech.config。
 */
export function EchField({ control, t }: { control: AnyControl; t: TFn }) {
  const { watch } = useFormContext();
  const enabled = watch('ech') === true;
  return (
    <div className="flex flex-col gap-[13px]">
      <FormField
        control={control}
        name="ech"
        render={({ field }) => (
          <div className="nd-swrow">
            <div className="nd-swrow-main">
              <div className="nd-swrow-t inline-flex items-center gap-1.5">
                {t('servers.ech')}
                <InfoTooltip content={t('servers.echDescFull')} />
              </div>
              <div className="nd-swrow-d">{t('servers.echDesc')}</div>
            </div>
            <Switch checked={field.value === true} onCheckedChange={field.onChange} />
          </div>
        )}
      />
      {enabled && (
        <FormField
          control={control}
          name="echConfig"
          render={({ field }) => (
            <div className="nd-fld">
              <span className="nd-fld-lbl">{t('servers.echConfig', 'ECH Config (optional)')}</span>
              <textarea
                className="nd-textarea"
                placeholder={'-----BEGIN ECH CONFIGS-----\n...\n-----END ECH CONFIGS-----'}
                {...field}
              />
              <FormMessage className="fld-err" />
            </div>
          )}
        />
      )}
    </div>
  );
}

/**
 * Multiplex（多路复用）字段组（`.nd-fset` + 头部 `.swt` 开关）。
 * @param disabled    置 true 时禁用并显示 disabledReason（如 vision flow 不兼容）
 */
export function MultiplexFields({
  control,
  t,
  disabled = false,
  disabledReason,
}: {
  control: AnyControl;
  t: TFn;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const { watch } = useFormContext();
  const enabled = watch('muxEnabled') === true;

  return (
    <div className="nd-fset">
      <FormField
        control={control}
        name="muxEnabled"
        render={({ field }) => (
          <div className="nd-fset-h">
            {t('servers.multiplex')}
            <Switch
              className="ml-auto"
              checked={field.value === true && !disabled}
              disabled={disabled}
              onCheckedChange={field.onChange}
            />
          </div>
        )}
      />

      {disabled && (
        <div className="nd-swrow-d">{disabledReason || t('servers.multiplexDisabled')}</div>
      )}

      {enabled && !disabled && (
        <>
          <FormField
            control={control}
            name="muxProtocol"
            render={({ field }) => (
              <div className="nd-fld">
                <span className="nd-fld-lbl">{t('servers.multiplexProtocol')}</span>
                <Select onValueChange={field.onChange} value={field.value || 'h2mux'}>
                  <SelectTrigger>
                    <SelectValue placeholder="h2mux" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="h2mux">h2mux</SelectItem>
                    <SelectItem value="smux">smux</SelectItem>
                    <SelectItem value="yamux">yamux</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage className="fld-err" />
              </div>
            )}
          />

          <div className="nd-grid2">
            <FormField
              control={control}
              name="muxMaxConnections"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.multiplexMaxConn')}</span>
                  <Input
                    type="number"
                    placeholder={t('servers.optional')}
                    {...field}
                    value={field.value ?? ''}
                    onChange={(e) =>
                      field.onChange(e.target.value ? parseInt(e.target.value, 10) : undefined)
                    }
                  />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
            <FormField
              control={control}
              name="muxMinStreams"
              render={({ field }) => (
                <div className="nd-fld">
                  <span className="nd-fld-lbl">{t('servers.multiplexMinStreams')}</span>
                  <Input
                    type="number"
                    placeholder={t('servers.optional')}
                    {...field}
                    value={field.value ?? ''}
                    onChange={(e) =>
                      field.onChange(e.target.value ? parseInt(e.target.value, 10) : undefined)
                    }
                  />
                  <FormMessage className="fld-err" />
                </div>
              )}
            />
          </div>

          <FormField
            control={control}
            name="muxPadding"
            render={({ field }) => (
              <div className="nd-swrow">
                <div className="nd-swrow-main">
                  <div className="nd-swrow-t">{t('servers.multiplexPadding')}</div>
                  <div className="nd-swrow-d">{t('servers.multiplexPaddingDesc')}</div>
                </div>
                <Switch checked={field.value === true} onCheckedChange={field.onChange} />
              </div>
            )}
          />
        </>
      )}
    </div>
  );
}
