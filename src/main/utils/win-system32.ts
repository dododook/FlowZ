/**
 * Windows System32 二进制绝对路径解析。
 *
 * 根因：部分设备的进程 PATH 缺失 C:\Windows\System32——常见于注册表 Path 值类型
 * 从 REG_EXPAND_SZ 退化为 REG_SZ 致 %SystemRoot% 不被展开，或系统+用户 PATH 超长被截断
 * 丢失尾部条目。此时 cmd.exe（经 ComSpec 绝对路径仍能起）解析裸命令
 * reg / netsh / ipconfig / taskkill / tasklist / powershell 失败，cmd 报
 *「'reg' 不是内部或外部命令」。这并非权限问题。
 *
 * 对策：用 System32 绝对路径调用这些二进制，完全不依赖 PATH。
 * 纯函数（path.win32 + 可注入 env），可在非 Windows 平台单测。
 */
import { win32 as winPath } from 'path';

/** %SystemRoot%（windir 兜底，最终回落 C:\Windows）。注入 env 便于单测。 */
export function getSystemRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.SystemRoot || env.windir || 'C:\\Windows';
}

/**
 * 解析 System32 下的二进制为绝对路径（如 'reg.exe' → C:\Windows\System32\reg.exe）。
 * 始终用 path.win32 生成反斜杠路径，输出与测试宿主 OS 无关（Linux 下单测亦得 Windows 路径）。
 */
export function system32(binary: string, env: NodeJS.ProcessEnv = process.env): string {
  return winPath.join(getSystemRoot(env), 'System32', binary);
}

/** PowerShell 绝对路径（System32\WindowsPowerShell\v1.0\powershell.exe）。 */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  return winPath.join(
    getSystemRoot(env),
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
}

/**
 * 判定错误是否为「命令未找到」。绝对路径化后此类错误本应消失；保留作纵深防御，并用于：
 * 1) retry 跳过无意义重试（重试一个找不到的二进制不会变好）；
 * 2) 错误文案给出 PATH 相关诊断，而非误导用户去开管理员权限。
 * 覆盖 Windows cmd 本地化输出（中/英）、ENOENT、POSIX command not found。
 */
export function isCommandNotFoundError(error: unknown): boolean {
  // exec 失败时 code 可能是字符串（spawn 失败如 'ENOENT'）或数字（cmd 退出码）
  const code = (error as { code?: string | number } | undefined)?.code;
  if (code === 'ENOENT') return true;
  if (code === 9009) return true; // cmd 命令/路径未找到的退出码
  const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  return (
    message.includes('不是内部或外部命令') || // cmd zh-CN: 'X' 不是内部或外部命令（裸命令）
    message.includes('is not recognized') || // cmd en: 'X' is not recognized（裸命令）
    message.includes('command not found') || // POSIX shell
    message.includes('系统找不到指定的路径') || // cmd zh-CN: 绝对路径不存在（如 SystemRoot 误判）
    message.includes('cannot find the path') // cmd en: cannot find the path specified
  );
}
