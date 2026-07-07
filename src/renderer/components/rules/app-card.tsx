/**
 * 单张应用分流卡片 —— 从 app-rules-card 抽出（可读性 + 每卡独立「正在选指定节点」局部态）。
 * 展开式：卡首摘要（图标 + 名 + 分类 · 副文 + 当前策略 dot+文字）→ 展开四态策略矩阵（代理/直连/阻止/指定节点）
 * + 指定节点一步 `.npick` 下拉（选中即回填卡首摘要）+ 规则集 chips + fail-closed 缺失说明。
 * 不新增 store action：策略变更统一回调 onPolicyChange（值口径同 handlePolicyChange：proxy-default/direct/block/node-<id>）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Trash2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NodePicker, type NodePickerGroup, type NodePickerItem } from '@/components/ui/node-picker';
import { iconProxySrc } from '../../../shared/icon-proxy';
import type { AppRule } from '../../../shared/types';
import { resolveAppIcon, type AppPolicyKind, type DisplayAppPreset } from './app-rules-logic';

interface AppCardProps {
  preset: DisplayAppPreset;
  rule: AppRule | undefined;
  policyKind: AppPolicyKind;
  /** 应用级规则集缺失（fail-closed）：geo 半暂不生效，进程名仍生效。 */
  missing: boolean;
  /** 展示名（内置经 i18n、自定义取原名，由父组件解析）。 */
  label: string;
  /** 卡首副文（分类 · 提示）。 */
  subText: string;
  /** 指定节点态下的当前出口名（回填卡首摘要）。 */
  nodeLabel?: string;
  targetItems: NodePickerItem[];
  targetGroups: NodePickerGroup[];
  viewMode: 'comfortable' | 'compact';
  iconFailed: boolean;
  onIconError: () => void;
  /** 值口径同 handlePolicyChange：'proxy-default' | 'direct' | 'block' | `node-${id}`。 */
  onPolicyChange: (value: string) => void;
  /** 自定义应用删除（内置不传）。 */
  onDelete?: () => void;
  /** 「前往规则资源」下载缺失规则集。 */
  onGoToResources: () => void;
}

const DOT_CLASS: Record<AppPolicyKind, string> = {
  proxy: 'bg-primary',
  node: 'bg-primary',
  direct: 'bg-success',
  block: 'bg-destructive',
};

const TEXT_CLASS: Record<AppPolicyKind, string> = {
  proxy: 'text-primary',
  node: 'text-primary',
  direct: 'text-success',
  block: 'text-destructive',
};

export function AppCard({
  preset,
  rule,
  policyKind,
  missing,
  label,
  subText,
  nodeLabel,
  targetItems,
  targetGroups,
  viewMode,
  iconFailed,
  onIconError,
  onPolicyChange,
  onDelete,
  onGoToResources,
}: AppCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // 局部「正在选指定节点」：点「指定节点」瓦片即揭示下拉但先不提交（未选节点前仍是跟随全局）；选中节点才写回。
  const [pickingNode, setPickingNode] = useState(false);

  const showPicker = policyKind === 'node' || pickingNode;
  const activeKind: AppPolicyKind = showPicker ? 'node' : policyKind;

  const icon = resolveAppIcon(preset, preset.id, iconFailed ? new Set([preset.id]) : undefined);

  const faceLabel =
    policyKind === 'node'
      ? nodeLabel || t('rules.proxy')
      : policyKind === 'direct'
        ? t('rules.direct')
        : policyKind === 'block'
          ? t('rules.block')
          : t('rules.proxy');

  const chips: { text: string; kind: 'geosite' | 'geoip' | 'proc' }[] = [
    ...preset.geositeTags.map((g) => ({ text: `geosite:${g}`, kind: 'geosite' as const })),
    ...(preset.geoipTags || []).map((g) => ({ text: `geoip:${g}`, kind: 'geoip' as const })),
    ...(preset.processNames || []).map((p) => ({ text: p, kind: 'proc' as const })),
  ];

  const selectTile = (kind: AppPolicyKind) => {
    if (kind === 'node') {
      setPickingNode(true);
      return;
    }
    setPickingNode(false);
    onPolicyChange(kind === 'proxy' ? 'proxy-default' : kind);
  };

  const tiles: { kind: AppPolicyKind; title: string; hint: string }[] = [
    { kind: 'proxy', title: t('rules.proxy'), hint: t('rules.appTile.proxyHint', '跟随全局出口') },
    { kind: 'direct', title: t('rules.direct'), hint: t('rules.appTile.directHint', '不经代理') },
    { kind: 'block', title: t('rules.block'), hint: t('rules.appTile.blockHint', '丢弃连接') },
    {
      kind: 'node',
      title: t('rules.appTile.nodeTitle', '指定节点'),
      hint:
        policyKind === 'node'
          ? t('rules.appTile.nodeLocked', '已锁定出口')
          : t('rules.appTile.nodePick', '选择出口'),
    },
  ];

  return (
    <div
      className={cn(
        'group/card relative rounded-xl border border-muted-foreground/10 bg-muted/40 transition-colors',
        expanded && 'bg-muted/60'
      )}
    >
      {/* 卡首：点击展开/收起 */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-xl text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          viewMode === 'comfortable' ? 'p-3' : 'p-2.5'
        )}
      >
        <span
          className={cn(
            'flex shrink-0 items-center justify-center rounded-lg border border-white/10 bg-background/80 shadow-sm',
            viewMode === 'comfortable' ? 'h-9 w-9 p-1' : 'h-7 w-7 p-0.5'
          )}
        >
          {icon.type === 'img' ? (
            <img
              src={iconProxySrc(icon.url)}
              alt=""
              className="h-full w-full object-contain"
              loading="lazy"
              onError={onIconError}
            />
          ) : (
            <span className={viewMode === 'comfortable' ? 'text-xl' : 'text-sm'}>{icon.char}</span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-bold tracking-tight">{label}</span>
            {missing && (
              <AlertTriangle
                className="h-3.5 w-3.5 shrink-0 text-destructive"
                aria-label={t('rules.appGeoMissingShort', '规则集缺失')}
              />
            )}
          </span>
          <span className="truncate text-[10.5px] text-muted-foreground">{subText}</span>
        </span>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 text-[11px] font-bold',
            TEXT_CLASS[policyKind]
          )}
        >
          <span className={cn('h-1.5 w-1.5 rounded-full', DOT_CLASS[policyKind])} />
          <span className="max-w-[7rem] truncate">{faceLabel}</span>
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform',
            expanded && 'rotate-180'
          )}
        />
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-muted-foreground/10 px-3 pb-3 pt-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('rules.appTile.policyLabel', '出站策略')}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {tiles.map((tile) => {
              const active = tile.kind === activeKind;
              return (
                <button
                  key={tile.kind}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => selectTile(tile.kind)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border p-2 text-start transition-colors',
                    active
                      ? 'border-primary/50 bg-primary/5'
                      : 'border-muted-foreground/10 hover:bg-muted/60'
                  )}
                >
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT_CLASS[tile.kind])} />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-bold">{tile.title}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {tile.hint}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* 指定节点：一步 `.npick` 下拉（选中即回填卡首摘要）。 */}
          {showPicker && (
            <NodePicker
              items={targetItems}
              groups={targetGroups}
              value={rule?.targetServerId ?? null}
              onSelect={(id) => onPolicyChange(`node-${id}`)}
              placeholder={t('rules.appTile.nodePick', '选择出口')}
              searchPlaceholder={t('common.search', '搜索')}
              ariaLabel={t('rules.appTile.nodeTitle', '指定节点')}
            />
          )}

          {chips.length > 0 && (
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('rules.appTile.ruleSetLabel', '规则集')}
                <span className="ms-1 font-normal normal-case opacity-70">
                  {t('rules.appTile.ruleSetSub', 'geosite / geoip / 进程名')}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {chips.map((c, i) => (
                  <span
                    key={`${c.kind}-${c.text}-${i}`}
                    className={cn(
                      'rounded px-1.5 py-0.5 font-mono text-[10px]',
                      c.kind === 'proc'
                        ? 'bg-primary/10 text-primary'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {c.text}
                  </span>
                ))}
              </div>
            </div>
          )}

          {missing && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-[11px] text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
              <span className="min-w-0">
                {t(
                  'rules.appGeoMissingTip',
                  '该应用引用的分流规则集缺失（已删除或文件丢失），仅按进程名生效；请到「规则资源」页下载恢复'
                )}
                <button
                  type="button"
                  onClick={onGoToResources}
                  className="ms-1 font-medium text-primary underline-offset-2 hover:underline"
                >
                  {t('rules.appTile.download', '下载')}
                </button>
              </span>
            </div>
          )}

          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="flex items-center gap-1.5 text-[11px] font-medium text-destructive/80 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('rules.customApp.delete', '删除应用')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
