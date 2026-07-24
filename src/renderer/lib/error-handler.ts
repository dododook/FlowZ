import { toast } from 'sonner';
import i18n from '../i18n';
import { ProxyErrorCode, isProxyErrorCode } from '../../shared/types';

export enum ErrorCategory {
  Config = 'Config',
  Connection = 'Connection',
  System = 'System',
  Process = 'Process',
  Unknown = 'Unknown',
}

export interface AppError {
  category: ErrorCategory;
  userMessage: string;
  technicalMessage?: string;
}

export class ErrorHandler {
  static handle(error: AppError): void {
    console.error(`[${error.category}] ${error.userMessage}`, error.technicalMessage);

    switch (error.category) {
      case ErrorCategory.Config:
        this.handleConfigError(error);
        break;
      case ErrorCategory.Connection:
        this.handleConnectionError(error);
        break;
      case ErrorCategory.System:
        this.handleSystemError(error);
        break;
      case ErrorCategory.Process:
        this.handleProcessError(error);
        break;
      default:
        this.handleUnknownError(error);
    }
  }

  static handleApiError(error: unknown, context: string): void {
    console.error(`API Error in ${context}:`, error);

    let userMessage = i18n.t('errors.operationFailed');
    let category = ErrorCategory.System;

    if (error instanceof Error) {
      userMessage = error.message || userMessage;
    } else if (typeof error === 'string') {
      userMessage = error;
    }

    if (this.isTrojanError(userMessage)) {
      category = ErrorCategory.Connection;
    } else if (this.isProtocolError(userMessage)) {
      category = ErrorCategory.Config;
    }

    this.handle({
      category,
      userMessage: `${context}: ${userMessage}`,
      technicalMessage: error instanceof Error ? error.stack : String(error),
    });
  }

  private static isTrojanError(message: string): boolean {
    const trojanKeywords = ['trojan', 'Trojan', '认证失败', '密码错误', 'TLS 握手失败'];
    return trojanKeywords.some((keyword) => message.includes(keyword));
  }

  private static isProtocolError(message: string): boolean {
    return (
      message.includes('不支持的协议') ||
      message.includes('Protocol') ||
      message.includes('暂不支持')
    );
  }

  static showSuccess(message: string): void {
    toast.success(message);
  }

  static showInfo(message: string): void {
    toast.info(message);
  }

  static showWarning(message: string): void {
    toast.warning(message);
  }

  static showError(message: string, description?: string): void {
    toast.error(message, {
      description,
    });
  }

  private static handleConfigError(error: AppError): void {
    this.showError(i18n.t('errors.configError'), error.userMessage);
  }

  private static handleConnectionError(error: AppError): void {
    this.showError(i18n.t('errors.connectionError'), error.userMessage);
  }

  private static handleSystemError(error: AppError): void {
    this.showError(i18n.t('errors.systemError'), error.userMessage);
  }

  private static handleProcessError(error: AppError): void {
    this.showError(i18n.t('errors.processError'), error.userMessage);
  }

  private static handleUnknownError(error: AppError): void {
    this.showError(i18n.t('errors.unknownError'), error.userMessage);
  }
}

/**
 * F15：代理错误码 → ErrorCategory 映射（跨进程分类的唯一依据）。
 * 非法/未知码返回 null，调用方回落到旧的中文字符串匹配 fallback。
 */
export function proxyErrorCategory(code: unknown): ErrorCategory | null {
  if (!isProxyErrorCode(code)) return null;
  switch (code) {
    case ProxyErrorCode.DEST_CONNECTION_REFUSED:
    case ProxyErrorCode.CONNECTION_REFUSED:
    case ProxyErrorCode.CONNECTION_TIMEOUT:
    case ProxyErrorCode.DNS_RESOLVE_FAILED:
    case ProxyErrorCode.TLS_CERT_ERROR:
    case ProxyErrorCode.AUTH_FAILED:
      return ErrorCategory.Connection;
    case ProxyErrorCode.CONFIG_INVALID:
    case ProxyErrorCode.PORT_IN_USE:
    case ProxyErrorCode.CLASH_API_PORT_RECYCLING:
      return ErrorCategory.Config;
    case ProxyErrorCode.PERMISSION_DENIED:
    case ProxyErrorCode.SYSTEM_PROXY_FAILED:
    case ProxyErrorCode.BINARY_NOT_EXECUTABLE:
    case ProxyErrorCode.BINARY_NOT_FOUND:
    case ProxyErrorCode.CRONET_LIB_MISSING:
    case ProxyErrorCode.TUN_INIT_PERSISTENT:
      return ErrorCategory.System;
    case ProxyErrorCode.STARTUP_FAILED:
    case ProxyErrorCode.PROCESS_KILLED:
    case ProxyErrorCode.PROCESS_EXITED:
    case ProxyErrorCode.AUTO_RESTARTING:
    case ProxyErrorCode.AUTO_RESTART_FAILED:
    case ProxyErrorCode.RESTART_LIMIT_REACHED:
    case ProxyErrorCode.STOP_AUTH_CANCELLED:
    case ProxyErrorCode.CORE_UPDATE_IN_PROGRESS:
      return ErrorCategory.Process;
    default:
      return null; // UNKNOWN
  }
}
