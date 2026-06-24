import { useTheme } from '@/components/theme-provider';
import { Toaster as Sonner } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

// 集成标题栏适配：Windows titleBarOverlay 的最小/最大/关闭按钮在右上 32px 区，top-right toast 用 sonner 默认
// offset(~24px) 会插进/紧贴关闭按钮 → 下移到 36px（避开 32px 区 + 4px 间隙，紧贴标题栏下方）。
// 取 36 而非 48：48px 间隔过大、toast 飘在标题栏与页面右上操作按钮之间，半遮按钮显乱（真机反馈）。
// Linux 原生框保险同处理；Mac 红绿灯在左上、top-right 不接缝 → 保持默认 offset。其余边（right）沿用 sonner 默认。
const notMacPlatform = window.electron?.platform !== 'darwin';

const Toaster = ({ richColors, ...props }: ToasterProps) => {
  const { theme } = useTheme();

  // 获取实际主题（处理 system 情况）
  const resolvedTheme =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;

  return (
    <Sonner
      theme={resolvedTheme as 'light' | 'dark'}
      className="toaster group"
      richColors={richColors}
      offset={notMacPlatform ? { top: '36px' } : undefined}
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
          success:
            'group-[.toaster]:!bg-background group-[.toaster]:!text-foreground group-[.toaster]:!border-border',
          error:
            'group-[.toaster]:!bg-background group-[.toaster]:!text-foreground group-[.toaster]:!border-border',
          warning:
            'group-[.toaster]:!bg-background group-[.toaster]:!text-foreground group-[.toaster]:!border-border',
          info: 'group-[.toaster]:!bg-background group-[.toaster]:!text-foreground group-[.toaster]:!border-border',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
