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
          'When off, this node never acts as a full-tunnel exit (the exit node below is ignored); it only reaches the tailnet and routed subnets.'
        )
      : t(
          'servers.allowInternetDesc',
          'When off, this node only routes the subnets listed below (e.g. peer LAN); it will not carry your default outbound traffic.'
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
        label={t('servers.allowInternet', 'Allow internet access')}
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
        label={t('servers.reverseMesh', 'Reverse mesh (be reachable)')}
        tooltip={t(
          'servers.reverseMeshDesc',
          'Create a real kernel interface so peers can reach this device or use it as a subnet router. Requires the privileged helper and TUN mode.'
        )}
      />
    </div>
  );
}
