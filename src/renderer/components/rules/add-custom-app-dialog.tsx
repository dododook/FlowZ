/**
 * 新增自定义应用对话框 —— 从 app-rules-card 抽出（审计 §6 Tier-2 #4：拆 AddCustomAppDialog）。
 * 自含：名称/图标/Geosite/GeoIP 表单 + geo 分类 catalog 拉取/刷新 + 提交（注入默认 appRule + fail-closed 下载 geo）。
 * 图标库视图委托 IconGalleryPicker。showIconGallery 为对话框内部态：每次打开重置为表单视图（取代原 +按钮的 reset）。
 * geoLocalList 由主卡传入（主卡亦用于「规则集缺失」角标，单一来源），localGeo*Tags 在此派生。
 */
import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Image as ImageIcon } from 'lucide-react';
import type {
  AppRule,
  CustomAppPreset,
  RuleResourceCatalogItem,
  RuleResourceListItem,
  UserConfig,
} from '../../../shared/types';
import { api } from '@/ipc/api-client';
import { GeoTagPicker } from './geo-tag-picker';
import { geoCategoryOptions, localGeoTagSet } from './geo-tag-picker-utils';
import { IconGalleryPicker } from './icon-gallery-picker';
import { toast } from 'sonner';

interface AddCustomAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: UserConfig;
  saveConfig: (config: UserConfig) => Promise<void>;
  geoLocalList: RuleResourceListItem[];
}

export function AddCustomAppDialog({
  open,
  onOpenChange,
  config,
  saveConfig,
  geoLocalList,
}: AddCustomAppDialogProps) {
  const { t } = useTranslation();

  const [showIconGallery, setShowIconGallery] = useState(false);
  const [newAppName, setNewAppName] = useState('');
  const [newAppEmoji, setNewAppEmoji] = useState('🌐');
  const [newAppIconUrl, setNewAppIconUrl] = useState('');
  const [newAppGeositeTags, setNewAppGeositeTags] = useState<string[]>([]);
  const [newAppGeoipTags, setNewAppGeoipTags] = useState<string[]>([]);
  // geo 分类 catalog（geosite/geoip 多选选择器数据源）：内置/缓存即时，全量需刷新
  const [geoCatalog, setGeoCatalog] = useState<RuleResourceCatalogItem[]>([]);
  const [geoCatalogLoading, setGeoCatalogLoading] = useState(false);
  const [geoCatalogRefreshing, setGeoCatalogRefreshing] = useState(false);

  // 打开时重置为表单视图（取代原 +按钮的 setShowIconGallery(false)）
  useEffect(() => {
    if (open) setShowIconGallery(false);
  }, [open]);

  // 打开新增对话框时拉 geo 分类 catalog（getCatalog 走内置/磁盘缓存，无网络）；只拉一次，全量由刷新按钮拉
  useEffect(() => {
    if (!open || geoCatalog.length > 0) return;
    setGeoCatalogLoading(true);
    api.ruleResources
      .getCatalog()
      .then((r) => setGeoCatalog(r.items || []))
      .catch(() => setGeoCatalog([]))
      .finally(() => setGeoCatalogLoading(false));
  }, [open, geoCatalog.length]);

  const geositeOptions = useMemo(() => geoCategoryOptions(geoCatalog, 'geosite'), [geoCatalog]);
  const geoipOptions = useMemo(() => geoCategoryOptions(geoCatalog, 'geoip'), [geoCatalog]);
  const localGeositeTags = useMemo(() => localGeoTagSet(geoLocalList, 'geosite'), [geoLocalList]);
  const localGeoipTags = useMemo(() => localGeoTagSet(geoLocalList, 'geoip'), [geoLocalList]);

  const appRules: AppRule[] = config.appRules || [];
  const customPresets: CustomAppPreset[] = config.customAppPresets || [];

  // 拉取远程全量 geo 分类清单（内置/缓存只含精选；与「资源库」对话框同源 MetaCubeX）
  const refreshGeoCatalog = async () => {
    setGeoCatalogRefreshing(true);
    try {
      const r = await api.ruleResources.refreshCatalog();
      setGeoCatalog(r.items || []);
    } catch {
      toast.error(t('rules.customApp.geoRefreshFailed', '刷新分类清单失败'));
    } finally {
      setGeoCatalogRefreshing(false);
    }
  };

  const handleAddCustomApp = async () => {
    if (!newAppName.trim() || newAppGeositeTags.length === 0) {
      toast.error(t('rules.customApp.fillNameAndGeosite'));
      return;
    }

    const newId = `custom-${Date.now()}`;
    const newPreset: CustomAppPreset = {
      id: newId,
      name: newAppName.trim(),
      emoji: newAppEmoji.trim() || '🌐',
      iconUrl: newAppIconUrl.trim() || undefined,
      geositeTags: newAppGeositeTags,
      geoipTags: newAppGeoipTags.length > 0 ? newAppGeoipTags : undefined,
    };

    try {
      await saveConfig({
        ...config,
        customAppPresets: [...customPresets, newPreset],
        // 同注入默认 appRule（代理·跟全局），使 rule-sel-app selector 随本次添加重启一并 materialize →
        // 首次切节点即热切换，与内置预设卡片一致（否则首次设策略还要再重启一次）。删除时 handleDeleteCustomApp 一并清理。
        appRules: [...appRules, { appId: newId, action: 'proxy', enabled: true }],
      });
    } catch {
      toast.error(t('common.saveFailed'));
      return;
    }

    // fail-closed 联动规则资源：所选 geo 中尚未本地（内置随包 / 已下载）的分类 → 下载进「规则资源」→ 可见可管 +
    // 路由生成复用本地副本（见 ProxyManager.localResPath）。已无远程兜底——下载失败时该分类的 geo 半暂不生效
    // （进程名仍生效），可在「规则资源」页重试后自动恢复；故失败须可感知（toast），不再静默吞掉。
    const toDownload = [
      ...newAppGeositeTags
        .filter((tg) => !localGeositeTags.has(tg))
        .map((tg) => ({ catalogId: `geosite-${tg}` })),
      ...newAppGeoipTags
        .filter((tg) => !localGeoipTags.has(tg))
        .map((tg) => ({ catalogId: `geoip-${tg}` })),
    ];
    if (toDownload.length > 0) {
      toast.info(
        t('rules.customApp.geoDownloading', '正在下载 {{n}} 个分类规则集到规则资源', {
          n: toDownload.length,
        })
      );
      void api.ruleResources
        .download(toDownload)
        .then((results) => {
          const fail = (results || []).filter((r) => !r.ok).length;
          if (fail > 0) {
            toast.warning(
              t(
                'rules.customApp.geoDownloadPartial',
                '{{n}} 个分类下载失败，可在「规则资源」页重试（缺失时该分类不生效，进程名仍生效）',
                { n: fail }
              )
            );
          }
        })
        .catch(() => {
          toast.error(
            t('rules.customApp.geoDownloadFailed', '分类规则集下载失败，可在「规则资源」页重试')
          );
        });
    }

    onOpenChange(false);
    setShowIconGallery(false);
    setNewAppName('');
    setNewAppEmoji('🌐');
    setNewAppIconUrl('');
    setNewAppGeositeTags([]);
    setNewAppGeoipTags([]);
    toast.success(t('rules.customApp.addSuccess'));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        {showIconGallery ? (
          <IconGalleryPicker
            onSelectIcon={(url, suggestedName) => {
              setNewAppIconUrl(url);
              if (!newAppName) setNewAppName(suggestedName);
              setShowIconGallery(false);
            }}
            onSelectDefault={() => {
              setNewAppIconUrl('');
              setNewAppEmoji('🌐');
              setShowIconGallery(false);
            }}
            onClose={() => setShowIconGallery(false)}
            manualUrl={newAppIconUrl}
            onManualUrlChange={setNewAppIconUrl}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('rules.customApp.addTitle')}</DialogTitle>
              <DialogDescription>{t('rules.customApp.addDesc')}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-end">{t('rules.customApp.iconLabel')}</Label>
                <div className="col-span-3">
                  <Button
                    variant="outline"
                    className="w-full flex items-center justify-between gap-3 px-4 h-12 rounded-xl group border-dashed hover:border-primary/50 hover:bg-primary/5 transition-all"
                    onClick={() => setShowIconGallery(true)}
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      <div className="h-8 w-8 flex items-center justify-center shrink-0">
                        {newAppIconUrl ? (
                          <img src={newAppIconUrl} className="h-full w-full object-contain" />
                        ) : (
                          <span className="text-xl">{newAppEmoji}</span>
                        )}
                      </div>
                      <div className="flex flex-col items-start overflow-hidden">
                        <span className="text-sm font-medium">
                          {t('rules.customApp.browseIcons')}
                        </span>
                        <span className="text-[10px] text-muted-foreground truncate">
                          {newAppIconUrl
                            ? t('rules.customApp.iconSelected', { url: newAppIconUrl })
                            : t('rules.customApp.iconChoosePrompt')}
                        </span>
                      </div>
                    </div>
                    <ImageIcon className="h-4 w-4 opacity-40 group-hover:opacity-100 group-hover:text-primary transition-all" />
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="name" className="text-end">
                  {t('rules.customApp.nameLabel')}
                </Label>
                <Input
                  id="name"
                  value={newAppName}
                  onChange={(e) => setNewAppName(e.target.value)}
                  placeholder={t('rules.customApp.namePlaceholder')}
                  className="col-span-3 h-10 rounded-lg bg-muted/20 border-none focus-visible:ring-1"
                />
              </div>
              <div className="grid grid-cols-4 items-start gap-4">
                <Label className="pt-3 text-end">Geosite</Label>
                <div className="col-span-3">
                  <GeoTagPicker
                    options={geositeOptions}
                    value={newAppGeositeTags}
                    onChange={setNewAppGeositeTags}
                    localTags={localGeositeTags}
                    loading={geoCatalogLoading}
                    refreshing={geoCatalogRefreshing}
                    onRefresh={refreshGeoCatalog}
                    placeholder={t('rules.customApp.geoSearchPlaceholder', '搜索分类，如 youtube')}
                  />
                </div>
              </div>
              <div className="grid grid-cols-4 items-start gap-4">
                <Label className="pt-3 text-end">GeoIP</Label>
                <div className="col-span-3">
                  <GeoTagPicker
                    options={geoipOptions}
                    value={newAppGeoipTags}
                    onChange={setNewAppGeoipTags}
                    localTags={localGeoipTags}
                    loading={geoCatalogLoading}
                    refreshing={geoCatalogRefreshing}
                    onRefresh={refreshGeoCatalog}
                    placeholder={t('rules.customApp.geoSearchPlaceholder', '搜索分类，如 youtube')}
                  />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleAddCustomApp}>{t('rules.customApp.save')}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
