/**
 * 出口节点选择：tailnet 设备下拉 + 自定义填写。
 *  - 列全部 peer（已排除 self）；可作出口(exitNodeOption)的可选，其余禁用并标「未广告出口」；标在线/离线、当前「使用中」。
 *  - 顶部「无」可清空；底部「自定义」→ 下方出现文本框填 IP/主机名。下拉始终可见，随时切回选设备（辨识度高）。
 *  - 无 peer（未连接/无数据）→ 退化为纯文本框。数据来自 store.tailscalePeers（L2 状态流/主动拉）。
 */
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/app-store';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// 哨兵值（不与任何 100.x IP 撞）。
const NONE = '__none__';
const CUSTOM = '__custom__';

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
  // 仅在用户真正打开过下拉后才让 onValueChange 写回——否则受控 value 在挂载/peer 流刷新时与渲染中的 item
  // 不同步，Radix 会触发一次伪 onValueChange(回退 NONE) 把已配置的 exit_node 静默清空（真机实证：
  // form.reset 后 exitNode 被清成 ''，存盘变「无」）。用户未交互的回调一律忽略，保住初始值。
  const interacted = useRef(false);

  // 排序：可作出口优先 → 在线优先 → 名称。仅含非空 IP 的 peer（radix SelectItem value 不可为空串）。
  const sorted = useMemo(
    () =>
      peers
        .filter((p) => !!p.ip)
        .slice()
        .sort((a, b) => {
          if (a.exitNodeOption !== b.exitNodeOption) return a.exitNodeOption ? -1 : 1;
          if (a.online !== b.online) return a.online ? -1 : 1;
          return (a.hostName || '').localeCompare(b.hostName || '');
        }),
    [peers]
  );

  const trimmed = value.trim();
  // 按 ip 或主机名匹配：sing-box exit_node 合法接受 IP 或 hostname，故 hostname 配置也要命中其设备行（不被误判自定义）。
  const matched = sorted.find((p) => p.ip === trimmed || p.hostName === trimmed);
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

  return (
    <div className="space-y-2">
      <Select
        value={isCustom ? CUSTOM : matched ? matched.ip : NONE}
        disabled={disabled}
        onOpenChange={(open) => {
          if (open) interacted.current = true;
        }}
        onValueChange={(v) => {
          // 挂载/peer 流刷新引发的伪回调（用户没开过下拉）→ 忽略，绝不清空已配置 exit_node。
          if (!interacted.current) return;
          if (v === CUSTOM) {
            setCustomMode(true);
          } else {
            setCustomMode(false);
            onChange(v === NONE ? '' : v);
          }
        }}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-96">
          <SelectItem value={NONE}>{t('servers.tsExitNodeNone', 'None')}</SelectItem>
          <SelectSeparator />
          {sorted.map((p) => (
            <SelectItem
              key={p.ip}
              value={p.ip}
              disabled={!p.exitNodeOption && p.ip !== trimmed && p.hostName !== trimmed}
            >
              <span className={`flex items-center gap-2 ${p.online ? '' : 'opacity-70'}`}>
                <span
                  aria-hidden
                  className={`text-[0.6rem] leading-none ${p.online ? 'text-foreground/60' : 'text-muted-foreground/40'}`}
                >
                  ●
                </span>
                <span className="font-medium">{p.hostName || p.ip}</span>
                <span className="font-mono text-xs text-muted-foreground">{p.ip}</span>
                {p.exitNode && (
                  <span className="text-xs text-primary">
                    · {t('servers.tsExitNodeInUse', 'in use')}
                  </span>
                )}
                {!p.online && (
                  <span className="text-xs text-muted-foreground">
                    · {t('servers.tsExitNodeOffline', 'offline')}
                  </span>
                )}
                {!p.exitNodeOption && (
                  <span className="text-xs text-muted-foreground">
                    · {t('servers.tsExitNodeNotAdvertised', 'not an exit node')}
                  </span>
                )}
              </span>
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={CUSTOM}>{t('servers.tsExitNodeCustom', 'Custom…')}</SelectItem>
        </SelectContent>
      </Select>
      {isCustom && customInput}
    </div>
  );
}
