/**
 * API wrapper - 适配层
 * 将 Electron IPC API 适配为原 WPF 项目的 API 接口
 */

import { api } from '../ipc/api-client';
import { ErrorHandler } from '../lib/error-handler';
import i18n from '../i18n';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
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
    await window.electron.ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, url);
    return { success: true, data: true };
  } catch (error: any) {
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
    case 'statsUpdated':
      return api.stats.onUpdated(listener);
    default:
      return () => {};
  }
}
