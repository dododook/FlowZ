/**
 * 无边框单行开关字段（密度瘦身）：左 `label + 可选 ⓘ`，右 `Switch`。去掉旧 `rounded-md border p-3` 卡片壳，
 * 长说明转 InfoTooltip。RHF 绑定（control+name），与 general-settings 的 store 驱动 toggle 不同，故独立件。
 *
 * - tooltip：label 旁 ⓘ 悬浮说明（密度首选）。
 * - hint：开关下方常驻提示（如 amber 联动文案），ReactNode 自带样式。
 * - disabled / checkedOverride：复刻 reverseMesh→allowInternet「强制 false + 禁用」联动，不改 field 值本身。
 */
import { type ReactNode } from 'react';
import type { Control, FieldPath, FieldValues } from 'react-hook-form';
import { FormControl, FormField, FormItem, FormLabel } from '@/components/ui/form';
import { Switch } from '@/components/ui/switch';
import { InfoTooltip } from './info-tooltip';

export function SwitchField<TFieldValues extends FieldValues>({
  control,
  name,
  label,
  tooltip,
  hint,
  disabled,
  checkedOverride,
}: {
  control: Control<TFieldValues>;
  name: FieldPath<TFieldValues>;
  label: ReactNode;
  tooltip?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  /** 显示态覆盖（不写回 field）；用于联动强制 off。undefined=跟随 field.value。 */
  checkedOverride?: boolean;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <FormLabel className="!mt-0 font-normal">{label}</FormLabel>
              {tooltip && <InfoTooltip content={tooltip} />}
            </div>
            <FormControl>
              <Switch
                checked={checkedOverride ?? field.value}
                disabled={disabled}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </div>
          {hint}
        </FormItem>
      )}
    />
  );
}
