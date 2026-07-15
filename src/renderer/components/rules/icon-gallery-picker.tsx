/**
 * 图标库选择器（Conduit `.ico-lib`，内联 `<details>` 展开）—— 用于新增自定义应用的「应用图标」字段：
 * 远端图标搜索 + 网格选择（`.ico-remote`，加载失败回退首字母 `.ico-fallback`）+ emoji 兜底调色板 `.ico-emoji`
 * + 手动粘贴图标 URL `.ico-url`。图标库经模块级缓存跨「打开/关闭」持久化，避免每次重拉 CDN。
 * 数据源解耦：只吃当前 emoji/iconUrl + appName，回调回填父级表单（onPickRemote / onPickEmoji / onApplyUrl）。
 */
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, ChevronDown } from 'lucide-react';
import { ruleResourcesApi } from '@/ipc/api-client';
import { iconProxySrc } from '../../../shared/icon-proxy';

type IconItem = { name: string; url: string };

// 模块级缓存：已拉取的图标库跨组件挂载持久化（图标库每次打开不重拉 CDN）；空结果不缓存（length>0 才跳过重拉）。
let _iconGalleryCache: IconItem[] = [];

const EMOJI_PALETTE = ['🌐', '📺', '🎬', '🎮', '💬', '🤖', '🛒', '🎵'];

interface IconGalleryPickerProps {
  /** 当前 emoji（无 iconUrl 时展示 + `.sel` 高亮）。 */
  emoji: string;
  iconUrl: string;
  /** 应用名（首字母回退用）。 */
  appName: string;
  /** 选中远端图标（url + 由文件名推导的建议名，供未命名时回填）。 */
  onPickRemote: (url: string, suggestedName: string) => void;
  /** 选中 emoji（清 iconUrl、置 emoji）。 */
  onPickEmoji: (emoji: string) => void;
  onApplyUrl: (url: string) => void;
}

const firstLetter = (s: string): string => (s.trim()[0] || '?').toUpperCase();

export function IconGalleryPicker({
  emoji,
  iconUrl,
  appName,
  onPickRemote,
  onPickEmoji,
  onApplyUrl,
}: IconGalleryPickerProps) {
  const { t } = useTranslation();
  const [iconGalleries, setIconGalleries] = useState<IconItem[]>(() => _iconGalleryCache);
  const [isLoadingIcons, setIsLoadingIcons] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [urlInput, setUrlInput] = useState('');
  // 加载失败的远端图标 url 集合 → 回退首字母（.ico-fallback）。
  const [failedRemotes, setFailedRemotes] = useState<Set<string>>(() => new Set());
  const [previewFailed, setPreviewFailed] = useState(false);

  useEffect(() => {
    // 已缓存有内容且非重试 → 跳过（保留原 iconGalleries.length>0 guard 语义）
    if (_iconGalleryCache.length > 0 && retryTick === 0) return;

    const fetchIcons = async () => {
      setIsLoadingIcons(true);
      try {
        // 图标库拉取下沉主进程经 update-in 统一会话（renderer 不再直接 fetch 走 default session）。
        // 多 CDN 源兜底 + 全失败返 [] 由主进程 RuleResourceManager.fetchIconGalleries 处理。
        const allIcons = await ruleResourcesApi.fetchIconGalleries();
        // 无论是否拿到数据都正常结束，失败时 allIcons 为空数组，UI 会显示 emoji/URL 兜底
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

  // 预览 img 换源时清失败态（避免上次失败缓存到新 url）。
  useEffect(() => {
    setPreviewFailed(false);
  }, [iconUrl]);

  const filteredIcons = searchQuery
    ? iconGalleries.filter((i) => i.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : iconGalleries.slice(0, 60);

  const markRemoteFailed = (url: string) =>
    setFailedRemotes((prev) => (prev.has(url) ? prev : new Set(prev).add(url)));

  const applyUrl = () => {
    const u = urlInput.trim();
    if (!u) return;
    onApplyUrl(u);
    setUrlInput('');
  };

  return (
    <details className="ico-lib">
      <summary className="ico-cur">
        <span className="ico-prev">
          {iconUrl && !previewFailed ? (
            <img src={iconProxySrc(iconUrl)} alt="" onError={() => setPreviewFailed(true)} />
          ) : iconUrl && previewFailed ? (
            <span className="ico-fallback">{firstLetter(appName || 'A')}</span>
          ) : (
            emoji
          )}
        </span>
        <span className="ico-cur-tx">
          {iconUrl
            ? t('rules.customApp.iconSelected', { url: iconUrl })
            : t('rules.customApp.iconChoosePrompt')}
        </span>
        <ChevronDown className="chev" />
      </summary>

      <div className="ico-lib-body">
        <label className="ico-search">
          <Search />
          <input
            type="text"
            placeholder={t('rules.customApp.searchIconPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </label>

        <div className="ico-sub">{t('rules.customApp.iconRemoteGroup', '远端图标')}</div>
        {isLoadingIcons ? (
          <div className="px-1 py-3 text-center text-xs text-fg-faint">
            {t('rules.customApp.loadingIcons')}
          </div>
        ) : iconGalleries.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-1 py-2 text-center">
            <span className="text-xs text-fg-faint">{t('rules.customApp.iconLoadFailed')}</span>
            <button
              type="button"
              className="text-[11px] text-flow-hi hover:underline"
              onClick={() => setRetryTick((n) => n + 1)}
            >
              {t('rules.customApp.retryLoad')}
            </button>
          </div>
        ) : (
          <div className="ico-grid">
            {filteredIcons.map((icon, idx) => {
              const failed = failedRemotes.has(icon.url);
              const selected = iconUrl === icon.url;
              const suggested = icon.name.replace('.png', '').replace(/_/g, ' ');
              return (
                <button
                  key={`${icon.name}-${idx}`}
                  type="button"
                  className={selected ? 'ico-remote sel' : 'ico-remote'}
                  title={icon.name}
                  onClick={() => onPickRemote(icon.url, suggested)}
                >
                  {failed ? (
                    <span className="ico-fallback">{firstLetter(icon.name)}</span>
                  ) : (
                    <img
                      src={iconProxySrc(icon.url)}
                      alt=""
                      loading="lazy"
                      onError={() => markRemoteFailed(icon.url)}
                    />
                  )}
                  <span className="rn">{suggested}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="ico-sub">{t('rules.customApp.iconEmojiGroup', 'emoji 兜底')}</div>
        <div className="ico-emoji">
          {EMOJI_PALETTE.map((e) => (
            <button
              key={e}
              type="button"
              className={!iconUrl && emoji === e ? 'sel' : undefined}
              onClick={() => onPickEmoji(e)}
            >
              {e}
            </button>
          ))}
          {appName.trim() && (
            <button
              type="button"
              className={!iconUrl && emoji === firstLetter(appName) ? 'ltr sel' : 'ltr'}
              title={t('rules.customApp.iconLetterFallback', '首字母图标')}
              onClick={() => onPickEmoji(firstLetter(appName))}
            >
              {firstLetter(appName)}
            </button>
          )}
        </div>

        <div className="ico-sub">{t('rules.customApp.iconUrlGroup', '或粘贴图标 URL')}</div>
        <div className="ico-url">
          <input
            type="text"
            placeholder="https://…/icon.png"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyUrl();
              }
            }}
          />
          <button type="button" className="btn sm ghost" onClick={applyUrl}>
            {t('common.apply', '应用')}
          </button>
        </div>

        <div className="ico-hint">
          {t('rules.customApp.iconFallbackHint', '远端图标加载失败时，自动回退为应用名首字母。')}
        </div>
      </div>
    </details>
  );
}
