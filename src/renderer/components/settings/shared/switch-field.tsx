/**
 * 行内开关行（Conduit `.nd-swrow`）：左 `标题 + 可选 ⓘ + 可选说明`，右 `Switch`（渲染为 `.swt` 视觉）。
 * RHF 绑定（control+name），与 general-settings 的 store 驱动 toggle 不同，故独立件。
 *
 * - tooltip：标题旁 ⓘ 悬浮说明（密度首选）。
 * - hint：开关下方常驻提示（如 amber 联动文案），ReactNode 自带样式，原样渲染于行下方。
 * - disabled / checkedOverride：复刻 reverseMesh→allowInternet「强制 false + 禁用」联动，不改 field 值本身。
 */
import { type ReactNode } from 'react';
import type { Control, FieldPath, FieldValues } from 'react-hook-form';
import { FormField } from '@/components/ui/form';
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
        <div className="flex flex-col gap-1.5">
          <div className="nd-swrow">
            <div className="nd-swrow-main">
              <div className="nd-swrow-t inline-flex items-center gap-1.5">
                {label}
                {tooltip && <InfoTooltip content={tooltip} />}
              </div>
            </div>
            <Switch
              checked={checkedOverride ?? field.value}
              disabled={disabled}
              onCheckedChange={field.onChange}
            />
          </div>
          {hint}
        </div>
      )}
    />
  );
}
