import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Search, X, RotateCw } from 'lucide-react';

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
 * geosite / geoip 分类多选选择器：从规则资源 catalog 受限选择，替代自由文本。
 * 自由文本会让 typo/不存在的分类 → 运行时 remote rule_set 404 → sing-box FATAL 崩整个代理；
 * 受限选择把可选项约束到源上真实存在的标准 geo 分类，从源头消灭该 footgun。
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

  const add = (tag: string) => {
    if (!value.includes(tag)) onChange([...value, tag]);
    setQuery('');
  };
  const remove = (tag: string) => onChange(value.filter((tg) => tg !== tag));

  return (
    <div className="space-y-2 rounded-lg border border-muted-foreground/10 bg-muted/20 p-2">
      {/* 已选 chips */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1 pe-1 font-normal">
              {tag}
              <button
                type="button"
                onClick={() => remove(tag)}
                className="rounded-full p-0.5 hover:bg-foreground/10"
                aria-label={`remove ${tag}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {/* 搜索 */}
      <div className="relative">
        <Search className="absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="h-9 border-none bg-background/60 ps-8 text-sm focus-visible:ring-1"
        />
      </div>

      {/* 匹配列表（仅在搜索时展开，保持紧凑） */}
      {q && (
        <div className="max-h-40 overflow-y-auto rounded-md border border-muted-foreground/10 bg-background/40">
          {loading ? (
            <div className="px-3 py-3 text-center text-xs text-muted-foreground">
              {t('rules.customApp.geoLoading', '加载分类…')}
            </div>
          ) : matches.length > 0 ? (
            matches.map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => add(o)}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-start text-xs hover:bg-muted/60"
              >
                <span className="truncate">{o}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {localTags?.has(o)
                    ? t('rules.customApp.geoLocalMark', '本地')
                    : t('rules.customApp.geoRemoteMark', '未下载')}
                </span>
              </button>
            ))
          ) : (
            <div className="px-3 py-3 text-center text-xs text-muted-foreground">
              {t('rules.customApp.geoNoMatch', '无匹配分类')}
            </div>
          )}
        </div>
      )}

      {/* 友好提示：选中的「未下载」分类会在保存时下载进规则资源（与路由生成本地优先联动） */}
      {value.some((tg) => !localTags?.has(tg)) && (
        <p className="text-[10px] leading-tight text-muted-foreground">
          {t('rules.customApp.geoUnsavedHint', '「未下载」的分类将在保存时下载到规则资源')}
        </p>
      )}

      {/* 刷新全量（内置/缓存只含精选） */}
      {onRefresh && (
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
          className="h-auto p-0 text-[10px] text-muted-foreground"
        >
          <RotateCw className={`me-1 h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing
            ? t('rules.customApp.geoRefreshing', '加载中…')
            : t('rules.customApp.geoLoadFull', '加载完整分类清单')}
        </Button>
      )}
    </div>
  );
}
