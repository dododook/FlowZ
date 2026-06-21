/**
 * 组网三开关共享分区（WG / Tailscale 共用，消除重复）：allowInternet / alwaysRouteSubnets / reverseMesh。
 * 按 protocol 选对应 `*Desc` 文案（WG/TS allowInternet、alwaysRouteSubnets 文案略不同；reverseMesh 相同），
 * 长说明全部转 ⓘ tooltip。内置 reverseMesh→allowInternet「强制 off + 禁用」联动（复刻原表单语义，不改 field 值/handleSubmit）。
 *
 * 纯 UI 摆位：mesh 语义单一真值仍在 shared/endpoint-routes.ts，本组件只渲染开关、不复制路由逻辑。
 */
import type { Control, FieldValues, FieldPath } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { SwitchField } from './switch-field';

type MeshProtocol = 'wireguard' | 'tailscale';

export function MeshOptionsSection<TFieldValues extends FieldValues>({
  control,
  protocol,
  reverseMesh,
}: {
  control: Control<TFieldValues>;
  protocol: MeshProtocol;
  /** 当前 reverseMesh 值（form.watch）——驱动 allowInternet 联动禁用与文案。 */
  reverseMesh: boolean;
}) {
  const { t } = useTranslation();
  const isTs = protocol === 'tailscale';

  const allowInternetTooltip = reverseMesh
    ? t(
        'servers.allowInternetSystemDisabled',
        'Disabled in reverse-mesh mode: a kernel-interface node only carries the listed subnets and never acts as the full-tunnel exit. Turn off reverse mesh to use this node as an exit.'
      )
    : isTs
      ? t(
          'servers.tsAllowInternetDesc',
          'On: all internet traffic egresses via the tailnet — but you must pick an exit node below for it to actually leave; Off: only the tailnet and routed subnets are reachable (no full tunnel).'
        )
      : t(
          'servers.allowInternetDesc',
          'On: all internet traffic egresses via this WireGuard node (this node is the exit); Off: only routes the subnets below (e.g. peer LAN), no default outbound.'
        );

  const alwaysRouteTooltip = isTs
    ? t(
        'servers.alwaysRouteSubnetsTsDesc',
        'On: the tailnet and routed subnets above are always reachable through this node. Off (egress-only): routed only when this node is the active exit or a rule/app explicitly targets it.'
      )
    : t(
        'servers.alwaysRouteSubnetsDesc',
        'On: the subnets below are always reachable through this node, regardless of which node is active. Off (egress-only): routed only when this node is the active exit or a rule/app explicitly targets it.'
      );

  return (
    <div className="space-y-4">
      <SwitchField
        control={control}
        name={'allowInternet' as FieldPath<TFieldValues>}
        label={t('servers.allowInternet', 'Route internet via this node (full tunnel)')}
        tooltip={allowInternetTooltip}
        disabled={reverseMesh}
        checkedOverride={reverseMesh ? false : undefined}
      />
      <SwitchField
        control={control}
        name={'alwaysRouteSubnets' as FieldPath<TFieldValues>}
        label={t('servers.alwaysRouteSubnets', 'Always route its subnets (mesh)')}
        tooltip={alwaysRouteTooltip}
      />
      <SwitchField
        control={control}
        name={'reverseMesh' as FieldPath<TFieldValues>}
        label={t('servers.reverseMesh', 'Allow inbound access (kernel interface)')}
        tooltip={
          isTs
            ? t(
                'servers.tsReverseMeshDesc',
                'Reverse mesh (be reachable): create a real kernel interface so other tailnet devices can reach services on this device. Requires the privileged helper and TUN mode.'
              )
            : t(
                'servers.wgReverseMeshDesc',
                'Create a real WireGuard kernel interface (the OS holds the tunnel IP) so peers can reach services on this device. Requires the privileged helper and TUN mode.'
              )
        }
      />
    </div>
  );
}
