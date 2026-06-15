/**
 * win-system32 单测（纯函数、无 FS/无进程）：验证 System32 二进制绝对路径解析与
 * command-not-found 判定。这是「部分设备系统代理设置失败：'reg' 不是内部或外部命令」修复的核心——
 * 用 System32 绝对路径调 reg/netsh/ipconfig/taskkill 等，规避进程 PATH 缺失 C:\Windows\System32。
 *
 * 用 path.win32 + 注入 env，输出与测试宿主 OS 无关（Linux gate 上亦得 Windows 反斜杠路径）。
 * 注意：真机层「绝对路径下 reg.exe 确能被找到并设置代理」需 Windows（含 PATH 破损态）实测，不在此测。
 */
import { getSystemRoot, system32, powershellPath, isCommandNotFoundError } from '../win-system32';

describe('getSystemRoot（%SystemRoot% 解析与兜底）', () => {
  it('优先取 SystemRoot', () => {
    expect(getSystemRoot({ SystemRoot: 'C:\\Windows', windir: 'D:\\X' })).toBe('C:\\Windows');
  });

  it('SystemRoot 缺失 → 回退 windir', () => {
    expect(getSystemRoot({ windir: 'D:\\WinDir' })).toBe('D:\\WinDir');
  });

  it('SystemRoot 与 windir 均缺失 → 回退 C:\\Windows', () => {
    expect(getSystemRoot({})).toBe('C:\\Windows');
  });
});

describe('system32（System32 二进制绝对路径）', () => {
  it('标准盘：reg.exe → C:\\Windows\\System32\\reg.exe', () => {
    expect(system32('reg.exe', { SystemRoot: 'C:\\Windows' })).toBe(
      'C:\\Windows\\System32\\reg.exe'
    );
  });

  it('非标准 SystemRoot（如 D:\\Win）也跟随', () => {
    expect(system32('netsh.exe', { SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\netsh.exe');
  });

  it('env 缺失时基于 C:\\Windows 兜底', () => {
    expect(system32('taskkill.exe', {})).toBe('C:\\Windows\\System32\\taskkill.exe');
  });

  it('始终输出反斜杠路径（host-OS 无关，Linux gate 亦然）', () => {
    const p = system32('ipconfig.exe', { SystemRoot: 'C:\\Windows' });
    expect(p).toContain('\\System32\\');
    expect(p).not.toContain('/');
  });
});

describe('powershellPath（PowerShell 绝对路径）', () => {
  it('指向 System32\\WindowsPowerShell\\v1.0\\powershell.exe', () => {
    expect(powershellPath({ SystemRoot: 'C:\\Windows' })).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    );
  });
});

describe('isCommandNotFoundError（命令未找到判定）', () => {
  it('ENOENT 错误码 → true', () => {
    const err = Object.assign(new Error('spawn reg ENOENT'), { code: 'ENOENT' });
    expect(isCommandNotFoundError(err)).toBe(true);
  });

  it('cmd 中文输出「不是内部或外部命令」→ true', () => {
    expect(
      isCommandNotFoundError(
        new Error("'reg' 不是内部或外部命令，也不是可运行的程序或批处理文件。")
      )
    ).toBe(true);
  });

  it('cmd 英文输出「is not recognized」→ true', () => {
    expect(
      isCommandNotFoundError(
        new Error("'reg' is not recognized as an internal or external command")
      )
    ).toBe(true);
  });

  it('POSIX「command not found」→ true', () => {
    expect(isCommandNotFoundError(new Error('reg: command not found'))).toBe(true);
  });

  it('cmd 退出码 9009（命令/路径未找到）→ true', () => {
    const err = Object.assign(new Error('Command failed'), { code: 9009 });
    expect(isCommandNotFoundError(err)).toBe(true);
  });

  it('绝对路径不存在「系统找不到指定的路径」→ true（SystemRoot 误判兜底）', () => {
    expect(isCommandNotFoundError(new Error('系统找不到指定的路径。'))).toBe(true);
  });

  it('英文「cannot find the path specified」→ true', () => {
    expect(isCommandNotFoundError(new Error('The system cannot find the path specified.'))).toBe(
      true
    );
  });

  it('权限错误（access denied）→ false（应交既有权限分支处理）', () => {
    expect(isCommandNotFoundError(new Error('Access is denied.'))).toBe(false);
  });

  it('无关错误 → false', () => {
    expect(isCommandNotFoundError(new Error('注册表访问被阻止'))).toBe(false);
  });

  it('非 Error 入参（字符串/undefined）不抛且判定正确', () => {
    expect(isCommandNotFoundError("'reg' 不是内部或外部命令")).toBe(true);
    expect(isCommandNotFoundError(undefined)).toBe(false);
    expect(isCommandNotFoundError(null)).toBe(false);
  });
});
