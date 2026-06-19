import { useState, useEffect } from 'react';
import { EyeOff, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAppStore } from '@/store/app-store';
import { api } from '@/ipc';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

export function PrivacyOverlay() {
  const { t } = useTranslation();
  const isPrivacyMode = useAppStore((state) => state.isPrivacyMode);
  const setPrivacyMode = useAppStore((state) => state.setPrivacyMode);
  const [passwordInput, setPasswordInput] = useState('');
  const [errorShake, setErrorShake] = useState(false);
  // F29：密码哈希在 main，渲染端不再读 config 明文——是否设密码经 IPC 查询，解锁经 IPC 校验。
  const [hasPassword, setHasPassword] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (isPrivacyMode) {
      setPasswordInput('');
      setErrorShake(false);
      api.privacy
        .hasPassword()
        .then(setHasPassword)
        .catch(() => setHasPassword(false));
    }
  }, [isPrivacyMode]);

  if (!isPrivacyMode) {
    return null;
  }

  const handleUnlock = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (verifying) return;
    setVerifying(true);
    try {
      // 在 main 校验（无密码则 main 直接放行）；ok 时 main 已退出隐私模式，这里同步 store 即时收起遮罩
      const { ok } = await api.privacy.unlock(passwordInput);
      if (ok) {
        setPrivacyMode(false);
        toast.success(t('privacy.unlocked'));
      } else {
        setErrorShake(true);
        toast.error(t('privacy.wrongPassword'));
        setTimeout(() => setErrorShake(false), 500);
      }
    } catch {
      // IPC 异常按解锁失败处理，避免静默卡在遮罩上
      setErrorShake(true);
      toast.error(t('privacy.wrongPassword'));
      setTimeout(() => setErrorShake(false), 500);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col justify-center items-center backdrop-blur-[100px] bg-background/95 transition-all duration-500">
      <EyeOff className="w-24 h-24 text-muted-foreground mb-6 animate-pulse" />
      <h2 className="text-3xl font-bold mb-3 tracking-tight">{t('privacy.title')}</h2>
      <p className="text-muted-foreground mb-8">{t('privacy.subtitle')}</p>

      <form onSubmit={handleUnlock} className="flex flex-col gap-3 items-center w-full max-w-sm">
        {hasPassword ? (
          <div
            className={`flex w-full space-x-2 rtl:space-x-reverse ${errorShake ? 'animate-shake' : ''}`}
          >
            <div className="relative flex-1">
              <Lock className="absolute start-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                type="password"
                placeholder={t('privacy.passwordPlaceholder')}
                className="ps-9 w-full"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                autoFocus
              />
            </div>
            <Button type="submit" variant="default" disabled={verifying}>
              {t('privacy.exit')}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            onClick={() => handleUnlock()}
            variant="default"
            size="lg"
            className="w-full"
          >
            {t('privacy.exit')}
          </Button>
        )}
      </form>
    </div>
  );
}
