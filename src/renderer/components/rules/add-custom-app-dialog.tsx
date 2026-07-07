/**
 * 新增自定义应用对话框 —— 从 app-rules-card 抽出（审计 §6 Tier-2 #4：拆 AddCustomAppDialog）。
 * 自含：名称/图标/分类归属/Geosite/GeoIP/进程名 表单 + geo 分类 catalog 拉取/刷新 + 提交（注入默认 appRule
 * + fail-closed 下载 geo）。图标库视图委托 IconGalleryPicker。字段级错误内联（红框+红字，不弹 toast），
 * 仅全局/系统错误（保存失败/下载失败）才 toast。
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { Image as ImageIcon, ArrowRight, ListChecks } from 'lucide-react';
import { iconProxySrc } from '../../../shared/icon-proxy';
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
import { ProcessPickerDialog } from './process-picker-dialog';
import { KNOWN_CATEGORIES } from './app-rules-logic';
import { toast } from 'sonner';

interface AddCustomAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: UserConfig;
  saveConfig: (config: UserConfig) => Promise<void>;
  geoLocalList: RuleResourceListItem[];
  /** 「前往规则资源」下载更多规则集：关对话框 + 切页。 */
  onGoToResources: () => void;
}

const CUSTOM_CATEGORY = '__custom__';

export function AddCustomAppDialog({
  open,
  onOpenChange,
  config,
  saveConfig,
  geoLocalList,
  onGoToResources,
}: AddCustomAppDialogProps) {
  const { t } = useTranslation();

  const [showIconGallery, setShowIconGallery] = useState(false);
  const [newAppName, setNewAppName] = useState('');
  const [newAppEmoji, setNewAppEmoji] = useState('🌐');
  const [newAppIconUrl, setNewAppIconUrl] = useState('');
  const [newAppCategory, setNewAppCategory] = useState<string>('tools');
  const [customCategory, setCustomCategory] = useState('');
  const [newAppGeositeTags, setNewAppGeositeTags] = useState<string[]>([]);
  const [newAppGeoipTags, setNewAppGeoipTags] = useState<string[]>([]);
  const [newAppProcessNames, setNewAppProcessNames] = useState('');
  const [processPickerOpen, setProcessPickerOpen] = useState(false);
  // 字段级错误（内联，不 toast）：仅在尝试提交后派生（改字段即时消错），对齐 rule-dialog 的 submitAttempted + 派生 errors 模式。
  const [submitAttempted, setSubmitAttempted] = useState(false);

  // geo 分类 catalog（geosite/geoip 多选数据源）：内置/缓存即时，全量需刷新
  const [geoCatalog, setGeoCatalog] = useState<RuleResourceCatalogItem[]>([]);
  const [geoCatalogLoading, setGeoCatalogLoading] = useState(false);
  const [geoCatalogRefreshing, setGeoCatalogRefreshing] = useState(false);

  // 字段级错误派生（提交 gate 与内联展示共用单一真值）：名称必填 + 至少一个 Geosite + 选「自定义分类」须填名。
  // 未尝试提交前全 false（打开即报错反直觉）；submitAttempted 后随字段实时刷新 → 用户改好即消。
  const errors = useMemo(() => {
    if (!submitAttempted) return { name: false, geosite: false, category: false };
    return {
      name: !newAppName.trim(),
      geosite: newAppGeositeTags.length === 0,
      category: newAppCategory === CUSTOM_CATEGORY && !customCategory.trim(),
    };
  }, [submitAttempted, newAppName, newAppGeositeTags, newAppCategory, customCategory]);

  // 打开时重置为表单视图（取代原 +按钮的 setShowIconGallery(false)）+ 清尝试提交态（避免重开即报错）
  useEffect(() => {
    if (open) {
      setShowIconGallery(false);
      setSubmitAttempted(false);
    }
  }, [open]);

  // 打开时拉 geo 分类 catalog（走内置/磁盘缓存，无网络）；只拉一次，全量由刷新按钮拉
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

  const resetForm = () => {
    setShowIconGallery(false);
    setNewAppName('');
    setNewAppEmoji('🌐');
    setNewAppIconUrl('');
    setNewAppCategory('tools');
    setCustomCategory('');
    setNewAppGeositeTags([]);
    setNewAppGeoipTags([]);
    setNewAppProcessNames('');
    setSubmitAttempted(false);
  };

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

  // 「选择进程」复用规则页 ProcessPickerDialog（一键拉运行进程 + 搜索 + 多选 + 系统进程过滤），勾选回填。
  // 合并进现有逗号串（去重、去空），保留手输作兜底（进程未运行时仍可手加）。
  const handlePickProcesses = (names: string[]) => {
    const existing = newAppProcessNames
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const merged = Array.from(new Set([...existing, ...names]));
    setNewAppProcessNames(merged.join(', '));
  };

  const handleAddCustomApp = async () => {
    // 字段级校验（内联，不 toast）：名称必填 + 至少一个 Geosite + 选「自定义分类」时须填名。
    // 置 submitAttempted → errors 派生生效并内联展示；gate 用同一判据。
    setSubmitAttempted(true);
    const nameBad = !newAppName.trim();
    const geositeBad = newAppGeositeTags.length === 0;
    const categoryBad = newAppCategory === CUSTOM_CATEGORY && !customCategory.trim();
    if (nameBad || geositeBad || categoryBad) return;

    const category = newAppCategory === CUSTOM_CATEGORY ? customCategory.trim() : newAppCategory;
    const processNames = newAppProcessNames
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const newId = `custom-${Date.now()}`;
    const newPreset: CustomAppPreset = {
      id: newId,
      name: newAppName.trim(),
      emoji: newAppEmoji.trim() || '🌐',
      iconUrl: newAppIconUrl.trim() || undefined,
      geositeTags: newAppGeositeTags,
      geoipTags: newAppGeoipTags.length > 0 ? newAppGeoipTags : undefined,
      processNames: processNames.length > 0 ? processNames : undefined,
      category,
    };

    try {
      await saveConfig({
        ...config,
        customAppPresets: [...customPresets, newPreset],
        // 同注入默认 appRule（代理·跟全局），使 rule-sel-app selector 随本次添加重启一并 materialize。
        appRules: [...appRules, { appId: newId, action: 'proxy', enabled: true }],
      });
    } catch {
      toast.error(t('common.saveFailed'));
      return;
    }

    // fail-closed 联动规则资源：所选 geo 中尚未本地的分类 → 下载进「规则资源」。失败可感知（toast），
    // 缺失时该分类 geo 半暂不生效（进程名仍生效），可在「规则资源」页重试后自动恢复。
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
    resetForm();
    toast.success(t('rules.customApp.addSuccess'));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[460px]">
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
              {/* 图标 */}
              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-end">{t('rules.customApp.iconLabel')}</Label>
                <div className="col-span-3">
                  <Button
                    variant="outline"
                    className="group flex h-12 w-full items-center justify-between gap-3 rounded-xl border-dashed px-4 transition-all hover:border-primary/50 hover:bg-primary/5"
                    onClick={() => setShowIconGallery(true)}
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center">
                        {newAppIconUrl ? (
                          <img
                            src={iconProxySrc(newAppIconUrl)}
                            className="h-full w-full object-contain"
                            onError={(e) => {
                              e.currentTarget.style.visibility = 'hidden';
                            }}
                          />
                        ) : (
                          <span className="text-xl">{newAppEmoji}</span>
                        )}
                      </div>
                      <div className="flex flex-col items-start overflow-hidden">
                        <span className="text-sm font-medium">
                          {t('rules.customApp.browseIcons')}
                        </span>
                        <span className="truncate text-[10px] text-muted-foreground">
                          {newAppIconUrl
                            ? t('rules.customApp.iconSelected', { url: newAppIconUrl })
                            : t('rules.customApp.iconChoosePrompt')}
                        </span>
                      </div>
                    </div>
                    <ImageIcon className="h-4 w-4 opacity-40 transition-all group-hover:text-primary group-hover:opacity-100" />
                  </Button>
                </div>
              </div>

              {/* 名称（必填，内联校验） */}
              <div className="grid grid-cols-4 items-start gap-4">
                <Label htmlFor="name" className="pt-2.5 text-end">
                  {t('rules.customApp.nameLabel')}
                </Label>
                <div className="col-span-3 space-y-1">
                  <Input
                    id="name"
                    value={newAppName}
                    onChange={(e) => setNewAppName(e.target.value)}
                    placeholder={t('rules.customApp.namePlaceholder')}
                    aria-invalid={errors.name}
                    className={cn(
                      'h-10 rounded-lg border-none bg-muted/20 focus-visible:ring-1',
                      errors.name && 'ring-1 ring-destructive'
                    )}
                  />
                  {errors.name && (
                    <p className="text-xs text-destructive">
                      {t('rules.customApp.nameRequired', '请填写应用名称')}
                    </p>
                  )}
                </div>
              </div>

              {/* 分类归属（含自定义） */}
              <div className="grid grid-cols-4 items-start gap-4">
                <Label className="pt-2.5 text-end">
                  {t('rules.customApp.categoryLabel', '分类归属')}
                </Label>
                <div className="col-span-3 space-y-1.5">
                  <Select value={newAppCategory} onValueChange={setNewAppCategory}>
                    <SelectTrigger className="h-10 rounded-lg border-none bg-muted/20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {KNOWN_CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {t(`rules.categories.${c}` as any, c)}
                        </SelectItem>
                      ))}
                      <SelectItem value={CUSTOM_CATEGORY}>
                        {t('rules.customApp.categoryCustom', '自定义…')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {newAppCategory === CUSTOM_CATEGORY && (
                    <>
                      <Input
                        value={customCategory}
                        onChange={(e) => setCustomCategory(e.target.value)}
                        placeholder={t(
                          'rules.customApp.categoryPlaceholder',
                          '输入新分类名，如 办公'
                        )}
                        aria-invalid={errors.category}
                        className={cn(
                          'h-9 rounded-lg border-none bg-muted/20 text-sm focus-visible:ring-1',
                          errors.category && 'ring-1 ring-destructive'
                        )}
                      />
                      {errors.category && (
                        <p className="text-xs text-destructive">
                          {t('rules.customApp.categoryRequired', '请输入分类名')}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Geosite（必填至少一个，内联校验） */}
              <div className="grid grid-cols-4 items-start gap-4">
                <Label className="pt-3 text-end">Geosite</Label>
                <div className="col-span-3 space-y-1">
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
                  {errors.geosite && (
                    <p className="text-xs text-destructive">
                      {t('rules.customApp.geositeRequired', '请至少选择一个 Geosite 分类')}
                    </p>
                  )}
                </div>
              </div>

              {/* GeoIP */}
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

              {/* 前往规则资源下载 */}
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  onGoToResources();
                }}
                className="col-span-4 flex items-center justify-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
              >
                {t('rules.customApp.goToResources', '规则集没有？前往「规则资源」下载更多')}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>

              {/* 进程名（可选，逗号分隔） */}
              <div className="grid grid-cols-4 items-start gap-4">
                <Label htmlFor="procnames" className="pt-2.5 text-end">
                  {t('rules.customApp.processLabel', '进程名')}
                </Label>
                <div className="col-span-3 space-y-1">
                  <div className="flex gap-2">
                    <Input
                      id="procnames"
                      value={newAppProcessNames}
                      onChange={(e) => setNewAppProcessNames(e.target.value)}
                      placeholder={t('rules.customApp.processPlaceholder', 'App.exe, appname')}
                      className="h-10 flex-1 rounded-lg border-none bg-muted/20 text-sm focus-visible:ring-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setProcessPickerOpen(true)}
                      className="h-10 shrink-0"
                    >
                      <ListChecks className="me-1.5 h-4 w-4" />
                      {t('rules.pickProcess', '从进程选择')}
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {t('rules.customApp.processHint', '可选 · 逗号分隔，比 geo 域名匹配更精准')}
                  </p>
                </div>
              </div>

              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t(
                  'rules.customApp.geoAutoDownloadNote',
                  '选中的 geosite / geoip 规则集若本地缺失，添加时将自动下载（fail-closed：下载完成前该应用的 geo 匹配不生效，进程名匹配不受影响）。'
                )}
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleAddCustomApp}>{t('rules.customApp.save')}</Button>
            </DialogFooter>
          </>
        )}
        <ProcessPickerDialog
          open={processPickerOpen}
          onOpenChange={setProcessPickerOpen}
          mode="name"
          onAdd={handlePickProcesses}
        />
      </DialogContent>
    </Dialog>
  );
}
