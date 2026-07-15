import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, RotateCw } from 'lucide-react';

interface GeoTagPickerProps {
  /** 可选分类名（已按 kind 过滤 + 去重 + 排序，来自 catalog）。 */
  options: string[];
  /** 已选 tag。 */
  value: string[];
  onChange: (tags: string[]) => void;
  /** 已在本地（内置随包 / 已下载进规则资源）的裸 tag 集合，用于标注「本地 / 未下载」。 */
  localTags?: Set<string>;
  loading?: boolean;
  refreshing?: boolean;
  /** 拉取远程全量 catalog（内置/缓存只含精选，全量需刷新）。 */
  onRefresh?: () => void;
  placeholder?: string;
}

const MAX_VISIBLE = 50;

/**
 * geosite / geoip 分类多选选择器（Conduit `.ms` 芯片 + `.ico-search`）：从规则资源 catalog 受限选择，替代自由文本。
 * 自由文本会让 typo/不存在的分类 → 运行时 remote rule_set 404 → sing-box FATAL 崩整个代理；
 * 受限选择把可选项约束到源上真实存在的标准 geo 分类，从源头消灭该 footgun。
 * 已选项恒显为选中 `.ms` 芯片（再点取消）；搜索时下方列出匹配项（未下载项带标注），点选即加入。
 */
export function GeoTagPicker({
  options,
  value,
  onChange,
  localTags,
  loading,
  refreshing,
  onRefresh,
  placeholder,
}: GeoTagPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const matches = useMemo(() => {
    const selected = new Set(value);
    return options
      .filter((o) => !selected.has(o) && (!q || o.toLowerCase().includes(q)))
      .slice(0, MAX_VISIBLE);
  }, [options, value, q]);

  const toggle = (tag: string) => {
    if (value.includes(tag)) onChange(value.filter((tg) => tg !== tag));
    else {
      onChange([...value, tag]);
      setQuery('');
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-2">
      {/* 已选 chips（选中态 `.ms`，`::before` ✓ 由 CSS 加；点击取消） */}
      {value.length > 0 && (
        <div className="ms">
          {value.map((tag) => (
            <label key={tag}>
              <input type="checkbox" checked onChange={() => toggle(tag)} />
              {tag}
            </label>
          ))}
        </div>
      )}

      <label className="ico-search">
        <Search />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
        />
      </label>

      {q && (
        <div className="max-h-40 overflow-y-auto">
          {loading ? (
            <div className="px-1 py-3 text-center text-xs text-fg-faint">
              {t('rules.customApp.geoLoading', '加载分类…')}
            </div>
          ) : matches.length > 0 ? (
            <div className="ms">
              {matches.map((o) => (
                <label key={o}>
                  <input type="checkbox" checked={false} onChange={() => toggle(o)} />
                  {o}
                  <span className="ms-1 text-[9.5px] text-fg-faint">
                    {localTags?.has(o)
                      ? t('rules.customApp.geoLocalMark', '本地')
                      : t('rules.customApp.geoRemoteMark', '未下载')}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <div className="px-1 py-3 text-center text-xs text-fg-faint">
              {t('rules.customApp.geoNoMatch', '无匹配分类')}
            </div>
          )}
        </div>
      )}

      {/* 与路由生成本地优先联动 */}
      {value.some((tg) => !localTags?.has(tg)) && (
        <p className="text-[10px] leading-tight text-fg-faint">
          {t('rules.customApp.geoUnsavedHint', '「未下载」的分类将在保存时下载到规则资源')}
        </p>
      )}

      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1 self-start text-[10px] text-fg-faint hover:text-fg-dim disabled:opacity-60"
        >
          <RotateCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing
            ? t('rules.customApp.geoRefreshing', '加载中…')
            : t('rules.customApp.geoLoadFull', '加载完整分类清单')}
        </button>
      )}
    </div>
  );
}
