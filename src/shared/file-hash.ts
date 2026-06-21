/**
 * 文件 sha256 单一真值：HelperManager（内核 install-core 校验主二进制）与 ResourceManager
 * （libcronet 自愈强校验冷路径）共用同一实现，杜绝两份各算各的散落（统一摘要算法/读法）。
 *
 * 同步读整文件再哈希——调用方仅在「冷路径/install 这类低频时机」用（非每次启动热路径），
 * sing-box/libcronet ~10MB 级，一次性读可接受；热路径完整性判据走 size 快筛，不进此函数。
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

/** 计算文件内容的 sha256（hex）。同步读整文件——仅冷路径/低频校验调用。 */
export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}
