/**
 * 出口节点选择：tailnet 设备下拉（`.npick` NodePicker）+ 自定义填写。
 *  - 列全部 peer（已排除 self）；可作出口(exitNodeOption)的可选，其余 disabled 并标「未广告出口」；标在线/离线、当前「使用中」。
 *  - 顶部「无」清空 exit_node；底部「自定义」→ 下方文本框填 IP/主机名。下拉始终可见，随时切回选设备（辨识度高）。
 *  - 无 peer（未连接/无数据）→ 退化为纯文本框。数据来自 store.tailscalePeers（L2 状态流/主动拉）。
 *  - NodePicker 基于 radix dropdown-menu、无受控 value/onValueChange 路径（value 只驱动回填✓、变更不回调），
 *    结构性免疫原 radix Select 架构下「form.reset / peer 流刷新触发伪 onValueChange(回退 NONE) 清空已配置
 *    exit_node」的回归 → 原 interacted 守卫已无必要、删除。回归验证见真机清单。纯映射逻辑在 exit-node-field-logic。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { Input } from '@/components/ui/input';
import { NodePicker } from '@/components/ui/node-picker';
import { CUSTOM, NONE, matchPeer, peersToItems, sortPeers } from './exit-node-field-logic';

interface ExitNodeFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** 当前 TS 节点 id（取 store.tailscalePeers[serverId]）。缺失则退化为纯文本输入。 */
  serverId?: string;
  disabled?: boolean;
}

export function ExitNodeField({ value, onChange, serverId, disabled }: ExitNodeFieldProps) {
  const { t } = useTranslation();
  const peers = useAppStore((s) => (serverId ? s.tailscalePeers[serverId] : undefined)) ?? [];
  const [customMode, setCustomMode] = useState(false);

  const sorted = useMemo(() => sortPeers(peers), [peers]);
  const trimmed = value.trim();
  const matched = matchPeer(sorted, trimmed);
  // 自定义 = 显式切入 或（有值且不匹配任何 peer）。
  const isCustom = customMode || (!!trimmed && !matched);

  const customInput = (
    <Input
      placeholder="100.x.y.z / hostname"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    />
  );

  // 无 peer（未连接/无数据）→ 纯文本框兜底（无设备可选）。
  if (sorted.length === 0) return customInput;

  const items = peersToItems(sorted, trimmed, {
    none: t('servers.tsExitNodeNone', 'None'),
    custom: t('servers.tsExitNodeCustom', 'Custom…'),
    inUse: t('servers.tsExitNodeInUse', 'in use'),
    offline: t('servers.tsExitNodeOffline', 'offline'),
    notAdvertised: t('servers.tsExitNodeNotAdvertised', 'not an exit node'),
  });
  // isCustom 优先：显式切「自定义」时即便当前值仍匹配某设备，也保持「自定义」（不回填设备）。
  const pickerValue = isCustom ? CUSTOM : matched ? matched.ip : NONE;

  const handleSelect = (id: string) => {
    if (id === CUSTOM) {
      setCustomMode(true);
      return;
    }
    setCustomMode(false);
    onChange(id === NONE ? '' : id);
  };

  return (
    <div className="space-y-2">
      <NodePicker
        items={items}
        value={pickerValue}
        onSelect={handleSelect}
        disabled={disabled}
        showAddress
        ariaLabel={t('servers.tsExitNode', 'Exit node')}
        searchPlaceholder={t('common.search', '搜索')}
      />
      {isCustom && customInput}
    </div>
  );
}
