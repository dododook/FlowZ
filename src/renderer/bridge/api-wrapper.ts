/**
 * API wrapper - 适配层
 * 将 Electron IPC API 适配为原 WPF 项目的 API 接口
 */

import { api } from '../ipc/api-client';
import { ErrorHandler } from '../lib/error-handler';
import i18n from '../i18n';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { SubscriptionPreviewResult } from '../../shared/subscription-preview';
import type { ApiResponse, ServerConfig, SubscriptionConfig } from './types';

/**
 * Logging APIs
 */
export async function getLogs(count?: number): Promise<ApiResponse<any[]>> {
  try {
    const logs = await api.logs.get(count);
    return { success: true, data: logs };
  } catch (error: any) {
    return { success: false, error: error?.message };
  }
}

export async function clearLogs(): Promise<ApiResponse<void>> {
  try {
    await api.logs.clear();
    ErrorHandler.showSuccess(i18n.t('apiToast.logsCleared'));
    return { success: true };
  } catch (error: any) {
    ErrorHandler.handleApiError(error, i18n.t('apiToast.clearLogs'));
    return { success: false, error: error?.message };
  }
}

/**
 * Version Information APIs
 */
export async function getVersionInfo(): Promise<
  ApiResponse<{
    appVersion: string;
    appName: string;
    buildDate: string;
    singBoxVersion: string;
    copyright: string;
    repositoryUrl: string;
    platform: string;
    arch: string;
    osVersion: string;
  }>
> {
  try {
    const data = await api.version.getInfo();
    return { success: true, data };
  } catch (error: any) {
    return { success: false, error: error?.message };
  }
}

/**
 * Shell APIs
 */
export async function openExternal(url: string): Promise<ApiResponse<boolean>> {
  try {
    // registerIpcHandler 包装 handler：成功返 {success:true,data}，抛错返 {success:false,error}。
    // 原代码忽略此 envelope 恒返 success:true，掩盖打开失败（点链接无反应却无任何提示）。检查真实结果。
    const result = await window.electron.ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, url);
    if (result?.success) {
      return { success: true, data: true };
    }
    ErrorHandler.showError(i18n.t('apiToast.openExternalFailed', { error: result?.error ?? '' }));
    return { success: false, error: result?.error };
  } catch (error: any) {
    ErrorHandler.showError(i18n.t('apiToast.openExternalFailed', { error: error?.message ?? '' }));
    return { success: false, error: error?.message };
  }
}

/**
 * Share URL APIs
 */
export async function generateShareUrl(server: ServerConfig): Promise<ApiResponse<string>> {
  try {
    const url = await api.server.generateUrl(server);
    return { success: true, data: url };
  } catch (error: any) {
    ErrorHandler.handleApiError(error, i18n.t('apiToast.generateShareUrl'));
    return { success: false, error: error?.message };
  }
}

/**
 * Update Management APIs
 */
export async function checkForUpdates(): Promise<
  ApiResponse<{
    hasUpdate: boolean;
    updateInfo?: {
      version: string;
      title: string;
      releaseNotes: string;
      downloadUrl: string;
      fileSize: number;
      publishedAt: string;
      isPrerelease: boolean;
      fileName: string;
    };
  }>
> {
  try {
    const result = await api.update.check();
    return { success: true, data: result };
  } catch (error: any) {
    return { success: false, error: error?.message };
  }
}

export async function downloadUpdate(updateInfo: any): Promise<ApiResponse<string>> {
  try {
    const result = await api.update.download(updateInfo);
    if (result.success && result.filePath) {
      return { success: true, data: result.filePath };
    }
    return { success: false, error: result.error || i18n.t('apiToast.downloadFailed') };
  } catch (error: any) {
    return { success: false, error: error?.message };
  }
}

export async function installUpdate(filePath: string): Promise<ApiResponse<void>> {
  try {
    const result = await api.update.install(filePath);
    if (result.success) {
      return { success: true };
    }
    return { success: false, error: result.error || i18n.t('apiToast.installFailed') };
  } catch (error: any) {
    return { success: false, error: error?.message };
  }
}

/**
 * Check Core Update
 */
export async function checkCoreUpdate(): Promise<
  ApiResponse<{
    hasUpdate: boolean;
    currentVersion: string;
    latestVersion?: string;
    downloadUrl?: string;
    releaseNotes?: string;
    /** latestVersion 是否跨当前 minor 带（如 1.13.x→1.14.x）；true 时 UI 标注跨大版本风险。 */
    crossBand?: boolean;
    error?: string;
  }>
> {
  try {
    const result = await api.coreUpdate.check();
    return { success: true, data: result };
  } catch (error: any) {
    return { success: false, error: error?.message };
  }
}

/**
 * Update Core
 */
export async function updateCore(downloadUrl: string): Promise<ApiResponse<boolean>> {
  try {
    const success = await api.coreUpdate.update(downloadUrl);
    return { success, data: success };
  } catch (error: any) {
    return { success: false, error: error?.message };
  }
}

/**
 * Subscription Management APIs
 */
export async function addSubscription(
  subscription: Omit<SubscriptionConfig, 'id' | 'createdAt'>
): Promise<ApiResponse<any>> {
  try {
    const newSub = await api.subscription.add(subscription);
    ErrorHandler.showSuccess(i18n.t('apiToast.subAdded'));
    return { success: true, data: newSub };
  } catch (error: any) {
    ErrorHandler.handleApiError(error, i18n.t('apiToast.addSub'));
    return { success: false, error: error?.message };
  }
}

export async function updateSubscription(subscription: any): Promise<ApiResponse<void>> {
  try {
    await api.subscription.update(subscription);
    ErrorHandler.showSuccess(i18n.t('apiToast.subUpdated'));
    return { success: true };
  } catch (error: any) {
    ErrorHandler.handleApiError(error, i18n.t('apiToast.updateSub'));
    return { success: false, error: error?.message };
  }
}

export async function deleteSubscription(subscriptionId: string): Promise<ApiResponse<void>> {
  try {
    await api.subscription.delete(subscriptionId);
    ErrorHandler.showSuccess(i18n.t('apiToast.subDeleted'));
    return { success: true };
  } catch (error: any) {
    ErrorHandler.handleApiError(error, i18n.t('apiToast.deleteSub'));
    return { success: false, error: error?.message };
  }
}

export async function updateSubscriptionServers(subscriptionId: string): Promise<
  ApiResponse<{
    addedServers: number;
    updatedServers: number;
    deletedServers: number;
  }>
> {
  try {
    const result = await api.subscription.updateServers(subscriptionId);
    if (result.success) {
      ErrorHandler.showSuccess(
        i18n.t('apiToast.subServersUpdated', {
          added: result.addedServers,
          updated: result.updatedServers,
          deleted: result.deletedServers,
        })
      );
      return { success: true, data: result };
    } else {
      ErrorHandler.showError(i18n.t('apiToast.subServersUpdateFailed', { error: result.error }));
      return { success: false, error: result.error };
    }
  } catch (error: any) {
    ErrorHandler.handleApiError(error, i18n.t('apiToast.updateSubServers'));
    return { success: false, error: error?.message };
  }
}

/**
 * 订阅预检（add 前先行，不写 config）：直接返回契约结果 SubscriptionPreviewResult（ok/errorKind/httpStatus）——
 * **不套 {success,data} 信封、不 toast**（错误文案由对话框按 errorKind 分类展示）。IPC 传输异常（预检本身不 throw）
 * → 兜底 unknown。
 */
export async function previewSubscription(
  url: string,
  opts: { viaProxy?: boolean; userAgent?: string }
): Promise<SubscriptionPreviewResult> {
  try {
    return await api.subscription.preview(url, opts);
  } catch (error: any) {
    return { ok: false, errorKind: 'unknown', message: error?.message };
  }
}

/**
 * Event listener functions
 */
/** 注册事件监听并返回 unsubscribe 清理函数（调用方 useEffect cleanup 必须调用，否则监听器泄漏）。 */
export function addEventListener(event: string, listener: (...args: any[]) => void): () => void {
  // 根据事件类型注册对应的监听器
  switch (event) {
    case 'proxyStarted':
      return api.proxy.onStarted(listener);
    case 'proxyStopped':
      return api.proxy.onStopped(listener);
    case 'proxyError':
      return api.proxy.onError(listener);
    case 'configChanged':
      return api.config.onChanged(listener);
    case 'logReceivedBatch':
      return api.logs.onReceivedBatch(listener);
    // 'statsUpdated' 已删（batch3 §3.7：stats 改 useStatsTopic('stats') 订阅，api.stats.onUpdated 随之移除；本 bridge 无该 case 消费者）。
    default:
      return () => {};
  }
}
