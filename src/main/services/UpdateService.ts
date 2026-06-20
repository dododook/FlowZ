/**
 * 更新检查服务
 * 通过 GitHub API 检查新版本并支持下载
 */

import { app, shell, BrowserWindow, dialog, net } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { LogManager } from './LogManager';
import type { UpdateInfo, UpdateCheckResult, UpdateProgress } from '../../shared/types/update';
import { APP_USER_AGENT } from '../../shared/constants';
import { getUserDataPath } from '../utils/paths';
import { system32 } from '../utils/win-system32';
import { compareSemver } from '../../shared/version';
import { ghMirrorUrl } from '../../shared/gh-proxy';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { createIdleTimeout, parseExpectedBytes } from './download-hardening';
import { findSuitableUpdateAsset } from './update-asset';
import {
  buildWindowsUpdateVbs,
  buildLinuxAppImageScript,
  buildMacUpdateScript,
  macAppBundleFromExe,
} from './update-install-script';

// 下载停滞超时：连接/下载 30s 无数据即视为卡死 → abort + 失败兜底（github 链接自动换镜像重试一次）。
// 防永久挂起致更新永不 resolve（进度窗/对话框永久转圈）。正常下载持续有 data、不断重置、不会误触发。
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

const GITHUB_OWNER = 'dododook';
const GITHUB_REPO = 'FlowZ';

export class UpdateService {
  private logManager: LogManager;
  private mainWindow: BrowserWindow | null = null;
  private progressWindow: BrowserWindow | null = null;
  private downloadProgress: UpdateProgress = {
    status: 'idle',
    percentage: 0,
    message: '',
  };
  private skippedVersion: string | null = null;
  private cleanupCallback: (() => Promise<void>) | null = null;

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
  async installUpdate(installerPath: string): Promise<boolean> {
    try {
      this.logManager.addLog('info', `准备安装更新: ${installerPath}`, 'UpdateService');

      // 检查文件是否存在
      if (!fs.existsSync(installerPath)) {
        this.logManager.addLog('error', `安装包不存在: ${installerPath}`, 'UpdateService');
        return false;
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
        this.logManager.addLog(
          'info',
          portableTarget ? '便携版：覆盖原 exe 原位更新' : 'NSIS：运行安装器原位升级',
          'UpdateService'
        );
        const vbsContent = buildWindowsUpdateVbs({ installerPath, portableTarget });

        fs.writeFileSync(vbsPath, vbsContent, 'utf-8');

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
        // deb(installed) → 交 dpkg/GUI 安装器原位升级（openPath，原行为）。
        const appImageTarget = process.env.APPIMAGE || null;
        if (appImageTarget && installerPath.endsWith('.AppImage')) {
          const { spawn } = require('child_process');
          const scriptPath = path.join(app.getPath('temp'), 'flowz_update.sh');
          const scriptContent = buildLinuxAppImageScript({ installerPath, appImageTarget });
          fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
          const child = spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' });
          child.unref();
          this.logManager.addLog('info', `AppImage 原位更新: ${appImageTarget}`, 'UpdateService');
        } else {
          await shell.openPath(installerPath);
          this.logManager.addLog('info', '安装程序已启动，正在退出应用...', 'UpdateService');
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
   * 显示更新对话框
   */
  async showUpdateDialog(updateInfo: UpdateInfo): Promise<'update' | 'later' | 'skip'> {
    if (!this.mainWindow) {
      return 'later';
    }

    const currentVersion = app.getVersion();
    // releaseNotes 按行截前 10 行（比定长 substring(0,500) 更整齐，避免半行截断撑乱 dialog）；完整日志走「查看更新日志」。
    const noteLines = (updateInfo.releaseNotes || '').split('\n');
    const notes = noteLines.slice(0, 10).join('\n');
    const notesSuffix = noteLines.length > 10 ? '\n…' : '';
    const result = await dialog.showMessageBox(this.mainWindow, {
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 ${updateInfo.version}`,
      detail: `当前版本: v${currentVersion}\n新版本: ${updateInfo.version}\n\n${notes}${notesSuffix}`,
      buttons: ['立即更新', '稍后提醒', '跳过此版本', '查看更新日志'],
      defaultId: 0,
      cancelId: 1,
    });

    switch (result.response) {
      case 0:
        return 'update';
      case 2:
        return 'skip';
      case 3:
        // 查看更新日志：打开 GitHub Releases 完整日志（复用 openReleasesPage，URL 用 GITHUB_OWNER/GITHUB_REPO 常量），
        // dialog 随之关闭按「稍后」处理（不更新、不跳过，下次检查再弹）。
        this.openReleasesPage();
        return 'later';
      default:
        return 'later';
    }
  }

  /**
   * 获取当前下载进度
   */
  getProgress(): UpdateProgress {
    return { ...this.downloadProgress };
  }

  /**
   * 创建下载进度窗口
   */
  private createProgressWindow(): BrowserWindow {
    // 如果已存在进度窗口，先关闭
    if (this.progressWindow && !this.progressWindow.isDestroyed()) {
      this.progressWindow.close();
    }

    const progressWindow = new BrowserWindow({
      width: 360,
      height: 100,
      resizable: false,
      minimizable: false,
      maximizable: false,
      closable: true,
      frame: false,
      transparent: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    // 加载进度页面 HTML
    const html = this.getProgressWindowHtml();
    progressWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    progressWindow.once('ready-to-show', () => {
      progressWindow.show();
    });

    progressWindow.on('closed', () => {
      this.progressWindow = null;
    });

    this.progressWindow = progressWindow;
    return progressWindow;
  }

  /**
   * 更新进度窗口
   */
  private updateProgressWindow(percentage: number, message: string): void {
    if (this.progressWindow && !this.progressWindow.isDestroyed()) {
      this.progressWindow.webContents
        .executeJavaScript(
          `
        document.getElementById('progress-bar').style.width = '${percentage}%';
        document.getElementById('progress-text').textContent = '${message}';
        document.getElementById('progress-percent').textContent = '${percentage}%';
      `
        )
        .catch(() => {
          // 忽略执行错误
        });
    }
  }

  /**
   * 关闭进度窗口
   */
  private closeProgressWindow(): void {
    if (this.progressWindow && !this.progressWindow.isDestroyed()) {
      this.progressWindow.close();
      this.progressWindow = null;
    }
  }

  /**
   * 获取进度窗口 HTML
   */
  private getProgressWindowHtml(): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: white;
      height: 100vh;
      padding: 24px;
      -webkit-app-region: drag;
    }
    .title {
      font-size: 16px;
      font-weight: 600;
      color: #1a1a2e;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .title svg {
      width: 20px;
      height: 20px;
      animation: bounce 1s infinite;
    }
    @keyframes bounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-4px); }
    }
    .progress-container {
      background: #e5e7eb;
      border-radius: 8px;
      height: 8px;
      overflow: hidden;
      margin-bottom: 12px;
    }
    .progress-bar {
      height: 100%;
      background: #3b82f6;
      border-radius: 8px;
      transition: width 0.3s ease;
      width: 0%;
    }
    .progress-info {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .progress-text {
      font-size: 13px;
      color: #6b7280;
    }
    .progress-percent {
      font-size: 14px;
      font-weight: 600;
      color: #3b82f6;
    }
  </style>
</head>
<body>
  <div class="title">
    <svg viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
    正在下载更新
  </div>
  <div class="progress-container">
    <div class="progress-bar" id="progress-bar"></div>
  </div>
  <div class="progress-info">
    <span class="progress-text" id="progress-text">准备下载...</span>
    <span class="progress-percent" id="progress-percent">0%</span>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * 带进度窗口的下载更新（用于托盘触发的更新）
   */
  async downloadUpdateWithProgress(updateInfo: UpdateInfo): Promise<string | null> {
    // 创建进度窗口
    this.createProgressWindow();
    this.updateProgressWindow(0, '准备下载...');

    try {
      this.logManager.addLog('info', `开始下载更新: ${updateInfo.version}`, 'UpdateService');

      const downloadDir = app.getPath('temp');
      const filePath = path.join(downloadDir, updateInfo.fileName);

      // 如果文件已存在，先删除
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      await this.downloadFileWithProgressWindow(
        updateInfo.downloadUrl,
        filePath,
        updateInfo.fileSize
      );

      this.logManager.addLog('info', `更新下载完成: ${filePath}`, 'UpdateService');
      this.updateProgressWindow(100, '下载完成');

      // 延迟关闭进度窗口
      setTimeout(() => {
        this.closeProgressWindow();
      }, 500);

      return filePath;
    } catch (error: any) {
      const errorMessage = error?.message || '下载更新失败';
      this.logManager.addLog('error', `下载更新失败: ${errorMessage}`, 'UpdateService');
      this.closeProgressWindow();

      // 显示错误对话框
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        dialog.showMessageBox(this.mainWindow, {
          type: 'error',
          title: '下载失败',
          message: '更新下载失败',
          detail: errorMessage,
          buttons: ['确定'],
        });
      }

      return null;
    }
  }

  // ========== 私有方法 ==========

  private async fetchReleases(): Promise<any[]> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const request = net.request({
        method: 'GET',
        url: `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
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
        res.on('data', (chunk) => (data += chunk.toString()));
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

  private async downloadFile(
    url: string,
    destPath: string,
    totalSize: number,
    isRetry = false
  ): Promise<void> {
    return this.downloadWithHardening(url, destPath, totalSize, isRetry, {
      onMirror: () =>
        this.updateProgress({
          status: 'downloading',
          percentage: 0,
          message: '正在尝试通过镜像下载...',
        }),
      onProgress: (downloaded, total) => {
        if (total > 0) {
          const percentage = Math.round((downloaded / total) * 100);
          this.updateProgress({
            status: 'downloading',
            percentage,
            message: `正在下载更新... ${percentage}%`,
          });
        }
      },
    });
  }

  private async downloadFileWithProgressWindow(
    url: string,
    destPath: string,
    totalSize: number,
    isRetry = false
  ): Promise<void> {
    return this.downloadWithHardening(url, destPath, totalSize, isRetry, {
      onMirror: () => this.updateProgressWindow(0, '正在尝试通过镜像下载...'),
      onProgress: (downloaded, total) => {
        if (total > 0) {
          const percentage = Math.round((downloaded / total) * 100);
          const downloadedMB = (downloaded / 1024 / 1024).toFixed(1);
          const totalMB = (total / 1024 / 1024).toFixed(1);
          this.updateProgressWindow(percentage, `${downloadedMB} MB / ${totalMB} MB`);
        }
      },
    });
  }

  /**
   * App 安装包下载的共享实现：两个进度展现（主窗进度 / 独立进度窗）仅 onProgress/onMirror 回调不同，主体复用。
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
    }
  ): Promise<void> {
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

        if (!isRetry && url.includes('github.com')) {
          this.logManager.addLog(
            'warn',
            `下载出错，尝试使用加速镜像: ${err.message}`,
            'UpdateService'
          );
          cb.onMirror();
          const mirrorUrl = ghMirrorUrl(url);
          this.downloadWithHardening(mirrorUrl, destPath, totalSize, true, cb)
            .then(resolve)
            .catch(reject);
          return;
        }
        reject(err);
      };

      const request = net.request({
        url: url,
        method: 'GET',
      });
      request.setHeader('User-Agent', APP_USER_AGENT);

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
              cb
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
