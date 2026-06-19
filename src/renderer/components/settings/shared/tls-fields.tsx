/**
 * TLS 相关字段的共享渲染组件（SNI/serverName、uTLS 指纹、allowInsecure、ALPN）。
 *
 * 各协议表单的 RHF schema / 默认值 / submit 仍各自维护，渲染统一走这里。
 * 约定字段名：tlsServerName?: string，tlsFingerprint?: string，
 *            tlsAllowInsecure?: boolean，alpn?: string。
 */
import type { Control } from 'react-hook-form';
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
