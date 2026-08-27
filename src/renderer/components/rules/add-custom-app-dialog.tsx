/**
 * 新增自定义应用对话框（Conduit `.ap-dialog` / `.apd-*` / `.ms`，承载于 radix Dialog）——
 * 图标（内联 `.ico-lib` 图标库）/ 名称 / 分类归属 / Geosite / GeoIP / 进程名 表单 + geo 分类 catalog 拉取/刷新
 * + 提交（注入默认 appRule + fail-closed 下载缺失 geo）。字段级错误内联（红框+红字，不弹 toast），
 * 仅全局/系统错误（保存失败/下载失败）才 toast。radix 内置关闭钮经 `[&>button]:hidden` 隐，改用 `.apd-x`。
 */
import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ArrowRight, ListChecks, X, ChevronDown } from 'lucide-react';
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

// 字段级错误内联红框：覆盖 `.apd-input` focus 描边。
const ERR_STYLE = {
  borderColor: 'hsl(var(--err))',
  boxShadow: '0 0 0 3px hsl(var(--err) / 0.1)',
} as const;

export function AddCustomAppDialog({
  open,
  onOpenChange,
  config,
  saveConfig,
  geoLocalList,
  onGoToResources,
}: AddCustomAppDialogProps) {
  const { t } = useTranslation();

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

  // 字段级错误单一真值（纯字段值派生，不受 submitAttempted gate）：名称必填 + 至少一个 Geosite + 选「自定义分类」须填名。
  // 提交 gate 与内联展示共用此 memo（对齐 rule-dialog 的 collectRuleFormErrors 模式），消除谓词字面重复。
  const fieldErrors = useMemo(
    () => ({
      name: !newAppName.trim(),
      geosite: newAppGeositeTags.length === 0,
      category: newAppCategory === CUSTOM_CATEGORY && !customCategory.trim(),
    }),
    [newAppName, newAppGeositeTags, newAppCategory, customCategory]
  );
  // 展示层：未尝试提交前全 false（打开即报错反直觉）；submitAttempted 后随字段实时刷新 → 用户改好即消。
  const errors = submitAttempted ? fieldErrors : { name: false, geosite: false, category: false };

  // 打开时清尝试提交态（避免重开即报错）
  useEffect(() => {
    if (open) {
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

  // ProcessPickerDialog 返回包含初始值在内的完整勾选集合；按集合回写，既保留未运行的手输项，也支持取消旧选择。
  const handlePickProcesses = (names: string[]) => {
    setNewAppProcessNames(Array.from(new Set(names)).join(', '));
  };

  const handleAddCustomApp = async () => {
    // 字段级校验（内联，不 toast）：置 submitAttempted → errors 派生生效并内联展示；
    // gate 直接消费 fieldErrors（与展示同一真值，无字面重复谓词）。
    setSubmitAttempted(true);
    if (fieldErrors.name || fieldErrors.geosite || fieldErrors.category) return;

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
      <DialogContent className="[&>button]:hidden flex max-h-[84vh] w-[min(468px,94vw)] max-w-none flex-col gap-0 overflow-y-auto rounded-[14px] border-line bg-surface p-0 sm:rounded-[14px]">
        {/* a11y：radix 需 Title；视觉标题另在 `.apd-h`，此处仅供辅助技术。 */}
        <DialogTitle className="sr-only">{t('rules.customApp.addTitle')}</DialogTitle>
        <DialogDescription className="sr-only">{t('rules.customApp.addDesc')}</DialogDescription>

        <div className="apd-h">
          <span className="apd-ico">＋</span>
          <h3>{t('rules.customApp.addTitle')}</h3>
          <button
            type="button"
            className="apd-x"
            title={t('common.cancel')}
            aria-label={t('common.cancel')}
            onClick={() => onOpenChange(false)}
          >
            <X />
          </button>
        </div>

        <div className="apd-body">
          <div className="field">
            <div className="field-lbl">
              {t('rules.customApp.iconLabel')}{' '}
              <small>
                {t('rules.customApp.iconFieldHint', '远端图标 / emoji / URL，加载失败回退首字母')}
              </small>
            </div>
            <IconGalleryPicker
              emoji={newAppEmoji}
              iconUrl={newAppIconUrl}
              appName={newAppName}
              onPickRemote={(url, suggestedName) => {
                setNewAppIconUrl(url);
                if (!newAppName) setNewAppName(suggestedName);
              }}
              onPickEmoji={(e) => {
                setNewAppEmoji(e);
                setNewAppIconUrl('');
              }}
              onApplyUrl={(u) => setNewAppIconUrl(u)}
            />
          </div>

          <div className="field">
            <div className="field-lbl">
              {t('rules.customApp.nameLabel')} <small>{t('rules.customApp.nameReq', '必填')}</small>
            </div>
            <input
              className="apd-input"
              type="text"
              value={newAppName}
              onChange={(e) => setNewAppName(e.target.value)}
              placeholder={t('rules.customApp.namePlaceholder')}
              aria-invalid={errors.name}
              style={errors.name ? ERR_STYLE : undefined}
            />
            {errors.name && (
              <p className="text-xs text-err">
                {t('rules.customApp.nameRequired', '请填写应用名称')}
              </p>
            )}
          </div>

          <div className="field">
            <div className="field-lbl">
              {t('rules.customApp.categoryLabel', '分类归属')}{' '}
              <small>
                {t('rules.customApp.categoryFieldHint', '归入对应分类组，选「自定义…」新建分类组')}
              </small>
            </div>
            <div className="apd-selwrap">
              <select
                className="apd-select"
                value={newAppCategory}
                onChange={(e) => setNewAppCategory(e.target.value)}
              >
                {KNOWN_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`rules.categories.${c}` as any, c)}
                  </option>
                ))}
                <option value={CUSTOM_CATEGORY}>
                  {t('rules.customApp.categoryCustom', '自定义…')}
                </option>
              </select>
              <ChevronDown className="apd-selchev" />
            </div>
            {newAppCategory === CUSTOM_CATEGORY && (
              <>
                <input
                  className="apd-input apd-custom-cat"
                  type="text"
                  value={customCategory}
                  onChange={(e) => setCustomCategory(e.target.value)}
                  placeholder={t('rules.customApp.categoryPlaceholder', '输入新分类名，如 办公')}
                  aria-invalid={errors.category}
                  style={errors.category ? ERR_STYLE : undefined}
                />
                {errors.category && (
                  <p className="text-xs text-err">
                    {t('rules.customApp.categoryRequired', '请输入分类名')}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="field">
            <div className="field-lbl">
              Geosite <small>{t('rules.customApp.geositeFieldHint', '域名匹配 · 多选')}</small>
            </div>
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
              <p className="text-xs text-err">
                {t('rules.customApp.geositeRequired', '请至少选择一个 Geosite 分类')}
              </p>
            )}
          </div>

          <div className="field">
            <div className="field-lbl">
              GeoIP <small>{t('rules.customApp.geoipFieldHint', 'IP 段匹配 · 多选')}</small>
            </div>
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

          <a
            className="apd-link"
            role="button"
            tabIndex={0}
            onClick={() => {
              onOpenChange(false);
              onGoToResources();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpenChange(false);
                onGoToResources();
              }
            }}
          >
            {t('rules.customApp.goToResources', '规则集没有？前往「规则资源」下载更多')}
            <ArrowRight />
          </a>

          <div className="field">
            <div className="field-lbl">
              {t('rules.customApp.processLabel', '进程名')}{' '}
              <small>{t('rules.customApp.processFieldHint', '可选 · 逗号分隔')}</small>
            </div>
            <div className="flex gap-2">
              <input
                className="apd-input"
                type="text"
                value={newAppProcessNames}
                onChange={(e) => setNewAppProcessNames(e.target.value)}
                placeholder={t('rules.customApp.processPlaceholder', 'App.exe, appname')}
              />
              <button
                type="button"
                className="btn ghost sm"
                style={{ flex: 'none' }}
                onClick={() => setProcessPickerOpen(true)}
              >
                <ListChecks className="h-4 w-4" />
                {t('rules.pickProcess', '从进程选择')}
              </button>
            </div>
            <p className="text-[10.5px] leading-relaxed text-fg-faint">
              {t(
                'rules.customApp.processHint',
                '可选 · 逗号分隔，比 geo 域名匹配更精准。区分大小写，建议用「从进程选择」获取准确名称。'
              )}
            </p>
          </div>

          <div className="apd-note">
            {t(
              'rules.customApp.geoAutoDownloadNote',
              '选中的 geosite / geoip 规则集若本地缺失，添加时将自动下载（fail-closed：下载完成前该应用的 geo 匹配不生效，进程名匹配不受影响）。'
            )}
          </div>
        </div>

        <div className="apd-foot">
          <button type="button" className="btn ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn flow" onClick={handleAddCustomApp}>
            {t('rules.customApp.save')}
          </button>
        </div>

        <ProcessPickerDialog
          open={processPickerOpen}
          onOpenChange={setProcessPickerOpen}
          mode="name"
          initialSelected={newAppProcessNames
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean)}
          onAdd={handlePickProcesses}
        />
      </DialogContent>
    </Dialog>
  );
}
