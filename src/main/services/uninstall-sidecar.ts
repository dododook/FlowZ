/**
 * Windows 完全卸载的分离 sidecar 脚本生成（纯字符串，便于单测钉死命令/编码/分支；执行是真机项）。
 *
 * 背景（review H-1 同类潜伏 bug）：原 sidecar 把 userData/exeDir/uninstaller 等**含 Windows 用户名的路径内联进
 * .bat/.vbs**，且两者都 UTF-8 无 BOM 落盘——
 *  - `.vbs`（wscript）：只认 UTF-16 LE+BOM 为 Unicode，UTF-8 无 BOM 按 ANSI 读 → 非 ASCII 路径错乱。
 *  - `.bat`（cmd）：按系统 OEM 代码页（中文=GBK/936）读，UTF-8 内联的中文路径乱码 → rmdir/del 删错或失败。
 * → 中文 Windows 用户名账户卸载清理失败（残留 userData/本体）。
 *
 * 治本：**所有非 ASCII 路径走进程环境变量**（.vbs 设、cmd 子进程继承）——
 *  - `.vbs` 以 UTF-16 LE+BOM 落盘，`WshShell.Environment("PROCESS")` 设的值是 Unicode；
 *  - `.bat` 纯 ASCII（命令 + `%VAR%` + System32 绝对路径，全 ASCII），用 `%FLOWZ_*%` 引用，cmd 内置命令
 *    （rmdir/del/if exist）对环境变量的 Unicode 值按 Unicode 处理 → 中文路径正确。
 * .bat 不再出现任何非 ASCII 字面，彻底绕开 cmd 代码页与 .bat 文件编码问题。
 */

import * as path from 'path';

/** VBS 字符串字面量里的双引号双写转义（反斜杠在 VBS 字符串不转义，路径单反斜杠原样即可）。 */
const vq = (s: string): string => s.replace(/"/g, '""');

/**
 * 解析「卸载要清理的应用本体」exe/目录。
 *
 * 便携态陷阱：`app.getPath('exe')` 在 7z SFX 便携形态下是 **%TEMP%\FlowZ\FlowZ.exe**（SFX 解压副本、electron 子
 * 进程映像，stub 退出时本就自清），**不是**用户双击的原始 `Downloads\FlowZ.exe`。用户卸载后报「本体仍在」指的正是
 * 那个原始 exe——它在 `PORTABLE_EXECUTABLE_FILE`（同据 paths.ts 用 `PORTABLE_EXECUTABLE_DIR` 定位 userData=原始
 * 目录\data、UpdateService 用 `PORTABLE_EXECUTABLE_FILE` 作自更新覆盖目标）。故便携态优先取这两个 env；NSIS 安装态
 * 无此 env → 回落 `app.getPath('exe')`（即真实安装 exe）。win32 路径语义，故用 path.win32.dirname（跨平台测试一致）。
 */
export function resolveUninstallBody(
  env: { PORTABLE_EXECUTABLE_FILE?: string; PORTABLE_EXECUTABLE_DIR?: string },
  realExe: string
): { exePath: string; exeDir: string } {
  const exePath = env.PORTABLE_EXECUTABLE_FILE || realExe;
  const exeDir = env.PORTABLE_EXECUTABLE_DIR || path.win32.dirname(exePath);
  return { exePath, exeDir };
}

export interface UninstallSidecarOpts {
  flowzPid: number;
  userData: string;
  exeDir: string;
  exePath: string;
  /** 有 NSIS 卸载器时其路径；portable（无卸载器）为 null。 */
  uninstaller: string | null;
  /** portable 删本体方式：true=移出 exe 后 rmdir 整个安装目录（目录名含 flowz 的专属目录）；false=只移出 exe 自身。 */
  portableRmdir: boolean;
  /** portable 本体移出目标（%TEMP% 下的一次性文件名）：move 本体到此（同卷=rename，运行中亦可）。 */
  bodyTmpPath: string;
  batPath: string;
  vbsPath: string;
  /** System32 绝对路径（全 ASCII，由调用方 system32() 解析后传入）。 */
  sys: { cmd: string; tasklist: string; find: string; ping: string };
}

/** 删本体的三种模式：有卸载器走卸载器；portable 按目录专属性 rmdir / del。 */
type BodyMode = 'uninstaller' | 'rmdir' | 'del';

/** 生成卸载 sidecar 的 .bat（纯 ASCII，路径走 %VAR%）+ .vbs（UTF-16 落盘，设环境变量 Unicode 路径）。 */
export function buildUninstallSidecar(opts: UninstallSidecarOpts): { bat: string; vbs: string } {
  const bodyMode: BodyMode = opts.uninstaller
    ? 'uninstaller'
    : opts.portableRmdir
      ? 'rmdir'
      : 'del';

  // ── .bat：纯 ASCII，PID 轮询本进程退出（60×~1s 上限）→ 删 userData → 删本体 → 删 .vbs → 自删。
  // 所有路径走 %FLOWZ_*% 环境变量（.vbs 设 Unicode 值），.bat 内零非 ASCII 字面。
  const batLines: string[] = [
    '@echo off',
    `set "FLOWZ_PID=${opts.flowzPid}"`,
    'set "WAIT=0"',
    ':wait',
    `"${opts.sys.tasklist}" /fi "PID eq %FLOWZ_PID%" 2>nul | "${opts.sys.find}" "%FLOWZ_PID%" >nul || goto clean`,
    'set /a WAIT+=1',
    'if %WAIT% GEQ 60 goto clean',
    `"${opts.sys.ping}" 127.0.0.1 -n 2 >nul`,
    'goto wait',
    ':clean',
    'rmdir /s /q "%FLOWZ_USERDATA%"',
  ];
  if (bodyMode === 'uninstaller') {
    batLines.push('if exist "%FLOWZ_UNINSTALLER%" "%FLOWZ_UNINSTALLER%" /S');
  } else {
    // portable 本体（exe）= 便携 stub launcher 自身映像，进程存活期被锁：del 删不掉（实测 30×1s 重试仍残留，
    // stub 清 %TEMP% 期间持锁）。但映像以 FILE_SHARE_DELETE 打开 → **改名/移动可行**：move 等价 rename，同卷=纯
    // 元数据操作、运行中亦成（与 portable 自更新覆盖同机制，已真机验证）。故 move 本体到 %TEMP%：原位置（Downloads）
    // 即净，%TEMP% 残留随系统清理。跨卷 move 退化为复制+删源 → 删源撞运行锁失败、本体留原位 → 由退出前 Electron
    // dialog 提示手动删兜底（仅跨卷时弹，见 helper-handlers）。move 失败不阻断后续删 .vbs + 自删。
    batLines.push('move /y "%FLOWZ_EXE%" "%FLOWZ_BODYTMP%" >nul 2>nul');
    if (bodyMode === 'rmdir') {
      // 专属安装目录：exe 已移出 + userData(data\) 已删 → 删剩余目录（已无被锁文件）。
      batLines.push('rmdir /s /q "%FLOWZ_EXEDIR%"');
    }
  }
  batLines.push('del /f /q "%FLOWZ_VBS%"', 'del "%~f0"', '');

  // ── .vbs：设进程环境变量（含非 ASCII 路径，UTF-16 落盘后值为 Unicode）+ 隐藏启动 cmd /c bat。
  const vbsLines: string[] = [
    'Set s = CreateObject("WScript.Shell")',
    'Set e = s.Environment("PROCESS")',
    `e("FLOWZ_USERDATA") = "${vq(opts.userData)}"`,
    `e("FLOWZ_VBS") = "${vq(opts.vbsPath)}"`,
  ];
  if (bodyMode === 'uninstaller') {
    vbsLines.push(`e("FLOWZ_UNINSTALLER") = "${vq(opts.uninstaller as string)}"`);
  } else {
    // portable 两态都 move exe → %TEMP%；rmdir 态额外删剩余安装目录。
    vbsLines.push(`e("FLOWZ_EXE") = "${vq(opts.exePath)}"`);
    vbsLines.push(`e("FLOWZ_BODYTMP") = "${vq(opts.bodyTmpPath)}"`);
    if (bodyMode === 'rmdir') {
      vbsLines.push(`e("FLOWZ_EXEDIR") = "${vq(opts.exeDir)}"`);
    }
  }
  // cmd / batPath 也可能含非 ASCII（batPath 在 %TEMP%\<用户名>）→ 但 .vbs 是 UTF-16，内联字面正确；
  // .Run 的 cmd 行用三引号容纳带空格路径（"" 即字面 "）。
  vbsLines.push(`s.Run """${vq(opts.sys.cmd)}"" /c ""${vq(opts.batPath)}""", 0, False`);

  return { bat: batLines.join('\r\n'), vbs: vbsLines.join('\r\n') + '\r\n' };
}
