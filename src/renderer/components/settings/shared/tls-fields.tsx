/**
 * TLS 相关字段的共享渲染组件（SNI/serverName、uTLS 指纹、TLS 引擎、TLS Spoof、allowInsecure、ALPN）——
 * Conduit `.nd-fld` / `.nd-swrow` 版。
 *
 * 各协议表单的 RHF schema / 默认值 / submit 仍各自维护，渲染统一走这里。
 * 约定字段名：tlsServerName?: string，tlsFingerprint?: string，tlsEngine?: string，
 *            tlsSpoofMethod?: string，tlsSpoofSni?: string，tlsAllowInsecure?: boolean，alpn?: string。
 */
import type { Control } from 'react-hook-form';
import { useFormContext } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormField, FormMessage } from '@/components/ui/form';
import { TLS_SPOOF_METHODS, isTlsSpoofSupportedArch } from '@shared/tls-spoof';
import { InfoTooltip } from './info-tooltip';
import { FieldGrid, FieldSpan } from './form-layout';
import { EchField } from './anti-censor-fields';

type AnyControl = Control<any>;
type TFn = (key: string, fallback?: any) => string;

/**
 * TLS serverName / SNI / Reality target —— 三种语义共用 tlsServerName 字段，标签按场景传入。
 * @param labelKey    标签 i18n key（默认 servers.tlsServerName）
 * @param placeholder 占位符（默认 example.com）
 * @param optional    true 时在标签后追加「(可选)」
 */
export function TlsServerNameField({
  control,
  t,
  labelKey = 'servers.tlsServerName',
  descKey = 'servers.tlsServerNameDesc',
  placeholder = 'example.com',
  optional = false,
}: {
  control: AnyControl;
  t: TFn;
  labelKey?: string;
  descKey?: string;
  placeholder?: string;
  optional?: boolean;
}) {
  // descKey 保留在 props 签名以兼容调用点（各表单仍显式传入语义化描述键），Conduit 密度下不再常驻渲染描述行。
  void descKey;
  return (
    <FormField
      control={control}
      name="tlsServerName"
      render={({ field }) => (
        <div className="nd-fld">
          <span className="nd-fld-lbl">
            {t(labelKey)}
            {optional && (
              <small className="font-medium text-fg-faint">
                {t('servers.optional', 'Optional')}
              </small>
            )}
          </span>
          <Input placeholder={placeholder} {...field} />
          <FormMessage className="fld-err" />
        </div>
      )}
    />
  );
}

/** uTLS 客户端指纹伪装下拉。统一含 none + 7 种指纹，i18n 标签。 */
export function FingerprintField({ control, t }: { control: AnyControl; t: TFn }) {
  return (
    <FormField
      control={control}
      name="tlsFingerprint"
      render={({ field }) => (
        <div className="nd-fld">
          <span className="nd-fld-lbl">{t('servers.fingerprint')}</span>
          <Select onValueChange={field.onChange} value={field.value}>
            <SelectTrigger>
              <SelectValue placeholder={t('servers.selectFingerprint', 'Select TLS Fingerprint')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('servers.none', 'None')}</SelectItem>
              <SelectItem value="chrome">Chrome</SelectItem>
              <SelectItem value="firefox">Firefox</SelectItem>
              <SelectItem value="safari">Safari</SelectItem>
              <SelectItem value="edge">Edge</SelectItem>
              <SelectItem value="ios">iOS</SelectItem>
              <SelectItem value="android">Android</SelectItem>
              <SelectItem value="random">{t('servers.random')}</SelectItem>
            </SelectContent>
          </Select>
          <FormMessage className="fld-err" />
        </div>
      )}
    />
  );
}

/**
 * TLS 栈引擎下拉（P3c，sing-box 1.14 tls.engine）。统一字段名 tlsEngine。
 *
 * - go：跨平台 Go TLS（默认；省略 = 等价 go）。
 * - windows(Schannel)：仅 Windows 运行时可用——非 Windows 平台启动 FATAL，故仅在 win32 暴露该选项。
 * - apple(Network.framework)：仅 Apple 运行时可用——非 Apple 平台启动 FATAL，故仅在 darwin 暴露该选项。
 */
export function TlsEngineField({ control, t }: { control: AnyControl; t: TFn }) {
  const platform = (typeof window !== 'undefined' && window.electron?.platform) || '';
  const isWin = platform === 'win32';
  const isMac = platform === 'darwin';
  return (
    <FormField
      control={control}
      name="tlsEngine"
      render={({ field }) => (
        <div className="nd-fld">
          <span className="nd-fld-lbl">{t('servers.tlsEngine', 'TLS 引擎')}</span>
          <Select onValueChange={field.onChange} value={field.value || 'go'}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="go">{t('servers.tlsEngineGo', 'Go（默认）')}</SelectItem>
              {isWin && (
                <SelectItem value="windows">
                  {t('servers.tlsEngineWindows', 'Windows (Schannel)')}
                </SelectItem>
              )}
              {isMac && (
                <SelectItem value="apple">
                  {t('servers.tlsEngineApple', 'Apple (Network.framework)')}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
          <FormMessage className="fld-err" />
        </div>
      )}
    />
  );
}

/**
 * TLS spoof 字段组（P3a 抗审查，sing-box 1.14 tls.spoof/spoof_method）。字段名 tlsSpoofMethod + tlsSpoofSni。
 *
 * 方法下拉：none（默认=不启用）+ wrong-ack / wrong-md5 / wrong-timestamp（sing-box check 实证的合法方法）。
 * 选中方法后展开「诱饵 SNI」输入。ARM64 内核不支持 → 整项置灰 + 描述说明。跨栅格占满整行。
 */
export function TlsSpoofField({ control, t }: { control: AnyControl; t: TFn }) {
  const arch = (typeof window !== 'undefined' && window.electron?.arch) || '';
  const archSupported = isTlsSpoofSupportedArch(arch);
  const { watch } = useFormContext();
  const methodSelected = archSupported && !!watch('tlsSpoofMethod');
  return (
    <div className="col-span-full flex flex-col gap-[13px]">
      <FormField
        control={control}
        name="tlsSpoofMethod"
        render={({ field }) => (
          <div className="nd-fld">
            <span className="nd-fld-lbl inline-flex items-center gap-1.5">
              {t('servers.tlsSpoof', 'TLS Spoof')}
              <InfoTooltip content={t('servers.tlsSpoofDescFull')} />
            </span>
            <Select
              onValueChange={(v) => field.onChange(v === 'none' ? undefined : v)}
              value={field.value || 'none'}
              disabled={!archSupported}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('servers.none', 'None')}</SelectItem>
                {TLS_SPOOF_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!archSupported && (
              <div className="nd-swrow-d">
                {t(
                  'servers.tlsSpoofArchUnsupported',
                  'ARM64 不支持 TLS spoof（内核仅 amd64 实现）。'
                )}
              </div>
            )}
            <FormMessage className="fld-err" />
          </div>
        )}
      />
      {methodSelected && (
        <FormField
          control={control}
          name="tlsSpoofSni"
          render={({ field }) => (
            <div className="nd-fld">
              <span className="nd-fld-lbl">{t('servers.tlsSpoofSni', 'Spoof SNI')}</span>
              <Input placeholder="www.bing.com" {...field} />
              <FormMessage className="fld-err" />
            </div>
          )}
        />
      )}
    </div>
  );
}

/** allowInsecure 开关行（`.nd-swrow` + `.swt`）—— 允许无效证书（不推荐）。 */
export function AllowInsecureField({ control, t }: { control: AnyControl; t: TFn }) {
  return (
    <FormField
      control={control}
      name="tlsAllowInsecure"
      render={({ field }) => (
        <div className="nd-swrow">
          <div className="nd-swrow-main">
            <div className="nd-swrow-t">{t('servers.allowInsecure')}</div>
            <div className="nd-swrow-d">{t('servers.allowInsecureDesc')}</div>
          </div>
          <Switch checked={field.value} onCheckedChange={field.onChange} />
        </div>
      )}
    />
  );
}

/**
 * ALPN 输入。
 * @param placeholder 占位符（如 trojan 用 http/1.1，tuic 用 h3）
 */
export function AlpnField({
  control,
  t,
  placeholder,
}: {
  control: AnyControl;
  t: TFn;
  placeholder: string;
}) {
  return (
    <FormField
      control={control}
      name="alpn"
      render={({ field }) => (
        <div className="nd-fld">
          <span className="nd-fld-lbl">{t('servers.alpn')}</span>
          <Input placeholder={placeholder} {...field} />
          <FormMessage className="fld-err" />
        </div>
      )}
    />
  );
}

/**
 * TLS 高级字段块（SNI/Fingerprint/Engine/Spoof/AllowInsecure/ECH 六字段）—— vless/vmess/trojan/anytls 四表单
 * 高级区收敛为单一组件（字段顺序/包裹与各表单原实现一致）。差异以 props 显式化：
 *   · alpn：仅 trojan 传（在 SNI 之后插入 ALPN 输入）；其余不传 → 不渲染 ALPN。
 *   · sniLabelKey/sniDescKey/sniOptional：仅 anytls 传（SNI 用「服务器名称指示(SNI)」标签 + 可选标记）。
 */
export function TlsAdvancedFields({
  control,
  t,
  alpn,
  sniLabelKey,
  sniDescKey,
  sniOptional = false,
}: {
  control: AnyControl;
  t: TFn;
  alpn?: string;
  sniLabelKey?: string;
  sniDescKey?: string;
  sniOptional?: boolean;
}) {
  return (
    <FieldGrid cols={2}>
      <TlsServerNameField
        control={control}
        t={t}
        labelKey={sniLabelKey}
        descKey={sniDescKey}
        optional={sniOptional}
      />
      {alpn !== undefined && <AlpnField control={control} t={t} placeholder={alpn} />}
      <FingerprintField control={control} t={t} />
      <TlsEngineField control={control} t={t} />
      <TlsSpoofField control={control} t={t} />
      <FieldSpan>
        <AllowInsecureField control={control} t={t} />
      </FieldSpan>
      <FieldSpan>
        <EchField control={control} t={t} />
      </FieldSpan>
    </FieldGrid>
  );
}
