/**
 * TLS 相关字段的共享渲染组件（SNI/serverName、uTLS 指纹、allowInsecure、ALPN）。
 *
 * 各协议表单的 RHF schema / 默认值 / submit 仍各自维护，渲染统一走这里。
 * 约定字段名：tlsServerName?: string，tlsFingerprint?: string，
 *            tlsAllowInsecure?: boolean，alpn?: string。
 */
import type { Control } from 'react-hook-form';
import { useFormContext } from 'react-hook-form';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { TLS_SPOOF_METHODS, isTlsSpoofSupportedArch } from '@shared/tls-spoof';
import { InfoTooltip } from './info-tooltip';
import { FieldGrid, FieldSpan } from './form-layout';
import { EchField } from './anti-censor-fields';

type AnyControl = Control<any>;
type TFn = (key: string, fallback?: any) => string;

/**
 * TLS serverName / SNI / Reality target —— 三种语义共用 tlsServerName 字段，标签按场景传入。
 * @param labelKey    标签 i18n key（默认 servers.tlsServerName）
 * @param descKey     描述 i18n key（默认 servers.tlsServerNameDesc）
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
  return (
    <FormField
      control={control}
      name="tlsServerName"
      render={({ field }) => (
        <FormItem>
          <FormLabel>
            {t(labelKey)}
            {optional ? ` (${t('servers.optional', 'Optional')})` : ''}
          </FormLabel>
          <FormControl>
            <Input placeholder={placeholder} {...field} />
          </FormControl>
          <FormDescription>{t(descKey)}</FormDescription>
          <FormMessage />
        </FormItem>
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
        <FormItem>
          <FormLabel>{t('servers.fingerprint')}</FormLabel>
          <Select onValueChange={field.onChange} value={field.value}>
            <FormControl>
              <SelectTrigger>
                <SelectValue
                  placeholder={t('servers.selectFingerprint', 'Select TLS Fingerprint')}
                />
              </SelectTrigger>
            </FormControl>
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
          <FormDescription>{t('servers.fingerprintDesc')}</FormDescription>
          <FormMessage />
        </FormItem>
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
 *
 * 系统原生栈让 ClientHello/握手指纹更贴近系统浏览器，抗指纹识别更真。仅对 TCP-TLS 协议有意义
 * （Hy2/TUIC 走 QUIC 自带 TLS1.3，不挂此选项）。
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
        <FormItem>
          <FormLabel>{t('servers.tlsEngine', 'TLS 引擎')}</FormLabel>
          <Select onValueChange={field.onChange} value={field.value || 'go'}>
            <FormControl>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
            </FormControl>
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
          <FormDescription>{t('servers.tlsEngineDesc')}</FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/**
 * TLS spoof 字段组（P3a 抗审查，sing-box 1.14 tls.spoof/spoof_method）。字段名 tlsSpoofMethod + tlsSpoofSni。
 *
 * 方法下拉：none（默认=不启用）+ wrong-ack / wrong-md5 / wrong-timestamp（sing-box check 实证的合法方法）。
 * 选中方法后展开「诱饵 SNI」输入：下发时 tls.spoof=诱饵 SNI（伪造 ClientHello 里的白名单域名）+ tls.spoof_method。
 *
 * **硬限界门控（已 sing-box 真核 check 实证，见 @shared/tls-spoof）**：
 *   · ARM64：内核仅 amd64 实现 → 整项置灰 + tooltip 说明「ARM64 不支持」（不下发）。
 *   · 需提权（Linux CAP_NET_RAW+NET_ADMIN / mac root / Win 管理员）：运行期生效条件，描述里提示用户。
 *   · 诱饵 SNI 须为域名（拒 IP 字面量）、且**必须不同于真 server_name**（内核 FATAL `spoof must differ from server_name`）；
 *     构建期再门控（applyAntiCensorshipOptions），此处仅录入。
 * 仅对标准 TCP-TLS 协议暴露（Hy2/TUIC 走 QUIC 无 TCP ClientHello、naive 由 Cronet 自管 → 不渲染本组件）。
 *
 * 跨 cols={2} 栅格占满整行（方法 + SNI 两输入并排），故外层包 FieldSpan-like 的 col-span-2。
 */
export function TlsSpoofField({ control, t }: { control: AnyControl; t: TFn }) {
  const arch = (typeof window !== 'undefined' && window.electron?.arch) || '';
  const archSupported = isTlsSpoofSupportedArch(arch);
  const { watch } = useFormContext();
  const methodSelected = archSupported && !!watch('tlsSpoofMethod');
  return (
    <div className="space-y-3 sm:col-span-2">
      <FormField
        control={control}
        name="tlsSpoofMethod"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="flex items-center gap-1.5">
              {t('servers.tlsSpoof', 'TLS Spoof')}
              <InfoTooltip content={t('servers.tlsSpoofDescFull')} />
            </FormLabel>
            <Select
              onValueChange={(v) => field.onChange(v === 'none' ? undefined : v)}
              value={field.value || 'none'}
              disabled={!archSupported}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="none">{t('servers.none', 'None')}</SelectItem>
                {TLS_SPOOF_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormDescription>
              {archSupported
                ? t('servers.tlsSpoofDesc')
                : t(
                    'servers.tlsSpoofArchUnsupported',
                    'ARM64 不支持 TLS spoof（内核仅 amd64 实现）。'
                  )}
            </FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      {methodSelected && (
        <FormField
          control={control}
          name="tlsSpoofSni"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('servers.tlsSpoofSni', 'Spoof SNI')}</FormLabel>
              <FormControl>
                <Input placeholder="www.bing.com" {...field} />
              </FormControl>
              <FormDescription>{t('servers.tlsSpoofSniDesc')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      )}
    </div>
  );
}

/** allowInsecure 复选框 —— 允许无效证书（不推荐）。 */
export function AllowInsecureField({ control, t }: { control: AnyControl; t: TFn }) {
  return (
    <FormField
      control={control}
      name="tlsAllowInsecure"
      render={({ field }) => (
        <FormItem className="flex flex-row items-start space-x-3 rtl:space-x-reverse space-y-0">
          <FormControl>
            <Checkbox checked={field.value} onCheckedChange={field.onChange} />
          </FormControl>
          <div className="space-y-1 leading-none">
            <FormLabel>{t('servers.allowInsecure')}</FormLabel>
            <FormDescription>{t('servers.allowInsecureDesc')}</FormDescription>
          </div>
        </FormItem>
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
        <FormItem>
          <FormLabel>{t('servers.alpn')}</FormLabel>
          <FormControl>
            <Input placeholder={placeholder} {...field} />
          </FormControl>
          <FormDescription>{t('servers.alpnDesc')}</FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/**
 * TLS 高级字段块（SNI/Fingerprint/Engine/Spoof/AllowInsecure/ECH 六字段）—— vless/vmess/trojan/anytls 四表单
 * 高级区此前各自重复同一组渲染，此处收敛为单一组件（字段顺序/包裹与各表单原实现逐字节一致）。差异以 props 显式化：
 *   · alpn：仅 trojan 传（在 SNI 之后插入 ALPN 输入，placeholder 如 "http/1.1"）；其余不传 → 不渲染 ALPN。
 *   · sniLabelKey/sniDescKey/sniOptional：仅 anytls 传（SNI 用「服务器名称指示(SNI)」标签 + 可选标记）；
 *     其余不传 → TlsServerNameField 用默认 labelKey/descKey（tlsServerName）、非可选。
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
