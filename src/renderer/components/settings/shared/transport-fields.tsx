/**
 * WebSocket / HTTPUpgrade 传输字段的共享渲染组件（path / Host）。
 *
 * network 下拉本身因各协议 enum 大小写不同（vless/vmess 首字母大写、trojan 小写）
 * 仍留在各表单内联；此处只抽 path / Host 两个完全一致的字段。
 * 约定字段名：wsPath?: string，wsHost?: string。
 */
import type { Control } from 'react-hook-form';
import { Input } from '@/components/ui/input';
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

/** WebSocket / HTTPUpgrade path。 */
export function WsPathField({ control, t }: { control: AnyControl; t: TFn }) {
  return (
    <FormField
      control={control}
      name="wsPath"
      render={({ field }) => (
        <FormItem>
          <FormLabel>{t('servers.wsPath')}</FormLabel>
          <FormControl>
            <Input placeholder="" {...field} />
          </FormControl>
          <FormDescription>{t('servers.wsPathDesc')}</FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** WebSocket / HTTPUpgrade Host header。 */
export function WsHostField({ control, t }: { control: AnyControl; t: TFn }) {
  return (
    <FormField
      control={control}
      name="wsHost"
      render={({ field }) => (
        <FormItem>
          <FormLabel>{t('servers.wsHost')}</FormLabel>
          <FormControl>
            <Input placeholder="example.com" {...field} />
          </FormControl>
          <FormDescription>{t('servers.wsHostDesc')}</FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** gRPC service name。约定字段名：grpcServiceName?: string。 */
export function GrpcServiceNameField({ control, t }: { control: AnyControl; t: TFn }) {
  return (
    <FormField
      control={control}
      name="grpcServiceName"
      render={({ field }) => (
        <FormItem>
          <FormLabel>{t('servers.grpcServiceName')}</FormLabel>
          <FormControl>
            <Input placeholder="GunService" {...field} />
          </FormControl>
          <FormDescription>{t('servers.grpcServiceNameDesc')}</FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
