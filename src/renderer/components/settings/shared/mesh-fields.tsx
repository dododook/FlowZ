/**
 * 组网共享件（WG / Tailscale 共用）。两条正交轴拆开（见 docs/design/mesh-mode-exit-redesign.md）：
 *  - 轴1 接入模式：`AccessModeField` 选择器（gVisor/System），替代旧 reverseMesh 布尔开关。绑同一 reverseMesh 字段
 *    （false=gVisor 用户态栈零提权；true=System 建内核接口、写 ifscope 路由、可被反向访问/替子网转发，需 helper+TUN）。
 *    「gVisor」是技术术语，各语言一律不本地化（用户要求）。
 *  - 轴2 出网/出口：WG=全隧道开关（表单内联，System 时禁用，F4）；TS=出口节点下拉（两模式可用）。不在本文件。
 *  - 子网可达：`SubnetReachabilitySwitch`（alwaysRouteSubnets），归折叠「子网路由」段。
 *
 * 纯 UI 摆位：mesh 语义单一真值仍在 shared/endpoint-routes.ts，本组件只渲染控件、不复制路由逻辑。
 */
import { useRef } from 'react';
import type { Control, FieldValues, FieldPath } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { FormControl, FormField, FormItem, FormLabel, FormDescription } from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SwitchField } from './switch-field';
import { meshSystemSupportedOnPlatform } from '../../../../shared/endpoint-routes';

type MeshProtocol = 'wireguard' | 'tailscale';

/**
 * 接入模式选择器（用户态/System），绑 reverseMesh 布尔。System 是「需 helper+TUN 的高级模式」——
 * 提权与反向可达/转发的运行时行为仍待真机验（设计 §7），文案如实标注，不冒进默认开。
 */
export function AccessModeField<TFieldValues extends FieldValues>({
  control,
}: {
  control: Control<TFieldValues>;
}) {
  const { t } = useTranslation();
  // System 内核接口需提权 + TUN 全量捕获 → FlowZ 仅在 TUN 模式发射 system:true（systemInterfaceAvailable=
  // proxyModeType==='tun'）。非 TUN 时该节点运行期一律按 gVisor 跑，故此处把选择器**置灰显示 gVisor**——但
  // **不写回 reverseMesh**（disabled 不触发 onChange）→ 存储的 System 意图保留，切回 TUN 自动恢复实际配置。
  const tunMode = useAppStore((s) => s.config?.proxyModeType) === 'tun';
  // Windows：直接禁 System（只允许 gVisor）。tsnet 在 Windows 给 flowz-ts 自装 exit 0/0 metric=0、抢直连/bootstrap
  // DNS 致全网瘫，且无 ifscope 作用域可隔离 → System 不可靠；gVisor userspace 栈零提权、不建内核接口、出口经 tsnet
  // 内部转发即可。故 Windows 一律置灰显示 gVisor（与非 TUN 同样不写回 reverseMesh，存储意图保留）。
  const isWindows = !meshSystemSupportedOnPlatform(window.electron?.platform);
  const systemSelectable = tunMode && !isWindows;
  // 同 ExitNodeField：受控 value 编程式变更（form.reset 把 reverseMesh 设为 true→value='system'）时，Radix
  // 隐藏原生 select 会触发一次伪 onValueChange(回退到首项 'userspace')，把刚 reset 的 System 静默打回 gVisor
  // （真机实证：保存 System 后重开/保存又恢复 gVisor）。用户真正打开过下拉才允许写回。
  const interacted = useRef(false);
  return (
    <FormField
      control={control}
      name={'reverseMesh' as FieldPath<TFieldValues>}
      render={({ field }) => {
        const isSystem = field.value === true;
        // 非 TUN 或 Windows：强制显示 gVisor（有效态），不动存储值；否则按实际 reverseMesh 显示。
        const shownSystem = systemSelectable && isSystem;
        return (
          <FormItem className="space-y-1.5">
            <FormLabel className="!mt-0 font-normal">
              {t('servers.accessMode', 'Access mode')}
            </FormLabel>
            <FormControl>
              <Select
                value={shownSystem ? 'system' : 'userspace'}
                disabled={!systemSelectable}
                onOpenChange={(open) => {
                  if (open) interacted.current = true;
                }}
                onValueChange={(v) => {
                  if (!interacted.current) return; // 挂载/reset 期伪回调 → 忽略，不打回 gVisor
                  field.onChange(v === 'system');
                }}
              >
                <SelectTrigger className="w-full sm:w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="userspace">
                    {t('servers.accessModeUserspace', 'gVisor')}
                  </SelectItem>
                  <SelectItem value="system">{t('servers.accessModeSystem', 'System')}</SelectItem>
                </SelectContent>
              </Select>
            </FormControl>
            <FormDescription>
              {isWindows
                ? t(
                    'servers.accessModeWindowsGvisorOnly',
                    'Windows supports gVisor only — runs as a userspace netstack (outbound / access; no kernel interface).'
                  )
                : !tunMode
                  ? t(
                      'servers.accessModeSystemTunOnly',
                      'System needs TUN mode; in non-TUN it runs as gVisor (your setting is kept and restored when you switch back to TUN).'
                    )
                  : isSystem
                    ? t(
                        'servers.accessModeSystemDesc',
                        'System: real kernel interface — reachable by other devices, can route for subnets (needs helper + TUN).'
                      )
                    : t(
                        'servers.accessModeUserspaceDesc',
                        'gVisor userspace netstack — no privileges; outbound / access only.'
                      )}
            </FormDescription>
          </FormItem>
        );
      }}
    />
  );
}

/** 子网恒可达开关（alwaysRouteSubnets）。protocol 决定文案口径，归折叠「子网路由」段。 */
export function SubnetReachabilitySwitch<TFieldValues extends FieldValues>({
  control,
  protocol,
}: {
  control: Control<TFieldValues>;
  protocol: MeshProtocol;
}) {
  const { t } = useTranslation();
  const tooltip =
    protocol === 'tailscale'
      ? t(
          'servers.alwaysRouteSubnetsTsDesc',
          'On: the tailnet and routed subnets are always reachable. Off (egress-only): routed only when this node is the active exit or a rule targets it.'
        )
      : t(
          'servers.alwaysRouteSubnetsDesc',
          'On: the subnets below are always reachable through this node. Off (egress-only): routed only when this node is the active exit or a rule targets it.'
        );
  return (
    <SwitchField
      control={control}
      name={'alwaysRouteSubnets' as FieldPath<TFieldValues>}
      label={t('servers.alwaysRouteSubnets', 'Always route its subnets (mesh)')}
      tooltip={tooltip}
    />
  );
}
