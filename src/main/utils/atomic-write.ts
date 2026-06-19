/**
 * 原子写文件：写**唯一后缀** .tmp（默认 pid+随机）→ rename 替换正本 → 失败清理 .tmp。
 *
 * 唯一后缀杜绝多 writer（跨实例/并发写）写同一 .tmp 致字节交错损坏正本——各 writer 写各自临时文件，
 * rename 各自原子落地（同分区 POSIX rename 原子）。无 fsync → 断电 durability 为尽力而为（与现有
 * .srs/catalog/config 落盘同规范）。
 *
 * mode：传入时在 open(2) 即生效（umask 只清位不加位）→ tmp 从创建起就是该权限，绝不出现宽权限携密窗口；
 * 非 Windows 额外 chmod 双保险（兼容旧 fd 语义）。
 *
 * makeTmpSuffix：允许调用方定制 .tmp 前的后缀片段（默认 `<pid>.<rand6hex>`）。供 ConfigManager 保留其
 * `<rand6hex>` 后缀以匹配既有 sweepStaleTmpFiles 清扫正则（行为字节保持）。
 */
import * as fs from 'fs/promises';
import { randomBytes } from 'crypto';

export interface WriteFileAtomicOptions {
  /** 文件权限（如 0o600）；传入则 write 时即生效 + 非 Windows chmod 双保险。 */
  mode?: number;
  /** .tmp 前缀片段生成器（默认 `<pid>.<rand6hex>`）。 */
  makeTmpSuffix?: () => string;
}

const defaultTmpSuffix = (): string => `${process.pid}.${randomBytes(6).toString('hex')}`;

export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  opts?: WriteFileAtomicOptions
): Promise<void> {
  const suffix = (opts?.makeTmpSuffix ?? defaultTmpSuffix)();
  const tmp = `${filePath}.${suffix}.tmp`;
  try {
    await fs.writeFile(tmp, data, opts?.mode !== undefined ? { mode: opts.mode } : undefined);
    if (opts?.mode !== undefined && process.platform !== 'win32') {
      await fs.chmod(tmp, opts.mode);
    }
    await fs.rename(tmp, filePath);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {}); // 清理半写 tmp，避免脏文件堆积
    throw e;
  }
}
