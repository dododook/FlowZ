import { useState, useEffect, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { ExternalLink, Loader2, Download, Bug } from 'lucide-react';
import {
  getVersionInfo,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  openExternal,
} from '@/bridge/api-wrapper';
import { api } from '@/ipc/api-client';
import type { UpdateProgress } from '@/ipc/api-client';
import { useTranslation } from 'react-i18next';
import { AppUpdateBanner } from './app-update-banner';
import { useAppStore } from '@/store/app-store';
import { buildBugReportUrl } from '@/lib/issue-report';

interface VersionInfo {
  appVersion: string;
  appName: string;
  buildDate: string;
  singBoxVersion: string;
  copyright: string;
  repositoryUrl: string;
  platform: string;
  arch: string;
  osVersion: string;
}

export function AboutSettings() {
  // F28：App 更新可用信息放 store（本组件随设置子节切换会卸载，本地 state 无法持久承载入口）
  const availableAppUpdate = useAppStore((s) => s.availableAppUpdate);
  const setAvailableAppUpdate = useAppStore((s) => s.setAvailableAppUpdate);
  // 「报告问题」按钮自动带上当前代理模式（系统代理/TUN），是 #57 类问题的关键定位信息
  const proxyModeType = useAppStore((s) => s.config?.proxyModeType);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const progressUnsubscribeRef = useRef<(() => void) | null>(null);
  const { t } = useTranslation();

  useEffect(() => {
    loadVersionInfo();
    // 清理进度监听器
    return () => {
      if (progressUnsubscribeRef.current) {
        progressUnsubscribeRef.current();
      }
    };
  }, []);

  const loadVersionInfo = async () => {
    try {
      setLoading(true);
      const response = await getVersionInfo();
      if (response && response.success && response.data) {
        setVersionInfo(response.data);
      }
    } catch (error) {
      console.error('Failed to load version info:', error);
      toast.error(t('settings.about.loadVersionFail'));
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadAndInstall = async (updateInfo: any) => {
    // 开始监听下载进度
    setDownloading(true);
    setDownloadProgress(0);

    // 订阅进度更新
    progressUnsubscribeRef.current = api.update.onProgress((progress: UpdateProgress) => {
      if (progress.status === 'downloading') {
        setDownloadProgress(progress.percentage);
      } else if (progress.status === 'downloaded') {
        setDownloadProgress(100);
      } else if (progress.status === 'error') {
        setDownloading(false);
        toast.error(t('settings.about.downloadFail'), {
          description: progress.error || progress.message,
          action: {
            label: t('settings.about.manualDownload'),
            onClick: () => openExternal(updateInfo.downloadUrl),
          },
        });
      }
    });

    try {
      const downloadResult = await downloadUpdate(updateInfo);

      // 取消订阅
      if (progressUnsubscribeRef.current) {
        progressUnsubscribeRef.current();
        progressUnsubscribeRef.current = null;
      }

      if (downloadResult.success && downloadResult.data) {
        toast.info(t('settings.about.downloadComplete'));
        setDownloading(false);
        await installUpdate(downloadResult.data);
      } else {
        setDownloading(false);
        toast.error(t('settings.about.downloadFail'), {
          description: downloadResult.error,
          action: {
            label: t('settings.about.manualDownload'),
            onClick: () => openExternal(updateInfo.downloadUrl),
          },
        });
      }
    } catch (error) {
      // 取消订阅
      if (progressUnsubscribeRef.current) {
        progressUnsubscribeRef.current();
        progressUnsubscribeRef.current = null;
      }
      setDownloading(false);
      toast.error(t('settings.about.downloadFail'), {
        description: error instanceof Error ? error.message : t('settings.about.unknownError'),
      });
    }
  };

  const handleCheckUpdate = async () => {
    try {
      setCheckingUpdate(true);
      toast.info(t('settings.about.checkingUpdate'));

      const response = await checkForUpdates();

      if (!response || !response.success) {
        toast.error(t('settings.about.checkUpdateFail'), {
          description: response?.error || t('settings.about.cannotConnectServer'),
        });
        return;
      }

      const data = response.data;
      if (!data) {
        toast.error(t('settings.about.checkUpdateFail'), {
          description: t('settings.about.invalidData'),
        });
        return;
      }

      if (data.hasUpdate && data.updateInfo) {
        const updateInfo = data.updateInfo;
        setAvailableAppUpdate(updateInfo); // 常驻入口（toast 8s 后消失，卡片持久）
        toast.success(t('settings.about.foundUpdate', { version: updateInfo.version }), {
          description: t('settings.about.clickToInstall'),
          action: {
            label: t('settings.about.updateNow'),
            onClick: () => handleDownloadAndInstall(updateInfo),
          },
          duration: 8000,
        });
      } else {
        setAvailableAppUpdate(null); // 已是最新：清除可能残留的旧 banner
        toast.success(t('settings.about.alreadyLatest'));
      }
    } catch (error) {
      console.error('Failed to check for updates:', error);
      toast.error(t('settings.about.checkUpdateFail'), {
        description: error instanceof Error ? error.message : t('settings.about.networkError'),
      });
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleOpenGitHub = async () => {
    const url = versionInfo?.repositoryUrl || 'https://github.com/dododook/FlowZ';
    await openExternal(url);
  };

  // 打开 GitHub 新建 issue 页，正文已自动带上版本/系统/架构/内核/代理模式，报告者只需补问题描述与日志。
  const handleReportIssue = async () => {
    const url = buildBugReportUrl(
      versionInfo?.repositoryUrl || 'https://github.com/dododook/FlowZ',
      {
        appVersion: versionInfo?.appVersion,
        platform: versionInfo?.platform,
        arch: versionInfo?.arch,
        osVersion: versionInfo?.osVersion,
        singBoxVersion: versionInfo?.singBoxVersion,
        proxyModeType,
      }
    );
    await openExternal(url);
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {availableAppUpdate && (
        <AppUpdateBanner
          updateInfo={availableAppUpdate}
          downloading={downloading}
          onUpdate={() => handleDownloadAndInstall(availableAppUpdate)}
          onDismiss={() => setAvailableAppUpdate(null)}
        />
      )}
      <Card>
        <CardContent className="space-y-6 pt-6">
          <div className="space-y-4">
            <div>
              <h4 className="text-sm font-medium text-muted-foreground">
                {t('settings.about.appVersion')}
              </h4>
              <p className="text-lg font-semibold">
                {versionInfo?.appName || 'FlowZ'} v{versionInfo?.appVersion || '—'}
              </p>
            </div>

            <Separator />

            <div className="space-y-2">
              {downloading ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Download className="h-4 w-4 animate-bounce text-primary" />
                    <span className="text-sm font-medium">
                      {t('settings.about.downloading')} {downloadProgress}%
                    </span>
                  </div>
                  <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-300 ease-out"
                      style={{ width: `${downloadProgress}%` }}
                    />
                  </div>
                </div>
              ) : (
                <Button
                  onClick={handleCheckUpdate}
                  disabled={checkingUpdate}
                  className="w-full sm:w-auto"
                >
                  {checkingUpdate && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {checkingUpdate ? t('settings.about.checking') : t('settings.about.checkUpdate')}
                </Button>
              )}
            </div>

            <Separator />

            <div className="space-y-4">
              <h4 className="text-sm font-medium text-muted-foreground">
                {t('settings.about.openSource')} & {t('settings.about.community', '社区')}
              </h4>
              <div className="flex flex-col sm:flex-row gap-3">
                <Button variant="outline" onClick={handleReportIssue} className="w-full sm:w-auto">
                  <Bug className="mr-2 h-4 w-4 shrink-0" />
                  <span className="flex-1 text-left">
                    {t('settings.about.reportIssue', '报告问题')}
                  </span>
                  <ExternalLink className="ml-2 h-3.5 w-3.5 opacity-50 shrink-0" />
                </Button>
                <Button variant="outline" onClick={handleOpenGitHub} className="w-full sm:w-auto">
                  <svg
                    className="mr-2 h-4 w-4 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"
                      fill="currentColor"
                    />
                  </svg>
                  <span className="flex-1 text-left">GitHub</span>
                  <ExternalLink className="ml-2 h-3.5 w-3.5 opacity-50 shrink-0" />
                </Button>
                <Button
                  variant="outline"
                  onClick={() => openExternal('https://t.me/flowz1234')}
                  className="w-full sm:w-auto text-[#2AABEE] hover:text-[#229ED9]"
                >
                  <svg
                    className="mr-2 h-5 w-5 shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.892-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"
                      fill="currentColor"
                    />
                  </svg>
                  <span className="flex-1 text-left">
                    {t('settings.about.tgChannel', 'FLOWZ频道')}
                  </span>
                  <ExternalLink className="ml-2 h-3.5 w-3.5 opacity-50 shrink-0" />
                </Button>
              </div>
            </div>

            <Separator />

            <div className="text-xs text-muted-foreground space-y-1">
              <p>{versionInfo?.copyright || '© 2025 FlowZ. All rights reserved.'}</p>
              <p>{t('settings.about.builtWith')}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
