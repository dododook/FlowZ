/**
 * Linux 提权 helper 管理器（systemd system service）。
 *
 * 解决：Linux TUN 模式每次启停 sing-box（含切节点重启）都弹 pkexec 授权框——根因是 setcap 把能力挂在会被换核/更新
 *       替换的二进制 inode 上（security.capability xattr 随 inode 蒸发）。
 * 方案：一次性把一个 root helper 装成 systemd system service（见 helper-linux/），之后 app 经 SO_PEERCRED 鉴权的
 *       unix socket 零提权驱动 sing-box 启停。helper 收到 start 后 setuid 回**发起的登录用户** + AmbientCaps=
 *       CAP_NET_ADMIN 拉核——能力挂进程 ambient set 不挂文件，故换核/软件更新后**无需再次授权、无需 setcap**。
 *
 * 与 macOS HelperManager 的差异（见 docs/design/flowz-linux-privileged-helper.md）：
 *   - 无 token：Linux 用 SO_PEERCRED（内核背书对端 uid）鉴权，行协议首行即命令、无鉴权行。
 *   - **核在 root-owned 受管目录**（/usr/local/lib/flowz/core，安装时播种、install-core hash 校验更新），与 macOS
 *     受保护目录一致：核不可被普通用户篡改，一份共享、版本一致。helper 只跑锁定 coreDir/sing-box（路径锁）→ 根除
 *     「借 helper 给任意自有二进制赋 CAP_NET_ADMIN」的提权面。换核经 install-core 免密（socket 调用，无 pkexec）。
 *   - config/cache/log 仍按用户在 userData（核以登录用户跑，属主天然对）。
 *
 * 仅 linux 有意义；其余平台所有方法安全降级（supported=false / ready=false）。未装时由 ProxyManager 回退到
 * PlatformPrivilegeService.ensureCapabilities（setcap+pkexec，现状），零回归。
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import type { HelperStatus } from '../../shared/types';
import type { IPrivilegedHelper, HelperStartResult } from './IPrivilegedHelper';
import type { ILogManager } from './LogManager';
import { resourceManager } from './ResourceManager';
import { getUserDataPath } from '../utils/paths';
import { shq } from '../utils/shell-quote';
import { sha256File } from '../../shared/file-hash';

const SERVICE_NAME = 'flowz-helper.service';
// 受管安装根（避开 /opt/FlowZ —— 那是 electron-builder deb 的应用目录，混放会与 dpkg 生命周期冲突）。
// FHS：本地管理员安装的软件归 /usr/local。helper 二进制 + root-owned 受管核都在此。
const INSTALL_DIR = '/usr/local/lib/flowz';
const HELPER_DEST = `${INSTALL_DIR}/flowz-helper`;
// root-owned 受管核目录（root:root 0755，普通用户改不动）：安装时播种随包核、install-core hash 校验更新。
// helper 只跑此目录内的 sing-box（路径锁），与 macOS 受保护目录 / Windows 锁定 --singbox 一致。
const CORE_DIR = `${INSTALL_DIR}/core`;
const CORE_BIN = `${CORE_DIR}/sing-box`;
const UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}`;
const STATE_DIR = '/var/lib/flowz';
const AUTH_FILE = `${STATE_DIR}/authorized-uids`;
const RUNTIME_DIR = '/run/flowz';
const SOCKET_PATH = `${RUNTIME_DIR}/helper.sock`;
// 与 helper-linux protoVersion 对应。proto ≥ MIN_USABLE 即 TUN 功能齐全；MIN_USABLE ≤ proto < EXPECTED → upgradeable
// （温和提示可升级）。v1 起 EXPECTED===MIN，故 upgradeable 恒 false（无历史包袱，尚无更旧可用版本）——**将来 helper 协议
// 加不兼容能力时，须把 EXPECTED_PROTO 提到新版号**，upgradeable 分支才会点亮「可升级」提示（对齐 Windows 同惯例）。
const EXPECTED_PROTO = 1;
const MIN_USABLE_PROTO = 1;

export class LinuxServiceHelper implements IPrivilegedHelper {
  constructor(private logManager?: ILogManager | null) {}

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.logManager?.addLog(level, message, 'Helper');
  }

  private get supported(): boolean {
    return process.platform === 'linux';
  }

  // ── socket 客户端（行协议：cmd\n [args...]；鉴权走 SO_PEERCRED，无 token 行）────────────────
  private sendCommand(rest: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(SOCKET_PATH);
      let buf = '';
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('helper socket 超时'));
      }, timeoutMs);
      sock.on('connect', () => {
        sock.end(rest.join('\n') + '\n');
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

  // ── 状态探测 ─────────────────────────────────────────────────────────────
  private filesPresent(): boolean {
    try {
      return fs.existsSync(HELPER_DEST) && fs.existsSync(UNIT_PATH);
    } catch {
      return false;
    }
  }

  /** 快速判定能否零提权驱动（ProxyManager 启动路由用）。 */
  async isReady(): Promise<boolean> {
    if (!this.supported || !this.filesPresent()) return false;
    try {
      const resp = await this.sendCommand(['ping'], 1500);
      const m = resp.match(/^OK pong uid=\d+ v(\d+)/);
      return !!m && parseInt(m[1], 10) >= MIN_USABLE_PROTO;
    } catch {
      return false;
    }
  }

  /** 完整状态：供设置页展示 + 安装/卸载按钮判态。backgroundDisabled/pathMismatch 为 macOS 专属，Linux 恒默认值。 */
  async getStatus(): Promise<HelperStatus> {
    if (!this.supported) {
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
    const installed = this.filesPresent();
    let version: string | null = null;
    let ready = false;
    let upgradeable = false;
    if (installed) {
      try {
        const resp = await this.sendCommand(['ping'], 1500);
        const m = resp.match(/^OK pong uid=\d+ v(\d+)/);
        if (m) {
          version = m[1];
          const pv = parseInt(version, 10);
          ready = !isNaN(pv) && pv >= MIN_USABLE_PROTO;
          upgradeable = ready && pv < EXPECTED_PROTO;
        }
      } catch {
        /* 未就绪：装了 unit 但 daemon 没起来（如刚 reboot 未起、被 mask）→ needsRepair 引导重装 */
      }
    }
    return {
      supported: true,
      installed,
      ready,
      upgradeable,
      version,
      loaded: installed ? true : null,
      needsRepair: installed && !ready,
      backgroundDisabled: false,
      pathMismatch: false,
      installedSingboxPath: null,
    };
  }

  // ── sing-box 启停（socket，零提权）────────────────────────────────────────
  /** 经 helper 启动 sing-box（以对端登录用户 + CAP_NET_ADMIN）。singbox 路径由 resourceManager 取——helper 就绪时
   *  getSingBoxPath 返回 root 受管核（coreDir/sing-box）；helper 侧路径锁校验 singbox==coreDir/sing-box、config 属主==对端 uid。 */
  async startCore(
    configPath: string,
    logPath: string,
    forward: boolean
  ): Promise<HelperStartResult> {
    try {
      await this.sendCommand(['stop'], 3000).catch(() => ''); // 幂等清残留旧 child
      const singbox = resourceManager.getSingBoxPath();
      const resp = await this.sendCommand(
        ['start', singbox, configPath, logPath || '', forward ? '1' : '0', String(process.pid)],
        8000
      );
      const m = resp.match(/^OK (?:started|already) (\d+)/);
      if (m) return { ok: true, pid: parseInt(m[1], 10) };
      return { ok: false, error: resp || 'helper 无响应' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async stopCore(): Promise<boolean> {
    try {
      const resp = await this.sendCommand(['stop'], 5000);
      return resp.startsWith('OK');
    } catch {
      return false;
    }
  }

  async cleanup(): Promise<boolean> {
    try {
      const resp = await this.sendCommand(['cleanup'], 5000);
      return resp.startsWith('OK');
    } catch {
      return false;
    }
  }

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

  async coreStatus(): Promise<{ running: boolean; pid?: number }> {
    try {
      const resp = await this.sendCommand(['status'], 2000);
      const m = resp.match(/^OK running (\d+)/);
      return m ? { running: true, pid: parseInt(m[1], 10) } : { running: false };
    } catch {
      return { running: false };
    }
  }

  // 出口托管路由 / 停核补默认路由：macOS 专属善后，Linux 暂不需要 → no-op（proto 语义等价旧 helper 的 ERR unknown）。
  async routeAdd(_iface: string, _cidrs: string[]): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'unsupported' };
  }
  async routeDel(_iface: string, _cidrs: string[]): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'unsupported' };
  }
  async restoreDefaultRoute(_gateway: string): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'unsupported' };
  }

  // ── 换核（install-core，socket 零提权）────────────────────────────────────
  /** 经 helper（root）把 srcDir（含 sing-box + libcronet）hash 校验后原子写入锁定的 root 受管核目录。换核/更新免密
   *  （socket 调用，无 pkexec）；helper 侧只写锁定 coreDir、sha256 校验主二进制防 TOCTOU。CoreUpdateService 落位时调。 */
  async installCore(srcDir: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const hash = sha256File(path.join(srcDir, 'sing-box'));
      const resp = await this.sendCommand(['install-core', srcDir, hash], 30_000);
      return resp.startsWith('OK') ? { ok: true } : { ok: false, error: resp };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── 安装 / 卸载（pkexec 一次授权）─────────────────────────────────────────
  /** 安装/修复 helper：pkexec 以 root 跑安装脚本（拷二进制 + 写授权 uid + 装 systemd unit + enable --now，弹一次密码框）。 */
  async install(): Promise<{ success: boolean; error?: string; status: HelperStatus }> {
    if (!this.supported) {
      return {
        success: false,
        error: '仅 Linux 支持 systemd helper',
        status: await this.getStatus(),
      };
    }
    const srcBinary = resourceManager.getLinuxHelperPath();
    if (!fs.existsSync(srcBinary)) {
      this.log('error', `helper 二进制缺失: ${srcBinary}`);
      return {
        success: false,
        error: 'helper 二进制缺失（构建未包含）',
        status: await this.getStatus(),
      };
    }
    // 授权 uid = 当前登录用户（app 进程 uid）。以 root 跑整 app 时 getuid()===0，helper 侧 root 恒授权。
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const bundledCore = resourceManager.getBundledSingBoxPath(); // 受管核种子源（随包核）

    const result = await this.runPkexecScript(
      'flowz-linux-helper-install.sh',
      this.buildInstallScript(srcBinary, uid, bundledCore)
    );
    if (!result.success) {
      return { success: false, error: result.error, status: await this.getStatus() };
    }
    // 等 daemon 起来绑定 socket，再确认就绪
    let status = await this.getStatus();
    for (let i = 0; i < 10 && !status.ready; i++) {
      await new Promise((r) => setTimeout(r, 300));
      status = await this.getStatus();
    }
    if (status.ready) this.log('info', 'helper 安装并就绪');
    else this.log('warn', 'helper 已安装但未在预期内就绪');
    return { success: true, status };
  }

  /** 卸载 helper：pkexec 以 root 停服务 + 删 unit / 二进制 / 授权文件 / 运行目录（弹一次密码框）。 */
  async uninstall(): Promise<{ success: boolean; error?: string; status: HelperStatus }> {
    if (!this.supported) {
      return {
        success: false,
        error: '仅 Linux 支持 systemd helper',
        status: await this.getStatus(),
      };
    }
    const result = await this.runPkexecScript(
      'flowz-linux-helper-uninstall.sh',
      this.buildUninstallScript()
    );
    if (!result.success) {
      return { success: false, error: result.error, status: await this.getStatus() };
    }
    this.log('info', 'helper 已卸载');
    return { success: true, status: await this.getStatus() };
  }

  // ── 脚本生成 ─────────────────────────────────────────────────────────────
  private buildUnit(): string {
    // helper 本体以 root 跑（无 User=）：需 root 才能 setuid 拉 child + 穿越登录用户 userData 校验/重定向。child 的
    // CAP_NET_ADMIN 由 helper 代码经 SysProcAttr.AmbientCaps 赋予（不在 unit 层）。CapabilityBoundingSet 收紧留待
    // 真机验证后加（P3；过早收紧易踩 setuid/chown/dac_override 缺失）。singbox/authfile 路径不烧进 unit（多用户）。
    return `[Unit]
Description=FlowZ privileged network helper
Documentation=https://github.com/dododook/FlowZ
After=network.target

[Service]
Type=simple
ExecStart=${HELPER_DEST} --socket=${SOCKET_PATH} --authfile=${AUTH_FILE} --coredir=${CORE_DIR}
RuntimeDirectory=flowz
RuntimeDirectoryMode=0755
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
  }

  private buildInstallScript(srcBinary: string, uid: number, bundledCore: string): string {
    // 单脚本一次 pkexec：拷 helper 二进制 → 播种 root 受管核（仅当尚无核，重装/修复不覆盖已 install-core 更新的核）
    // → 授权 uid **合并追加**（不覆写：多用户各自装/修复不互相抹掉授权）→ 装 unit → daemon-reload → enable --now。
    // uid 已是数字，安全内插。libcronet 若随包（naive 出站需）随核一并播种。
    const bundledDir = path.dirname(bundledCore);
    const bundledCronet = path.join(bundledDir, 'libcronet.so');
    return `#!/bin/sh
set -e
install -D -o root -g root -m 0755 ${shq(srcBinary)} ${shq(HELPER_DEST)}
mkdir -p ${shq(CORE_DIR)}
chown root:root ${shq(CORE_DIR)}
chmod 0755 ${shq(CORE_DIR)}
if [ ! -x ${shq(CORE_BIN)} ]; then
  install -o root -g root -m 0755 ${shq(bundledCore)} ${shq(CORE_BIN)}
  [ -f ${shq(bundledCronet)} ] && install -o root -g root -m 0755 ${shq(bundledCronet)} ${shq(CORE_DIR + '/libcronet.so')} || true
fi
mkdir -p ${shq(STATE_DIR)}
chmod 0755 ${shq(STATE_DIR)}
touch ${shq(AUTH_FILE)}
chmod 0644 ${shq(AUTH_FILE)}
grep -qxF '${uid}' ${shq(AUTH_FILE)} || printf '%s\\n' '${uid}' >> ${shq(AUTH_FILE)}
cat > ${shq(UNIT_PATH)} <<'FLOWZ_UNIT_EOF'
${this.buildUnit()}FLOWZ_UNIT_EOF
chmod 0644 ${shq(UNIT_PATH)}
systemctl daemon-reload
systemctl enable --now ${SERVICE_NAME}
echo flowz-helper-install-ok
`;
  }

  private buildUninstallScript(): string {
    // 对称清理：停服务 + 删 unit + 删受管安装根（helper 二进制 + root 核）+ 状态/运行目录。INSTALL_DIR 是 flowz 专属
    // 目录（/usr/local/lib/flowz），整删安全，不碰 deb 的 /opt/FlowZ。
    return `#!/bin/sh
systemctl disable --now ${SERVICE_NAME} 2>/dev/null || true
rm -f ${shq(UNIT_PATH)}
rm -rf ${shq(INSTALL_DIR)} ${shq(STATE_DIR)} ${shq(RUNTIME_DIR)}
systemctl daemon-reload 2>/dev/null || true
echo flowz-helper-uninstall-ok
`;
  }

  /** 写脚本到 userData 后用 pkexec 以 root 执行（弹一次密码框）。区分取消/无认证代理(126)与命令缺失(127)。 */
  private runPkexecScript(
    name: string,
    script: string
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      let scriptPath: string;
      try {
        scriptPath = path.join(getUserDataPath(), name);
        fs.writeFileSync(scriptPath, script, { mode: 0o755 });
      } catch (e) {
        resolve({ success: false, error: e instanceof Error ? e.message : String(e) });
        return;
      }
      const proc = spawn('/usr/bin/pkexec', ['/bin/sh', scriptPath]);
      let stderr = '';
      proc.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('exit', (code) => {
        try {
          fs.unlinkSync(scriptPath);
        } catch {
          /* 忽略 */
        }
        if (code === 0) resolve({ success: true });
        else if (code === 126)
          resolve({ success: false, error: '授权被取消或系统缺少 polkit 认证代理' });
        else if (code === 127) resolve({ success: false, error: '系统缺少 pkexec（polkit）' });
        else resolve({ success: false, error: stderr.trim() || `pkexec 退出码 ${code}` });
      });
      proc.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });
    });
  }
}
