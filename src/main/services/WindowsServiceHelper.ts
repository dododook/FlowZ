/**
 * Windows 提权服务客户端（对齐 macOS HelperManager，实现 IPrivilegedHelper）。
 *
 * 解决：未签名应用在 TUN 模式下每次启停 sing-box（含切节点重启）都弹 UAC。
 * 方案：一次性安装一个 LocalSystem Windows 服务（Go 二进制，见 helper-win/），之后普通用户 app 经 token 鉴权的
 *       命名管道零提权驱动 sing-box 启停——切节点/停止/退出/崩溃回收均免再次 UAC。
 *
 * 仅 Windows 有意义；其余平台所有方法安全降级（supported=false / ready=false）。
 * 未安装时由 ProxyManager 回退到 buildWindowsUacLaunchCommand（每次 UAC）。
 *
 * 与 macOS HelperManager 的对应（协议/行协议/token 语义一致，便于共用上层逻辑）：
 *   launchd daemon → Windows 服务（SCM, LocalSystem, start=auto）
 *   unix socket    → 命名管道 \\.\pipe\flowz-helper（ACL：SYSTEM + 交互用户；token 为主鉴权边界）
 *   osascript 授权 → UAC（Start-Process -Verb RunAs）
 *   命令集取子集：ping/version/status/start/stop/cleanup/freeport（无 macOS 专属 install-core）。
 *
 * 服务 start=auto 常驻 → app 全程只对管道发命令、不 start/stop 服务 → 普通用户起核只依赖管道 ACL，
 * 不依赖给普通用户授 SCM 权限（核心卖点的去风险点）。
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import { system32, powershellPath } from '../utils/win-system32';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { HelperStatus } from '../../shared/types';
import type { ILogManager } from './LogManager';
import type { IPrivilegedHelper, HelperStartResult } from './IPrivilegedHelper';
import { resourceManager } from './ResourceManager';
import { getUserDataPath } from '../utils/paths';

/** SCM 服务名。 */
const SERVICE_NAME = 'FlowZHelper';
/** 命名管道路径（与 helper-win 默认一致）。Node net.connect 支持 \\.\pipe\ 形式。 */
const PIPE_PATH = '\\\\.\\pipe\\flowz-helper';
/** SYSTEM 侧支持目录：服务以 LocalSystem 读 helper.token；安装时 elevated 写入并设 ACL（SYSTEM + Administrators）。 */
const SUPPORT_DIR = path.join(process.env.ProgramData || 'C:\\ProgramData', 'FlowZ');
/** sc query 不存在服务时的退出码（ERROR_SERVICE_DOES_NOT_EXIST）。 */
const ERROR_SERVICE_DOES_NOT_EXIST = 1060;
/** 与 helper-win 的 protoVersion 对应。Windows 独立谱系：v1 = ping/version/status/start/stop/cleanup/freeport。 */
const MIN_USABLE_PROTO = 1;
const EXPECTED_PROTO = 1;

export class WindowsServiceHelper implements IPrivilegedHelper {
  /** 装/卸互斥期返回最近稳定快照，避免 TOCTOU 半态（对齐 HelperManager.lastStableStatus）。 */
  private lastStableStatus: HelperStatus | null = null;
  private mutationInFlight = false;

  constructor(private logManager?: ILogManager | null) {}

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.logManager?.addLog(level, message, 'Helper');
  }

  private get supported(): boolean {
    return process.platform === 'win32';
  }

  private notSupportedStatus(): HelperStatus {
    return {
      supported: false,
      installed: false,
      ready: false,
      upgradeable: false,
      version: null,
      loaded: null,
      needsRepair: false,
      backgroundDisabled: false,
      pathMismatch: false,
      installedSingboxPath: null,
    };
  }

  // ── token（app 侧客户端副本，与服务侧 helper.token 同值）─────────────────
  // 独立成文件（非 UserConfig 字段）：渲染端整体回写 config.json 时碰不到它，杜绝竞态（对齐 HelperManager）。
  private tokenFilePath(): string {
    return path.join(getUserDataPath(), 'helper-client.token');
  }

  private token(): string {
    try {
      return fs.readFileSync(this.tokenFilePath(), 'utf8').trim();
    } catch {
      return '';
    }
  }

  // ── 命名管道客户端（行协议：token\n cmd\n [args...]，与 helper.go/HelperManager 同款）────────
  private sendCommand(rest: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(PIPE_PATH);
      let buf = '';
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('helper pipe 超时'));
      }, timeoutMs);
      sock.on('connect', () => {
        sock.end([this.token(), ...rest].join('\n') + '\n');
      });
      sock.on('data', (d) => {
        buf += d.toString();
      });
      sock.on('end', () => {
        clearTimeout(timer);
        resolve(buf.trim());
      });
      sock.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  // ── SCM 状态探测 ─────────────────────────────────────────────────────────
  /** sc query：服务是否存在 + 是否 RUNNING。不存在（exit 1060）→ {exists:false}。 */
  private queryService(): Promise<{ exists: boolean; running: boolean }> {
    return new Promise((resolve) => {
      execFile(
        system32('sc.exe'),
        ['query', SERVICE_NAME],
        { timeout: 4000, windowsHide: true },
        (err, stdout) => {
          const code = (err as { code?: number } | null)?.code;
          if (code === ERROR_SERVICE_DOES_NOT_EXIST) {
            return resolve({ exists: false, running: false });
          }
          const out = stdout || '';
          // 存在：无错误，或输出含 SERVICE_NAME 段（1060 以外的瞬时错误时尽量按存在处理，宁误判存在不误判缺失）
          const exists = !err || /SERVICE_NAME/i.test(out);
          const running = /STATE\s*:\s*\d+\s+RUNNING/i.test(out);
          resolve({ exists, running });
        }
      );
    });
  }

  /** 快速判定能否零提权驱动（ProxyManager 启动路由用）。 */
  async isReady(): Promise<boolean> {
    if (!this.supported || !this.token()) return false;
    try {
      const resp = await this.sendCommand(['ping'], 1500);
      const m = resp.match(/^OK pong uid=-?\d+ v(\d+)/);
      return !!m && parseInt(m[1], 10) >= MIN_USABLE_PROTO;
    } catch {
      return false;
    }
  }

  /** 完整状态：供设置页展示 + 安装/卸载按钮判态。装/卸互斥期返回最近稳定快照。 */
  async getStatus(force = false): Promise<HelperStatus> {
    if (this.mutationInFlight && this.lastStableStatus) return this.lastStableStatus;
    const s = await this.computeStatus(force);
    if (this.mutationInFlight && this.lastStableStatus) return this.lastStableStatus;
    this.lastStableStatus = s;
    return s;
  }

  private async computeStatus(_force = false): Promise<HelperStatus> {
    if (!this.supported) return this.notSupportedStatus();
    const { exists: installed, running } = await this.queryService();
    let version: string | null = null;
    let ready = false;
    let upgradeable = false;
    if (installed && this.token()) {
      try {
        const resp = await this.sendCommand(['ping'], 1500);
        const m = resp.match(/^OK pong uid=-?\d+ v(\d+)/);
        if (m) {
          version = m[1];
          const pv = parseInt(version, 10);
          ready = !isNaN(pv) && pv >= MIN_USABLE_PROTO;
          upgradeable = ready && pv < EXPECTED_PROTO;
        }
      } catch {
        /* 未就绪 */
      }
    }
    return {
      supported: true,
      installed,
      ready,
      upgradeable,
      version,
      // SCM RUNNING 即「已加载」；未安装为 null（对齐 HelperManager.loaded 语义）。
      loaded: installed ? running : null,
      needsRepair: installed && !ready,
      // 以下为 macOS 专属字段，Windows 恒默认值（消费方契约：先判 backgroundDisabled 再判 needsRepair）。
      backgroundDisabled: false,
      // 已知限制（review TS-H2，待真机/后续）：Windows 核更新（Portable 模式写 userData/core_update）后，服务 binPath
      // 仍指向安装时锁定的 sing-box，此处不检测漂移（恒 false）→ 不触发修复 gate。后续可比对服务 ImagePath 的 --singbox
      // 段 vs 当前 getSingBoxPath() 实现之；当前 Windows 核更新走 app 侧、非 helper，影响有限。
      pathMismatch: false,
      installedSingboxPath: null,
    };
  }

  // ── sing-box 启停（管道，零提权）──────────────────────────────────────────
  /** 经服务以 SYSTEM 启动 sing-box（已提权，无内层 UAC）。行6=父 app PID（父死看护）。 */
  async startCore(
    configPath: string,
    logPath: string,
    forward: boolean
  ): Promise<HelperStartResult> {
    try {
      await this.sendCommand(['stop'], 3000).catch(() => '');
      const resp = await this.sendCommand(
        ['start', configPath, logPath || '', forward ? '1' : '0', String(process.pid)],
        8000
      );
      const m = resp.match(/^OK (?:started|already) (\d+)/);
      if (m) return { ok: true, pid: parseInt(m[1], 10) };
      return { ok: false, error: resp || 'helper 无响应' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 经服务停止 sing-box（SYSTEM），零提权。 */
  async stopCore(): Promise<boolean> {
    try {
      const resp = await this.sendCommand(['stop'], 5000);
      return resp.startsWith('OK');
    } catch {
      return false;
    }
  }

  /** 经服务杀掉所有 sing-box（含孤儿），零提权。 */
  async cleanup(): Promise<boolean> {
    try {
      const resp = await this.sendCommand(['cleanup'], 5000);
      return resp.startsWith('OK');
    } catch {
      return false;
    }
  }

  /** 经服务按端口清占用者：是 sing-box 才杀，否则回报 foreign（不杀无辜，对齐 macOS v4）。 */
  async freePort(port: number): Promise<{ freed?: boolean; foreign?: string; error?: string }> {
    try {
      const resp = await this.sendCommand(['freeport', String(port)], 5000);
      if (resp.startsWith('OK free') || resp.startsWith('OK killed')) return { freed: true };
      const m = resp.match(/^OK foreign (.+)/);
      if (m) return { foreign: m[1].trim() };
      return { error: resp || 'helper 无响应' };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 服务当前是否在托管一个 sing-box（孤儿探测）。 */
  async coreStatus(): Promise<{ running: boolean; pid?: number }> {
    try {
      const resp = await this.sendCommand(['status'], 2000);
      const m = resp.match(/^OK running (\d+)/);
      return m ? { running: true, pid: parseInt(m[1], 10) } : { running: false };
    } catch {
      return { running: false };
    }
  }

  // ── 安装 / 卸载（一次 UAC）─────────────────────────────────────────────────
  /**
   * 安装/修复服务：生成随机 token + UAC 提权跑 sc create/start。
   * ⚠️ 真机必验：sc create binPath= 含空格路径的引号语义、helper.token ACL、UAC 取消回退、非管理员经已装服务起核。
   */
  async install(): Promise<{ success: boolean; error?: string; status: HelperStatus }> {
    if (!this.supported) {
      return {
        success: false,
        error: '仅 Windows 支持提权服务',
        status: await this.computeStatus(),
      };
    }
    this.mutationInFlight = true;
    try {
      const exe = resourceManager.getWinHelperPath();
      if (!fs.existsSync(exe)) {
        this.log('error', `helper 二进制缺失: ${exe}`);
        return {
          success: false,
          error: 'helper 二进制缺失（构建未包含）',
          status: await this.computeStatus(),
        };
      }
      const singboxPath = resourceManager.getSingBoxPath();
      const confDir = getUserDataPath();

      // token：复用已有，否则生成并写入客户端副本；UAC 脚本把同值写 SYSTEM 侧 helper.token。
      let token = this.token();
      if (!token) {
        token = randomBytes(16).toString('hex');
        try {
          fs.writeFileSync(this.tokenFilePath(), token);
        } catch (e) {
          return {
            success: false,
            error: `写入 token 失败: ${e instanceof Error ? e.message : String(e)}`,
            status: await this.computeStatus(),
          };
        }
      }

      const script = this.buildInstallScript(exe, singboxPath, confDir, token);
      const result = await this.runElevatedPowerShell(script);
      if (!result.success) {
        return { success: false, error: result.error, status: await this.computeStatus() };
      }

      // 等服务起来绑定管道，再确认就绪（对齐 macOS install 的 10×300ms 就绪等待）。
      let status = await this.computeStatus();
      for (let i = 0; i < 10 && !status.ready; i++) {
        await new Promise((r) => setTimeout(r, 300));
        status = await this.computeStatus();
      }
      if (status.ready) this.log('info', 'helper 服务安装并就绪');
      else this.log('warn', 'helper 服务已安装但未在预期内就绪');
      this.lastStableStatus = status;
      return { success: true, status };
    } finally {
      this.mutationInFlight = false;
    }
  }

  /**
   * 卸载服务。优先**管道 uninstall（零 UAC）**：helper 以 SYSTEM 收割 child → 派生旁路自停删服务 + 删 ProgramData
   * （含外置 helper.exe 自身 + helper.token，见 helper.go uninstall / winproc.go spawnSelfUninstall）→ 轮询确认服务真消失。
   * 管道不可用 / 自卸载未在预期内完成 → 回退**提权 PS（一次 UAC）**兜底（sc stop/delete + 删 ProgramData）。
   * 最后删客户端 token 副本。镜像「日常启停零提权」的同一 token 鉴权边界（卸载也走零提权主路径）。
   */
  async uninstall(): Promise<{ success: boolean; error?: string; status: HelperStatus }> {
    if (!this.supported) {
      return {
        success: false,
        error: '仅 Windows 支持提权服务',
        status: await this.computeStatus(),
      };
    }
    this.mutationInFlight = true;
    try {
      // 1) 管道自卸载（零 UAC）。仅 helper 就绪（有 token + 管道可达）时可行。
      let done = false;
      if (this.token()) {
        try {
          const resp = await this.sendCommand(['uninstall'], 5000);
          if (resp.startsWith('OK')) {
            // 自卸载是异步收尾（helper ~800ms 后自退 → 旁路 ping 延迟后 sc delete + rmdir，合计约 3-4s）。
            // 轮询至多 ~6s 确认服务真从 SCM 消失，再判成功，避免「OK 但服务残留」被当成功。
            for (let i = 0; i < 15; i++) {
              await new Promise((r) => setTimeout(r, 400));
              if (!(await this.queryService()).exists) {
                done = true;
                break;
              }
            }
          }
        } catch {
          /* 管道不可用（未装/未就绪/超时）→ 回退提权 */
        }
      }
      // 2) 回退：提权 PS（管道路径不可用，或自卸载未在预期内完成 → 诚实兜底，宁可一次 UAC 也要真卸干净）。
      if (!done) {
        const result = await this.runElevatedPowerShell(this.buildUninstallScript());
        if (!result.success) {
          return { success: false, error: result.error, status: await this.computeStatus() };
        }
      }
      try {
        fs.unlinkSync(this.tokenFilePath());
      } catch {
        /* 不存在则忽略 */
      }
      this.log(
        'info',
        done ? 'helper 服务经管道自卸载（零提权）' : 'helper 服务已卸载（提权兜底）'
      );
      const status = await this.computeStatus();
      this.lastStableStatus = status;
      return { success: true, status };
    } finally {
      this.mutationInFlight = false;
    }
  }

  // ── 提权脚本生成 + 执行 ────────────────────────────────────────────────────
  /** PowerShell 单引号字符串转义（'' 转义单引号；防注入）。 */
  private psq(s: string): string {
    return s.replace(/'/g, "''");
  }

  /**
   * 安装脚本体（在 runElevatedPowerShell 的 $ErrorActionPreference=Stop + try/catch 包裹内跑）：**锁目录 ACL**
   * （$support 去继承、仅 SYSTEM/Admin 私有，机密性的唯一来源）→ 删旧+写 token（继承目录锁、刻意不单独只读，否则
   * 重装 Set-Content 覆盖被拒——真机根因）→ 幂等清旧服务并**轮询等其真正消失** → **把 helper.exe 外置复制到
   * ProgramData 并锁 ACL**（U1，与 app 生命周期解耦的根因修复）→ New-Service **1072 退避重试**创建（BinaryPathName
   * 单一 .NET 字符串直达 CreateService，真双引号锁定 exe + 三参，默认 LocalSystem，Automatic 开机自启）→ sc start。
   * 全程幂等可重入：重装/修复覆盖旧 token、停删旧服务、覆盖旧外置副本，均能自愈已损状态。
   */
  private buildInstallScript(
    exe: string,
    singboxPath: string,
    confDir: string,
    token: string
  ): string {
    // 外置 helper.exe 到 ProgramData（U1，根因修复）：旧实现把服务 binPath 指向 **app 目录内**的 helper.exe，致
    //   ① app 更新：NSIS 覆盖被「正在运行的服务锁定」的 helper.exe → 占用失败/残留；
    //   ② app 卸载：NSIS 删 app 文件却留下仍指向已删路径的 SCM 服务（孤儿服务 + 残留 ProgramData token）。
    // 镜像 macOS「把 helper 复制出 .app 到 /Library/PrivilegedHelperTools」范式：安装期把 helper.exe 复制到
    // SUPPORT_DIR（ProgramData\FlowZ），服务 binPath 指向该**外置副本** → 二进制与 app 目录彻底解耦，
    // 更新随便覆盖 app、卸载由 helper 自卸载/NSIS 钩子清服务+ProgramData（见 helper.go uninstall / 卸载钩子）。
    // 用 path.win32.basename 取末段：exe 恒为 Windows 反斜杠路径，在 POSIX 测试宿主上普通 path.basename 不识别
    // 反斜杠会整串返回；win32 变体在两种宿主都正确剥出 com.flowz.helper.exe（与 getWinHelperPath 的名字保持耦合）。
    const helperDst = path.join(SUPPORT_DIR, path.win32.basename(exe));
    // BinaryPathName(ImagePath)：各含空格路径用**真双引号**包裹，经 New-Service 单一字符串直达 Win32 CreateService。
    // 不可用 `sc.exe create binPath= "\"..\""`：PS 原样把 `\"` 传给 sc → 服务启动经 CommandLineToArgvW 时 `\"`
    // 退化为字面引号 → 含空格安装路径（默认 C:\Program Files\FlowZ）下 argv 碎裂、flag 值带字面引号 → 服务侧
    // singboxBin/confDir/supportDir 全污染（isLockedSingbox/cfgAllowed/tokenValue 全失效）。
    // 注：binPath 指向 ProgramData 外置副本（$helperDst，无空格）；--singbox 仍可能含空格（app 安装目录）→ 仍需真双引号。
    const binPath = `"${helperDst}" --singbox "${singboxPath}" --confdir "${confDir}" --support "${SUPPORT_DIR}"`;
    const tokenFile = path.join(SUPPORT_DIR, 'helper.token');
    return [
      `$support = '${this.psq(SUPPORT_DIR)}'`,
      `$tokenFile = '${this.psq(tokenFile)}'`,
      `$helperSrc = '${this.psq(exe)}'`,
      `$helperDst = '${this.psq(helperDst)}'`,
      `$bp = '${this.psq(binPath)}'`,
      'New-Item -ItemType Directory -Force -Path $support | Out-Null',
      // 先锁**目录**ACL（防本地提权 + 闭 token TOCTOU）：ProgramData 默认 ACL 经继承给 Users「创建文件」+ 父级
      // FILE_DELETE_CHILD + CREATOR OWNER 完全控制 → 普通用户能删/替换这个以 SYSTEM 运行的 helper.exe（重启即 SYSTEM
      // 任意码执行，Pritunl/NetBird 同类 CVE）。文件级 ACL 挡不住：删子文件由父目录 FILE_DELETE_CHILD 授权，非文件自身
      // DACL。故去继承（清掉 CREATOR OWNER + Users 创建/删子权）、仅留 SYSTEM/Administrators 完全控制并以 (OI)(CI)
      // 下传 → 目录内 token/exe **出生即** SYSTEM/Admin 私有（Users 无任何访问：既不能替换 exe，也读不到 token，
      // 无「写后到设 ACL 之间 token 短暂可读」的竞态窗口）。对齐 macOS helper 落在 root-only 写的受保护目录。
      `& '${system32('icacls.exe')}' $support /inheritance:r | Out-Null`,
      `& '${system32('icacls.exe')}' $support /grant:r "SYSTEM:(OI)(CI)(F)" "Administrators:(OI)(CI)(F)" | Out-Null`,
      // 先删任何残留旧 token 再写：重装/修复时旧 token 可能是「Admin 只读」（旧版 ACL）或部分失败安装的残留，
      // 而 Set-Content 覆盖一个 Admin 只读的现存文件会被拒（真机实测「对…helper.token 的访问被拒绝」的根因）。
      // 经目录 Admin 的 FILE_DELETE_CHILD 删旧文件**不受其自身只读 DACL 阻挡** → 随后 Set-Content 必成（自愈已损状态）。
      'Remove-Item -Force -Path $tokenFile -ErrorAction SilentlyContinue',
      // 写 token（无 BOM ASCII）。机密性由**目录锁**保证（Users 对 $support 零访问，根本进不来读）→ token 继承目录的
      // SYSTEM/Admin 全权即可：SYSTEM 可读（服务鉴权用）、Admin 可写（**重装可覆盖**）。刻意不再单独给 token 上「只读」
      // ACL——只读对机密性零增益（Users 已被目录挡死），却会令重装时 Set-Content 覆盖被拒（即上面那个真机根因）。
      `Set-Content -Path $tokenFile -Value '${this.psq(token)}' -NoNewline -Encoding ascii`,
      // 幂等重装：停 + 删旧服务（按名）
      `& '${system32('sc.exe')}' stop ${SERVICE_NAME} 2>$null | Out-Null`,
      `& '${system32('sc.exe')}' delete ${SERVICE_NAME} 2>$null | Out-Null`,
      // sc delete 是异步「标记删除」（须等所有句柄关闭 + 进程停才移除）→ 轮询等服务真消失，否则 New-Service 撞
      // 1072 ERROR_SERVICE_MARKED_FOR_DELETE（重装真机高概率命中）。注：服务注销与进程映像完全解除映射之间仍有 ms 级
      // 窗口，故旧副本解锁**靠下方 Copy-Item 的退避重试兜底**、而非仅靠本轮询（勿据此误删重试）。
      '$deadline = (Get-Date).AddSeconds(15)',
      `while ((Get-Service -Name ${SERVICE_NAME} -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }`,
      // 外置复制（U1）：旧服务已停删 → ProgramData 旧副本（若有）已解锁 → -Force 覆盖。带退避重试兜「文件仍被占用」
      // 的解锁窗口竞态（sc delete 后进程退出有微小延迟）。失败 fail-loud（不静默留旧副本跑老逻辑）。
      '$copied = $false',
      'for ($i = 0; $i -lt 10 -and -not $copied; $i++) {',
      '  try { Copy-Item -LiteralPath $helperSrc -Destination $helperDst -Force; $copied = $true }',
      '  catch { Start-Sleep -Milliseconds 300 }',
      '}',
      'if (-not $copied) { throw "复制 helper.exe 到 ProgramData 失败（旧服务二进制可能仍被占用，请稍后重试或重启后再装）" }',
      // 显式收紧外置副本 ACL（兜底）：目录已锁 SYSTEM/Admin 私有、本副本继承之即足够；这里再去继承 + 仅 SYSTEM/Admin
      // 完全控制，确保 Users 对这个**以 SYSTEM 运行**的二进制零访问（不可写/不可替换 → 杜绝本地提权）。
      `& '${system32('icacls.exe')}' $helperDst /inheritance:r | Out-Null`,
      `& '${system32('icacls.exe')}' $helperDst /grant:r "SYSTEM:(F)" "Administrators:(F)" | Out-Null`,
      // New-Service 退避重试兜底（删除标记态 1072 窗口期）：BinaryPathName 单一字符串直达 CreateService；
      // 默认账户即 LocalSystem；-StartupType Automatic = 开机自启常驻（app 全程只发管道命令、不 start/stop 服务）。
      '$created = $false',
      '$lastErr = $null',
      'for ($i = 0; $i -lt 10 -and -not $created; $i++) {',
      `  try { New-Service -Name ${SERVICE_NAME} -BinaryPathName $bp -StartupType Automatic | Out-Null; $created = $true }`,
      '  catch { $lastErr = $_; Start-Sleep -Milliseconds 500 }',
      '}',
      // 失败抛**真实异常**（不用硬编码 1072 文案盖掉真因——非 1072 失败如路径非法/权限也要透出真原因，闭合 MED-2）
      `if (-not $created) { throw "New-Service 失败（重试 10 次；多为 sc delete 标记删除态 1072 竞态，若持续请重启）：$($lastErr.Exception.Message)" }`,
      `& '${system32('sc.exe')}' start ${SERVICE_NAME} | Out-Null`,
    ].join('\n');
  }

  /** 卸载脚本体（在 runElevatedPowerShell 的 Stop + try/catch 包裹内跑）：停 + 删服务 + 删受保护 token/目录。
   *  对「服务/目录不存在」容错（sc 外部命令不受 Stop 影响、不抛；Remove-Item 显式 SilentlyContinue）。 */
  private buildUninstallScript(): string {
    return [
      `& '${system32('sc.exe')}' stop ${SERVICE_NAME} 2>$null | Out-Null`,
      'Start-Sleep -Milliseconds 300',
      `& '${system32('sc.exe')}' delete ${SERVICE_NAME} 2>$null | Out-Null`,
      `Remove-Item -Recurse -Force -Path '${this.psq(SUPPORT_DIR)}' -ErrorAction SilentlyContinue`,
    ].join('\n');
  }

  /**
   * 以一次 UAC 跑 PowerShell 脚本：写临时 .ps1 → 外层 Start-Process -Verb RunAs -Wait 触发 UAC。
   * 内层以 $ErrorActionPreference=Stop + try/catch 包裹脚本体：成功写 flag "0"；失败把**异常信息**写 .err + flag "1"，
   * 供 app 回传具体失败原因（对齐「失败须带原因」——否则只见「退出码 N」无法区分 1072 竞态 / 路径错 / ACL 失败）。
   * UAC 取消 → Start-Process 抛错 → 外层 exit 1。
   * ⚠️ 真机必验：UAC 弹窗/取消、-Wait 完成语义、flag/err 回写时序、sc delete→New-Service 重装竞态命中率。
   */
  private runElevatedPowerShell(inner: string): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const stamp = randomBytes(6).toString('hex');
      const scriptPath = path.join(os.tmpdir(), `flowz-helper-${stamp}.ps1`);
      const flagPath = path.join(os.tmpdir(), `flowz-helper-${stamp}.done`);
      const errPath = path.join(os.tmpdir(), `flowz-helper-${stamp}.err`);
      const script = [
        "$ErrorActionPreference = 'Stop'",
        'try {',
        inner,
        `  "0" | Out-File -FilePath '${this.psq(flagPath)}' -Encoding ascii`,
        '} catch {',
        // 用 .NET WriteAllText（默认 UTF-8 无 BOM）写异常信息——避免 PS5.1 `Out-File -Encoding utf8` 的 BOM
        // 在 app 回传文案前残留零宽字符（MED-B）。
        `  [System.IO.File]::WriteAllText('${this.psq(errPath)}', $_.Exception.Message)`,
        `  "1" | Out-File -FilePath '${this.psq(flagPath)}' -Encoding ascii`,
        '}',
      ].join('\n');
      try {
        fs.writeFileSync(scriptPath, script, 'utf8');
      } catch (e) {
        return resolve({ success: false, error: `写入提权脚本失败: ${String(e)}` });
      }
      const outer =
        `try { Start-Process '${powershellPath()}' -Verb RunAs -WindowStyle Hidden -Wait ` +
        `-ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${this.psq(scriptPath)}'; exit 0 } ` +
        `catch { exit 1 }`;
      execFile(
        powershellPath(),
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer],
        { timeout: 120000, windowsHide: true },
        (err) => {
          let success = false;
          let error: string | undefined;
          if (err) {
            error = 'UAC 取消或提权失败';
          } else {
            let code = '';
            try {
              code = fs.readFileSync(flagPath, 'utf8').trim();
            } catch {
              /* 未写回 */
            }
            if (code === '0') {
              success = true;
            } else {
              let detail = '';
              try {
                detail = fs.readFileSync(errPath, 'utf8').trim();
              } catch {
                /* 无具体原因 */
              }
              error =
                detail ||
                (code === '' ? '提权脚本未写回结果（可能被取消）' : `提权脚本失败（码 ${code}）`);
            }
          }
          for (const p of [scriptPath, flagPath, errPath]) {
            try {
              fs.unlinkSync(p);
            } catch {
              /* ignore */
            }
          }
          resolve({ success, error });
        }
      );
    });
  }
}
