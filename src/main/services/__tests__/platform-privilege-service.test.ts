/**
 * PlatformPrivilegeService 平台差异单测（T16）。
 *
 * 覆盖三平台（darwin/win32/linux）× 三个公开方法：
 *   - needsPrivilege() / needsElevation()：TUN 模式才需提权；平台决定 osascript/uac/pkexec/none。
 *   - buildElevatedLaunchCommand(paths)：darwin→osascript + 'with administrator privileges'；
 *     win32→powershell.exe + Start-Process -Verb RunAs；linux→兜底直起（不进提权分支）。
 *   - generateWatchdogScript()：darwin→bash wrapper（含 stopflag 轮询/父进程存活/TERM→KILL）；
 *     win32→PowerShell .ps1（含 param/Start-Process -Verb RunAs/Stop-Process）。
 *
 * 关键工程点：
 *   1. process.platform 跨测试 mock 后须 afterEach 还原（防污染同进程其他 suite）。
 *   2. 构造仅需 PrivilegeContext mock + helperManager=null（提权决策/命令组装/脚本生成不依赖 helper）。
 *   3. generateWatchdogScript 写真实文件到 getUserDataPath()（已 mock electron → TMP），验返回值 + 读回脚本内容关键字面。
 *   4. buildElevatedLaunchCommand 只验返回值 {command,args} 字面，绝不 spawn（无副作用）。
 */
const os = require('os');
const path = require('path');
const fsSync = require('fs');

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-priv-test-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import {
  PlatformPrivilegeService,
  PrivilegeContext,
  ElevatedLaunchPaths,
  windowsWatchdogScriptText,
} from '../PlatformPrivilegeService';
import type { LogLevel } from '../../../shared/types';
import { powershellPath } from '../../utils/win-system32';
import { setPlatform, restorePlatform } from './platform-test-utils';

afterAll(() => {
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// process.platform mock 走共享夹具（mock 后须还原，防污染同进程其他 suite）。
afterEach(restorePlatform);

// --- PrivilegeContext mock ---------------------------------------------------------
// isTunMode 可控（其余回调提权决策路径用不到，给 noop 占位避免 undefined 调用报错）。

function makeCtx(isTun: boolean): PrivilegeContext {
  return {
    log: ((_level: LogLevel, _msg: string) => {}) as PrivilegeContext['log'],
    isTunMode: () => isTun,
    isInteractive: () => true,
    configPath: () => '/fake/config.json',
    singboxPath: () => '/fake/sing-box',
    currentManagedPid: () => null,
    isProcessAlive: () => false,
    waitForNetworkCleanup: async () => {},
    startedViaHelper: () => false,
    stopFlagPath: () => '/fake/stopflag',
    waitForProcessExit: async () => true,
    onStopAuthCancelled: () => {},
  };
}

function makeSvc(isTun: boolean) {
  return new PlatformPrivilegeService(makeCtx(isTun), null);
}

/** 完整 ElevatedLaunchPaths（各方法只取自己关心的字段，全填避免 undefined）。 */
function makePaths(): ElevatedLaunchPaths {
  return {
    singboxPath: '/app/sing-box',
    configPath: '/app/config.json',
    pidFile: '/app/sb.pid',
    startupLogFile: '/app/startup.log',
    watchdogLog: '/app/watchdog.log',
    stopFlag: '/app/stop.flag',
    wrapper: '/app/wrapper.sh',
    watchdog: 'C:\\app\\watchdog.ps1',
    parentPid: 12345,
    parentName: 'electron',
    fwd: '1',
  };
}

// ============================================================================
// 一、needsPrivilege / needsElevation（三平台 × tun/non-tun）
// ============================================================================

describe('PlatformPrivilegeService.needsPrivilege', () => {
  it('darwin + tun → true', () => {
    setPlatform('darwin');
    expect(makeSvc(true).needsPrivilege()).toBe(true);
  });

  it('win32 + tun → true', () => {
    setPlatform('win32');
    expect(makeSvc(true).needsPrivilege()).toBe(true);
  });

  it('linux + tun → true', () => {
    setPlatform('linux');
    expect(makeSvc(true).needsPrivilege()).toBe(true);
  });

  it('darwin + 非 tun（systemProxy）→ false', () => {
    setPlatform('darwin');
    expect(makeSvc(false).needsPrivilege()).toBe(false);
  });

  it('win32 + 非 tun → false', () => {
    setPlatform('win32');
    expect(makeSvc(false).needsPrivilege()).toBe(false);
  });

  it('linux + 非 tun → false', () => {
    setPlatform('linux');
    expect(makeSvc(false).needsPrivilege()).toBe(false);
  });
});

describe('PlatformPrivilegeService.needsElevation', () => {
  it('darwin + tun → osascript', () => {
    setPlatform('darwin');
    expect(makeSvc(true).needsElevation()).toBe('osascript');
  });

  it('win32 + tun → uac', () => {
    setPlatform('win32');
    expect(makeSvc(true).needsElevation()).toBe('uac');
  });

  it('linux + tun → pkexec', () => {
    setPlatform('linux');
    expect(makeSvc(true).needsElevation()).toBe('pkexec');
  });

  it('darwin + 非 tun → none', () => {
    setPlatform('darwin');
    expect(makeSvc(false).needsElevation()).toBe('none');
  });

  it('win32 + 非 tun → none', () => {
    setPlatform('win32');
    expect(makeSvc(false).needsElevation()).toBe('none');
  });

  it('linux + 非 tun → none', () => {
    setPlatform('linux');
    expect(makeSvc(false).needsElevation()).toBe('none');
  });
});

// ============================================================================
// 二、buildElevatedLaunchCommand（三平台，只验返回值字面，不 spawn）
// ============================================================================

describe('PlatformPrivilegeService.buildElevatedLaunchCommand', () => {
  it('darwin → osascript + "with administrator privileges" + wrapper 命令链', () => {
    setPlatform('darwin');
    const svc = makeSvc(true);
    const paths = makePaths();
    const { command, args } = svc.buildElevatedLaunchCommand(paths);
    expect(command).toBe('/usr/bin/osascript');
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-e');
    // 关键字面：do shell script + with administrator privileges + wrapper/singbox/config 路径链
    const script = args[1] as string;
    expect(script).toContain('do shell script');
    expect(script).toContain('with administrator privileges');
    expect(script).toContain(paths.wrapper);
    expect(script).toContain(paths.singboxPath);
    expect(script).toContain(paths.configPath);
    expect(script).toContain(paths.pidFile);
    expect(script).toContain(paths.stopFlag);
    expect(script).toContain(String(paths.parentPid));
    expect(script).toContain(paths.fwd);
  });

  it('win32 → powershell.exe + Start-Process -Verb RunAs + watchdog -File 链', () => {
    setPlatform('win32');
    const svc = makeSvc(true);
    const paths = makePaths();
    const { command, args } = svc.buildElevatedLaunchCommand(paths);
    // 绝对路径调 PowerShell（规避 PATH 缺 System32），不再裸 'powershell.exe'
    expect(command).toBe(powershellPath());
    expect(args[0]).toBe('-NoProfile');
    expect(args[1]).toBe('-ExecutionPolicy');
    expect(args[2]).toBe('Bypass');
    expect(args[3]).toBe('-Command');
    const psScript = args[4] as string;
    // 关键字面：Start-Process -Verb RunAs + watchdog 路径经 -File 传入
    expect(psScript).toContain('Start-Process');
    expect(psScript).toContain('-Verb RunAs');
    expect(psScript).toContain(paths.watchdog);
    expect(psScript).toContain(paths.singboxPath);
    expect(psScript).toContain(paths.configPath);
    expect(psScript).toContain(paths.parentName);
  });

  it('linux → 兜底直起 sing-box run -c config（非 macOS/Win 不进提权分支）', () => {
    setPlatform('linux');
    const svc = makeSvc(true);
    const paths = makePaths();
    const { command, args } = svc.buildElevatedLaunchCommand(paths);
    expect(command).toBe(paths.singboxPath);
    expect(args).toEqual(['run', '-c', paths.configPath]);
  });
});

// ============================================================================
// 三、generateWatchdogScript（darwin/win32，验返回值 + 读回脚本内容关键字面）
// ============================================================================

describe('PlatformPrivilegeService.generateWatchdogScript', () => {
  it('darwin → bash wrapper：isWindows=false + 路径 singbox-wrapper.sh + 脚本含 stopflag 轮询/父进程存活/TERM→KILL', () => {
    setPlatform('darwin');
    const svc = makeSvc(true);
    const result = svc.generateWatchdogScript();
    expect(result.isWindows).toBe(false);
    expect(result.path).toBe(path.join(TMP, 'singbox-wrapper.sh'));
    // 文件真实写出
    expect(fsSync.existsSync(result.path)).toBe(true);
    const script = fsSync.readFileSync(result.path, 'utf8');
    // shebang + 关键看护逻辑字面
    expect(script.startsWith('#!/bin/bash')).toBe(true);
    expect(script).toContain('STOPFLAG'); // stopflag 检测
    expect(script).toContain('PARENT'); // 父进程存活校验
    expect(script).toContain('kill -0 "$PARENT"'); // 父进程存活轮询
    expect(script).toContain('kill -TERM "$SBPID"'); // 优雅停
    expect(script).toContain('kill -9 "$SBPID"'); // 强杀兜底
    expect(script).toContain('sleep 0.5'); // 轮询间隔
    // IP 转发开启分支（fwd=1）
    expect(script).toContain('net.inet.ip.forwarding');
  });

  it('win32 → PowerShell .ps1：isWindows=true + 路径 flowz-win-watchdog.ps1 + 脚本含 param/Start-Process/Stop-Process', () => {
    setPlatform('win32');
    const svc = makeSvc(true);
    const result = svc.generateWatchdogScript();
    expect(result.isWindows).toBe(true);
    expect(result.path).toBe(path.join(TMP, 'flowz-win-watchdog.ps1'));
    expect(fsSync.existsSync(result.path)).toBe(true);
    const script = fsSync.readFileSync(result.path, 'utf8');
    // Mandatory 参数声明
    expect(script).toContain('[Parameter(Mandatory = $true)][string]$SbPath');
    expect(script).toContain('[Parameter(Mandatory = $true)][int]$ParentPid');
    expect(script).toContain('[Parameter(Mandatory = $true)][string]$ParentName');
    // 启动 sing-box
    expect(script).toContain('Start-Process -FilePath $SbPath');
    expect(script).toContain('-WindowStyle Hidden');
    // 看护循环：进程名校验 + stopflag + 父进程名校验（防 PID 复用）
    expect(script).toContain("$sb.ProcessName -ne 'sing-box'");
    expect(script).toContain('Test-Path -LiteralPath $StopFlag');
    expect(script).toContain('$parent.ProcessName -ne $ParentName');
    // 强停兜底
    expect(script).toContain('Stop-Process -Id $sbId -Force');
  });
});

// ============================================================================
// 六、Windows 看护脚本正文 × 提权参数链（issue #324：核 stderr 必须落盘）
// ============================================================================

describe('windowsWatchdogScriptText — 核 stderr 落盘与文件分工', () => {
  const script = windowsWatchdogScriptText();

  it('脚本正文必须是纯 ASCII（PowerShell 5.1 按 ANSI 解码无 BOM 文件，非 ASCII 会破坏语法）', () => {
    // 真机实测：脚本里放中文注释 → `fs.writeFileSync` 写出 UTF-8 无 BOM → PowerShell 5.1 按 GBK 解码，
    // 多字节序列被拆出反引号/引号 → ParserError「表达式或语句中包含意外的标记」→ 看护脚本根本不启动，
    // 核也就永远起不来。这条本地跑不出来（Linux/Node 读 UTF-8 一切正常），只有真机会暴露。
    const offenders = [...script].filter((ch) => ch.charCodeAt(0) > 127);
    expect(offenders).toEqual([]);
  });

  it('Start-Process 重定向 sing-box 的 stderr 到 $LogFile', () => {
    // sing-box 启动失败的 FATAL 只走 stderr，不进 config 的 log.output（Windows 真机实测：log.output
    // 文件里只有一行 "updated default interface"）。不重定向 = #324 的失败原因彻底丢失。
    expect(script).toMatch(/Start-Process[^\n]*-RedirectStandardError \$LogFile/);
  });

  it('不重定向 stdout：PowerShell 禁止两者指向同一路径（真机实测抛错）', () => {
    expect(script).not.toContain('-RedirectStandardOutput');
  });

  it('看护脚本自述行写 $WatchdogLog，不写 $LogFile（后者被重定向独占，真机实测写入报文件占用）', () => {
    expect(script).toMatch(/param\([\s\S]*\$WatchdogLog[\s\S]*\)/);
    expect(script).toMatch(/function Log[\s\S]*Out-File -FilePath \$WatchdogLog/);
    // 起始行也落看护日志，不能再写 $LogFile
    expect(script).toMatch(/'FlowZ watchdog starting\.\.\.' \| Out-File -FilePath \$WatchdogLog/);
    expect(script).not.toMatch(/Out-File -FilePath \$LogFile/);
  });

  it('脚本 param 个数与提权参数链长度一致（缺参会让看护脚本在隐藏窗口里挂起）', () => {
    setPlatform('win32');
    const svc = makeSvc(true);
    const { args } = svc.buildElevatedLaunchCommand(makePaths());
    const psScript = args[4] as string;

    // 脚本 param(...) 块里声明的参数个数
    const paramBlock = script.slice(
      script.indexOf('param('),
      script.indexOf(')\n$ErrorActionPreference')
    );
    // 只数形如 `[string]$Xxx` 的形参名——裸 `\$[A-Za-z]\w*` 会把 `Mandatory = $true` 里的 $true 也算进去
    const declared = (paramBlock.match(/\]\$[A-Za-z]\w*/g) ?? []).length;

    // -ArgumentList 里 '-File' 之后的元素：第一个是脚本自身路径，其余是传给 param 的实参
    // psScript 各行用 '; ' 拼接，-ArgumentList 链止于该行末尾的分号（fixture 路径不含分号）
    const afterFile = psScript.slice(psScript.indexOf("'-File'") + "'-File'".length);
    const argList = afterFile.slice(0, afterFile.indexOf(';'));
    const passed = argList.split(',').filter((x) => x.trim().length > 0).length - 1;

    expect(declared).toBeGreaterThan(0);
    expect(passed).toBe(declared);
  });

  it('提权参数链把 watchdogLog 传进去（顺序：startupLogFile → watchdogLog → fwd）', () => {
    setPlatform('win32');
    const svc = makeSvc(true);
    const paths = makePaths();
    const { args } = svc.buildElevatedLaunchCommand(paths);
    const psScript = args[4] as string;
    expect(psScript).toContain(paths.watchdogLog);
    expect(psScript.indexOf(paths.watchdogLog)).toBeGreaterThan(
      psScript.indexOf(paths.startupLogFile)
    );
    // UAC 发起失败的 ERROR 行也落看护日志（不污染归 stderr 独占的 startupLogFile）
    expect(psScript).toMatch(
      /ERROR launching watchdog[\s\S]*Out-File -FilePath '[^']*watchdog\.log'/
    );
  });
});
