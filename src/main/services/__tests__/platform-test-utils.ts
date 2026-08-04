/**
 * 平台敏感单测共享夹具：pin `process.platform` 后恢复原值。
 * config-gen 多处按 process.platform 分支（TUN 栈/排除段/日志 output 路径），共享避免各 *.test.ts 重复定义。
 *
 * 提供两种形态，按被测代码的取值时机选：
 *  - **包裹式** `withPlatform` / `withPlatformAsync` —— 平台只在这段调用期间生效，作用域自闭；
 *  - **命令式** `setPlatform` + `restorePlatform` —— 整个 suite 同一平台，或**构造函数会快照
 *    `process.platform`**（如 ResourceManager）必须先 pin 再 `new` 的场景。这类测试套不进回调形态。
 */

/** 本进程真实平台，在任何 mock 之前捕获（本模块在测试文件 import 时即求值）。 */
export const REAL_PLATFORM: NodeJS.Platform = process.platform;

/** 命令式 pin。**调用方须自行在 afterEach 调 restorePlatform()**，否则污染同进程其他 suite。 */
export function setPlatform(plat: NodeJS.Platform | string): void {
  Object.defineProperty(process, 'platform', { value: plat, configurable: true });
}

/** 还原为 REAL_PLATFORM。惯用法：`afterEach(restorePlatform)`。 */
export function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true });
}

/**
 * 包裹式（同步）。**fn 必须是同步的**——传 async fn 会在 promise 兑现【之前】就走到 finally 还原平台，
 * 被测异步代码读到的是宿主真实平台，测试在本地绿、CI 换平台即挂。异步用 withPlatformAsync。
 */
export function withPlatform<T>(plat: NodeJS.Platform, fn: () => T): T {
  const orig = process.platform;
  Object.defineProperty(process, 'platform', { value: plat, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: orig, configurable: true });
  }
}

/** 包裹式（异步）：await 完 fn 再还原，覆盖 withPlatform 提前还原的缺口。 */
export async function withPlatformAsync<T>(
  plat: NodeJS.Platform,
  fn: () => Promise<T>
): Promise<T> {
  const orig = process.platform;
  Object.defineProperty(process, 'platform', { value: plat, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: orig, configurable: true });
  }
}
