import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import {
  getVersionInfo,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  openExternal,
} from '@/bridge/api-wrapper';
import flowzIcon from '@/assets/flowz-icon.svg';
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
    setDownloading(true);
    setDownloadProgress(0);

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
    setCheckingUpdate(true);
    // 进度 toast 捕获 id：结果各分支带 { id } 原地替换（loading→success/error），不残留「正在检查」；声明在 try 外供 catch 引用。
    const updateToastId = toast.loading(t('settings.about.checkingUpdate'));
    try {
      const response = await checkForUpdates();

      if (!response || !response.success) {
        toast.error(t('settings.about.checkUpdateFail'), {
          id: updateToastId,
          description: response?.error || t('settings.about.cannotConnectServer'),
        });
        return;
      }

      const data = response.data;
      if (!data) {
        toast.error(t('settings.about.checkUpdateFail'), {
          id: updateToastId,
          description: t('settings.about.invalidData'),
        });
        return;
      }

      if (data.hasUpdate && data.updateInfo) {
        const updateInfo = data.updateInfo;
        setAvailableAppUpdate(updateInfo); // 常驻入口（toast 8s 后消失，卡片持久）
        toast.success(t('settings.about.foundUpdate', { version: updateInfo.version }), {
          id: updateToastId,
          description: t('settings.about.clickToInstall'),
          action: {
            label: t('settings.about.updateNow'),
            onClick: () => handleDownloadAndInstall(updateInfo),
          },
          duration: 8000,
        });
      } else {
        setAvailableAppUpdate(null); // 已是最新：清除可能残留的旧 banner
        toast.success(t('settings.about.alreadyLatest'), { id: updateToastId });
      }
    } catch (error) {
      console.error('Failed to check for updates:', error);
      toast.error(t('settings.about.checkUpdateFail'), {
        id: updateToastId,
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
      <div className="set-panel">
        <div className="card set-card">
          <div className="set-pad" style={{ alignItems: 'center', padding: '32px 15px' }}>
            <Loader2 className="h-8 w-8 animate-spin" style={{ color: 'hsl(var(--fg-faint))' }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="set-panel">
      {availableAppUpdate && (
        <AppUpdateBanner
          updateInfo={availableAppUpdate}
          downloading={downloading}
          onUpdate={() => handleDownloadAndInstall(availableAppUpdate)}
          onDismiss={() => setAvailableAppUpdate(null)}
        />
      )}
      <div className="card set-card">
        <div className="about-brand">
          {/* FlowZ 自有应用图标（ui/icon.svg，F/Z 导流单色渐变）——替换原通用占位 SVG（用户反馈）。 */}
          <div className="about-logo overflow-hidden !bg-transparent !p-0">
            <img src={flowzIcon} alt="FlowZ" className="h-full w-full object-cover" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="about-name">{versionInfo?.appName || 'FlowZ'}</div>
            <div className="about-ver">
              {t('settings.about.version', '版本')}{' '}
              <span className="mono tnum">{versionInfo?.appVersion || '—'}</span>
              {availableAppUpdate && (
                <>
                  {' · '}
                  <span className="pill warn" style={{ verticalAlign: 'middle' }}>
                    {t('settings.about.updateAvailable', '可更新 {{version}}', {
                      version: availableAppUpdate.version,
                    })}
                  </span>
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            className="btn ghost sm"
            onClick={handleCheckUpdate}
            disabled={checkingUpdate || downloading}
          >
            {checkingUpdate && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {checkingUpdate ? t('settings.about.checking') : t('settings.about.checkUpdate')}
          </button>
        </div>

        {downloading && (
          <>
            <div className="set-hair" />
            <div className="set-pad">
              <div className="srow-desc" style={{ fontSize: 12 }}>
                {t('settings.about.downloading')}{' '}
                <span className="mono tnum">{downloadProgress}%</span>
              </div>
              <div className="bar">
                <i style={{ width: `${downloadProgress}%` }} />
              </div>
            </div>
          </>
        )}

        <div className="set-hair" />

        <div className="ext-links">
          <button type="button" className="btn ghost sm" onClick={handleReportIssue}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
            >
              <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" strokeLinejoin="round" />
              <path d="M12 8v5M12 16h.01" strokeLinecap="round" />
            </svg>
            {t('settings.about.reportIssue', '报告问题')}
          </button>
          <button type="button" className="btn ghost sm" onClick={handleOpenGitHub}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            GitHub
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => openExternal('https://t.me/flowz1234')}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
            >
              <path
                d="M22 3L2 10.5l6 2.2M22 3l-3 16-6.5-5.3M22 3L8 12.7M8 12.7V18l3.5-3.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {t('settings.about.tgChannel', 'FLOWZ频道')}
          </button>
        </div>

        <div className="about-foot">
          {t('settings.about.builtWith')}
          <br />
          {versionInfo && (
            <>
              <span className="mono">
                sing-box <span className="tnum">{versionInfo.singBoxVersion}</span> ·{' '}
                {versionInfo.platform} {versionInfo.arch}
              </span>
              <br />
            </>
          )}
          {versionInfo?.copyright || '© 2025 FlowZ. All rights reserved.'}
        </div>
      </div>
    </div>
  );
}
