/**
 * 重试工具函数
 * 用于处理临时性错误的自动重试
 */

export interface RetryOptions {
  maxRetries: number;

  /** 重试延迟（毫秒） */
  delay: number;

  exponentialBackoff?: boolean;

  shouldRetry?: (error: Error) => boolean;

  /** 重试前（sleep 延迟之前）调用。 */
  onRetry?: (error: Error, attempt: number) => void;
}

function defaultShouldRetry(error: Error): boolean {
  const message = error.message.toLowerCase();
  const errorCode = (error as NodeJS.ErrnoException).code;

  const temporaryErrors = [
    'timeout',
    'timed out',
    'econnrefused',
    'econnreset',
    'etimedout',
    'enetunreach',
    'ehostunreach',
    'enotfound',
    'temporary failure',
  ];

  if (errorCode && temporaryErrors.includes(errorCode.toLowerCase())) {
    return true;
  }

  return temporaryErrors.some((pattern) => message.includes(pattern));
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const {
    maxRetries = 3,
    delay = 1000,
    exponentialBackoff = true,
    shouldRetry = defaultShouldRetry,
    onRetry,
  } = options;

  let lastError: Error | null = null;

  // attempt 含初始尝试（0）与后续重试（1..maxRetries）
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt >= maxRetries) {
        throw lastError;
      }

      if (!shouldRetry(lastError)) {
        throw lastError;
      }

      const currentDelay = exponentialBackoff ? delay * Math.pow(2, attempt) : delay;

      if (onRetry) {
        onRetry(lastError, attempt + 1);
      }

      console.log(
        `操作失败，将在 ${currentDelay}ms 后进行第 ${attempt + 1} 次重试...`,
        lastError.message
      );

      await sleep(currentDelay);
    }
  }

  // 理论上不会到达这里，但为了类型安全
  throw lastError || new Error('重试失败');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
