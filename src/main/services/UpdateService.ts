/**
 * 更新检查服务
 * 通过 GitHub API 检查新版本并支持下载
 */

import { app, shell, BrowserWindow, dialog, net, type Session } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { LogManager } from './LogManager';
import type {
  UpdateInfo,
  UpdateCheckResult,
  UpdateProgress,
  UpdatePopupState,
  UpdatePopupAction,
  UpdatePopupLabels,
} from '../../shared/types/update';
import {
  UPDATE_POPUP_WIDTH,
  popupHeightFor,
  popupPosition,
  previewReleaseNotes,
} from './update-popup-layout';
import { APP_USER_AGENT } from '../../shared/constants';
import { MAX_GITHUB_JSON_BYTES } from '../utils/http-limits';
import { getUserDataPath } from '../utils/paths';
import { system32 } from '../utils/win-system32';
import { compareSemver } from '../../shared/version';
import { ghMirrorUrl, normalizeGhProxyPrefix } from '../../shared/gh-proxy';
import type { UserConfig } from '../../shared/types';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { createIdleTimeout, parseExpectedBytes } from './download-hardening';
import { findSuitableUpdateAsset } from './update-asset';
import { UpdateNetwork } from './UpdateNetwork';
import {
  buildWindowsUpdateVbs,
  buildLinuxAppImageScript,
  buildLinuxDebScript,
  buildMacUpdateScript,
  macAppBundleFromExe,
} from './update-install-script';
import { mt, getMainLanguage } from '../i18n';

// 下载停滞超时：连接/下载 30s 无数据即视为卡死 → abort + 失败兜底（github 链接自动换镜像重试一次）。
// 防永久挂起致更新永不 resolve（进度窗/对话框永久转圈）。正常下载持续有 data、不断重置、不会误触发。
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

const GITHUB_OWNER = 'dododook';
const GITHUB_REPO = 'FlowZ';

/**
 * 单次下载的取消 token（per-call，非实例共享）：弹窗流持有自己的 token，取消只作用于它；关于页手动下载
 * 不传 token（不可取消、天然隔离）。避免两流并发时共享实例态互相误取消 / 吞镜像重试（#292 review Med-1）。
 */
interface DownloadControl {
  cancelled: boolean;
  /** 由 downloadWithHardening 在建请求后填入（abort 当前在途请求 + 显式 reject）；镜像/重定向递归时更新为最新请求。 */
  abort: (() => void) | null;
}

export class UpdateService {
  private logManager: LogManager;
  private mainWindow: BrowserWindow | null = null;
  // 独立 Conduit mini 更新窗（remind/progress/done/error 四态），取代旧的白底进度窗 + 原生 messagebox。
  private updatePopupWindow: BrowserWindow | null = null;
  // 当前更新信息（供弹窗动作 manualDownload 取 downloadUrl、进度镜像取 version）。
  private currentUpdateInfo: UpdateInfo | null = null;
  // 在途弹窗动作 awaiter（remind：update/later/skip；error：retry/manualDownload/close；关窗解为 '__closed__'）。
  private popupActionResolver: ((action: UpdatePopupAction | '__closed__') => void) | null = null;
  private popupActionListenerBound = false;
  // 上次弹窗内容高度：仅态切换（高度变）时 setContentSize+重定位，避免进度每帧重设致抖动。
  private lastPopupHeight = 0;
  // 最近下发的弹窗状态：renderer 崩溃/重载后 did-finish-load 重放，避免空白挂死窗（#292 review Low-4）。
  private lastPopupState: UpdatePopupState | null = null;
  // 弹窗流当前下载的取消 token（progress 态 × / OS 关窗时取消它；仅弹窗流持有，与手动下载隔离）。
  private popupDownloadControl: DownloadControl | null = null;
  private downloadProgress: UpdateProgress = {
    status: 'idle',
    percentage: 0,
    message: '',
  };
  private skippedVersion: string | null = null;
  private cleanupCallback: (() => Promise<void>) | null = null;
  // #60：注入配置读取器（仅用于读 ghProxyPrefix 下载镜像前缀），构造后注入。未配置→null（直连，旧行为）。
  // 与 CoreUpdateService.configProvider / CoreDownloader 同口径——App 自更新与内核/资源下载共用同一 gh 加速前缀。
  private configProvider: (() => Promise<UserConfig | null>) | null = null;
  // 更新链路统一会话层（类2：viaProxy/port 决策已收口到 UpdateNetwork.resolveSessionForMainUpdate，providers
  // 由 index.ts 一次注入 updateNetwork.setMainUpdateProviders；本服务只持 updateNetwork 引用）。
  // 未注入 → updateSession 返回 undefined（net.request 回落 default session，旧行为兜底）。
  private updateNetwork: UpdateNetwork | null = null;

  constructor(logManager: LogManager) {
    this.logManager = logManager;
    this.loadSkippedVersion();
  }

  /**
   * 设置清理回调函数
   * 在安装更新前会调用此函数来停止代理进程等资源
   */
  setCleanupCallback(callback: () => Promise<void>): void {
    this.cleanupCallback = callback;
  }

  /** #60：注入配置读取器（读 ghProxyPrefix）。仿 CoreUpdateService.setConfigProvider，构造后由 index.ts 注入。 */
  setConfigProvider(provider: () => Promise<UserConfig | null>): void {
    this.configProvider = provider;
  }

  /** 注入更新链路统一会话层（类2：决策 providers 改由 index.ts 注入 updateNetwork.setMainUpdateProviders）。 */
  setUpdateNetwork(updateNetwork: UpdateNetwork): void {
    this.updateNetwork = updateNetwork;
  }

  /**
   * 更新链路（检查/下载）统一会话。viaProxy/port 决策收口到 UpdateNetwork.resolveSessionForMainUpdate（类2，
   * 三链路单点防漂移）：mainSessionViaProxy×proxyRunning×updateInPort 求值、端口不可用/读 config 失败回落直连、
   * 经 sessionForOrDirect 绝不消费 default session（M1）。未注入 updateNetwork → undefined（旧行为兜底）；
   * 极罕见 direct 也 reject → undefined 守 net.request「绝不抛」契约。
   */
  private async updateSession(): Promise<Session | undefined> {
    if (!this.updateNetwork) return undefined;
    return this.updateNetwork.resolveSessionForMainUpdate().catch(() => undefined);
  }

  /** 读用户配置的 GitHub 加速前缀（规范化）。未配置/读失败 → undefined（直连兜底，不抛）。 */
  private async resolveGhPrefix(): Promise<string | undefined> {
    try {
      const cfg = this.configProvider ? await this.configProvider() : null;
      const raw = cfg?.ghProxyPrefix;
      return raw ? (normalizeGhProxyPrefix(raw) ?? undefined) : undefined;
    } catch {
      return undefined;
    }
  }

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  /** 网络切换/断连瞬态错误（TUN 起来、断网重连，启动期常见）：不报刺眼 error，延迟重试一次再定论。 */
  private isTransientNetworkError(msg: string): boolean {
    return /ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_IO_SUSPENDED|ERR_NAME_NOT_RESOLVED|ECONNRESET|ETIMEDOUT|socket hang up/i.test(
      msg
    );
  }

  /**
   * 检查更新（retried：内部一次性重试标记，瞬态网络错误延迟后自重试用）
   */
  async checkForUpdate(includePrerelease = false, retried = false): Promise<UpdateCheckResult> {
    try {
      this.logManager.addLog('info', '开始检查更新...', 'UpdateService');
      this.updateProgress({ status: 'checking', percentage: 0, message: '正在检查更新...' });

      const releases = await this.fetchReleases();

      // 过滤并排序
      const validReleases = releases
        .filter((r: any) => includePrerelease || !r.prerelease)
        .sort(
          (a: any, b: any) =>
            new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
        );

      if (validReleases.length === 0) {
        this.logManager.addLog('warn', '未找到任何发布版本', 'UpdateService');
        this.updateProgress({ status: 'no-update', percentage: 0, message: '未找到发布版本' });
        return { hasUpdate: false };
      }

      const latestRelease = validReleases[0];
      const currentVersion = app.getVersion();
      const latestVersion = latestRelease.tag_name.replace(/^v/, '');

      // 检查是否为新版本
      if (!this.isNewerVersion(latestVersion, currentVersion)) {
        this.logManager.addLog('info', `当前已是最新版本: ${currentVersion}`, 'UpdateService');
        this.updateProgress({ status: 'no-update', percentage: 0, message: '当前已是最新版本' });
        return { hasUpdate: false };
      }

      // 查找适合当前平台的安装包
      const asset = this.findSuitableAsset(latestRelease.assets);

      if (!asset) {
        this.logManager.addLog('warn', '未找到适合当前平台的安装包', 'UpdateService');
        this.updateProgress({
          status: 'no-update',
          percentage: 0,
          message: '未找到适合当前平台的安装包',
        });
        return { hasUpdate: false };
      }

      const updateInfo: UpdateInfo = {
        version: latestRelease.tag_name,
        title: latestRelease.name || latestRelease.tag_name,
        releaseNotes: latestRelease.body || '',
        downloadUrl: asset.browser_download_url,
        fileSize: asset.size,
        publishedAt: latestRelease.published_at,
        isPrerelease: latestRelease.prerelease,
        fileName: asset.name,
      };

      // 检查是否被跳过
      if (this.skippedVersion === latestVersion) {
        this.logManager.addLog('info', `版本 ${latestVersion} 已被用户跳过`, 'UpdateService');
        this.updateProgress({ status: 'no-update', percentage: 0, message: '此版本已被跳过' });
        return { hasUpdate: false };
      }

      this.logManager.addLog('info', `发现新版本: ${latestVersion}`, 'UpdateService');
      this.updateProgress({
        status: 'update-available',
        percentage: 0,
        message: `发现新版本 ${latestVersion}`,
      });

      return { hasUpdate: true, updateInfo };
    } catch (error: any) {
      const errorMessage = error?.message || '检查更新失败';
      const transient = this.isTransientNetworkError(errorMessage);
      // 网络切换/瞬态（TUN 起来、断网重连，启动期常见）：不报刺眼 error；首次延迟 5s 自重试一次（等网络稳定）。
      if (transient && !retried) {
        this.logManager.addLog(
          'info',
          `网络切换中，5s 后重试检查更新: ${errorMessage}`,
          'UpdateService'
        );
        await new Promise((r) => setTimeout(r, 5000));
        return this.checkForUpdate(includePrerelease, true);
      }
      // 重试后仍失败的瞬态 → warn + 静默（no-update），不弹 error UI；其它 → error。
      this.logManager.addLog(
        transient ? 'warn' : 'error',
        `检查更新失败: ${errorMessage}`,
        'UpdateService'
      );
      this.updateProgress({
        status: transient ? 'no-update' : 'error',
        percentage: 0,
        message: '检查更新失败',
        error: errorMessage,
      });
      return { hasUpdate: false, error: errorMessage };
    }
  }

  /**
   * 下载更新
   */
  async downloadUpdate(updateInfo: UpdateInfo): Promise<string | null> {
    // 手动下载不传 cancel token → 不可取消、与弹窗流的取消 token 完全隔离（无跨流污染）。
    try {
      this.logManager.addLog('info', `开始下载更新: ${updateInfo.version}`, 'UpdateService');
      this.updateProgress({ status: 'downloading', percentage: 0, message: '正在下载更新...' });

      const downloadDir = app.getPath('temp');
      const filePath = path.join(downloadDir, updateInfo.fileName);

      // 如果文件已存在，先删除
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      await this.downloadFile(updateInfo.downloadUrl, filePath, updateInfo.fileSize);

      this.logManager.addLog('info', `更新下载完成: ${filePath}`, 'UpdateService');
      this.updateProgress({ status: 'downloaded', percentage: 100, message: '下载完成' });

      return filePath;
    } catch (error: any) {
      const errorMessage = error?.message || '下载更新失败';
      this.logManager.addLog('error', `下载更新失败: ${errorMessage}`, 'UpdateService');
      this.updateProgress({
        status: 'error',
        percentage: 0,
        message: '下载失败',
        error: errorMessage,
      });
      return null;
    }
  }

  /**
   * 安装更新（打开下载的安装包）
   */
  /** Linux deb 安装态判定（双守卫，与 installUpdate 分派逻辑同源）：非 AppImage 运行 + .deb 资产。 */
  private isDebUpdateForm(installerPath: string): boolean {
    return process.platform === 'linux' && !process.env.APPIMAGE && installerPath.endsWith('.deb');
  }

  /** deb 更新前的一次性授权说明框（后续 pkexec 弹的 polkit 通用框文案改不了，先在 app 内解释缘由）。返回 true=继续更新。 */
  private async confirmDebElevation(): Promise<boolean> {
    const opts = {
      type: 'info' as const,
      title: mt('debUpdateElevationTitle'),
      message: mt('debUpdateElevationMessage'),
      detail: mt('debUpdateElevationDetail'),
      buttons: [mt('debUpdateElevationContinue'), mt('debUpdateElevationCancel')],
      defaultId: 0,
      cancelId: 1,
    };
    const win = this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : null;
    const { response } = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts);
    return response === 0;
  }

  async installUpdate(installerPath: string): Promise<boolean> {
    try {
      this.logManager.addLog('info', `准备安装更新: ${installerPath}`, 'UpdateService');

      // 检查文件是否存在
      if (!fs.existsSync(installerPath)) {
        this.logManager.addLog('error', `安装包不存在: ${installerPath}`, 'UpdateService');
        return false;
      }

      // Linux deb 安装态：后续 pkexec apt 会弹 polkit 通用授权框（文案不可改）——先在 app 内弹一个说清缘由的确认框。
      // 仅 deb 形态（AppImage/portable/mac/win 全跳过）；取消=不更新。**必须在下方 cleanupCallback 停代理之前** →
      // 取消即真 no-op（代理未停、脚本未写、未 app.exit），不留「代理被停但没更新」的坏态。
      if (this.isDebUpdateForm(installerPath)) {
        const proceed = await this.confirmDebElevation();
        if (!proceed) {
          this.logManager.addLog('info', 'deb 更新被用户取消（授权说明框）', 'UpdateService');
          return false;
        }
      }

      // 在安装更新前，先清理资源（停止代理进程等）
      // 这是关键步骤，否则 Windows 上会因为文件被占用而安装失败
      if (this.cleanupCallback) {
        this.logManager.addLog('info', '正在停止代理进程...', 'UpdateService');
        try {
          await this.cleanupCallback();
          this.logManager.addLog('info', '代理进程已停止', 'UpdateService');
        } catch (error: any) {
          this.logManager.addLog('warn', `停止代理进程时出错: ${error?.message}`, 'UpdateService');
          // 继续安装，不要因为清理失败而中断
        }
      }

      if (process.platform === 'win32') {
        // Windows: 用 VBScript 隐藏窗口运行。便携态(PORTABLE_EXECUTABLE_FILE)=覆盖回原 exe 原位更新；
        // 否则=跑 NSIS setup（注册表记住目录原位升级）。两者都只动产物、不碰 data。
        const { spawn } = require('child_process');
        const vbsPath = path.join(app.getPath('temp'), 'flowz_update.vbs');

        const portableTarget = process.env.PORTABLE_EXECUTABLE_FILE || null;
        // B（移入新版本名 + 删旧版本名）：新版本名文件放回原目录（原目录 + 下载件文件名），保留 GitHub release
        // 带版本号的命名。
        const portableNewPath = portableTarget
          ? path.join(path.dirname(portableTarget), path.basename(installerPath))
          : null;
        this.logManager.addLog(
          'info',
          portableTarget ? '便携版：移入新版本名文件 + 删旧版本名' : 'NSIS：运行安装器原位升级',
          'UpdateService'
        );
        const vbsContent = buildWindowsUpdateVbs({
          installerPath,
          portableTarget,
          portableNewPath,
          fallbackMessage: mt('portableUpdateManualReplace'),
        });

        // .vbs 必须 UTF-16 LE + BOM：wscript 只认它为 Unicode；UTF-8 无 BOM 会按系统 ANSI 代码页解读 →
        // 非 ASCII 用户名/路径（如中文账户的 %TEMP%/便携目录）错乱致文件操作失败、多语 MsgBox 乱码。
        fs.writeFileSync(vbsPath, '\ufeff' + vbsContent, 'utf16le');

        // 使用 wscript 运行 VBS（完全无窗口）
        const vbs = spawn(system32('wscript.exe'), [vbsPath], {
          detached: true,
          stdio: 'ignore',
          shell: false,
        });
        vbs.unref();

        this.logManager.addLog('info', '更新脚本已启动，正在退出应用...', 'UpdateService');

        // 给一点时间让 VBS 启动，然后退出应用
        setTimeout(() => {
          this.destroyTrayForExit();
          app.exit(0);
        }, 500);
      } else if (process.platform === 'darwin') {
        // macOS: 自动挂载 DMG → 原子替换 .app（定位到则自动；定位不到回退手动 open DMG）。只换 .app、不碰 data。
        const { spawn } = require('child_process');
        const scriptPath = path.join(app.getPath('temp'), 'flowz_update.sh');

        const appBundlePath = macAppBundleFromExe(app.getPath('exe'));
        this.logManager.addLog(
          'info',
          appBundlePath ? `自动替换 .app: ${appBundlePath}` : '定位 .app 失败，回退手动拖拽',
          'UpdateService'
        );
        const scriptContent = buildMacUpdateScript({ dmgPath: installerPath, appBundlePath });

        fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

        // 使用 spawn 启动独立进程执行脚本
        const child = spawn('/bin/bash', [scriptPath], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();

        this.logManager.addLog('info', 'DMG 文件将在应用退出后打开...', 'UpdateService');

        setTimeout(() => {
          this.destroyTrayForExit();
          app.exit(0);
        }, 1000);
      } else {
        // Linux: AppImage(loose, $APPIMAGE) → 覆盖原 AppImage 原位更新 + 重启（只换文件、不碰 ~/.config）；
        // deb(installed) → pkexec apt-get install 原位升级 + 重启（取代旧 shell.openPath(.deb)：Ubuntu 24.04+
        // 默认 .deb 处理器 App Center 对本地 deb 不做版本升级、只显示 Installed，见 buildLinuxDebScript）。
        // 两路统一走 spawn detached bash 脚本（不再依赖系统默认 .deb 关联）。
        const appImageTarget = process.env.APPIMAGE || null;
        const isAppImage = !!appImageTarget && installerPath.endsWith('.AppImage');
        // deb 脚本严格按【运行形态 + 资产形态】双守卫（review Med-2）：仅「非 AppImage 运行（=deb 安装态）+ .deb 资产」
        // 才走 root apt 安装。杜绝「AppImage(loose) 用户因 release 只发 deb 被跨形态兜底选中 → 被 system-wide 装 deb」。
        const isDeb = this.isDebUpdateForm(installerPath); // 与顶部确认框谓词同源（双守卫单一真值）
        if (isAppImage || isDeb) {
          const { spawn } = require('child_process');
          const scriptPath = path.join(app.getPath('temp'), 'flowz_update.sh');
          const scriptContent = isAppImage
            ? buildLinuxAppImageScript({ installerPath, appImageTarget: appImageTarget as string })
            : buildLinuxDebScript({ installerPath, exePath: app.getPath('exe') });
          fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
          const child = spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' });
          child.unref();
          this.logManager.addLog(
            'info',
            isAppImage
              ? `AppImage 原位更新: ${appImageTarget}`
              : 'deb 原位升级（pkexec apt-get install + 重启）',
            'UpdateService'
          );
        } else {
          // 形态错配（AppImage 运行却拿到 .deb / deb 态拿到 .AppImage 等跨形态兜底）：不强制 root 安装，回退交系统
          // 处理（openPath）让用户手动决定，安全优先。
          await shell.openPath(installerPath);
          this.logManager.addLog(
            'warn',
            `更新包形态与运行形态不匹配，交系统处理: ${installerPath}`,
            'UpdateService'
          );
        }
        setTimeout(() => {
          this.destroyTrayForExit();
          app.exit(0);
        }, 1000);
      }

      return true;
    } catch (error: any) {
      this.logManager.addLog('error', `安装更新失败: ${error?.message}`, 'UpdateService');
      return false;
    }
  }

  /**
   * app.exit() 绕过 before-quit/will-quit 退出管线（含托盘销毁）→ 安装更新前主动销毁托盘，
   * 否则 Windows 上残留幽灵图标（hover 才消失）。延迟 require 避免与 index.ts 顶层循环依赖；best-effort。
   */
  private destroyTrayForExit(): void {
    try {
      const { getTrayManager } = require('../index');
      getTrayManager()?.destroyTray();
    } catch {
      /* 托盘销毁失败不阻断更新退出 */
    }
  }

  /**
   * 跳过此版本
   */
  skipVersion(version: string): void {
    this.skippedVersion = version.replace(/^v/, '');
    this.saveSkippedVersion();
    this.logManager.addLog('info', `已跳过版本: ${version}`, 'UpdateService');
  }

  /**
   * 打开 GitHub Releases 页面
   */
  openReleasesPage(): void {
    shell.openExternal(`https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`);
  }

  /**
   * 发现新版本提醒：弹 Conduit mini 更新窗 remind 态，等用户动作。取代原生 dialog.showMessageBox。
   * 不再依赖 mainWindow（弹窗独立）→ 修「主窗销毁/托盘轻量态时提醒不弹」缺陷。签名与返回语义不变 → call site 零改。
   * action==='update' 时保留弹窗，交由 downloadUpdateWithProgress 续进 progress 态（一窗四态无缝）。
   */
  async showUpdateDialog(updateInfo: UpdateInfo): Promise<'update' | 'later' | 'skip'> {
    // 已有活跃更新流（弹窗在：remind 等待 / 下载中 / error）→ 不打断、不覆盖 resolver，本次检查按「稍后」处理。
    // 防 startup 自动检查与托盘手动检查并发时第二个 showUpdateDialog 覆盖 resolver 致首个 awaiter 泄漏 + 双下载。
    if (this.updatePopupWindow && !this.updatePopupWindow.isDestroyed()) {
      return 'later';
    }
    this.currentUpdateInfo = updateInfo;
    this.createUpdatePopup({
      phase: 'remind',
      theme: this.resolvedTheme(),
      version: updateInfo.version,
      currentVersion: `v${app.getVersion()}`,
      notes: previewReleaseNotes(updateInfo.releaseNotes || ''),
      labels: this.popupLabels(),
    });

    const action = await this.awaitPopupAction(['update', 'later', 'skip']);
    if (action === 'update') return 'update'; // 保留弹窗，进度态由 downloadUpdateWithProgress 续
    this.closeUpdatePopup();
    return action === 'skip' ? 'skip' : 'later'; // later / __closed__（关窗）
  }

  /**
   * 获取当前下载进度
   */
  getProgress(): UpdateProgress {
    return { ...this.downloadProgress };
  }

  /** 生效主题（= nativeTheme.shouldUseDarkColors，themeSource 已由 index.ts 按 uiTheme 设）。弹窗首帧即用。 */
  private resolvedTheme(): 'dark' | 'light' {
    const { nativeTheme } = require('electron') as typeof import('electron');
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }

  /** 弹窗静态文案（按当前语言 mt 渲染进载荷；弹窗页无 i18n runtime，E5）。 */
  private popupLabels(): UpdatePopupLabels {
    return {
      remindTitle: mt('updRemindTitle'),
      progressTitle: mt('updProgressTitle'),
      doneTitle: mt('updDoneTitle'),
      errorTitle: mt('updErrorTitle'),
      currentPrefix: mt('updCurrentPrefix'),
      installing: mt('updInstalling'),
      tryingMirror: mt('updTryingMirror'),
      update: mt('updBtnUpdate'),
      later: mt('updBtnLater'),
      skip: mt('updBtnSkip'),
      viewLog: mt('updBtnViewLog'),
      cancel: mt('updBtnCancel'),
      retry: mt('updBtnRetry'),
      manualDownload: mt('updBtnManualDownload'),
      close: mt('updBtnClose'),
    };
  }

  /**
   * 创建（或复用）独立 Conduit mini 更新窗并推初始状态。已有存活弹窗 → 复用（remind→progress 无缝续态）。
   * frameless + 非 transparent（E2：Win/Linux 透明窗鼠标穿透）+ 主题化实色底防白闪 + 角落 showInactive 不抢焦点。
   * 加载打包 HTML 入口（dev 走 vite dev server），与主窗共享 index.css token/字体（E3，非 data:URL 复制值）。
   */
  private createUpdatePopup(state: UpdatePopupState): BrowserWindow {
    if (this.updatePopupWindow && !this.updatePopupWindow.isDestroyed()) {
      this.sendPopupState(state);
      return this.updatePopupWindow;
    }

    const { nativeTheme } = require('electron') as typeof import('electron');
    const isDark = nativeTheme.shouldUseDarkColors;
    const width = UPDATE_POPUP_WIDTH;
    const height = popupHeightFor(state.phase);

    const win = new BrowserWindow({
      width,
      height,
      resizable: false,
      minimizable: false,
      maximizable: false,
      frame: false,
      transparent: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      // 防白闪：按生效主题给实色底（= index.css --surface；主进程 hex 不受 renderer eslint 约束）。
      backgroundColor: isDark ? '#161C24' : '#FFFFFF',
      webPreferences: {
        preload: path.join(app.getAppPath(), 'dist/main/main/preload-update-popup.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // 当前界面语言注入 preload：弹窗页据此设 <html lang/dir>（fa=rtl），修 lang 写死 zh-CN（review Nit）。
        additionalArguments: [`--flowz-popup-lang=${getMainLanguage()}`],
      },
    });
    if (process.platform !== 'darwin') win.setMenu(null);
    // 拒绝任何子窗口打开（纯本地受信内容，belt-and-braces；对齐 dashboard 窗先例）。
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const isDev = process.env.NODE_ENV === 'development';
    const loaded = isDev
      ? win.loadURL('http://localhost:5173/update-popup.html')
      : win.loadFile(path.join(app.getAppPath(), 'dist/renderer/update-popup.html'));
    loaded.catch((err: Error) => {
      this.logManager.addLog('error', `更新弹窗加载失败: ${err.message}`, 'UpdateService');
      // 加载失败弹窗永不 ready-to-show/无按钮 → 关窗并解 awaiter，避免 showUpdateDialog/下载流永挂（旧实现降级 later）。
      if (this.updatePopupWindow === win) {
        this.closeUpdatePopup();
        this.popupActionResolver?.('__closed__');
      }
    });

    win.once('ready-to-show', () => {
      this.positionPopup(win, width, popupHeightFor(state.phase));
      win.showInactive(); // 不抢键盘焦点（角落 toast 语义，非打断式 dialog）
    });
    // 内容就绪即重放最近状态（非 once：renderer 崩溃/重载后重新渲染当前态，避免空白挂死窗，Low-4）。
    win.webContents.on('did-finish-load', () => {
      if (this.updatePopupWindow === win && this.lastPopupState)
        this.sendPopupState(this.lastPopupState);
    });
    // renderer 进程崩溃：无按钮/无法交互的隐形 alwaysOnTop 窗 → 视同关窗收尾（取消在途下载 + 解 awaiter）。
    win.webContents.on('render-process-gone', () => {
      if (this.updatePopupWindow !== win) return;
      if (this.popupDownloadControl) {
        this.popupDownloadControl.cancelled = true;
        this.popupDownloadControl.abort?.();
      }
      this.popupActionResolver?.('__closed__');
      this.closeUpdatePopup();
    });

    win.on('closed', () => {
      // 仅当关闭的是当前活跃弹窗才复位 + 解 awaiter：防 close→closed 异步间隙内已被新流程替换时，
      // 旧窗 closed 误清新窗引用 / 误 resolve 新 awaiter（Low：竞态僵尸窗）。
      if (this.updatePopupWindow !== win) return;
      this.updatePopupWindow = null;
      this.lastPopupHeight = 0;
      // Med-2：progress 态经 OS 关窗（Alt+F4/Cmd+W）视同取消——中断在途下载，防「关了窗仍静默下完 + 杀 app 装更新」。
      // 与「×」取消收敛到同一 token 收尾；无在途下载（remind/error）时 control 为 null，此段 no-op。
      if (this.popupDownloadControl) {
        this.popupDownloadControl.cancelled = true;
        this.popupDownloadControl.abort?.();
      }
      // 用户直接关窗（Alt+F4 等）→ 解掉在途 awaiter，避免 Promise 永挂。
      this.popupActionResolver?.('__closed__');
    });

    this.updatePopupWindow = win;
    this.registerPopupActionListener();
    // 下发初始状态：写 lastPopupState 供 did-finish-load 重放（页面 onState 监听晚于此 send 时兜底）。
    // 缺此行则 remind 态 lastPopupState 恒 null → did-finish-load 不重放 → 页面永空 → 白卡片挂死窗（#300）。
    this.sendPopupState(state);
    return win;
  }

  /** 向弹窗整帧下发状态；态切换（高度变）时才 setContentSize + 保角锚点重定位。 */
  private sendPopupState(state: UpdatePopupState): void {
    this.lastPopupState = state; // 记录供 did-finish-load 崩溃/重载重放（Low-4）。
    const win = this.updatePopupWindow;
    if (!win || win.isDestroyed()) return;
    const height = popupHeightFor(state.phase);
    if (height !== this.lastPopupHeight) {
      win.setContentSize(UPDATE_POPUP_WIDTH, height);
      this.positionPopup(win, UPDATE_POPUP_WIDTH, height);
      this.lastPopupHeight = height;
    }
    win.webContents.send(IPC_CHANNELS.UPDATE_POPUP_STATE, state);
  }

  /** 角落停靠（纯计算在 update-popup-layout.popupPosition；workArea 由 screen 注入）。 */
  private positionPopup(win: BrowserWindow, width: number, height: number): void {
    const { screen } = require('electron') as typeof import('electron');
    const { x, y } = popupPosition(
      screen.getPrimaryDisplay().workArea,
      width,
      height,
      process.platform
    );
    win.setPosition(x, y);
  }

  /** 关闭并复位弹窗状态。 */
  private closeUpdatePopup(): void {
    this.lastPopupHeight = 0;
    this.lastPopupState = null;
    if (this.updatePopupWindow && !this.updatePopupWindow.isDestroyed()) {
      this.updatePopupWindow.close();
    }
    this.updatePopupWindow = null;
  }

  /** 注册弹窗动作监听（进程生命周期内一次；仅一个弹窗，按 sender 甄别本窗口）。 */
  private registerPopupActionListener(): void {
    if (this.popupActionListenerBound) return;
    const { ipcMain } = require('electron') as typeof import('electron');
    ipcMain.on(IPC_CHANNELS.UPDATE_POPUP_ACTION, this.onPopupAction);
    this.popupActionListenerBound = true;
  }

  /** 弹窗动作路由：viewLog/manualDownload 就地开外链，cancel 中断下载；其余交 awaiter 决策（update/later/skip/retry/close）。 */
  private onPopupAction = (event: Electron.IpcMainEvent, action: UpdatePopupAction): void => {
    if (!this.updatePopupWindow || this.updatePopupWindow.isDestroyed()) return;
    if (event.sender !== this.updatePopupWindow.webContents) return; // 只认本弹窗
    if (action === 'viewLog') {
      this.openReleasesPage(); // 打开 releases，弹窗保留在 remind 态（不 resolve）
      return;
    }
    if (action === 'cancel') {
      // progress 态取消：只作用于弹窗流自己的 token（不碰关于页手动下载）→ downloadFile reject → 下载循环静默收尾。
      const ctl = this.popupDownloadControl;
      if (ctl) {
        ctl.cancelled = true;
        ctl.abort?.();
      }
      return;
    }
    if (action === 'manualDownload' && this.currentUpdateInfo) {
      // 仅放行 https（防被篡改的非 http(s) scheme 经 openExternal 触发协议处理器，review Nit）。
      const url = this.currentUpdateInfo.downloadUrl;
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
    }
    this.popupActionResolver?.(action);
  };

  /** 等弹窗回传合法动作（或关窗 '__closed__'）；非法/副作用动作（viewLog）不 resolve。 */
  private awaitPopupAction(valid: UpdatePopupAction[]): Promise<UpdatePopupAction | '__closed__'> {
    return new Promise((resolve) => {
      // 弹窗已不在（如 progress 态被用户关窗后才走到 error 态 await）→ 立即解，避免无人可 resolve 致永挂。
      if (!this.updatePopupWindow || this.updatePopupWindow.isDestroyed()) {
        resolve('__closed__');
        return;
      }
      this.popupActionResolver = (a) => {
        if (a === '__closed__' || valid.includes(a as UpdatePopupAction)) {
          this.popupActionResolver = null;
          resolve(a);
        }
      };
    });
  }

  /**
   * 托盘/启动触发的下载：Conduit 弹窗承载 progress→done/error 态。error 态支持「重试」循环。
   * 下载走统一 downloadFile（mirrorToPopup=true → 进度只镜像弹窗，不打扰关于页；与旧 downloadFileWithProgressWindow
   * 的「不触碰 mainWindow 进度」语义一致）。
   */
  async downloadUpdateWithProgress(updateInfo: UpdateInfo): Promise<string | null> {
    this.currentUpdateInfo = updateInfo;
    const downloadDir = app.getPath('temp');
    const filePath = path.join(downloadDir, updateInfo.fileName);

    // 复用 remind 弹窗续进 progress，或新建 progress 态弹窗。
    this.createUpdatePopup({
      phase: 'progress',
      theme: this.resolvedTheme(),
      version: updateInfo.version,
      percentage: 0,
      bytesText: '',
      labels: this.popupLabels(),
    });

    // 失败可重试循环：error 态「重试」→ 重下；「手动下载/关闭/关窗」→ 收尾返回 null。
    for (;;) {
      // 每轮独立 cancel token（清上一轮 / 异步迟到的取消）；挂到实例供「×」/OS 关窗只取消本弹窗流。
      const ctl: DownloadControl = { cancelled: false, abort: null };
      this.popupDownloadControl = ctl;
      try {
        this.logManager.addLog('info', `开始下载更新: ${updateInfo.version}`, 'UpdateService');
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        await this.downloadFile(
          updateInfo.downloadUrl,
          filePath,
          updateInfo.fileSize,
          false,
          true,
          ctl
        );

        // 竞态：取消恰在下载完成瞬间到达（download 已 resolve）→ 仍按取消处理，不进 done/不安装。
        if (ctl.cancelled) return this.finishPopupCancel(filePath, '（完成瞬间）');

        this.popupDownloadControl = null;
        this.logManager.addLog('info', `更新下载完成: ${filePath}`, 'UpdateService');
        this.sendPopupState({
          phase: 'done',
          theme: this.resolvedTheme(),
          version: updateInfo.version,
          percentage: 100,
          labels: this.popupLabels(),
        });
        // 捕获当前窗引用：800ms 后仅当仍是这个弹窗才关（防期间被新流程复用后误关新窗，Low 竞态）。
        const doneWin = this.updatePopupWindow;
        setTimeout(() => {
          if (this.updatePopupWindow === doneWin) this.closeUpdatePopup();
        }, 800);
        return filePath;
      } catch (error: any) {
        // 用户取消（progress 态 × / OS 关窗）：abort 触发的 reject 不是真错误 → 静默关窗、不显 error 态、不安装、删残件。
        if (ctl.cancelled) return this.finishPopupCancel(filePath, '');

        this.popupDownloadControl = null;
        const errorMessage = error?.message || '下载更新失败';
        this.logManager.addLog('error', `下载更新失败: ${errorMessage}`, 'UpdateService');
        this.sendPopupState({
          phase: 'error',
          theme: this.resolvedTheme(),
          version: updateInfo.version,
          errorText: this.localizeDownloadError(errorMessage), // 本地化展示；原始详情已进日志
          labels: this.popupLabels(),
        });

        const action = await this.awaitPopupAction(['retry', 'manualDownload', 'close']);
        if (action === 'retry') {
          this.sendPopupState({
            phase: 'progress',
            theme: this.resolvedTheme(),
            version: updateInfo.version,
            percentage: 0,
            bytesText: '',
            labels: this.popupLabels(),
          });
          continue;
        }
        this.closeUpdatePopup(); // manualDownload（已外链）/ close / __closed__
        return null;
      }
    }
  }

  /** 把下载错误的（中文）内部消息按类别映射为本地化文案，供 5 语弹窗 error 态展示；原始详情仍进日志（review Low-5）。 */
  private localizeDownloadError(raw: string): string {
    if (
      /停滞超时|超时|ETIMEDOUT|ECONNRESET|DISCONNECTED|NETWORK_CHANGED|socket hang up|中断|拦截/i.test(
        raw
      )
    ) {
      return mt('updErrNetwork');
    }
    if (/不完整|截断|incomplete|truncat/i.test(raw)) return mt('updErrIncomplete');
    if (/HTTP\s*\d|返回错误|频率限制|响应过大|403|5\d\d/i.test(raw)) return mt('updErrServer');
    return mt('updErrGeneric');
  }

  /** 取消下载的统一收尾：清 token + 删残件 + 关窗 + 返回 null（不安装）。 */
  private finishPopupCancel(filePath: string, note: string): null {
    this.popupDownloadControl = null;
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      /* 残件清理失败无害（temp 目录 OS 自清） */
    }
    this.logManager.addLog('info', `用户取消更新下载${note}`, 'UpdateService');
    this.closeUpdatePopup();
    return null;
  }

  // ========== 私有方法 ==========

  private async fetchReleases(): Promise<any[]> {
    const sess = await this.updateSession();
    return new Promise((resolve, reject) => {
      let settled = false;
      const request = net.request({
        method: 'GET',
        url: `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
        session: sess,
      });
      // 单点收口：防 request/response 双错误源重复 settle；clear timeout；之后任何回调都 no-op。
      const finish = (err: Error | null, val?: any[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(val as any[]);
      };
      // 兜底超时：net.request 在连接被中间设备静默吞掉时可能长时间不触发 error → 检查更新 Promise 永不 settle
      // → 前端永久转圈（与 CoreUpdateService.fetchReleases 对齐）。15s 后主动 abort+reject。
      const timer = setTimeout(() => {
        try {
          request.abort();
        } catch {
          /* ignore */
        }
        finish(new Error('检查更新超时（GitHub 不可达或被网络拦截）'));
      }, 15000);

      request.setHeader('User-Agent', APP_USER_AGENT);
      request.setHeader('Accept', 'application/vnd.github.v3+json');

      request.on('response', (res) => {
        let data = '';
        res.on('data', (chunk) => {
          // 已收口（超限/超时/错误）后忽略 drain 中的残帧：abort 不同步停止 res，
          // 已 buffer 的帧仍会触发 data，若继续累加会徒增内存峰值。
          if (settled) return;
          data += chunk.toString();
          // OOM 防护（审计 #2）：GitHub api 被劫持/WAF 接管可回灌 GB 级响应撞 V8 堆/512MB string 上限。
          // 启动后 5s 自动检查更新即可被诱发。超 16MiB 即 abort + 单点收口 finish（releases JSON 实际 < 数 MB）。
          if (data.length > MAX_GITHUB_JSON_BYTES) {
            try {
              request.abort();
            } catch {
              /* ignore */
            }
            finish(new Error('GitHub 响应过大（疑似被劫持/WAF 拦截）'));
            return;
          }
        });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              finish(null, JSON.parse(data));
            } catch {
              finish(new Error('解析 GitHub API 响应失败'));
            }
          } else if (res.statusCode === 403) {
            finish(new Error('GitHub API 访问频率限制 (403)，请稍后再试或使用代理'));
          } else {
            finish(new Error(`GitHub API 返回错误: ${res.statusCode}`));
          }
        });
        // response 阶段断连（ERR_CONNECTION_CLOSED 等）从 res emit 'error'，缺此 handler 会逃逸成主进程
        // uncaughtException 且 Promise 永不 settle → checkForUpdate await 永挂 → 前端检查更新永久转圈。
        res.on('error', (err: Error) => finish(err));
      });

      request.on('error', (err: Error) => finish(err));
      request.end();
    });
  }

  private findSuitableAsset(assets: any[]): any | null {
    // 纯逻辑在 update-asset，此处仅注入 process 平台/架构 + 运行形态（loose vs installed），
    // 使每平台各取对应包（#72）。loose 检测：win=PORTABLE_EXECUTABLE_DIR / linux=APPIMAGE
    // （均 electron-builder 运行时注入，与 paths/ResourceManager 的便携判定同源）；mac 只有 DMG、不用。
    const looseForm =
      process.platform === 'win32'
        ? !!process.env.PORTABLE_EXECUTABLE_DIR
        : process.platform === 'linux'
          ? !!process.env.APPIMAGE
          : false;
    return findSuitableUpdateAsset(assets, process.platform, process.arch, looseForm);
  }

  private isNewerVersion(latest: string, current: string): boolean {
    // 收口到 shared/version.compareSemver（与 CoreUpdateService 共用单一权威）：原 split('.').map(Number)
    // 遇 prerelease（"1.2.3-beta"）某段算成 NaN → 比较恒 false 误判「非新版本」漏更新；compareSemver 容忍 -/+ 后缀。
    return compareSemver(latest, current) > 0;
  }

  /**
   * mirrorToPopup 决定进度归属，避免跨流串扰：
   * - false（关于页手动 downloadUpdate）：进度发 mainWindow（EVENT_UPDATE_PROGRESS，about 页订阅）。
   * - true（downloadUpdateWithProgress，托盘/启动）：进度只镜像弹窗，不触碰 mainWindow（旧 downloadFileWithProgressWindow 语义）。
   *   否则关于页正手动下载时若托盘流并发，两流都写 mainWindow 进度会互相串入；且弹窗被无关流劫持成 progress 态。
   */
  private async downloadFile(
    url: string,
    destPath: string,
    totalSize: number,
    isRetry = false,
    mirrorToPopup = false,
    ctl?: DownloadControl
  ): Promise<void> {
    return this.downloadWithHardening(
      url,
      destPath,
      totalSize,
      isRetry,
      {
        onMirror: () => {
          if (mirrorToPopup) {
            this.mirrorProgressToPopup(0, undefined, true);
          } else {
            this.updateProgress({
              status: 'downloading',
              percentage: 0,
              message: '正在尝试通过镜像下载...',
            });
          }
        },
        onProgress: (downloaded, total) => {
          if (total > 0) {
            const percentage = Math.round((downloaded / total) * 100);
            if (mirrorToPopup) {
              const downloadedMB = (downloaded / 1024 / 1024).toFixed(1);
              const totalMB = (total / 1024 / 1024).toFixed(1);
              this.mirrorProgressToPopup(percentage, `${downloadedMB} MB / ${totalMB} MB`, false);
            } else {
              this.updateProgress({
                status: 'downloading',
                percentage,
                message: `正在下载更新... ${percentage}%`,
              });
            }
          }
        },
      },
      ctl
    );
  }

  /** 把下载进度镜像成弹窗 progress 态（仅 downloadUpdateWithProgress 调用；弹窗已销毁则 no-op）。 */
  private mirrorProgressToPopup(
    percentage: number,
    bytesText: string | undefined,
    mirror: boolean
  ): void {
    if (!this.updatePopupWindow || this.updatePopupWindow.isDestroyed()) return;
    this.sendPopupState({
      phase: 'progress',
      theme: this.resolvedTheme(),
      version: this.currentUpdateInfo?.version ?? '',
      percentage,
      bytesText,
      mirror,
      labels: this.popupLabels(),
    });
  }

  /**
   * App 安装包下载的共享实现：主窗进度 + 弹窗镜像仅 onProgress/onMirror 回调不同，主体复用。
   * 对齐 CoreUpdateService.downloadFile 的三项加固：
   *   ① idle/stall 停滞超时——30s 无 data 即 abort，防网络中断/被拦截致永久挂起、更新永不 resolve（转圈不退）。
   *   ② Content-Length 完整性校验——end 时比对实收字节与响应头 totalSize，被截断的下载 reject（github 链接自动换镜像重试）。
   *   ③ 背压——file.write 返回 false（写盘慢于收流）时 response.pause()，drain 后 resume，防大包下内存堆积。
   * mirror 兜底：原 mirror.ghproxy.com 已停服，复用 shared/gh-proxy 内置 preset[0]（末尾带 '/'）。
   */
  private async downloadWithHardening(
    url: string,
    destPath: string,
    totalSize: number,
    isRetry: boolean,
    cb: {
      onMirror: () => void;
      onProgress: (downloadedBytes: number, totalSize: number) => void;
    },
    ctl?: DownloadControl
  ): Promise<void> {
    // #60：先解析用户 ghProxyPrefix（async），供 handleError 兜底镜像拼接用——与 CoreDownloader.downloadFile 同口径
    // （在 Promise executor 外 await 配置，闭包内用解析后的同步值）。未配置 → undefined（ghMirrorUrl 回落内置 preset[0]）。
    const ghPrefix = await this.resolveGhPrefix();
    const sess = await this.updateSession();
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      let downloadedBytes = 0;
      let settled = false;
      // 完整性校验用：优先响应头 content-length，缺失回落调用方传入的 totalSize（GitHub asset size）。
      let expectedBytes = NaN;

      // ① 停滞看门狗：每收到 data / 连接阶段 arm；30s 无进展 → abort + handleError。收口 download-hardening。
      const idle = createIdleTimeout(() => {
        try {
          request.abort();
        } catch {
          /* ignore */
        }
        handleError(new Error('下载停滞超时（30s 无数据，网络中断或被拦截）'));
      }, DOWNLOAD_IDLE_TIMEOUT_MS);

      const handleError = (err: any) => {
        if (settled) return;
        settled = true;
        idle.clear();
        file.close();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);

        // 用户取消（abort 触发）：不走镜像重试，直接 reject → downloadUpdateWithProgress 按取消收尾。
        if (ctl?.cancelled) {
          reject(err);
          return;
        }

        if (!isRetry && url.includes('github.com')) {
          this.logManager.addLog(
            'warn',
            `下载出错，尝试使用加速镜像: ${err.message}`,
            'UpdateService'
          );
          cb.onMirror();
          // #60：兜底镜像优先用用户配置的 ghProxyPrefix（应用内核/资源下载同一加速前缀），缺失才回落内置 preset[0]。
          const mirrorUrl = ghMirrorUrl(url, ghPrefix);
          this.downloadWithHardening(mirrorUrl, destPath, totalSize, true, cb, ctl)
            .then(resolve)
            .catch(reject);
          return;
        }
        reject(err);
      };

      const request = net.request({
        url: url,
        method: 'GET',
        session: sess,
      });
      request.setHeader('User-Agent', APP_USER_AGENT);
      // 暴露中断钩子给「取消」动作（progress 态 × / OS 关窗）；递归镜像/重定向时更新为最新在途请求（同时仅一个活跃）。
      // 与 idle 看门狗同款：abort 后**显式** handleError 驱动 settle，不依赖 abort 是否 emit 'error'
      // （守 download-hardening「abort 之后必须自己 reject」约定；ctl.cancelled 已置位 → handleError 走 reject、跳镜像）。
      if (ctl) {
        ctl.abort = () => {
          try {
            request.abort();
          } catch {
            /* ignore */
          }
          handleError(new Error('下载已取消'));
        };
        // Low-3：取消可能落在建请求前的 await 间隙（resolveGhPrefix/updateSession，含端口探测）——彼时 ctl.abort 尚为
        // null、abort() 是 no-op。到此请求已建、abort 钩子已装，若期间已置取消则立即收尾，避免白下整包才被完成后检查丢弃。
        if (ctl.cancelled) {
          handleError(new Error('下载已取消'));
          return;
        }
      }

      request.on('response', (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            if (settled) return;
            settled = true;
            idle.clear();
            file.close();
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            // 重定向沿用 isRetry（不消耗镜像名额），但重置 settled 由新一轮 Promise 接管
            this.downloadWithHardening(
              Array.isArray(redirectUrl) ? redirectUrl[0] : redirectUrl,
              destPath,
              totalSize,
              isRetry,
              cb,
              ctl
            )
              .then(resolve)
              .catch(reject);
            return;
          }
        }

        if (response.statusCode !== 200) {
          if (settled) return;
          settled = true;
          idle.clear();
          file.close();
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          reject(new Error(`下载失败: HTTP ${response.statusCode}`));
          return;
        }

        // ② 完整性校验基准：响应头 content-length 优先，缺失回落调用方 totalSize。
        expectedBytes = parseExpectedBytes(response.headers['content-length'], totalSize);

        response.on('data', (chunk) => {
          idle.arm(); // 每收到数据重置停滞计时
          downloadedBytes += chunk.length;
          cb.onProgress(downloadedBytes, totalSize);
          // ③ 背压：写盘返回 false（缓冲已满）时暂停接收，drain 后恢复，防大文件下内存堆积。
          // Electron 的 IncomingMessage TS 类型未暴露 pause/resume（运行时是可读流，确有这两方法）→ 窄化断言。
          if (!file.write(chunk)) {
            const pausable = response as unknown as {
              pause: () => void;
              resume: () => void;
            };
            pausable.pause();
            file.once('drain', () => pausable.resume());
          }
        });

        response.on('end', () => {
          idle.clear();
          file.end(() => {
            if (settled) return;
            // ② 截断校验：实收字节与期望不符 → reject（github 链接经 handleError 自动换镜像重试一次）。
            if (!isNaN(expectedBytes) && downloadedBytes !== expectedBytes) {
              handleError(
                new Error(
                  `下载不完整：收到 ${downloadedBytes} 字节，期望 ${expectedBytes}（可能被截断）`
                )
              );
              return;
            }
            settled = true;
            resolve();
          });
        });

        response.on('error', handleError);
      });

      request.on('error', handleError);

      idle.arm(); // 连接阶段也启动停滞计时（连接挂起 30s 超时）
      request.end();
    });
  }

  private updateProgress(progress: UpdateProgress): void {
    this.downloadProgress = progress;
    // 发送进度到渲染进程
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC_CHANNELS.EVENT_UPDATE_PROGRESS, progress);
    }
  }

  private loadSkippedVersion(): void {
    try {
      // 使用统一的路径工具，确保始终使用正确的用户数据路径
      const configPath = path.join(getUserDataPath(), 'skipped_version.txt');
      if (fs.existsSync(configPath)) {
        this.skippedVersion = fs.readFileSync(configPath, 'utf-8').trim();
      }
    } catch {
      // 忽略错误
    }
  }

  private saveSkippedVersion(): void {
    try {
      // 使用统一的路径工具，确保始终使用正确的用户数据路径
      const configPath = path.join(getUserDataPath(), 'skipped_version.txt');
      if (this.skippedVersion) {
        fs.writeFileSync(configPath, this.skippedVersion);
      } else if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
      }
    } catch {
      // 忽略错误
    }
  }
}
