/**
 * 单张应用分流卡片（Conduit `<details class="app-card">`）—— 卡首 `.ac-face`（图标 + 名 + 分类·副文 + 当前策略 dot+文字 + chev）
 * 经原生 `<details>` 展开为 `.ac-body`：四态策略矩阵 `.matrix`（代理/直连/阻止/指定节点，原生 radio + `.pol`，选中态 `:has(input:checked)`）
 * + 指定节点 `.npick` 下拉（`.node-sel`，由 `:has(.pol-node input:checked)` CSS 揭示）+ 规则集 `.chips` + fail-closed 缺失 `.ac-warn`。
 * 不新增 store action：策略变更统一回调 onPolicyChange（值口径同 handlePolicyChange：proxy-default/direct/block/node-<id>）。
 * 视图密度（舒适/紧凑）由父级 `.ap-viewseg` + 反应式 CSS 排版，本卡不再按 viewMode 分支尺寸。
 */
import { useTranslation } from 'react-i18next';
import { ChevronDown, Trash2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NodePicker, type NodePickerGroup, type NodePickerItem } from '@/components/ui/node-picker';
import { iconProxySrc } from '../../../shared/icon-proxy';
import type { AppRule } from '../../../shared/types';
import { resolveAppIcon, type AppPolicyKind, type DisplayAppPreset } from './app-rules-logic';
import { FOLLOW_GLOBAL_NODE_ID } from './rule-dialog-logic';

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
  iconFailed: boolean;
  onIconError: () => void;
  /** 值口径同 handlePolicyChange：'proxy-default' | 'direct' | 'block' | `node-${id}`。 */
  onPolicyChange: (value: string) => void;
  /** 自定义应用删除（内置不传）。 */
  onDelete?: () => void;
  /** 「前往规则资源」下载缺失规则集。 */
  onGoToResources: () => void;
}

/** 四态派生 → 卡首 `.ac-policy` / `.pdot` 语义色（node 复用 proxy teal）。 */
const FACE_CLASS: Record<AppPolicyKind, 'proxy' | 'direct' | 'block'> = {
  proxy: 'proxy',
  node: 'proxy',
  direct: 'direct',
  block: 'block',
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
  iconFailed,
  onIconError,
  onPolicyChange,
  onDelete,
  onGoToResources,
}: AppCardProps) {
  const { t } = useTranslation();
  // 策略模型对齐路由规则（用户反馈）：3 态 代理/直连/阻断。「代理」态下方揭示节点选择器（跟随全局哨兵=proxy-default /
  // 具体节点=node-<id>），不再单列「指定节点」瓦片。proxyActive = 代理瓦片选中（policyKind 为 proxy 或 node）。
  const proxyActive = policyKind === 'proxy' || policyKind === 'node';

  const icon = resolveAppIcon(preset, preset.id, iconFailed ? new Set([preset.id]) : undefined);
  const isLetterIcon = icon.type === 'emoji' && /^[A-Za-z0-9]$/.test(icon.char);

  const faceKind = FACE_CLASS[policyKind];
  const faceLabel =
    policyKind === 'node'
      ? nodeLabel || t('rules.proxy')
      : policyKind === 'direct'
        ? t('rules.direct')
        : policyKind === 'block'
          ? t('rules.block')
          : t('rules.proxy');

  const chips: { text: string; proc: boolean }[] = [
    ...preset.geositeTags.map((g) => ({ text: `geosite:${g}`, proc: false })),
    ...(preset.geoipTags || []).map((g) => ({ text: `geoip:${g}`, proc: false })),
    ...(preset.processNames || []).map((p) => ({ text: p, proc: true })),
  ];

  const selectTile = (kind: AppPolicyKind) => {
    // 代理：切到代理态——默认跟随全局；已是代理/指定节点则不动（下方 picker 承接节点选择）。直连/阻断：直接提交。
    if (kind === 'proxy') {
      if (!proxyActive) onPolicyChange('proxy-default');
      return;
    }
    onPolicyChange(kind);
  };

  const tiles: {
    kind: AppPolicyKind;
    dot: 'proxy' | 'direct' | 'block';
    node?: boolean;
    title: string;
    hint: string;
  }[] = [
    {
      kind: 'proxy',
      dot: 'proxy',
      title: t('rules.proxy'),
      hint: t('rules.appTile.proxyHint', '跟随全局出口'),
    },
    {
      kind: 'direct',
      dot: 'direct',
      title: t('rules.direct'),
      hint: t('rules.appTile.directHint', '不经代理'),
    },
    {
      kind: 'block',
      dot: 'block',
      title: t('rules.block'),
      hint: t('rules.appTile.blockHint', '丢弃连接'),
    },
  ];

  return (
    // name= 令同组 details 互斥（手风琴）：展开一张即收起其他（用户反馈）。Chromium 136 原生支持。
    <details className="app-card" name="app-policy-card">
      <summary className="ac-face">
        <span className={cn('app-ico', isLetterIcon && 'letter')}>
          {icon.type === 'img' ? (
            <img src={iconProxySrc(icon.url)} alt="" loading="lazy" onError={onIconError} />
          ) : (
            icon.char
          )}
        </span>
        <span className="ac-meta">
          <span className="ac-name">{label}</span>
          <span className="ac-sub">
            {subText}
            {missing && (
              <>
                {' · '}
                <span className="miss">⚠ {t('rules.appGeoMissingShort', '规则集缺失')}</span>
              </>
            )}
          </span>
        </span>
        <span className={cn('ac-policy', faceKind)}>
          <span className={cn('pdot', faceKind)} />
          {faceLabel}
        </span>
        <ChevronDown className="ac-chev" />
      </summary>

      <div className="ac-body">
        <div className="ac-lbl">
          {t('rules.appTile.policyLabel', '出站策略')}{' '}
          <small>{t('rules.appTile.policyClickHint', '点击切换')}</small>
        </div>
        <div className="matrix">
          {tiles.map((tile) => (
            <label key={tile.kind} className={cn('pol', tile.kind === 'proxy' && 'pol-proxy')}>
              <input
                type="radio"
                name={`pol-${preset.id}`}
                checked={tile.kind === 'proxy' ? proxyActive : policyKind === tile.kind}
                onChange={() => selectTile(tile.kind)}
              />
              <span className={cn('pdot', tile.dot)} />
              <span className="pt">
                <b>{tile.title}</b>
                <small>{tile.hint}</small>
              </span>
            </label>
          ))}
        </div>

        {/* 代理态节点选择器（对齐路由规则）：跟随全局哨兵置顶 = proxy-default，具体节点 = node-<id>。
            显隐由 `:has(.pol-proxy input:checked)` CSS 驱动（选中「代理」瓦片即显）。 */}
        <div className="node-sel">
          <NodePicker
            items={targetItems}
            groups={targetGroups}
            value={policyKind === 'node' ? (rule?.targetServerId ?? null) : FOLLOW_GLOBAL_NODE_ID}
            onSelect={(id) =>
              onPolicyChange(id === FOLLOW_GLOBAL_NODE_ID ? 'proxy-default' : `node-${id}`)
            }
            placeholder={t('rules.appTile.nodePick', '选择出口')}
            searchPlaceholder={t('common.search', '搜索')}
            ariaLabel={t('rules.targetNode', '目标节点')}
          />
        </div>

        {chips.length > 0 && (
          <>
            <div className="ac-lbl">
              {t('rules.appTile.ruleSetLabel', '规则集')}{' '}
              <small>{t('rules.appTile.ruleSetSub', 'geosite / geoip / 进程名')}</small>
            </div>
            <div className="chips">
              {chips.map((c, i) => (
                <span key={`${c.text}-${i}`} className={cn('chip', c.proc && 'proc')}>
                  {c.text}
                </span>
              ))}
            </div>
          </>
        )}

        {missing && (
          <div className="ac-warn">
            <AlertTriangle />
            <span>
              {t(
                'rules.appGeoMissingTip',
                '该应用引用的分流规则集缺失（已删除或文件丢失），仅按进程名生效；请到「规则资源」页下载恢复'
              )}
            </span>
            <span
              className="lk"
              role="button"
              tabIndex={0}
              onClick={onGoToResources}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onGoToResources();
                }
              }}
            >
              {t('rules.appTile.download', '下载')}
            </span>
          </div>
        )}

        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex items-center gap-1.5 self-start text-[11px] font-medium text-err/80 hover:text-err"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('rules.customApp.delete', '删除应用')}
          </button>
        )}
      </div>
    </details>
  );
}
