/**
 * 图标库选择器 —— 从 app-rules-card 抽出（审计 §6 Tier-2 #4：拆 IconGallery）。
 * 自含：多 CDN 兜底拉取图标库 + 搜索 + 网格选择 + 加载失败手动输入兜底。
 * 与主卡的 preset 图标失败缓存（_failedIconsCache）无关，故可独立成组件。
 * 图标库经模块级缓存跨「打开/关闭」持久化（同 _failedIconsCache 模式），避免每次开重拉 CDN。
 */
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Plus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ruleResourcesApi } from '@/ipc/api-client';
import { iconProxySrc } from '../../../shared/icon-proxy';

type IconItem = { name: string; url: string };

// 模块级缓存：已拉取的图标库跨组件挂载持久化（图标库每次打开不重拉 CDN）；空结果不缓存（length>0 才跳过重拉）。
let _iconGalleryCache: IconItem[] = [];

interface IconGalleryPickerProps {
  /** 选中图标库中的某图标（url + 由文件名推导的建议名，供未命名时回填）。 */
  onSelectIcon: (url: string, suggestedName: string) => void;
  /** 选「默认 🌐」：清图标 URL、置 emoji 🌐 并关闭图标库。 */
  onSelectDefault: () => void;
  /** 关闭图标库（返回新增表单）。 */
  onClose: () => void;
  /** 手动输入图标 URL 兜底（绑定外层 newAppIconUrl）。 */
  manualUrl: string;
  onManualUrlChange: (v: string) => void;
}

export function IconGalleryPicker({
  onSelectIcon,
  onSelectDefault,
  onClose,
  manualUrl,
  onManualUrlChange,
}: IconGalleryPickerProps) {
  const { t } = useTranslation();
  const [iconGalleries, setIconGalleries] = useState<IconItem[]>(() => _iconGalleryCache);
  const [isLoadingIcons, setIsLoadingIcons] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    // 已缓存有内容且非重试 → 跳过（保留原 iconGalleries.length>0 guard 语义）
    if (_iconGalleryCache.length > 0 && retryTick === 0) return;

    const fetchIcons = async () => {
      setIsLoadingIcons(true);
      try {
        // 图标库拉取下沉主进程经 update-in 统一会话（Phase 1b：renderer 不再直接 fetch 走 default session）。
        // 多 CDN 源兜底 + 全失败返 [] 由主进程 RuleResourceManager.fetchIconGalleries 处理。
        const allIcons = await ruleResourcesApi.fetchIconGalleries();
        // 无论是否拿到数据都正常结束，失败时 allIcons 为空数组，UI 会显示手动输入兜底
        _iconGalleryCache = allIcons;
        setIconGalleries(allIcons);
      } catch (e) {
        console.error('Failed to fetch icon galleries:', e);
        setIconGalleries([]); // 保证 isLoading 能结束，并显示兜底 UI
      } finally {
        setIsLoadingIcons(false);
      }
    };
    fetchIcons();
  }, [retryTick]);

  const filteredIcons = searchQuery
    ? iconGalleries.filter((i) => i.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : iconGalleries.slice(0, 100);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
            <Plus className="h-4 w-4 rotate-45" />
          </Button>
          {t('rules.customApp.selectIconGallery')}
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div className="relative">
          <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('rules.customApp.searchIconPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ps-9 h-10 text-sm bg-muted/30 border-none focus-visible:ring-1"
          />
        </div>
        <ScrollArea className="h-[300px] pe-4">
          <div className="grid grid-cols-5 gap-3 p-1">
            {isLoadingIcons ? (
              <div className="col-span-5 py-20 text-center text-sm text-muted-foreground animate-pulse">
                {t('rules.customApp.loadingIcons')}
              </div>
            ) : (
              <>
                {!searchQuery && (
                  <Button
                    variant="outline"
                    className="h-12 w-12 p-0 text-xl hover:bg-primary/5 hover:border-primary/30"
                    onClick={onSelectDefault}
                  >
                    🌐
                  </Button>
                )}
                {filteredIcons.map((icon, idx) => (
                  <Button
                    key={`${icon.name}-${idx}`}
                    variant="ghost"
                    className="h-12 w-12 p-1.5 hover:bg-primary/5 hover:border-primary/30 border border-transparent transition-all"
                    onClick={() =>
                      onSelectIcon(icon.url, icon.name.replace('.png', '').replace(/_/g, ' '))
                    }
                  >
                    <img
                      src={iconProxySrc(icon.url)}
                      className="h-full w-full object-contain"
                      alt={icon.name}
                      onError={(e) => {
                        // 图标代理 403(SSRF)/502(拉取失败) → 隐藏破图（缩略图为可选展示，无需占位）
                        e.currentTarget.style.visibility = 'hidden';
                      }}
                    />
                  </Button>
                ))}
              </>
            )}
          </div>
          {!isLoadingIcons && iconGalleries.length === 0 && (
            <div className="py-6 px-2 space-y-3">
              <p className="text-xs text-center text-muted-foreground">
                {t('rules.customApp.iconLoadFailed')}
              </p>
              {/* 兜底方案：手动输入图标 URL */}
              <div className="space-y-2">
                <p className="text-[10px] text-muted-foreground">
                  {t('rules.customApp.manualIconHint')}
                </p>
                <div className="flex gap-2">
                  <Input
                    placeholder="https://example.com/icon.png"
                    value={manualUrl}
                    onChange={(e) => onManualUrlChange(e.target.value)}
                    className="h-9 text-xs bg-muted/30 border-none focus-visible:ring-1"
                  />
                  <Button size="sm" variant="outline" className="shrink-0 h-9" onClick={onClose}>
                    {t('common.confirm')}
                  </Button>
                </div>
              </div>
              <Button
                variant="link"
                size="sm"
                className="text-[10px] w-full"
                onClick={() => setRetryTick((n) => n + 1)}
              >
                {t('rules.customApp.retryLoad')}
              </Button>
            </div>
          )}
        </ScrollArea>
      </div>
    </>
  );
}
