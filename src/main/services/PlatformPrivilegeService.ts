/**
 * 平台提权服务（T16：从 ProxyManager/CoreUpdateService 抽离的 4 平台提权层）。
 *
 * 职责：纯函数 / 无状态的提权脚本生成、命令捕获、文件权限修复、提权复制 + 孤儿进程清理。
 * 已迁（子 commit 1）：纯函数/无状态方法。
 * 已迁（子 commit 2）：killOrphans 链（顶层分发 + Mac/Linux/Windows + escalateKillRootOrphans）。
 * 已迁（子 commit 3）：stopElevated（darwin: helper.stopCore→stopflag→osascript + win: stopflag→RunAs taskkill）。
 * 已迁（子 commit 4）：ensureCapabilities（Linux setcap+polkit）+ buildElevatedLaunchCommand（提权包装命令构造，不 spawn）+ generateWatchdogScript。
 * 已迁（子 commit 5）：needsPrivilege + needsElevation（needs* wrapper delegate，调用点零改动）。
 *
 * 不变量：
 * - 不持有进程句柄 / 不 spawn sing-box（提权包装命令构造在子 commit 4）。
 * - log 经 ctx.log 注入（与 ProxyManager.logToManager / CoreUpdateService.logManager.addLog 同形）。
 * - isTunMode 经 ctx.isTunMode 回调注入（替代原 ProxyManager.needsRootPrivilege 的隐式 currentConfig 读取）。
 * - isProcessAlive / waitForNetworkCleanup 经 ctx 回调注入（二者被 ProxyManager 多处依赖，留原处避免双向耦合）。
 * - helperManager 供 macOS 分支委托（helper 就绪时零提权 cleanup），DI 注入可 null。
 * - ROOT_ORPHAN_BLOCKED 文本判定原样保留（escalateKillRootOrphans 抛出的 Error message 内嵌
 *   `[ROOT_ORPHAN_BLOCKED]` + err.code='ROOT_ORPHAN_BLOCKED'，attemptAutoRestart 据此判终态，不可丢）。
 * - startInteractive 非交互保护经 ctx.isInteractive 注入（!isInteractive → throw ROOT_ORPHAN_BLOCKED，逻辑不变）。
 * - stopElevated 边界：收口提权停止动作（helper.stopCore / stopflag / osascript / RunAs taskkill），返回 {stopped}
 *   供调用方判终态。finishStop/cleanup/waitForProcessExit（进程状态管理）留 ProxyManager——wrapper 据返回值统一收尾。
 * - quitting 零弹框透传：service 内部跳过 osascript/UAC（退出语境残留交下次启动的 killOrphans 清扫）。
 * - forceKillOrReportCancelled 语义保留（取消授权不谎报已停止，M3）：service 只做「提权强杀 + 复核仍存活」返回
 *   {stopped:false}；「发 STOP_AUTH_CANCELLED 事件」这个跨层副作用由 ProxyManager stopElevated wrapper 承担（有 sendEventToRenderer）。
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { app } from 'electron';

import type { HelperManager } from './HelperManager';
import type { LogLevel } from '../../shared/types';
import {
  getUserDataPath,
  getCachePath,
  getSingBoxLogPath,
  getSingBoxPidPath,
} from '../utils/paths';
import { system32, powershellPath } from '../utils/win-system32';
import { shq } from '../utils/shell-quote';

/**
 * 提权服务依赖注入上下文。所有成员为只读回调——避免本服务直接访问 ProxyManager 内部状态。
 * - log/isTunMode：子 commit 1 引入（fixFilePermissions 用）。
 * - isInteractive/configPath/singboxPath/isProcessAlive/waitForNetworkCleanup：子 commit 2 引入（killOrphans 链用）。
 * - startedViaHelper/stopFlagPath/waitForProcessExit/onStopAuthCancelled：子 commit 3 引入（stopElevated 用）。
 */
export interface PrivilegeContext {
  /** 统一日志入口：ProxyManager 传 source='sing-box'，CoreUpdateService 传 'CoreUpdateService'。 */
  log: (level: LogLevel, message: string, source?: string) => void;
  /** 当前是否处于 TUN 模式（替代原 ProxyManager.needsRootPrivilege 的隐式 currentConfig 读取）。 */
  isTunMode: () => boolean;
  /** 本次 start 是否交互式（非交互=崩溃自动重启）：escalateKillRootOrphans 非交互时直接抛 ROOT_ORPHAN_BLOCKED（F10）。 */
  isInteractive: () => boolean;
  /** sing-box 配置文件路径（macOS 系统代理模式 pgrep 匹配 orphan 用）。 */
  configPath: () => string;
  /** sing-box 核心可执行路径（Linux pgrep 匹配 orphan 用）。 */
  singboxPath: () => string;
  /**
   * 当前正在管理的 sing-box PID（singboxPid || pid），用于排除避免误杀自己；null 表示无（启动前清理）。
   */
  currentManagedPid: () => number | null;
  /**
   * 进程存活判定（统一走系统命令，避免 Node.js process.kill(pid,0) 对特权进程不可靠）。
   * 进程状态判定留 ProxyManager（被 16 处依赖），经回调注入避免双向耦合。
   */
  isProcessAlive: (pid: number) => boolean;
  /** 等待 TUN 接口/路由表收敛（macOS TUN 清理后调用）。实现留 ProxyManager。 */
  waitForNetworkCleanup: () => Promise<void>;
  /**
   * 本次代理是否经 helper 启动（macOS stopElevated helper 分支判定：经 socket 让 root daemon 停核，零提权）。
   * 实现（读 startedViaHelper 私有状态）留 ProxyManager。
   */
  startedViaHelper: () => boolean;
  /** 停止信号文件路径（app 普通用户写入，root 看护脚本检测后自杀 sing-box —— 停止免再次提权）。 */
  stopFlagPath: () => string;
  /**
   * 等待进程退出（轮询 isProcessAlive，超时返回 false）。实现留 ProxyManager（被多处依赖）；
   * 超时分级（退出 3s / 普通 5-8s）由调用方经 timeout 参数传入。
   */
  waitForProcessExit: (pid: number, timeout: number) => Promise<boolean>;
  /**
   * 取消授权致进程仍活时的跨层副作用回调（子 commit 3）：原 ProxyManager.forceKillOrReportCancelled 内联的
   * sendEventToRenderer(STOP_AUTH_CANCELLED)。service 不持有 IPC 通道，经回调把「发非终态提示」交还 ProxyManager。
   * 调用时机：service.stopElevated 返回 {stopped:false} 且进程仍存活（取消授权未杀死）。
   */
  onStopAuthCancelled: () => void;
}

/**
 * 提权启动命令构造所需路径集合（子 commit 4）。由 ProxyManager startSingBoxProcess 提权分支组装后传入
 * buildElevatedLaunchCommand。所有路径均属 ProxyManager 生命周期状态（PID 文件/启动日志/看护脚本路径等），
 * service 不自算——仅包装成提权命令。
 */
export interface ElevatedLaunchPaths {
  /** sing-box 核心可执行路径。 */
  singboxPath: string;
  /** sing-box 配置文件路径。 */
  configPath: string;
  /** PID 文件路径（提权看护脚本写出，与 waitForPidFile 协议一致：ASCII、无换行）。 */
  pidFile: string;
  /** 启动日志文件路径（macOS/win 提权后台进程 stdout 无法捕获，经此文件 tail）。 */
  startupLogFile: string;
  /** 停止信号文件路径（app 普通用户写入，看护脚本检测后自杀 sing-box）。 */
  stopFlag: string;
  /** macOS root 看护脚本路径（osascript 以 root 执行）。 */
  wrapper: string;
  /** Windows 提权看护脚本路径（UAC PowerShell 以 -File 执行）。 */
  watchdog: string;
  /** Electron 主进程 PID：退出即让看护脚本联动停 sing-box，杜绝孤儿。 */
  parentPid: number;
  /** 父进程名（无扩展名，Windows 配合 PID 校验防 PID 复用误判）。 */
  parentName: string;
  /** 是否开启 IP 转发（allowLan）：'1' 开启，'0' 关闭。 */
  fwd: string;
}

/**
 * 提权脚本生成 / 提权文件操作的纯函数集合。constructor 注入 ctx + helperManager（DI）。
 */
export class PlatformPrivilegeService {
  constructor(
    private readonly ctx: PrivilegeContext,
    // macOS launchd daemon 管理器：killOrphanedProcessesMac 优先委托 helper.cleanup()（零提权），不可用回退 osascript。
    // 可 null（helper 未装）。
    private readonly helperManager: HelperManager | null
  ) {}

  // ─── 工具方法（迁自 ProxyManager；曾公开供 ProxyManager delegate，现仅 ensureCapabilities 内部用 → 收回 private）──

  /**
   * 运行命令并捕获 stdout（出错 reject）。用于 getcap 探测。
   * 迁自 ProxyManager.execCapture。
   */
  private execCapture(bin: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args);
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d) => {
        stdout += d.toString();
      });
      proc.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('exit', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `exit ${code}`));
      });
      proc.on('error', reject);
    });
  }

  /**
   * 以 pkexec(root) 跑 bash 脚本（弹一次密码框）。区分取消(126)/无认证代理(127)。
   * 迁自 ProxyManager.runPkexecScript。
   */
  private runPkexecScript(scriptPath: string): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const proc = spawn('/usr/bin/pkexec', ['/bin/bash', scriptPath]);
      let stderr = '';
      proc.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('exit', (code) => {
        if (code === 0) resolve({ success: true });
        else if (code === 126) resolve({ success: false, error: '授权被取消' });
        else if (code === 127)
          resolve({ success: false, error: '授权失败或系统缺少 polkit 认证代理' });
        else if (code === 3) resolve({ success: false, error: '系统缺少 setcap（libcap2-bin）' });
        else resolve({ success: false, error: stderr.trim() || `pkexec 退出码 ${code}` });
      });
      proc.on('error', (err) => resolve({ success: false, error: err.message }));
    });
  }

  /**
   * 生成 Linux TUN 提权脚本：setcap 赋权 + 安装限定用户的 resolve1 polkit 规则（含 0.105 .pkla 回退）。
   * 迁自 ProxyManager.buildLinuxTunSetupScript。
   */
  private buildLinuxTunSetupScript(corePath: string, user: string, rulesFile: string): string {
    // user 已经白名单校验（[a-z0-9_.@-]），可安全嵌入 heredoc 字面量
    return `#!/bin/bash
set -e
CORE=${shq(corePath)}
RULES=${shq(rulesFile)}
SETCAP="$(command -v setcap || echo /usr/sbin/setcap)"
# setcap 缺失（精简 Debian 无 libcap2-bin）→ 用退出码 3 区分于 pkexec 的 126/127（P3-1）
[ -x "$SETCAP" ] || { echo "setcap 未安装(libcap)" >&2; exit 3; }
"$SETCAP" 'cap_net_admin,cap_net_bind_service,cap_net_raw=+ep' "$CORE"
mkdir -p /etc/polkit-1/rules.d
cat > "$RULES" <<'EOF'
// FlowZ: 允许指定用户改 systemd-resolved 链路 DNS（TUN auto_route 免逐条密码框）。手动删除本文件即恢复默认。
polkit.addRule(function(action, subject) {
  if (action.id.indexOf("org.freedesktop.resolve1.") === 0 &&
      subject.user === "${user}" && subject.local && subject.active) {
    return polkit.Result.YES;
  }
});
EOF
# 0.105 .pkla 回退：只要 polkit localauthority 父目录在就建 50-local.d 并写（P3-2，放宽过严条件）
PKLA_DIR=/etc/polkit-1/localauthority/50-local.d
if [ -d /etc/polkit-1/localauthority ]; then
  mkdir -p "$PKLA_DIR"
  cat > "$PKLA_DIR/49-flowz-resolved.pkla" <<'EOF2'
[FlowZ resolved DNS]
Identity=unix-user:${user}
Action=org.freedesktop.resolve1.*
ResultActive=yes
EOF2
fi
echo flowz-linux-tun-setup-ok
`;
  }

  // ─── 看护脚本生成（迁自 ProxyManager.writeWrapperScript / writeWindowsWatchdogScript）────────

  /**
   * macOS root 看护脚本路径（osascript 以 root 执行它来托管 sing-box）。
   * 字面与 ProxyManager.getWrapperScriptPath 恒一致——本服务自算路径避免循环依赖，
   * ProxyManager.getWrapperScriptPath 留原处供 startSingBoxProcess 读取（调用点零改动）。
   */
  private getWrapperScriptPath(): string {
    return path.join(getUserDataPath(), 'singbox-wrapper.sh');
  }

  /**
   * 写出 macOS root 看护脚本。设计：osascript 一次授权后以 root 跑此脚本 → 它起 sing-box 并循环监听
   * stopflag(普通用户可写)与父进程(Electron)存活；二者任一触发即 TERM→(等待)→KILL sing-box 并清理。
   * 收益：停止/退出/崩溃回收均无需再次管理员授权（仅启动那一次）。app 退出时父进程消失 → 不留孤儿。
   * 迁自 ProxyManager.writeWrapperScript。
   */
  writeWrapperScript(): void {
    const script = `#!/bin/bash
# FlowZ 看护脚本（osascript 以 root 执行）；勿手改。
SB="$1"; CFG="$2"; LOG="$3"; PIDFILE="$4"; STOPFLAG="$5"; PARENT="$6"; FWD="$7"
if [ "$FWD" = "1" ]; then sysctl -w net.inet.ip.forwarding=1 >/dev/null 2>&1; sysctl -w net.inet6.ip6.forwarding=1 >/dev/null 2>&1; fi
"$SB" run -c "$CFG" > "$LOG" 2>&1 &
SBPID=$!
echo "$SBPID" > "$PIDFILE"
while kill -0 "$SBPID" 2>/dev/null; do
  [ -f "$STOPFLAG" ] && break
  kill -0 "$PARENT" 2>/dev/null || break
  sleep 0.5
done
kill -TERM "$SBPID" 2>/dev/null
for i in $(seq 1 10); do kill -0 "$SBPID" 2>/dev/null || break; sleep 0.5; done
kill -9 "$SBPID" 2>/dev/null
# 归还运行时目录属主给登录用户（根治跨提权态属主冲突）：root 跑的 sing-box 把 tailscale state /
# dashboard / ui 写成 root → 下次以登录用户跑读不了致 endpoint post-start FATAL。CONFDIR(=config 父目录)
# 属主即登录用户；本看护脚本以 root 跑、有权 chown。与 helper daemon 路径(helper.go chownRuntimeDirs)同口径。
CONFDIR=$(dirname "$CFG")
OWNER=$(stat -f %u "$CONFDIR" 2>/dev/null)
if [ -n "$OWNER" ] && [ "$OWNER" != "0" ]; then
  for d in tailscale singbox-dashboard ui; do chown -R "$OWNER" "$CONFDIR/$d" 2>/dev/null; done
fi
rm -f "$STOPFLAG"
`;
    require('fs').writeFileSync(this.getWrapperScriptPath(), script, { mode: 0o755 });
  }

  /**
   * Windows 提权看护脚本路径（UAC 提权的 PowerShell 以 -File 执行它来托管 sing-box）。
   * 字面与 ProxyManager.getWindowsWatchdogScriptPath 恒一致（同上避免循环依赖）。
   */
  private getWindowsWatchdogScriptPath(): string {
    return path.join(getUserDataPath(), 'flowz-win-watchdog.ps1');
  }

  /**
   * 迁自 ProxyManager.writeWindowsWatchdogScript。UAC 提权 PowerShell 以 -File 执行此脚本托管 sing-box。
   */
  writeWindowsWatchdogScript(): void {
    const script = `# FlowZ elevated watchdog (run by UAC-elevated PowerShell via -File). Do not edit manually.
param(
  [Parameter(Mandatory = $true)][string]$SbPath,
  [Parameter(Mandatory = $true)][string]$CfgPath,
  [Parameter(Mandatory = $true)][string]$PidFile,
  [Parameter(Mandatory = $true)][string]$StopFlag,
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$ParentName,
  [Parameter(Mandatory = $true)][string]$LogFile,
  [string]$Forward = '0'
)
$ErrorActionPreference = 'Continue'
function Log([string]$Msg) {
  try { ((Get-Date -Format 'HH:mm:ss') + ' [watchdog] ' + $Msg) | Out-File -FilePath $LogFile -Append -Encoding UTF8 } catch {}
}
try { 'FlowZ watchdog starting...' | Out-File -FilePath $LogFile -Encoding UTF8 } catch {}
if (-not (Test-Path -LiteralPath $SbPath)) { Log 'ERROR: sing-box not found'; exit 1 }
if (-not (Test-Path -LiteralPath $CfgPath)) { Log 'ERROR: config not found'; exit 1 }

# (a) sweep leftover sing-box started from OUR core path (reuses this elevation).
try {
  $orphans = @(Get-CimInstance Win32_Process -Filter "Name='sing-box.exe'" | Where-Object { $_.ExecutablePath -eq $SbPath })
  foreach ($o in $orphans) {
    Log ('Killing leftover sing-box PID ' + $o.ProcessId)
    Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($orphans.Count -gt 0) { Start-Sleep -Milliseconds 500 }
} catch { Log ('Orphan sweep failed: ' + $_.Exception.Message) }

if ($Forward -eq '1') {
  try {
    Set-NetIPInterface -Forwarding Enabled
    Set-NetIPInterface -AddressFamily IPv6 -Forwarding Enabled
    Log 'IP forwarding enabled'
  } catch { Log ('Enable IP forwarding failed: ' + $_.Exception.Message) }
}

# (b) start sing-box (already elevated, no inner RunAs); PID file protocol unchanged.
# Config path is explicitly quoted: -ArgumentList does NOT auto-quote elements with spaces.
try {
  $proc = Start-Process -FilePath $SbPath -ArgumentList 'run', '-c', ('"' + $CfgPath + '"') -PassThru -WindowStyle Hidden
} catch {
  Log ('ERROR: failed to start sing-box: ' + $_.Exception.Message)
  exit 1
}
if (-not ($proc -and $proc.Id)) { Log 'ERROR: Start-Process returned null'; exit 1 }
$sbId = $proc.Id
try {
  $sbId | Out-File -FilePath $PidFile -Encoding ASCII -NoNewline
} catch {
  Log ('ERROR: failed to write PID file: ' + $_.Exception.Message)
  Stop-Process -Id $sbId -Force -ErrorAction SilentlyContinue
  exit 1
}
Log ('sing-box started, PID ' + $sbId)

# (c) babysit: exit when core dies; kill core on stopflag or parent death (name check vs PID reuse).
while ($true) {
  $sb = Get-Process -Id $sbId -ErrorAction SilentlyContinue
  if (-not $sb -or $sb.ProcessName -ne 'sing-box') { Log 'sing-box exited by itself'; break }
  if (Test-Path -LiteralPath $StopFlag) { Log 'Stopflag detected'; break }
  $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
  if (-not $parent -or $parent.ProcessName -ne $ParentName) { Log 'Parent process gone'; break }
  Start-Sleep -Seconds 1
}
$sb = Get-Process -Id $sbId -ErrorAction SilentlyContinue
if ($sb -and $sb.ProcessName -eq 'sing-box') {
  Stop-Process -Id $sbId -Force -ErrorAction SilentlyContinue
  Log 'sing-box stopped by watchdog'
}
Remove-Item -LiteralPath $StopFlag -Force -ErrorAction SilentlyContinue
Log 'Watchdog exit'
exit 0
`;
    require('fs').writeFileSync(this.getWindowsWatchdogScriptPath(), script);
  }

  // ─── 文件权限 / 提权复制（迁自 ProxyManager.fixFilePermissions / CoreUpdateService.copyFileElevatedWindows）──

  /**
   * 修复可能被 root 创建的文件权限（macOS）
   * 当从 TUN 模式切换到系统代理模式时，某些文件可能仍然属于 root
   * 需要在普通用户模式下修复这些文件的权限
   *
   * 迁自 ProxyManager.fixFilePermissions。原 this.needsRootPrivilege() → ctx.isTunMode()（隐式 currentConfig
   * 读取经 ctx 回调注入）；原 this.logToManager → ctx.log（source 默认 'sing-box'）。
   */
  async fixFilePermissions(): Promise<void> {
    // 只在 macOS 上需要处理
    if (process.platform !== 'darwin') {
      return;
    }

    // 如果是 TUN 模式，不需要修复（会以 root 权限运行）
    if (this.ctx.isTunMode()) {
      return;
    }

    const userDataPath = getUserDataPath();
    const filesToFix = [
      getCachePath(),
      getSingBoxLogPath(),
      getSingBoxPidPath(),
      path.join(userDataPath, 'singbox_startup.log'),
    ];

    const fsSync = require('fs');
    const { execSync } = require('child_process');

    for (const filePath of filesToFix) {
      try {
        if (fsSync.existsSync(filePath)) {
          const stats = fsSync.statSync(filePath);
          // 检查文件是否属于 root (uid 0)
          if (stats.uid === 0) {
            this.ctx.log('info', `修复文件权限: ${filePath}`);
            // 使用 chown 修改文件所有权为当前用户
            const currentUser = process.env.USER || process.env.LOGNAME;
            if (currentUser) {
              try {
                // 尝试使用 chown（可能需要密码）
                execSync(`chown ${currentUser} "${filePath}"`, { stdio: 'ignore' });
              } catch {
                // 如果 chown 失败，尝试删除文件让 sing-box 重新创建
                try {
                  fsSync.unlinkSync(filePath);
                  this.ctx.log('info', `已删除需要重新创建的文件: ${filePath}`);
                } catch {
                  this.ctx.log(
                    'warn',
                    `无法修复文件权限: ${filePath}，请手动删除或运行: sudo chown ${currentUser} "${filePath}"`
                  );
                }
              }
            }
          }
        }
      } catch {
        // 忽略检查错误
      }
    }
  }

  /**
   * 通用提权复制文件（原 Windows 专用 copyFileElevatedWindows）。
   * 通过 PowerShell 以管理员权限复制文件——解决将文件写入 C:\Program Files (UAC 保护目录) 时的 EPERM 问题。
   *
   * 迁自 CoreUpdateService.copyFileElevatedWindows：PowerShell RunAs 逻辑原样保留，
   * 仅迁移位置 + this.logManager.addLog → ctx.log（source 默认 'CoreUpdateService'）。
   * 当前仅 Windows 分支使用 RunAs；非 Windows 由调用方保证不进入（fallback 留给后续平台扩展）。
   */
  async copyFileElevated(src: string, dest: string): Promise<void> {
    const { execSync } = require('child_process') as typeof import('child_process');

    // Escape single quotes in paths for PowerShell
    const escapedSrc = src.replace(/'/g, "''");
    const escapedDest = dest.replace(/'/g, "''");

    // Ensure destination directory exists
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    try {
      // First try a direct copy (works if app has write access)
      fs.copyFileSync(src, dest);
    } catch (directErr: any) {
      if (directErr.code !== 'EPERM' && directErr.code !== 'EACCES' && directErr.code !== 'EBUSY') {
        throw directErr;
      }

      this.ctx.log(
        'info',
        `Direct copy failed (${directErr.code}), attempting elevated PowerShell copy...`,
        'CoreUpdateService'
      );

      // Fall back: use PowerShell with -Verb RunAs to elevate.
      // TOCTOU 加固：脚本落到当前用户私有子目录(userData/priv，非共享的 os.tmpdir()) + 随机不可预测文件名
      // (crypto.randomBytes 而非可预测的 Date.now()) + O_EXCL 独占创建(flag 'wx' 拒绝已存在文件防抢占) + 权限收紧
      // —— 收窄「fs 写入 → UAC 提权执行」之间脚本被改写致管理员权限任意代码执行的窗口（原共享临时目录 + 可预测名，
      // 任意本地用户可预置/抢占落点）。Windows 文件权限位有限，私有目录(用户 profile ACL)是主要防线。
      const privDir = path.join(getUserDataPath(), 'priv');
      try {
        fs.mkdirSync(privDir, { recursive: true, mode: 0o700 });
      } catch {
        /* 已存在 → 忽略 */
      }
      const scriptPath = path.join(privDir, `flowz-copy-${randomBytes(12).toString('hex')}.ps1`);
      // 使用 $ErrorActionPreference = 'Stop' 确保出错时非 0 退出。
      // Fix：原 `Stop-Process -Name "sing-box"` 盲杀所有 sing-box.exe，与换核 async 窗口叠加会误杀用户重连启动的核。
      // 改为仅按 ExecutablePath 定向终止「正在运行本次待覆盖二进制(dest)」的进程（与 writeWindowsWatchdogScript 的
      // 精确匹配同口径）：只有它锁着 dest → 覆盖前必须先放行，其它路径的核一律不动。try/catch 保证枚举失败不阻断复制。
      fs.writeFileSync(
        scriptPath,
        `$ErrorActionPreference = 'Stop'\n` +
          `try { Get-CimInstance Win32_Process -Filter "Name='sing-box.exe'" | ` +
          `Where-Object { $_.ExecutablePath -eq '${escapedDest}' } | ` +
          `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } } catch {}\n` +
          `Start-Sleep -Seconds 1\n` +
          `Copy-Item -Path '${escapedSrc}' -Destination '${escapedDest}' -Force\n`,
        { mode: 0o600, flag: 'wx' }
      );

      try {
        // 使用 Start-Process -Verb RunAs 触发 UAC 提权并用 -Wait 阻塞直到完成
        execSync(
          `"${powershellPath()}" -Command "Start-Process '${powershellPath()}' -ArgumentList '-ExecutionPolicy Bypass -WindowStyle Hidden -File \\"${scriptPath}\\"' -Verb RunAs -Wait"`,
          {
            stdio: 'pipe',
            timeout: 60000,
          }
        );
      } finally {
        try {
          fs.unlinkSync(scriptPath);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * macOS 无 helper 时一次性提权安装内核到受保护目录（借鉴 buildMacUpdateScript / HelperManager.runRootScript 的
   * osascript-admin 范式）：先试免提权 direct copy（受保护核 EPERM 失败）→ 落盘 root 脚本 → osascript「with administrator
   * privileges」一次弹密码跑 mkdir+cp+chmod。root 跑 → dest 恒 root:wheel，消除「root 跑用户可写二进制」、无 privesc。
   * 用户取消授权 → 抛「已取消管理员授权」。补齐 copyFileElevated 的 macOS 腿（该方法注释「fallback 留后续平台扩展」）。
   */
  async installCoreElevatedMac(src: string, dest: string): Promise<void> {
    if (process.platform !== 'darwin') throw new Error('installCoreElevatedMac 仅 macOS');
    const destDir = path.dirname(dest);
    // 受保护核目录恒 root:wheel、普通用户写不动 → 不试免提权 direct copy：①避免非 EPERM 错（ENOSPC/ENOENT）在弹窗前抛、
    // 致调用方 declinedVersion 已记却从未弹；②杜绝「万一目录松权时植入用户属主二进制」的 TOCTOU（复审硬化）。mkdir 由
    // 下方 root 脚本做。落盘 root 脚本（shq 转义路径），osascript 一次性 admin 跑（mirror runRootScript）。启动期代理未连，pkill 防御性。
    const script = [
      '#!/bin/bash',
      'set -e',
      `mkdir -p ${shq(destDir)}`,
      'pkill -x sing-box 2>/dev/null || true',
      `cp -f ${shq(src)} ${shq(dest)}`,
      `chmod 755 ${shq(dest)}`,
      '',
    ].join('\n');
    const scriptPath = path.join(app.getPath('temp'), `flowz-core-install-${process.pid}.sh`);
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
    try {
      await new Promise<void>((resolve, reject) => {
        // 路径单引号包裹容忍空格；FlowZ 路径不含单/双引号（同 runRootScript 约束）。
        const proc = spawn('/usr/bin/osascript', [
          '-e',
          `do shell script "/bin/bash '${scriptPath}'" with administrator privileges`,
        ]);
        let stderr = '';
        proc.stderr?.on('data', (d) => (stderr += d.toString()));
        proc.on('exit', (code) => {
          if (code === 0) resolve();
          else if (/-128|User canceled/i.test(stderr)) reject(new Error('已取消管理员授权'));
          else reject(new Error(stderr.trim() || `osascript 退出码 ${code}`));
        });
        proc.on('error', (err) => reject(err));
      });
    } finally {
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* ignore */
      }
    }
  }

  // ─── 提权停止（迁自 ProxyManager.stopSingBoxWithSudo / stopSingBoxOnWindows，子 commit 3）──────
  //
  // 入口 stopElevated(pid, opts) 平台分发：
  // - darwin：helper.stopCore（零提权）→ stopflag → osascript 强杀；quitting 跳过 osascript。
  // - win32：stopflag → RunAs taskkill；quitting 跳过 UAC。
  // 返回 {stopped}：true=进程已停（调用方可 finishStop），false=取消授权/仍存活（不 finishStop，保留 M3）。
  // 进程状态收尾（finishStop/cleanup）留 ProxyManager stopSingBoxProcess wrapper。

  /**
   * 提权停止 sing-box（顶层平台分发）。
   * 迁自 ProxyManager.stopSingBoxWithSudo（darwin）+ stopSingBoxOnWindows（win32）。
   *
   * @returns stopped=true 进程已终止（调用方据 finishStop）；stopped=false 取消授权/仍存活（不谎报已停止，M3）。
   */
  async stopElevated(pid: number, opts?: { quitting?: boolean }): Promise<{ stopped: boolean }> {
    if (process.platform === 'darwin') {
      return this.stopElevatedDarwin(pid, opts);
    }
    if (process.platform === 'win32') {
      return this.stopElevatedWindows(pid, opts);
    }
    // Linux TUN 走 setcap 路径，sing-box 以当前用户运行，不进提权停止分支（stopSingBoxProcess 直接走用户态 kill）。
    return { stopped: true };
  }

  /**
   * macOS 提权停止 sing-box。
   * - helper 路径：经 socket 让 root daemon stopCore（零提权），未生效时 quitting 跳过 osascript / 否则 osascript 强杀。
   * - 非 helper 路径：进程已不在直接返回；否则写 stopflag 通知 root 看护脚本自杀；超时 fallback osascript。
   * - quitting 语境：全程跳过 osascript 弹框（残留交下次启动 killOrphanedProcessesMac 清扫）。
   * 迁自 ProxyManager.stopSingBoxWithSudo。
   */
  private async stopElevatedDarwin(
    pid: number,
    opts?: { quitting?: boolean }
  ): Promise<{ stopped: boolean }> {
    // helper 路径：经 socket 让 root daemon 停 sing-box，零提权（PR-M2）。
    if (this.ctx.startedViaHelper() && this.helperManager) {
      this.ctx.log('info', `正在经提权 helper 停止 sing-box (PID: ${pid})（免授权）...`);
      if (this.ctx.isProcessAlive(pid)) {
        await this.helperManager.stopCore();
        // 8s（非退出）覆盖 helper terminateChild 的「TERM→等≤5s→KILL」完整窗口 + 收割余量：
        // 原 5s 会在 helper 即将 SIGKILL 时正好超时 → 误判「helper 停止未生效」→ 多弹一次 osascript 强杀。
        await this.ctx.waitForProcessExit(pid, opts?.quitting ? 3000 : 8000);
      }
      if (this.ctx.isProcessAlive(pid)) {
        if (opts?.quitting) {
          // 退出语境零弹框：helper 未生效也不弹 osascript，交由 teardownForQuit 的 helper.cleanup() 兜底回收
          this.ctx.log('warn', 'helper 停止未生效，退出语境跳过提权弹框（cleanup 兜底）');
        } else {
          // 极少触发：helper 未生效 → 退回 osascript 强杀（一次授权）。取消授权(进程仍活) → 不谎报已停止。
          this.ctx.log('warn', 'helper 停止未生效，退回提权强制终止');
          const ok = await this.forceKillElevated(pid);
          if (!ok) return { stopped: false };
        }
      } else {
        this.ctx.log('info', 'sing-box 已由提权 helper 停止（免授权）');
      }
      return { stopped: true };
    }

    // M1-a：进程已不在 → 直接返回（免一次提权授权框）。finishStop 由调用方统一做。
    if (!this.ctx.isProcessAlive(pid)) {
      this.ctx.log('info', 'sing-box 进程已不在，跳过提权终止');
      return { stopped: true };
    }

    // M1-b：写 stopflag，由 root 看护脚本自杀 sing-box —— 停止无需再次提权
    this.ctx.log('info', `正在停止 sing-box (PID: ${pid})，通知看护脚本...`);
    try {
      require('fs').writeFileSync(this.ctx.stopFlagPath(), '');
    } catch (e) {
      this.ctx.log('warn', `写 stopflag 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (await this.ctx.waitForProcessExit(pid, opts?.quitting ? 3000 : 8000)) {
      this.ctx.log('info', 'sing-box 已由看护脚本停止（无需提权）');
      return { stopped: true };
    }

    // Fallback：看护脚本未在预期内收口（异常/旧式直起）→ 退回 osascript 提权终止
    if (opts?.quitting) {
      // 退出语境零弹框：跳过 osascript，残留 sing-box 由下次启动的 killOrphanedProcessesMac 清扫
      this.ctx.log('warn', '看护脚本未及时停止，退出语境跳过提权弹框（下次启动清扫孤儿）');
      return { stopped: true };
    }
    this.ctx.log('warn', '看护脚本未及时停止 sing-box，退回提权终止');
    return new Promise((resolve) => {
      const killProcess = spawn('/usr/bin/osascript', [
        '-e',
        `do shell script "kill -TERM ${pid}" with administrator privileges`,
      ]);

      killProcess.on('exit', async (code) => {
        if (code === 0) {
          await this.ctx.waitForProcessExit(pid, 3000);
          if (this.ctx.isProcessAlive(pid)) {
            this.ctx.log('warn', '进程未响应 SIGTERM，尝试强制终止...');
            const ok = await this.forceKillElevated(pid);
            resolve({ stopped: ok });
          } else {
            this.ctx.log('info', 'sing-box 进程已停止');
            resolve({ stopped: true });
          }
        } else {
          this.ctx.log('warn', `停止 sing-box 进程可能失败，退出码: ${code}`);
          const ok = await this.forceKillElevated(pid);
          resolve({ stopped: ok }); // 取消授权(进程仍活) → 不谎报已停止（M3）
        }
      });

      killProcess.on('error', async (error) => {
        this.ctx.log('error', `停止 sing-box 进程失败: ${error.message}`);
        // spawn 失败（osascript 无法启动，非用户取消授权）：尽力强杀但不发 STOP_AUTH_CANCELLED（MED-2，避免误报）。
        const ok = await this.forceKillElevated(pid, false);
        resolve({ stopped: ok });
      });
    });
  }

  /**
   * Windows 提权停止 sing-box。
   * 主路径：写 stopflag → 提权看护脚本 ~1s 内 Stop-Process 收割 —— 停止零 UAC。
   * 兜底：等待超时（跨版本旧直起无看护 / 看护异常）且非退出语境 → RunAs taskkill（一次 UAC，与旧版语义一致）；
   * 退出语境恪守零弹框不变量 → 仅 log 跳过（父进程消失后看护脚本自行收割，确无看护的残留交下次启动提权清扫）。
   * 迁自 ProxyManager.stopSingBoxOnWindows。
   */
  private async stopElevatedWindows(
    pid: number,
    opts?: { quitting?: boolean }
  ): Promise<{ stopped: boolean }> {
    // 进程已不在 → 直接返回，免一次 UAC（镜像 macOS M1-a）
    if (!this.ctx.isProcessAlive(pid)) {
      this.ctx.log('info', 'sing-box 进程已不在，跳过提权终止');
      return { stopped: true };
    }

    // 主路径：写 stopflag，由提权看护脚本收割 sing-box —— 停止无需再次 UAC
    this.ctx.log('info', `正在停止 sing-box (PID: ${pid})，通知看护脚本...`);
    try {
      require('fs').writeFileSync(this.ctx.stopFlagPath(), '');
    } catch (e) {
      this.ctx.log('warn', `写 stopflag 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    // 看护脚本 1s 轮询 + Stop-Process，5s 覆盖足够；退出语境压到 3s（cleanupResources 8s 预算内）
    if (await this.ctx.waitForProcessExit(pid, opts?.quitting ? 3000 : 5000)) {
      this.ctx.log('info', 'sing-box 已由看护脚本停止（无需 UAC）');
      return { stopped: true };
    }

    // 超时：看护脚本未收口（跨版本边界：旧版 Start-Process 直起无看护；或看护异常退出）
    if (opts?.quitting) {
      // 退出语境零弹框（跨平台不变量）：跳过 RunAs taskkill。父进程消失后看护脚本仍会 ~1s 收割；
      // 确无看护时残留交下次启动的提权清扫（watchdog 步骤 a）。stopflag 留给看护消费/下次启动清理。
      this.ctx.log(
        'warn',
        `看护脚本未及时停止 sing-box（PID ${pid}），退出语境跳过 UAC 弹框（父死看护/下次启动清扫兜底）`
      );
      return { stopped: true };
    }

    this.ctx.log('warn', '看护脚本未及时停止 sing-box，退回提权 taskkill（需要 UAC 授权）...');
    return new Promise((resolve) => {
      // RunAs taskkill 兜底：覆盖旧版直起（无看护）与看护异常两种情形，一次 UAC（与旧版语义一致）。
      // /FI "IMAGENAME eq sing-box.exe" 防 PID 复用误杀（值含空格→ -ArgumentList 元素须内嵌双引号；VM 实测通过）。
      const psScript =
        `Start-Process -FilePath '${system32('taskkill.exe')}' -ArgumentList '/F','/PID','` +
        pid.toString() +
        "','/FI','\"IMAGENAME eq sing-box.exe\"' -Verb RunAs -Wait -WindowStyle Hidden";

      const killProcess = spawn(
        powershellPath(),
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
        {
          windowsHide: true,
        }
      );

      killProcess.stderr?.on('data', (data) => {
        this.ctx.log('warn', `taskkill stderr: ${data.toString()}`);
      });

      killProcess.on('exit', (code) => {
        if (code === 0) {
          this.ctx.log('info', 'sing-box 进程已停止');
        } else {
          // 非零退出码可能是进程已退出或用户取消 UAC
          this.ctx.log('warn', `停止进程结果: code=${code}`);
        }

        // 兜底路径无看护脚本消费 stopflag → 主动清掉，防下次会话看护误触发
        try {
          require('fs').unlinkSync(this.ctx.stopFlagPath());
        } catch {
          /* 忽略 */
        }

        // 复核存活：取消 UAC 致进程仍活 → 不谎报已停止（M3 镜像 macOS forceKillOrReportCancelled）
        const stopped = !this.ctx.isProcessAlive(pid);
        if (!stopped) {
          this.ctx.onStopAuthCancelled();
        }
        resolve({ stopped });
      });

      killProcess.on('error', (error) => {
        this.ctx.log('error', `停止 sing-box 进程失败: ${error.message}`);
        // spawn 失败：尽力复核，仍以存活为准
        const stopped = !this.ctx.isProcessAlive(pid);
        resolve({ stopped });
      });
    });
  }

  /**
   * 提权强杀 sing-box（macOS osascript kill -9）。
   * 成功（进程已死）→ true；取消授权/失败致仍存活 → false（调用方据此不谎报已停止 + 触发 onStopAuthCancelled）。
   *
   * 迁自 ProxyManager.forceKillProcess（剥离 sendEventToRenderer 跨层副作用，副作用由调用方承担）。
   * 「取消授权→发 STOP_AUTH_CANCELLED 事件」原内联于 forceKillOrReportCancelled，现由 stopElevatedDarwin
   * 据本方法返回 false 触发 ctx.onStopAuthCancelled（保留 M3 语义，service 不持 IPC 通道）。
   */
  private async forceKillElevated(pid: number, reportCancelled = true): Promise<boolean> {
    await new Promise<void>((resolve) => {
      const killProcess = spawn('/usr/bin/osascript', [
        '-e',
        `do shell script "kill -9 ${pid}" with administrator privileges`,
      ]);

      killProcess.on('close', () => {
        resolve();
      });

      killProcess.on('error', () => {
        // 最后尝试普通 kill
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // 忽略错误
        }
        resolve();
      });
    });
    // 复核：osascript 取消授权时进程仍活 → 返回 false，并发 STOP_AUTH_CANCELLED。
    // reportCancelled=false：spawn 失败兜底路径（osascript 无法启动，非用户取消授权）不发该事件，避免误报「停止被取消授权」（MED-2）。
    const stopped = !this.ctx.isProcessAlive(pid);
    if (!stopped && reportCancelled) {
      this.ctx.onStopAuthCancelled();
    }
    return stopped;
  }

  // ─── 提权判定（迁自 ProxyManager.needsRootPrivilege / needsOsascript / needsWindowsUAC，子 commit 5）──
  //
  // needsPrivilege：是否需要 root/admin（TUN 模式 + 三平台门控）。
  // needsElevation：合并 needsOsascript/needsWindowsUAC 的提权方式判定（'osascript'|'uac'|'pkexec'|'none'）。
  // ProxyManager 保留 needsRootPrivilege/needsOsascript/needsWindowsUAC 作 thin wrapper delegate（resolveClashApiPortConflict
  // 等 ~10 处调用零改动），实现收口至此。

  /**
   * 当前配置是否需要 root/admin 权限（TUN 模式）。
   * Windows/macOS/Linux TUN 模式都需要管理员权限。
   * 迁自 ProxyManager.needsRootPrivilege：原 this.currentConfig?.proxyModeType === 'tun' → ctx.isTunMode()。
   */
  needsPrivilege(): boolean {
    const isTunMode = this.ctx.isTunMode();
    return (
      isTunMode &&
      (process.platform === 'darwin' ||
        process.platform === 'win32' ||
        process.platform === 'linux')
    );
  }

  /**
   * 提权方式判定（合并 needsOsascript/needsWindowsUAC）。
   * - 'osascript'：macOS TUN（osascript 管理员授权）。
   * - 'uac'：Windows TUN（PowerShell Start-Process -Verb RunAs）。
   * - 'pkexec'：Linux TUN（pkexec，经 ensureCapabilities 在 spawn 前一次性 setcap，运行期非每启提权）。
   * - 'none'：系统代理模式 / 非 TUN（无需提权）。
   *
   * 注：当前 ProxyManager 调用点仍用 needsOsascript/needsWindowsUAC wrapper（细分判定），本方法作为
   * 统一视图供未来聚合判定；wrapper 内部链式 delegate 到 needsPrivilege 保持一致。
   */
  needsElevation(): 'osascript' | 'uac' | 'pkexec' | 'none' {
    if (!this.needsPrivilege()) return 'none';
    if (process.platform === 'darwin') return 'osascript';
    if (process.platform === 'win32') return 'uac';
    if (process.platform === 'linux') return 'pkexec';
    return 'none';
  }

  // ─── 提权能力 + 提权启动命令（迁自 ProxyManager.ensureLinuxTunCapabilities + startSingBoxProcess 提权分支，子 commit 4）──
  //
  // ensureCapabilities：Linux setcap + polkit 规则（首次弹 1 次密码，之后启停零弹窗）。
  // buildElevatedLaunchCommand：返回提权包装 {command, args}（osascript / powershell RunAs），【不 spawn】——
  //   spawn + stdout 监听 + exit 处理（startupResolved 门控、双启动流防护）+ waitForPidFile 留 ProxyManager。
  // generateWatchdogScript：组装 writeWrapperScript + writeWindowsWatchdogScript（子 commit 1 已迁），返回 {path, isWindows}。

  /**
   * 确保 Linux TUN 核心具备所需 capabilities + 安装 polkit 规则（免逐条 DNS 密码框）。
   * 迁自 ProxyManager.ensureLinuxTunCapabilities：
   * - this.needsRootPrivilege()（平台+TUN 门控）→ process.platform 门控 + ctx.isTunMode()（剥离平台门控给调用方，
   *   原因：ensureCapabilities 仅 Linux 生效，平台门控留原处更清晰）。
   * - this.singboxPath → ctx.singboxPath()。
   * - this.execCapture/runPkexecScript/buildLinuxTunSetupScript → 本服务自身方法（子 commit 1 已迁）。
   * - this.logToManager → ctx.log。
   *
   * 幂等：caps 已具备且规则文件已存在则零弹窗直接返回。授权取消 → 抛含「权限」的错误（命中 nonRetryableErrors）。
   */
  async ensureCapabilities(): Promise<void> {
    if (process.platform !== 'linux' || !this.ctx.isTunMode()) return;
    // 以 root 跑整个 app → 已有全部权限，无需 pkexec
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    const fs = require('fs');
    const corePath = this.ctx.singboxPath();
    const rulesFile = '/etc/polkit-1/rules.d/49-flowz-resolved.rules';

    // 核心不存在 → 直接报「找不到」（命中 nonRetryableErrors），不白弹密码框（P2-3）
    if (!fs.existsSync(corePath)) {
      throw new Error(`找不到 sing-box 可执行文件: ${corePath}`);
    }

    // 定位 getcap（普通用户 PATH 常不含 /usr/sbin）；绝对路径都不在则退回裸名走 PATH（P2-1）
    const getcapBin =
      ['/usr/sbin/getcap', '/sbin/getcap', '/usr/bin/getcap'].find((p) => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      }) || 'getcap';

    // true=有 caps，false=无 caps，null=getcap 不可用（无法判定，复检时以脚本退出码为准）
    const probeCaps = async (): Promise<boolean | null> => {
      try {
        return /cap_net_admin/.test(await this.execCapture(getcapBin, [corePath]));
      } catch {
        return null;
      }
    };

    let rulesExist = false;
    try {
      rulesExist = fs.existsSync(rulesFile);
    } catch {
      /* ignore */
    }

    // 已具备 caps 且规则文件已存在 → 零弹窗
    if ((await probeCaps()) === true && rulesExist) return;

    // 当前用户名（白名单校验，杜绝注入）。允许企业目录用户名常见的 . 与 @（SSSD/AD），
    // 三处嵌入上下文（quoted-heredoc / JS 双引号串 / .pkla 值）对 . @ 均安全。
    let user = '';
    try {
      user = require('os').userInfo().username;
    } catch {
      /* fallthrough */
    }
    if (!user) {
      throw new Error('TUN 模式需要管理员权限：无法确定当前用户名，请手动配置 setcap');
    }
    if (!/^[a-z_][a-z0-9_.@-]*$/i.test(user)) {
      throw new Error(`TUN 模式需要管理员权限：用户名 "${user}" 含不支持的字符，请手动配置 setcap`);
    }

    this.ctx.log(
      'info',
      'Linux TUN 首次配置：请求一次管理员授权（赋核心网络权限 + 安装 DNS polkit 规则）...'
    );

    const scriptPath = path.join(getUserDataPath(), 'flowz-linux-tun-setup.sh');
    try {
      fs.writeFileSync(scriptPath, this.buildLinuxTunSetupScript(corePath, user, rulesFile), {
        mode: 0o755,
      });
    } catch (e) {
      throw new Error(
        `TUN 模式需要管理员权限：无法写入提权脚本 (${e instanceof Error ? e.message : String(e)})`
      );
    }

    const result = await this.runPkexecScript(scriptPath);
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      /* 忽略 */
    }

    // 复检 caps。getcap 不可用（null）时无法验证 → 信任脚本退出码（set -e + 末行 echo 保证 setcap
    // 成功才退 0）。仅当「getcap 明确说无 caps」或「getcap 不可用且脚本失败」才判失败（P2-1）。
    const post = await probeCaps();
    if (post === false || (post === null && !result.success)) {
      throw new Error(
        `TUN 模式需要管理员权限：${result.error || '授权被取消或系统缺少 polkit 认证代理'}。` +
          `可手动执行: sudo setcap 'cap_net_admin,cap_net_bind_service,cap_net_raw=+ep' "${corePath}"`
      );
    }
    this.ctx.log('info', 'Linux TUN 提权配置完成（核心已赋权，DNS polkit 规则已安装）');
  }

  /**
   * 看护脚本工厂：按平台写看护脚本（macOS bash / Windows PowerShell），返回脚本路径 + 平台标识。
   * ProxyManager startSingBoxProcess 提权分支调此统一写脚本，再 buildElevatedLaunchCommand 用返回的路径构造 args。
   * writeWrapperScript / writeWindowsWatchdogScript 实现子 commit 1 已迁，此处组装。
   * 返回 isWindows 供调用方区分日志措辞（与原 needsOsascript/needsWindowsUAC 分支日志一致）。
   */
  generateWatchdogScript(): { path: string; isWindows: boolean } {
    if (process.platform === 'win32') {
      this.writeWindowsWatchdogScript();
      return { path: this.getWindowsWatchdogScriptPath(), isWindows: true };
    }
    // macOS 走 bash 看护脚本（Linux TUN 走 setcap 直起，不进提权看护）
    this.writeWrapperScript();
    return { path: this.getWrapperScriptPath(), isWindows: false };
  }

  /**
   * 提权启动命令所需路径集合（ProxyManager startSingBoxProcess 提权分支组装后传入）。
   * 所有路径由调用方提供（PID 文件/启动日志/看护脚本/stopflag/父进程信息等均属 ProxyManager 生命周期状态）。
   */
  buildElevatedLaunchCommand(paths: ElevatedLaunchPaths): { command: string; args: string[] } {
    if (process.platform === 'darwin') {
      return this.buildOsascriptLaunchCommand(paths);
    }
    if (process.platform === 'win32') {
      return this.buildWindowsUacLaunchCommand(paths);
    }
    // 非 macOS/Windows TUN 不进提权分支（ensureCapabilities 已收 Linux setcap 路径）。
    // 兜底返回直起命令（与原 startSingBoxProcess else 分支一致）。
    return { command: paths.singboxPath, args: ['run', '-c', paths.configPath] };
  }

  /** 把路径安全嵌入 osascript `do shell script "..."`：先 shq 做 shell 单引号(防 shell 注入)，再对结果做
   *  AppleScript 字符串转义(反斜杠翻倍、双引号转义)。两层引号缺一层，含撇号/引号的家目录路径即击穿引号 →
   *  静默失败或以 root 注入命令。 */
  private osaShellArg(p: string): string {
    return shq(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * macOS osascript 提权启动命令构造。
   * 迁自 ProxyManager.startSingBoxProcess needsOsascript 分支（command/args 构造段）：
   * osascript 一次授权 → 以 root 跑「看护脚本」托管 sing-box（停止/退出/崩溃回收无需再提权）。
   * 各路径经 osaShellArg（shell 单引号 + AppleScript 转义）嵌入，容忍空格/撇号/引号（含撇号家目录不再引号破裂）。
   */
  private buildOsascriptLaunchCommand(paths: ElevatedLaunchPaths): {
    command: string;
    args: string[];
  } {
    const { wrapper, singboxPath, configPath, startupLogFile, pidFile, stopFlag, parentPid, fwd } =
      paths;
    // 各路径经 shq(shell 单引号) + AppleScript 转义嵌入 osascript：含撇号/引号/空格的家目录路径不再击穿引号
    // （原始单引号包裹遇撇号即破裂 → 静默失败或 root 注入）。parentPid 为数值、安全直嵌。
    const a = (p: string) => this.osaShellArg(p);
    return {
      command: '/usr/bin/osascript',
      args: [
        '-e',
        `do shell script "/bin/bash ${a(wrapper)} ${a(singboxPath)} ${a(configPath)} ${a(startupLogFile)} ${a(pidFile)} ${a(stopFlag)} ${parentPid} ${a(fwd)} >/dev/null 2>&1 &" with administrator privileges`,
      ],
    };
  }

  /**
   * Windows UAC 提权启动命令构造。
   * 迁自 ProxyManager.startSingBoxProcess needsWindowsUAC 分支（command/args + psScript 构造段）：
   * 外层 powershell（非提权）只负责发起 UAC：Start-Process -Verb RunAs 拉起提权 powershell 执行看护脚本。
   * 参数经 -File 传递（不走 -Command 内联，避免多层转义）；-ArgumentList 不会给含空格元素自动加引号
   * → 路径元素显式内嵌双引号（FlowZ 路径不含单/双引号）。
   * 授权成功外层立即退 0（不 -Wait，看护脚本常驻）；取消 UAC 时 Start-Process 抛错 → 退 1，
   * 与旧实现的退出码协议一致（exit 处理留 ProxyManager）。
   */
  private buildWindowsUacLaunchCommand(paths: ElevatedLaunchPaths): {
    command: string;
    args: string[];
  } {
    const {
      watchdog,
      singboxPath,
      configPath,
      pidFile,
      stopFlag,
      parentPid,
      parentName,
      startupLogFile,
      fwd,
    } = paths;

    // -ArgumentList 不会给含空格元素自动加引号 → 路径元素显式内嵌双引号
    const q = (s: string) => `'"${s.replace(/'/g, "''")}"'`;
    const watchdogArgs = [
      "'-NoProfile'",
      // -NonInteractive：看护脚本含 Mandatory 参数，若引号链失效缺参，避免在隐藏窗口交互式提示→永久挂起
      "'-NonInteractive'",
      "'-ExecutionPolicy'",
      // 值 token 不带前导横线：elevated powershell 会把 '-Bypass'/'-Hidden' 当参数名而非 ExecutionPolicy/
      // WindowStyle 的值 → ExecutionPolicy 未设 Bypass、WindowStyle 未设 Hidden → 看护脚本被拦/可见窗口闪现。
      "'Bypass'",
      "'-WindowStyle'",
      "'Hidden'",
      "'-File'",
      q(watchdog),
      q(singboxPath),
      q(configPath),
      q(pidFile),
      q(stopFlag),
      `'${parentPid}'`,
      q(parentName),
      q(startupLogFile),
      `'${fwd}'`,
    ].join(',');
    const logFileEsc = startupLogFile.replace(/'/g, "''");
    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      'try {',
      `  Start-Process -FilePath '${powershellPath()}' -Verb RunAs -WindowStyle Hidden ` +
        '-ArgumentList ' +
        watchdogArgs,
      '  exit 0',
      '} catch {',
      "  'ERROR launching watchdog: ' + $_.Exception.Message | Out-File -FilePath '" +
        logFileEsc +
        "' -Encoding UTF8",
      '  exit 1',
      '}',
    ].join('; ');

    return {
      command: powershellPath(),
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
    };
  }

  // ─── 孤儿进程清理（迁自 ProxyManager.killOrphanedSingBoxProcesses 链，子 commit 2）──────────────
  //
  // 入口 killOrphans(isTunMode) 顶层分发 → Mac/Linux/Windows 子函数。macOS 系统代理模式还会经
  // escalateKillRootOrphans 提权清理 EPERM 杀不动的 root 残留（含 ROOT_ORPHAN_BLOCKED 终态语义）。
  // ProxyManager.killOrphanedSingBoxProcesses 改 delegate（startInternal:658 调用点零改动）。

  /**
   * 清理残留 sing-box 进程（顶层平台分发）。
   * 迁自 ProxyManager.killOrphanedSingBoxProcesses。
   */
  async killOrphans(isTunMode: boolean): Promise<void> {
    if (process.platform === 'darwin') {
      await this.killOrphanedProcessesMac(isTunMode);
    } else if (process.platform === 'win32') {
      await this.killOrphanedProcessesWindows();
    } else if (process.platform === 'linux') {
      await this.killOrphanedProcessesLinux();
    }
  }

  /**
   * Linux: 清理残留的 sing-box 进程（崩溃后占用 tun 设备会致下次启动 "resource busy"）。
   * 按本应用核心完整路径匹配（不误杀系统装的外部 sing-box）；进程属当前用户，TERM→KILL 无需提权。
   * 迁自 ProxyManager.killOrphanedProcessesLinux。
   */
  private async killOrphanedProcessesLinux(): Promise<void> {
    const singboxPath = this.ctx.singboxPath();
    return new Promise((resolve) => {
      // pgrep -f 把模式当 ERE：转义路径元字符（防自定义 userData 含 (/+/[ 致 regex 错而 fail-open）+
      // 用 ' run' 收口（孤儿 cmdline 恒为 "<path> run -c …"），避免误杀 less/tar 等打开核心文件的进程（P2-2）。
      const escaped = singboxPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pgrep = spawn('/usr/bin/pgrep', ['-f', `${escaped} run`]);
      let pids = '';
      pgrep.stdout?.on('data', (d: Buffer) => {
        pids += d.toString();
      });
      pgrep.on('close', () => {
        const pidList = this.filterExcludePids(pids);
        if (pidList.length === 0) {
          resolve();
          return;
        }

        this.ctx.log(
          'warn',
          `发现 ${pidList.length} 个残留的 sing-box 进程，正在清理: ${pidList.join(', ')}`
        );
        for (const p of pidList) {
          try {
            process.kill(p, 'SIGTERM');
          } catch {
            /* 已退出 */
          }
        }
        // 1.5s 后对仍存活者补 SIGKILL
        setTimeout(() => {
          for (const p of pidList) {
            try {
              if (this.ctx.isProcessAlive(p)) process.kill(p, 'SIGKILL');
            } catch {
              /* 忽略 */
            }
          }
          resolve();
        }, 1500);
      });
      pgrep.on('error', () => resolve());
    });
  }

  /**
   * macOS: 清理残留 sing-box 进程。
   * - helper 就绪：委托 root daemon cleanup() 一把清零提权（任意模式通用）。
   * - 系统代理模式：用户态 process.kill；杀不动的 root 残留走 escalateKillRootOrphans。
   * - TUN 模式：osascript 提权 kill -9（弹一次管理员密码框）。
   * 迁自 ProxyManager.killOrphanedProcessesMac。
   */
  private async killOrphanedProcessesMac(isTunMode: boolean): Promise<void> {
    // PR-M2：helper 就绪时，由 root daemon 一把清掉所有 sing-box（含上次 osascript 路径/崩溃遗留的孤儿），
    // 零提权（任意模式通用）。成功即直接返回，不再 pgrep+osascript——否则外部孤儿仍需 osascript 强杀弹框。
    if (this.helperManager && (await this.helperManager.isReady())) {
      try {
        if (await this.helperManager.cleanup()) {
          // 仅 TUN 需等接口/路由表收敛；systemProxy 不依赖 TUN，省掉这 2s 固定开销（P2-1）。
          if (isTunMode) await this.ctx.waitForNetworkCleanup();
          return;
        }
      } catch {
        /* helper 异常 → 落到下方兜底 */
      }
    }
    // 1B：系统代理模式孤儿通常是用户进程 → 零提权 process.kill。但若上次 TUN 会话（helper 卸载/BTM 关闭后）
    // 残留 root sing-box 仍占着 9090 等端口，用户态杀不动（EPERM）→ killUserOrphansMac 返回这些 PID，
    // 升级提权清理（交互 osascript 一次 / 非交互终态），杜绝「以为清完实则 9090 仍被占」的启动风暴。
    if (!isTunMode) {
      const rootSurvivors = await this.killUserOrphansMac();
      if (rootSurvivors.length > 0) {
        await this.escalateKillRootOrphans(rootSurvivors);
      }
      return;
    }
    return new Promise((resolve) => {
      // 仅匹配真正的 sing-box 运行进程（'sing-box run'）：避免误杀 argv 含 '--singbox <…/sing-box>'
      // 的常驻 helper daemon（其命令行含 'sing-box' 但不含 'sing-box run'）。
      const pgrep = spawn('/usr/bin/pgrep', ['-f', 'sing-box run']);
      let pids = '';

      pgrep.stdout.on('data', (data: Buffer) => {
        pids += data.toString();
      });

      pgrep.on('close', async () => {
        let pidList = pids
          .trim()
          .split('\n')
          .filter((p) => p.trim())
          .map((p) => parseInt(p.trim(), 10))
          .filter((p) => !isNaN(p) && p > 0);

        // 排除当前正在管理的进程（避免误杀）
        pidList = this.excludeCurrentPid(pidList);

        if (pidList.length === 0) {
          resolve();
          return;
        }

        this.ctx.log(
          'warn',
          `发现 ${pidList.length} 个残留的 sing-box 进程，正在清理: ${pidList.join(', ')}`
        );

        // TUN 模式下 sing-box 以 root 权限运行，必须用 osascript 请求管理员权限终止
        const killCmd = pidList.map((p) => `kill -9 ${p}`).join('; ');
        const killProcess = spawn('/usr/bin/osascript', [
          '-e',
          `do shell script "${killCmd}" with administrator privileges`,
        ]);

        killProcess.on('close', async (code) => {
          if (code === 0) {
            this.ctx.log('info', '残留进程已清理');
          } else {
            this.ctx.log('warn', `清理残留进程可能失败，退出码: ${code}`);
          }
          // 等待系统完全清理 TUN 接口和路由表
          await this.ctx.waitForNetworkCleanup();
          resolve();
        });

        killProcess.on('error', async (error) => {
          this.ctx.log('warn', `清理残留进程失败: ${error.message}`);
          await this.ctx.waitForNetworkCleanup();
          resolve();
        });
      });

      pgrep.on('error', () => {
        resolve();
      });
    });
  }

  /**
   * macOS 系统代理模式：用户态 process.kill 清理同 configPath 的 sing-box，返回 EPERM 杀不动的 root 残留 PID。
   * 迁自 ProxyManager.killUserOrphansMac。
   */
  private async killUserOrphansMac(): Promise<number[]> {
    const configPath = this.ctx.configPath();
    return new Promise((resolve) => {
      const escaped = configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pgrep = spawn('/usr/bin/pgrep', ['-f', escaped]);
      let pids = '';
      pgrep.stdout?.on('data', (d: Buffer) => {
        pids += d.toString();
      });
      pgrep.on('close', () => {
        const pidList = this.filterExcludePids(pids);

        if (pidList.length === 0) {
          resolve([]);
          return;
        }

        this.ctx.log(
          'warn',
          `发现 ${pidList.length} 个残留的 sing-box 进程，尝试零提权清理: ${pidList.join(', ')}`
        );
        const epermPids = new Set<number>();
        for (const p of pidList) {
          try {
            process.kill(p, 'SIGTERM');
          } catch (e) {
            // EPERM = root 进程，用户态杀不动；ESRCH = 已退出
            if ((e as NodeJS.ErrnoException)?.code === 'EPERM') epermPids.add(p);
          }
        }
        // 1.5s 后对仍存活者补 SIGKILL，再据「EPERM + 仍存活」判定真正杀不动的 root 残留
        setTimeout(() => {
          for (const p of pidList) {
            try {
              if (this.ctx.isProcessAlive(p)) process.kill(p, 'SIGKILL');
            } catch (e) {
              if ((e as NodeJS.ErrnoException)?.code === 'EPERM') epermPids.add(p);
            }
          }
          const survivors = pidList.filter((p) => epermPids.has(p) && this.ctx.isProcessAlive(p));
          const killed = pidList.filter((p) => !survivors.includes(p));
          if (killed.length) {
            this.ctx.log('info', `已清理 ${killed.length} 个用户态残留: ${killed.join(', ')}`);
          }
          if (survivors.length) {
            this.ctx.log(
              'warn',
              `${survivors.length} 个 root 残留用户态杀不动(EPERM): ${survivors.join(', ')}，需提权清理`
            );
          }
          resolve(survivors);
        }, 1500);
      });
      pgrep.on('error', () => resolve([]));
    });
  }

  /**
   * 提权清理 root 残留 sing-box（osascript 一次管理员授权）。
   *
   * 不变量（不可丢）：
   * - ROOT_ORPHAN_BLOCKED 文本判定：Error message 内嵌 `[ROOT_ORPHAN_BLOCKED]` + err.code='ROOT_ORPHAN_BLOCKED'，
   *   attemptAutoRestart.isUnrecoverableRestartError 仅按 message 文本判终态、不再退避重试 3 次（L-1）。
   * - startInteractive 非交互保护：!isInteractive → 直接抛 ROOT_ORPHAN_BLOCKED（崩溃自动重启场景不裸弹 osascript，F10）。
   * - 复核仍存活才算失败（PID 已自然退出 → kill 非零但已无残留，不应误报终态，M2）。
   *
   * 迁自 ProxyManager.escalateKillRootOrphans。
   */
  private async escalateKillRootOrphans(pids: number[]): Promise<void> {
    const blocked = (msg: string): Error & { code?: string } => {
      const err = new Error(`${msg} [ROOT_ORPHAN_BLOCKED]`) as Error & { code?: string };
      err.code = 'ROOT_ORPHAN_BLOCKED';
      return err;
    };
    if (!this.ctx.isInteractive()) {
      throw blocked(
        `残留 root sing-box (${pids.join(', ')}) 占用端口，自动重启无法提权清理，请手动停止后重试`
      );
    }
    // 每个 kill 容错 + 整体兜 true：某 PID 已自然退出会让 kill 返回非零 → 原实现据 osascript 退出码误判
    // ROOT_ORPHAN_BLOCKED（其实端口已释放，M2）。改为只把 osascript 自身非零（用户取消授权=-128）当失败，
    // kill 结果用「复核仍存活」判定。
    this.ctx.log(
      'warn',
      `[孤儿] 即将弹提权框清理 root 残留 ${pids.join(', ')}（osascript）—— 若长时间无响应可能是授权框被遮挡`
    );
    const killCmd = pids.map((p) => `kill -9 ${p} 2>/dev/null`).join('; ') + '; true';
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('/usr/bin/osascript', [
        '-e',
        `do shell script "${killCmd}" with administrator privileges`,
      ]);
      proc.on('close', (code) => {
        if (code !== 0) {
          // osascript 非零 = 用户取消授权（-128）等 → 端口可能仍被占 → 终态（避免裸启动撞占用进风暴）
          reject(blocked('提权清理 root 残留被取消，端口可能仍被占用'));
          return;
        }
        // 复核：仍存活才算失败（PID 已自然退出 → kill 非零但已无残留，不应误报终态）
        const survivors = pids.filter((p) => this.ctx.isProcessAlive(p));
        if (survivors.length === 0) {
          this.ctx.log('info', `已提权清理 ${pids.length} 个 root 残留: ${pids.join(', ')}`);
          resolve();
        } else {
          reject(blocked(`提权清理后仍有 root 残留存活: ${survivors.join(', ')}`));
        }
      });
      proc.on('error', (e) => reject(blocked(`提权清理 root 残留失败: ${e.message}`)));
    });
  }

  /**
   * Windows: 清理残留 sing-box 进程（tasklist 枚举 + taskkill）。
   * 非提权 taskkill：同权限孤儿有效；提权孤儿 Access denied 记入 failed，交由启动期提权看护脚本在同次 UAC 内清扫。
   * 迁自 ProxyManager.killOrphanedProcessesWindows。
   */
  private async killOrphanedProcessesWindows(): Promise<void> {
    return new Promise((resolve) => {
      const { execSync } = require('child_process');

      try {
        // tasklist 无匹配时输出本地化 INFO 提示行而非 CSV → 逐行正则只取合法 CSV 行
        // CSV 形如 "sing-box.exe","1234","Console","1","12,345 K"，第 2 列为 PID
        const result = execSync(
          `"${system32('tasklist.exe')}" /FI "IMAGENAME eq sing-box.exe" /FO CSV /NH`,
          {
            encoding: 'utf-8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
          }
        );

        let pidList = result
          .split('\n')
          .map((l: string) => {
            const m = l.trim().match(/^"[^"]*","(\d+)"/);
            return m ? parseInt(m[1], 10) : NaN;
          })
          .filter((p: number) => !isNaN(p) && p > 0);

        // 排除当前正在管理的进程
        pidList = this.excludeCurrentPid(pidList);

        if (pidList.length === 0) {
          resolve();
          return;
        }

        this.ctx.log(
          'warn',
          `发现 ${pidList.length} 个残留的 sing-box 进程，正在清理: ${pidList.join(', ')}`
        );

        // 逐个终止（非提权 taskkill：同权限孤儿有效；提权孤儿 Access denied 记入 failed）
        const failed: number[] = [];
        for (const pid of pidList) {
          try {
            execSync(`"${system32('taskkill.exe')}" /F /PID ${pid}`, {
              windowsHide: true,
              stdio: 'ignore',
            });
          } catch {
            failed.push(pid);
          }
        }

        if (failed.length > 0) {
          // 不静默：大概率是提权孤儿，交由启动期提权看护脚本在同次 UAC 内清扫
          this.ctx.log(
            'warn',
            `非提权清理失败: ${failed.join(', ')}（疑似提权孤儿，交启动期提权看护脚本清扫）`
          );
        } else {
          this.ctx.log('info', '残留进程已清理');
        }

        // 等待一小段时间让系统清理
        setTimeout(resolve, 500);
      } catch (e) {
        // tasklist 本身失败（被策略禁用等）→ log 不静默，放行启动（提权看护脚本步骤 a 仍兜底）
        this.ctx.log(
          'warn',
          `枚举残留 sing-box 进程失败: ${e instanceof Error ? e.message : String(e)}`
        );
        resolve();
      }
    });
  }

  // ─── PID 解析辅助（迁自 ProxyManager 各 killOrphaned* 内联逻辑，统一去重 + 排除自管理 PID）──

  /**
   * 解析 pgrep stdout（多行 PID 文本）→ PID 数组，排除自身(process.pid)与当前管理的 sing-box PID。
   * 原 killOrphanedProcessesLinux / killUserOrphansMac 内联逻辑同形，此处收口。
   */
  private filterExcludePids(stdout: string): number[] {
    const selfPid = process.pid;
    const pidList = stdout
      .trim()
      .split('\n')
      .map((p) => parseInt(p.trim(), 10))
      .filter((p) => !isNaN(p) && p > 0 && p !== selfPid);
    return this.excludeCurrentPid(pidList);
  }

  /**
   * 从 PID 列表中排除当前正在管理的 sing-box PID（singboxPid || pid，避免误杀自己）。
   * 迁自各 killOrphaned* 内联逻辑（macOS/win 原 `this.singboxPid || this.pid`）。
   */
  private excludeCurrentPid(pidList: number[]): number[] {
    const currentPid = this.ctx.currentManagedPid();
    if (currentPid == null) return pidList;
    return pidList.filter((p) => p !== currentPid);
  }
}
