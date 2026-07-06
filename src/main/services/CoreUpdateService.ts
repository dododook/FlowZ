/**
 * 核心更新服务
 * 负责检查 Sing-box 核心更新、下载并替换
 */

import { app, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { LogManager } from './LogManager';
import { ProxyManager } from './ProxyManager';
import type { HelperManager } from './HelperManager';
import { PlatformPrivilegeService } from './PlatformPrivilegeService';
import { resourceManager } from './ResourceManager';

import type { UserConfig, HelperStatus } from '../../shared/types';
import { encodeMajorMinor, sameMajorMinor, compareSemver } from '../../shared/version';
import {
  classifyCoreBuild,
  comparableCoreVersion,
  decideCoreOverride,
  parseUploadedCoreVersion,
  type CoreBuildKind,
} from '../../shared/core-build';
import { CoreUpdateStateStore } from './core-update-state-store';
import type { StagedCoreInfo, CoreAutoUpdateState } from './core-update-state-store';
import { CoreDownloader } from './core-downloader';
import type { UpdateNetwork } from './UpdateNetwork';
import coreManifest from '../../shared/core-manifest.json';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { system32, powershellPath } from '../utils/win-system32';

export interface CoreUpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  crossBand?: boolean; // latestVersion 是否跨当前 minor 带（restrict 关闭时让 UI 标「跨大版本、风险更高」）
  error?: string;
}

export interface CoreVersionInfo {
  currentVersion: string;
  backupVersion: string | null;
  hasBackup: boolean;
  lastKnownVersion: string | null;
  // 内核来源：official=官方 / fork=第三方（禁在线·自动更新）/ unknown=无法确认（仅提示）。
  build: CoreBuildKind;
}

// StagedCoreInfo / CoreAutoUpdateState 迁至 core-update-state-store（与 CoreUpdateStateStore 同处）；re-export 保对外兼容。
export type { StagedCoreInfo, CoreAutoUpdateState };

/**
 * tryApplyStaged 落位结果枚举（供 applyStagedNow / UI 区分反馈）：
 * - applied:   已换核落位成功（installCoreFromDir 完成、staged 已清）
 * - discarded: staged 已不适用被作废（不再领先 / known-bad / 缺文件 / 重预检失败），未换核
 * - deferred:  代理运行中暂不落位，保持 staged（待安全窗口生效）；或开关已关不自动落位
 * - failed:    落位中途异常（已尽力 restoreBackup），staged 保留待重试
 * - noop:      无 staged 可落位 / isUpdating 重入 → 无操作
 */
export type StagedApplyResult = 'applied' | 'discarded' | 'deferred' | 'failed' | 'noop';

/** 推渲染端的内核自动更新状态快照（UI：待生效行 / 跨带提示行）。 */
export interface CoreAutoStatus {
  autoUpdateEnabled: boolean;
  lastCheckAt: number | null;
  staged: { version: string; stagedAt: string } | null;
  crossBandLatest: string | null; // 检测到但跨 minor、不自动的最新版本
}

/**
 * 兼容版本带「地板」= 随 App 出厂的内核版本带（编码 major*1000+minor，1.13.13→1013）。出厂内核必经 FlowZ
 * 配置生成器验证，故其版本带即官方背书的兼容下限，**从出厂内核动态推导、不再独立硬编码**（去掉了 manifest 的
 * compatibleCeiling 字段，消除「两字段手动同步」隐患）。有效兼容上限 = max(地板, 当前实跑带, verifiedCeiling)，
 * 见 checkUpdate；跨越有效上限默认不自动更新（可在设置关闭）。
 */
const BUNDLED_CEILING = encodeMajorMinor(coreManifest.bundledCoreVersion);

export class CoreUpdateService {
  private logManager: LogManager;
  private proxyManager: ProxyManager | null = null;
  // helper 的 install-core 能力窄视图（mac HelperManager / linux LinuxServiceHelper 均满足 getStatus+installCore；
  // Windows 无 install-core）。B 块：经 helper install-core 写 root 受保护/受管核目录。
  private helperManager: Pick<HelperManager, 'getStatus' | 'installCore'> | null = null;
  private privilegeService: PlatformPrivilegeService | null = null; // T16：copyFileElevatedWindows delegate
  private isUpdating: boolean = false;
  // 更新后等待「首次成功运行」验证的新版本号；首启成功→清除并删备份，首启失败→自动回滚
  private pendingUpdateVersion: string | null = null;
  private pendingUpdateAt: number = 0; // 更新落盘时间戳，用于"待验证"过期保护（防陈旧 pending 误回滚）
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  // 兜底计时器：更新后若迟迟无 'started'/'error' 事件来解决待验证态（如更新时代理未运行、用户不重启），
  // 到期解除自动重启抑制，避免抑制闩永久挂起。
  private pendingFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private configProvider: (() => Promise<UserConfig>) | null = null;
  // 推渲染端的自动更新状态事件发送器（注入，仿 configProvider；不直接 import electron ipc 便于隔离）
  private eventSender: ((channel: string, payload: unknown) => void) | null = null;
  // 新核心首启成功后需"稳定运行"此时长（无 error）才删旧备份——防 'started'(仅1s存活) 假成功删掉回滚网。
  // 不变量：必须 > ProxyManager 健康检查间隔(10s)，否则 TUN 模式下崩溃在轮询检测到之前就被判稳定、误删备份。
  private static readonly STABILITY_DWELL_MS = 30000;
  // "待验证"最长有效期：超过则后续 error 视为与本次更新无关，不再触发回滚（防陈旧 pending 误回滚）
  private static readonly PENDING_MAX_AGE_MS = 5 * 60 * 1000;

  private readonly stateStore: CoreUpdateStateStore;
  private readonly coreDownloader: CoreDownloader;

  constructor(logManager: LogManager) {
    this.logManager = logManager;
    this.stateStore = new CoreUpdateStateStore(logManager, app.getPath('userData'));
    // configProvider 在构造后才注入，故传惰性 thunk：调用时读当前 this.configProvider（未配置→null）。
    this.coreDownloader = new CoreDownloader(logManager, () =>
      this.configProvider ? this.configProvider() : Promise.resolve(null)
    );
  }

  setProxyManager(proxyManager: ProxyManager): void {
    this.proxyManager = proxyManager;
  }

  /** §8：把更新链路统一会话层转发给 CoreDownloader（核更新链路接入 update-in）；proxyRunning/update-in 端口惰性读 this.proxyManager。 */
  setUpdateNetwork(updateNetwork: UpdateNetwork): void {
    this.coreDownloader.setUpdateNetwork(updateNetwork);
  }

  /** B 块：注入 helper（macOS/Linux 持久化内核更新经 helper install-core 写 root 受保护/受管核目录）。 */
  setHelperManager(helperManager: Pick<HelperManager, 'getStatus' | 'installCore'>): void {
    this.helperManager = helperManager;
  }

  /** T16：注入平台提权服务（copyFileElevatedWindows delegate → service.copyFileElevated）。 */
  setPrivilegeService(service: PlatformPrivilegeService): void {
    this.privilegeService = service;
  }

  /** 注入配置读取器（用于读取"仅兼容版本带内更新"开关）。 */
  setConfigProvider(provider: () => Promise<UserConfig>): void {
    this.configProvider = provider;
  }

  /** 注入渲染端事件发送器（推内核自动更新状态：staged 待生效 / 跨带提示）。 */
  setEventSender(fn: (channel: string, payload: unknown) => void): void {
    this.eventSender = fn;
  }

  /**
   * 检查核心更新
   */
  async checkUpdate(): Promise<CoreUpdateCheckResult> {
    try {
      this.logManager.addLog('info', '正在检查 Sing-box 核心更新...', 'CoreUpdateService');

      const currentVersion = await this.getCurrentVersion();

      // 第三方（非官方）内核：禁在线更新（不打 GitHub），避免覆盖用户刻意安装的 fork。
      // 自动调度经 runAutoUpdateCycle→checkUpdate 同被此闸拦下（=自动更新对 fork 失效）。
      if ((await this.getCoreBuild()) === 'fork') {
        this.logManager.addLog(
          'info',
          '检测到第三方（非官方）内核，已禁用在线检查更新',
          'CoreUpdateService'
        );
        return {
          hasUpdate: false,
          currentVersion,
          error:
            '当前为第三方（非官方）内核，已禁用在线更新；如需恢复官方更新，请先回滚或重置到出厂内核',
        };
      }

      const releases = await this.coreDownloader.fetchReleases();

      if (!releases || releases.length === 0) {
        return { hasUpdate: false, currentVersion, error: '未找到发布版本' };
      }

      // 过滤出正式版 (非 prerelease)
      const validReleases = releases.filter((r: any) => !r.prerelease);
      if (validReleases.length === 0) {
        return { hasUpdate: false, currentVersion, error: '未找到正式版本' };
      }

      const latestRelease = validReleases[0];
      // release tag 通常是 v1.8.0 格式，去掉 v
      const latestVersion = latestRelease.tag_name.replace(/^v/, '');

      this.logManager.addLog(
        'info',
        `当前版本: ${currentVersion}, 最新版本: ${latestVersion}`,
        'CoreUpdateService'
      );

      if (this.compareVersions(latestVersion, currentVersion) > 0) {
        // 跳过曾预检/启动失败的问题版本（手动更新可绕过）
        if (this.isKnownBad(latestVersion)) {
          this.logManager.addLog(
            'info',
            `最新版本 ${latestVersion} 曾验证失败，已跳过自动更新`,
            'CoreUpdateService'
          );
          return {
            hasUpdate: false,
            currentVersion,
            latestVersion,
            error: `版本 ${latestVersion} 与当前配置不兼容（已跳过）；如需仍可手动更新`,
          };
        }

        // 版本带闸门：默认不自动跨越「有效兼容上限」（防 schema 破坏导致无法解析）。有效上限 =
        // max(出厂内核带, 当前实跑带, verifiedCeiling)——出厂带是官方背书地板；当前实跑带 + verifiedCeiling 是
        // 「已成功运行实证兼容」的带，使手动跨带成功后不被锁在首版、放行同带补丁；preflightValidate 每次仍兜底，
        // 与自动闸 sameMajorMinor 的 current 基准统一。地板守住「首次跨带仍需用户主动」。
        if (await this.isRestrictToCompatibleMinor()) {
          const latest = encodeMajorMinor(latestVersion);
          const curEnc = encodeMajorMinor(currentVersion);
          const verified = this.loadAutoState().verifiedCeiling ?? 0;
          const effectiveCeiling = Math.max(BUNDLED_CEILING, isNaN(curEnc) ? 0 : curEnc, verified);
          if (!isNaN(latest) && latest > effectiveCeiling) {
            this.logManager.addLog(
              'info',
              `最新版本 ${latestVersion} 跨越当前兼容版本带，不自动更新`,
              'CoreUpdateService'
            );
            return {
              hasUpdate: false,
              currentVersion,
              latestVersion,
              error: `新版本 ${latestVersion} 跨越兼容版本带，建议随 App 升级（可在设置关闭"仅兼容版本带内更新"以手动尝试）`,
            };
          }
        }

        // 找到适合当前平台的资源
        const asset = this.coreDownloader.findSuitableAsset(latestRelease.assets);
        if (asset) {
          const result = {
            hasUpdate: true,
            currentVersion,
            latestVersion,
            downloadUrl: asset.browser_download_url,
            releaseNotes: latestRelease.body,
            // 跨当前 minor 带（如 1.13→1.14）→ UI 标风险。能走到这说明带内或 restrict 关闭，跨带必是 restrict 关闭所致。
            crossBand: !sameMajorMinor(latestVersion, currentVersion),
          };
          this.logManager.addLog(
            'info',
            `Found suitable asset: ${asset.browser_download_url}`,
            'CoreUpdateService'
          );
          return result;
        } else {
          const msg = `未找到适合当前平台的构建 (Platform: ${process.platform}, Arch: ${process.arch})`;
          this.logManager.addLog('warn', msg, 'CoreUpdateService');
          return { hasUpdate: false, currentVersion, error: msg };
        }
      }

      return { hasUpdate: false, currentVersion };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logManager.addLog('error', `检查核心更新失败: ${msg}`, 'CoreUpdateService');
      return { hasUpdate: false, currentVersion: '未知', error: msg };
    }
  }

  /**
   * 执行更新
   */
  async updateCore(downloadUrl: string): Promise<boolean> {
    if (this.isUpdating) {
      throw new Error('更新正在进行中');
    }

    // 第三方（非官方）内核：拒绝在线更新，避免覆盖用户刻意安装的 fork。force 刷新版本行（本方法守卫前无 getCurrentVersion）。
    if ((await this.getCoreBuild(true)) === 'fork') {
      throw new Error(
        '当前为第三方（非官方）内核，已禁用在线更新；请先回滚或重置到出厂内核后再更新'
      );
    }

    this.isUpdating = true;
    let backupMade = false;

    try {
      // 1. 下载文件
      this.logManager.addLog('info', '开始下载核心文件...', 'CoreUpdateService');
      const tempPath = await this.coreDownloader.downloadFile(downloadUrl);

      // 2. 解压文件 (如果需要)
      // Sing-box release 通常是 .tar.gz 或 .zip
      this.logManager.addLog('info', '正在解压核心文件...', 'CoreUpdateService');
      const { corePath, extractDir: tempExtractDir } =
        await this.coreDownloader.extractCore(tempPath);

      // 2.5 预检：新核心可执行 + 可解析当前配置。不通过则不动现役核心（代理继续运行，永不 brick）。
      const preflight = await this.preflightValidate(corePath);
      if (!preflight.ok) {
        if (preflight.version) this.markKnownBad(preflight.version);
        try {
          fs.unlinkSync(tempPath);
          if (tempExtractDir && fs.existsSync(tempExtractDir)) {
            fs.rmSync(tempExtractDir, { recursive: true, force: true });
          }
        } catch {
          /* ignore */
        }
        throw new Error(`核心更新预检失败，已放弃（现役核心继续运行）：${preflight.reason}`);
      }

      // 3. 停止代理
      let wasRunning = false;
      if (this.proxyManager) {
        const status = this.proxyManager.getStatus();
        if (status.running) {
          this.logManager.addLog('info', '正在停止代理服务...', 'CoreUpdateService');
          await this.proxyManager.stop();
          wasRunning = true;
          // 等待进程完全退出
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      // 4-5. 备份→替换核心→签名→待验证闩（抽到 installCoreFromDir，手动/自动落位共用，行为零变）。
      // onBackupDone 在 backupCurrentCore() 成功后同点回调，保持原 backupMade 语义（预检前失败不误恢复陈旧 .bak）。
      // core-swap 手动轴门控：标记「二进制替换窗口」开启——installCoreFromDir 执行期间拒绝手动 start/restart/switchMode
      // （防撞半替换核 FATAL）。try/finally 精确覆盖 installCoreFromDir；清位后下方 proxyManager.start 放行。
      this.proxyManager?.setCoreSwapInProgress(true);
      try {
        await this.installCoreFromDir(path.dirname(corePath), preflight.version, () => {
          backupMade = true;
        });
      } finally {
        this.proxyManager?.setCoreSwapInProgress(false);
      }

      // 6. 清理临时文件
      try {
        fs.unlinkSync(tempPath);
        // 清理整个临时解压目录
        if (tempExtractDir && fs.existsSync(tempExtractDir)) {
          fs.rmSync(tempExtractDir, { recursive: true, force: true });
          this.logManager.addLog('info', '已清理临时解压目录', 'CoreUpdateService');
        }
      } catch (err) {
        // 忽略清理错误
        this.logManager.addLog('warn', `清理临时解压目录失败: ${err}`, 'CoreUpdateService');
      }

      // 7. 重启代理（之前在运行才重启）。照 applyStagedNow：configProvider() 拿当前 config → proxyManager.start。
      //    早期此处是空壳占位（只打日志不启动），导致手动「检查更新→更新」换核后代理永不自动拉起 → 断网（P0-1）。
      if (wasRunning && this.proxyManager) {
        this.logManager.addLog('info', '正在重启代理服务...', 'CoreUpdateService');
        const cfg = this.configProvider ? await this.configProvider() : null;
        if (cfg) {
          await this.proxyManager.start(cfg);
        } else {
          this.logManager.addLog(
            'warn',
            '无法获取配置，代理未自动重启，请在主界面手动连接',
            'CoreUpdateService'
          );
        }
      }

      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logManager.addLog('error', `更新核心失败: ${msg}`, 'CoreUpdateService');

      // 尝试恢复备份（仅当本次确已备份；预检阶段失败时尚无新备份，避免误恢复陈旧 .bak 致降级）
      if (backupMade) await this.restoreBackup();

      throw error;
    } finally {
      this.isUpdating = false;
    }
  }

  /**
   * 落位：备份旧核心 → 把 sourceDir 下的核心+配套文件复制到目标位置 → chmod → ensureCronetBeside →
   * macOS 签名 → naive 警告 → 置「待首启验证」闩+抑制自动重启+兜底解除 timer。
   * 从 updateCore 抽出（手动更新与自动 staged 落位共用），行为逐字节零变。
   * 不变量：**调用方须保证此刻代理进程不存在**（updateCore 已停代理、tryApplyStaged 仅在 !running 时进入）。
   * @param onBackupDone backupCurrentCore() 成功后立即回调（让调用方在同一时点置 backupMade，保留原失败恢复语义）。
   */
  /**
   * helper 是否支持 install-core（受保护/受管核目录持久化写入）——命令级能力门，取代旧的 `ready && !upgradeable`。
   * 为什么不能用 `!upgradeable`：upgradeable 的门槛是 helper 的 EXPECTED_PROTO（macOS=9），远高于 install-core 的
   * 真实契约。install-core 各平台起始 proto 不同（见 HelperManager.installCore / LinuxServiceHelper 注释）：
   *  - macOS：proto ≥ 5（v5 引入受保护目录持久化，proto<5 回 ERR unknown）；
   *  - Linux：proto ≥ 1（v1 起即支持，ready 已含此下限）。
   * 旧门 `ready && !upgradeable` 让 macOS proto 5-8 的旧 helper 用户被判「无 install-core」→ 内核更新走 bundle
   * 写入却仍跑受保护目录旧核，更新静默失效。故改按 ready + 平台最低 proto 判定。version 即 ping 返回的 proto 串。
   */
  private helperSupportsInstallCore(st: HelperStatus): boolean {
    if (!st.ready) return false;
    const minProto = process.platform === 'darwin' ? 5 : 1;
    const proto = Number.parseInt(st.version ?? '', 10);
    // version 非数字串（异常 ping 应答/未来格式变体）→ NaN 比较恒 false 会把有能力 helper 误判无能力、
    // 静默走 bundle 分支复现本 bug；回退旧布尔语义（ready && !upgradeable）而非一票否决。
    if (Number.isNaN(proto)) return !st.upgradeable;
    return proto >= minProto;
  }

  private async installCoreFromDir(
    sourceDir: string,
    version: string | null,
    onBackupDone?: () => void
  ): Promise<void> {
    // B 块：macOS + helper v5 → 整个核心目录经 install-core 由 root 写入受保护目录（含 libcronet：先 ensureCronetBeside
    // 把配套放进 sourceDir，再整目录交 helper）。不经普通用户 fs.copy（受保护目录 root-only）。受保护目录回滚靠 B5。
    if ((process.platform === 'darwin' || process.platform === 'linux') && this.helperManager) {
      const st = await this.helperManager.getStatus();
      if (this.helperSupportsInstallCore(st)) {
        await this.backupCurrentCore(); // 备份现役(受保护/受管核可读)→userData，供首启失败回滚（[HIGH-1]）
        onBackupDone?.();
        await resourceManager.ensureCronetBeside(sourceDir);
        const res = await this.helperManager.installCore(sourceDir);
        if (!res.ok) throw new Error(`内核写入受保护目录失败：${res.error}`);
        this.armPendingValidation(version); // 待首启验证闩：首启 crash → autoRollback（经 helper，见 rollbackCore）
        return;
      }
    }

    // 4. 备份旧核心
    await this.backupCurrentCore();
    onBackupDone?.();

    // 5. 替换核心
    this.logManager.addLog('info', '正在替换核心文件...', 'CoreUpdateService');
    const targetPath = resourceManager.getSingBoxUpdateTargetPath();

    // 确保目标目录存在
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // 复制新核心及配套文件到目标位置（只取文件，不递归目录）
    const files = fs
      .readdirSync(sourceDir)
      .filter((f) => fs.statSync(path.join(sourceDir, f)).isFile());

    if (process.platform === 'win32') {
      // Windows: 目标在 Program Files（UAC 保护），逐文件 elevated 覆盖；无简单原子 rename，保持原行为。
      for (const file of files) {
        this.logManager.addLog('info', `正在复制: ${file}`, 'CoreUpdateService');
        await this.copyFileElevatedWindows(path.join(sourceDir, file), path.join(targetDir, file));
      }
    } else {
      // M2：非 Windows 原子落位——先把全部文件复制到同目录临时名（.flowz-new），全部成功后逐个原子 rename
      // 就位。复制阶段任一失败（磁盘满等）→ 删临时文件、抛错，现役核心目录完全未动（杜绝「新核心 + 旧/坏
      // libcronet」半替换混搭——原逐文件直接覆盖在中途失败时会留下此混搭，而 restoreBackup 仅回滚主二进制救不回）。
      const stagedRenames: Array<{ tmp: string; dest: string }> = [];
      try {
        for (const file of files) {
          this.logManager.addLog('info', `正在复制: ${file}`, 'CoreUpdateService');
          const dest = path.join(targetDir, file);
          const tmp = `${dest}.flowz-new`;
          await this.copyFileWithRetry(path.join(sourceDir, file), tmp);
          stagedRenames.push({ tmp, dest });
        }
        // 全部复制成功 → 逐个原子 rename 就位（同目录 rename 为原子 syscall，不占新磁盘空间，几乎不失败）
        for (const { tmp, dest } of stagedRenames) {
          fs.renameSync(tmp, dest);
        }
      } catch (e) {
        for (const { tmp } of stagedRenames) {
          try {
            if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
          } catch {
            /* ignore */
          }
        }
        throw e;
      }
    }

    // 设置执行权限 (macOS/Linux)
    if (process.platform !== 'win32') {
      fs.chmodSync(targetPath, 0o755);
    }

    // 核心单独更新后，确保 NaiveProxy 库 libcronet 与新核心同目录（官方 sing-box 包不含 libcronet，
    // naive 仍依赖随 app 打包的那个；purego 从核心同目录加载）。
    await resourceManager.ensureCronetBeside(targetDir);

    // macOS: 清除下载隔离标记并重新 ad-hoc 签名
    // 原因: macOS Gatekeeper 对新放入的未公证二进制会拦截执行 (SIGKILL)
    // xattr -cr 清除 quarantine 标记, codesign --force -s - 重新 ad-hoc 签名使其被系统接受
    if (process.platform === 'darwin') {
      try {
        const { execSync } = require('child_process');
        execSync(`xattr -cr "${targetPath}"`, { stdio: 'pipe' });
        execSync(`codesign --force --deep -s - "${targetPath}"`, { stdio: 'pipe' });
        this.logManager.addLog('info', '已完成 macOS Gatekeeper 签名处理', 'CoreUpdateService');
      } catch (signError: any) {
        this.logManager.addLog(
          'warn',
          `macOS 签名处理失败 (可能需要手动运行 sudo codesign --force -s -): ${signError.message}`,
          'CoreUpdateService'
        );
      }
    }

    this.logManager.addLog('info', '核心文件替换成功', 'CoreUpdateService');

    // naive 依赖随 app 打包的 libcronet（匹配出厂核心的 cronet-go 版本）。单独更新核心——尤其跨版本——
    // 可能与打包库 ABI 漂移；该漂移在 dlopen 前不可见，sing-box check 预检无法发现。有 naive 节点则提示。
    if (this.proxyManager?.hasNaiveNodes()) {
      this.logManager.addLog(
        'warn',
        'naive 节点依赖随 app 打包的 libcronet；本次核心更新后如遇 naive 不可用，请回滚核心或等待 app 整体更新',
        'CoreUpdateService'
      );
    }

    // 标记"待首启验证"：稳定运行→删备份（稳定即弃）；首启失败→自动回滚（见 index 'error' 钩子）。
    this.armPendingValidation(version);
  }

  /** 置「待首启验证」闩 + 抑制自动重启 + 超时兜底。bundle 落位与 macOS install-core 落位共用，保证两条路径都有
   *  「首启 crash → autoRollback」保护网（修 [HIGH-2]：install-core 分支原本早退跳过此闩）。 */
  private armPendingValidation(version: string | null): void {
    // 同时抑制 ProxyManager 自动重启——让新核心首次异常退出立即上报，而非在坏核心上空转重试。
    this.pendingUpdateVersion = version;
    this.pendingUpdateAt = Date.now();
    this.proxyManager?.setAutoRestartSuppressed(true);
    // 兜底：到期仍未被 'started'/'error' 解决，则清待验证态并解除抑制（避免抑制闩永久挂起）。
    if (this.pendingFallbackTimer) clearTimeout(this.pendingFallbackTimer);
    this.pendingFallbackTimer = setTimeout(() => {
      this.pendingFallbackTimer = null;
      if (this.pendingUpdateVersion) {
        this.logManager.addLog(
          'info',
          '核心更新待验证窗口超时未见首启事件，解除自动重启抑制',
          'CoreUpdateService'
        );
        this.pendingUpdateVersion = null;
        this.proxyManager?.setAutoRestartSuppressed(false);
      }
    }, CoreUpdateService.PENDING_MAX_AGE_MS);
  }

  /** 撤销待首启验证闩（arm 后 start 同步失败 / 改以原核重启前调，避免原核首启被当作新版本观察/记录）。 */
  private disarmPendingValidation(): void {
    this.pendingUpdateVersion = null;
    this.proxyManager?.setAutoRestartSuppressed(false);
    if (this.pendingFallbackTimer) {
      clearTimeout(this.pendingFallbackTimer);
      this.pendingFallbackTimer = null;
    }
  }

  /** B 块 macOS：把单个 sing-box 二进制 src 经 helper install-core 持久化写入受保护目录（连带打包的 libcronet）。
   *  调用方须先经 helperSupportsInstallCore(st) 确认 helper 支持 install-core。replaceManualCore / rollbackCore / restoreBackup 共用。 */
  private async installSingleCoreViaHelper(src: string): Promise<void> {
    if (!this.helperManager) throw new Error('helper 不可用');
    const tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'flowz-core-'));
    try {
      fs.copyFileSync(src, path.join(tmpDir, 'sing-box'));
      fs.chmodSync(path.join(tmpDir, 'sing-box'), 0o755);
      await resourceManager.ensureCronetBeside(tmpDir);
      const res = await this.helperManager.installCore(tmpDir);
      if (!res.ok) throw new Error(`内核写入受保护目录失败：${res.error}`);
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /** B 块 macOS：当前是否启用受保护目录持久化（helper v5 在位且 ready）。回滚/恢复据此决定经 helper 还是普通写。 */
  private async isProtectedCoreActive(): Promise<boolean> {
    if ((process.platform !== 'darwin' && process.platform !== 'linux') || !this.helperManager)
      return false;
    const st = await this.helperManager.getStatus();
    return this.helperSupportsInstallCore(st);
  }

  // === 内核自动更新（仅兼容版本带内）：持久状态 / staged 落位 / 周期检查 ===

  /** 读自动更新持久状态（委托 CoreUpdateStateStore；损坏/缺失→空对象，失败安全）。 */
  private loadAutoState(): CoreAutoUpdateState {
    return this.stateStore.loadAutoState();
  }

  /** 合并写入自动更新持久状态（委托 CoreUpdateStateStore；原子写 tmp+rename，崩溃一致性）。 */
  private saveAutoState(patch: Partial<CoreAutoUpdateState>): void {
    this.stateStore.saveAutoState(patch);
  }

  /** 清除 staged 暂存（落位成功/作废后调用）：删元数据 + 删暂存目录。 */
  private clearStaged(): void {
    const st = this.loadAutoState();
    const dir = st.staged?.dir;
    this.saveAutoState({ staged: undefined });
    if (dir) {
      try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        // L3：删暂存目录失败不致命（下次 stageCore 会 rmSync 重建覆盖），但记一条便于排查残留磁盘垃圾。
        this.logManager.addLog('warn', `清除 staged 暂存目录失败: ${e}`, 'CoreUpdateService');
      }
    }
  }

  private getStagedDir(): string {
    return path.join(app.getPath('userData'), 'core-staged');
  }

  private emitAutoStatus(extra?: { crossBandLatest?: string | null }): void {
    if (!this.eventSender) return;
    try {
      const st = this.loadAutoState();
      // M3：事件 payload 不含 autoUpdateEnabled——其真值需 await configProvider（同步 emit 拿不到），旧实现发
      // 占位 false 会在渲染端覆盖 getAutoStatus 拉到的真值。真值仅由 getAutoStatus 快照提供（UI 另读 config）。
      const payload: Omit<CoreAutoStatus, 'autoUpdateEnabled'> = {
        lastCheckAt: st.lastCheckAt ?? null,
        staged: st.staged ? { version: st.staged.version, stagedAt: st.staged.stagedAt } : null,
        crossBandLatest:
          extra && 'crossBandLatest' in extra
            ? (extra.crossBandLatest ?? null)
            : (st.crossBandNotifiedVersion ?? null),
      };
      this.eventSender(IPC_CHANNELS.EVENT_CORE_AUTO_UPDATE_STATUS, payload);
    } catch {
      /* ignore */
    }
  }

  /** UI 拉取的内核自动更新状态快照。 */
  async getAutoStatus(): Promise<CoreAutoStatus> {
    const st = this.loadAutoState();
    let enabled = false;
    try {
      const cfg = this.configProvider ? await this.configProvider() : null;
      enabled = cfg?.autoUpdateCore === true;
    } catch {
      /* ignore */
    }
    return {
      autoUpdateEnabled: enabled,
      lastCheckAt: st.lastCheckAt ?? null,
      staged: st.staged ? { version: st.staged.version, stagedAt: st.staged.stagedAt } : null,
      crossBandLatest: st.crossBandNotifiedVersion ?? null,
    };
  }

  /** 把解压目录（含核心+配套文件）复制到 userData/core-staged 暂存，写元数据。返回 staged 信息。 */
  private stageCore(sourceDir: string, version: string): StagedCoreInfo {
    const dir = this.getStagedDir();
    // 清掉旧暂存目录，避免不同版本文件残留混入
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    fs.mkdirSync(dir, { recursive: true });
    for (const file of fs.readdirSync(sourceDir)) {
      const src = path.join(sourceDir, file);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(dir, file));
      }
    }
    const staged: StagedCoreInfo = { version, dir, stagedAt: new Date().toISOString() };
    this.saveAutoState({ staged });
    this.logManager.addLog(
      'info',
      `新内核 ${version} 已下载预检通过，暂存待代理停止后落位`,
      'CoreUpdateService'
    );
    return staged;
  }

  /**
   * 内核自动更新一轮：检查→（带内）下载+预检+暂存/落位；跨带仅发事件不下载。
   * 唯一入口由 CoreUpdateScheduler.cycleIfDue 调用；isUpdating 防重入。
   * 不变量：自动路径恒强制 sameMajorMinor（跨 minor 绝不自动），不受 restrictCoreUpdateToCompatibleMinor 影响。
   */
  async runAutoUpdateCycle(): Promise<void> {
    if (this.isUpdating) return;
    // H1：入口同步持闸（与 isUpdating 检查间无 await，原子），覆盖 check→下载→解压→预检→暂存→落位全程，
    // 防与手动 updateCore 并发双换核（原仅末尾 tryApplyStaged 持闸，数十秒下载/暂存段 isUpdating=false 留并发
    // 窗口，两条链同写 core-staged/目标目录/*.bak 互相覆盖、备份取自半替换核心、回滚失真）。内部 tryApplyStaged
    // 传 lockHeld=true 复用本闸、不二次检查/置/复位。autoUpdateCore 关时短暂持闸即经 finally 复位，无害。
    this.isUpdating = true;
    try {
      const cfg = this.configProvider ? await this.configProvider() : null;
      if (cfg?.autoUpdateCore !== true) return;

      const check = await this.checkUpdate();
      // 仅成功检查才刷新 lastCheckAt：失败轮（network/API 限流等，check.error 有值）保留旧值，
      // 让 6h tick 在下个周期重试，而非把整 24h due 推迟（原无条件刷新致失败后停检一整天）。
      if (!check.error) {
        this.saveAutoState({ lastCheckAt: Date.now() });
      }
      const latest = check.latestVersion;

      const current = check.currentVersion;
      // M3：用户手动升级追上/越过曾提示的跨带版本后，清除残留跨带提示（否则只写不清，旧提示常驻 UI）。
      // current >= notified 或已同带（current 升到 notified 所在 minor）即视为已消化该跨带版本。
      {
        const st = this.loadAutoState();
        const notified = st.crossBandNotifiedVersion;
        if (
          notified &&
          current &&
          current !== '未知' &&
          (this.compareVersions(current, notified) >= 0 || sameMajorMinor(current, notified))
        ) {
          this.saveAutoState({ crossBandNotifiedVersion: undefined });
          this.logManager.addLog(
            'info',
            `当前内核 ${current} 已追上跨带提示版本 ${notified}，清除跨带提示`,
            'CoreUpdateService'
          );
          this.emitAutoStatus({ crossBandLatest: null });
        }
      }

      // 无更新 / 检查失败 / 无可用更新：本轮结束（check 内部已处理 known-bad/ceiling/asset）
      if (!latest) return;
      // 兼容带硬闸：自动路径仅在同 major.minor 内继续；跨带绝不下载/落位，仅发提示事件（每版本只提示一次）
      if (!sameMajorMinor(current, latest)) {
        const crossable = this.compareVersions(latest, current) > 0 && !this.isKnownBad(latest);
        const st = this.loadAutoState();
        if (crossable && st.crossBandNotifiedVersion !== latest) {
          this.saveAutoState({ crossBandNotifiedVersion: latest });
          this.logManager.addLog(
            'info',
            `检测到跨版本带新版 ${latest}（当前 ${current}），不自动更新，已提示用户手动处理`,
            'CoreUpdateService'
          );
          this.emitAutoStatus({ crossBandLatest: latest });
        }
        return;
      }

      // 带内：若已有相同版本 staged，直接尝试落位（避免重复下载）
      const staged = this.loadAutoState().staged;
      if (staged && staged.version === latest) {
        await this.tryApplyStaged('staged-same-version', true);
        return;
      }

      // check.hasUpdate=true 才有 downloadUrl；带内但 hasUpdate=false（已是最新）则无可下
      if (!check.hasUpdate || !check.downloadUrl) return;

      // 下载 → 解压 → 预检（全复用现有手动路径逻辑，零新增回滚代码）
      let tempPath: string | null = null;
      let extractDir: string | null = null;
      try {
        tempPath = await this.coreDownloader.downloadFile(check.downloadUrl);
        const extracted = await this.coreDownloader.extractCore(tempPath);
        extractDir = extracted.extractDir;
        const preflight = await this.preflightValidate(extracted.corePath);
        if (!preflight.ok) {
          if (preflight.version) this.markKnownBad(preflight.version);
          this.logManager.addLog(
            'warn',
            `自动更新预检失败，放弃 ${latest}：${preflight.reason}`,
            'CoreUpdateService'
          );
          return;
        }
        // 暂存（从解压目录复制到 core-staged，因临时目录随后清理）
        this.stageCore(path.dirname(extracted.corePath), preflight.version ?? latest);
        this.emitAutoStatus();
        // 下载后立即尝试落位（代理未运行→直接换；运行中→保持 staged，延到安全窗口）
        await this.tryApplyStaged('post-download', true);
      } finally {
        try {
          if (tempPath) fs.unlinkSync(tempPath);
        } catch {
          /* ignore */
        }
        try {
          if (extractDir && fs.existsSync(extractDir)) {
            fs.rmSync(extractDir, { recursive: true, force: true });
          }
        } catch {
          /* ignore */
        }
      }
    } finally {
      this.isUpdating = false;
    }
  }

  /**
   * 尝试落位 staged 内核：**仅在代理进程不存在时真正换核**（不断流硬不变量）。
   * 运行中 → 保持 staged、发「待生效」事件、不动现役核心。无 staged / isUpdating → 直接返回 noop。
   *
   * 返回 StagedApplyResult，供 applyStagedNow / UI 区分反馈（修 M1：原 void 返回让调用方只能靠
   * 「staged 是否还在」二值推断，把 discarded/deferred/failed 一律误判，UI 误报「已应用」）。
   *
   * @param trigger 触发来源；非 'manual-apply' 的自动触发（startup / proxy-stopped / tick /
   *   post-download / staged-same-version）须经 autoUpdateCore 守门（修 M4：撤回同意后已暂存内核
   *   不应自动换核；保留 staged，用户重开开关或点「立即应用」即生效）。
   */
  async tryApplyStaged(trigger: string, lockHeld = false): Promise<StagedApplyResult> {
    // L1：入口同步置 applying 闸（与 isUpdating 检查间无 await），防并发 tryApplyStaged 双通过。
    // lockHeld=true（runAutoUpdateCycle 内调）→ 复用外层已持的 isUpdating 闸，不二次检查/置/复位（H1）。
    if (!lockHeld && this.isUpdating) return 'noop';
    if (!lockHeld) this.isUpdating = true;
    try {
      // 第三方（非官方）内核：作废任何暂存的官方核（不落位覆盖用户刻意安装的 fork）。
      // 覆盖「曾官方→自动 staged→用户手动换 fork」时序，杜绝 staged 静默回覆 fork。force 刷新版本行（守卫前无强制刷新）。
      if ((await this.getCoreBuild(true)) === 'fork') {
        if (!this.loadAutoState().staged) return 'noop'; // 无暂存可作废 → noop（保持返回契约：discarded=确有 staged 被清）
        this.logManager.addLog(
          'info',
          '当前为第三方内核，作废暂存的官方内核（不覆盖用户内核）',
          'CoreUpdateService'
        );
        this.clearStaged();
        this.emitAutoStatus();
        return 'discarded';
      }

      const staged = this.loadAutoState().staged;
      if (!staged) return 'noop';

      // M4：自动触发（非用户「立即应用」）须开关开启才落位；关则保持 staged、不动现役核心。
      if (trigger !== 'manual-apply') {
        let autoEnabled = false;
        try {
          const cfg = this.configProvider ? await this.configProvider() : null;
          autoEnabled = cfg?.autoUpdateCore === true;
        } catch {
          /* 读配置失败 → 失败安全：视作未开启，不自动落位 */
        }
        if (!autoEnabled) {
          this.logManager.addLog(
            'info',
            `自动更新已关闭，内核 ${staged.version} 保持暂存不自动落位（${trigger}）`,
            'CoreUpdateService'
          );
          this.emitAutoStatus();
          return 'deferred';
        }
      }

      // staged 已不再领先当前 / 已知坏：作废清理
      const current = await this.getCurrentVersion();
      if (this.compareVersions(staged.version, current) <= 0 || this.isKnownBad(staged.version)) {
        this.logManager.addLog(
          'info',
          `staged 内核 ${staged.version} 不再适用（当前 ${current}），清理暂存`,
          'CoreUpdateService'
        );
        this.clearStaged();
        this.emitAutoStatus();
        return 'discarded';
      }

      // 代理运行中 → 绝不落位（只下载+暂存，绝不静默断流）。发「待生效」事件供 UI 提示。
      if (this.proxyManager?.getStatus().running) {
        this.logManager.addLog(
          'info',
          `代理运行中，内核 ${staged.version} 暂不落位，待停止后生效（${trigger}）`,
          'CoreUpdateService'
        );
        this.emitAutoStatus();
        return 'deferred';
      }

      // 落位（代理未运行）：重预检（下载到落位间 config 可能变）→ installCoreFromDir
      const corePath = path.join(
        staged.dir,
        process.platform === 'win32' ? 'sing-box.exe' : 'sing-box'
      );
      if (!fs.existsSync(corePath)) {
        this.logManager.addLog(
          'warn',
          `staged 暂存核心缺失，清理：${corePath}`,
          'CoreUpdateService'
        );
        this.clearStaged();
        this.emitAutoStatus();
        return 'discarded';
      }
      const preflight = await this.preflightValidate(corePath);
      if (!preflight.ok) {
        if (preflight.version) this.markKnownBad(preflight.version);
        this.logManager.addLog(
          'warn',
          `落位前重预检失败，放弃 staged ${staged.version}：${preflight.reason}`,
          'CoreUpdateService'
        );
        this.clearStaged();
        this.emitAutoStatus();
        return 'discarded';
      }
      // M2：跟踪本次是否已备份；installCoreFromDir 中途失败（复制半截/磁盘满）时回滚半替换核心，
      // 对齐 updateCore 的 catch restoreBackup（否则留半替换核心，下次启动失败也不 autoRollback）。
      let backupMade = false;
      // core-swap 手动轴门控：标记「二进制替换窗口」开启——installCoreFromDir 执行期间拒绝手动 start/restart/switchMode
      // （防撞半替换核 FATAL）。finally 清位；applyStagedNow 在 tryApplyStaged 返回后的 start（coreSwapInProgress 已清）放行。
      this.proxyManager?.setCoreSwapInProgress(true);
      try {
        await this.installCoreFromDir(staged.dir, preflight.version ?? staged.version, () => {
          backupMade = true;
        });
      } catch (installErr) {
        // N-1：restoreBackup 在 finally 清位前执行（此刻 coreSwapInProgress 仍 true）——但 restoreBackup 仅写核文件、
        // 不调 start/switchMode（不触门控），故无害。与 updateCore/replaceManualCore（restoreBackup 在清位后）略不一致，
        // 系 try/catch/finally 语义所致；后人若给 restoreBackup 加重启逻辑须先清位。
        if (backupMade) await this.restoreBackup();
        throw installErr;
      } finally {
        this.proxyManager?.setCoreSwapInProgress(false);
      }
      this.clearStaged();
      this.logManager.addLog(
        'info',
        `内核已自动更新落位至 ${staged.version}（${trigger}）`,
        'CoreUpdateService'
      );
      // 复用 banner 作成功提示 + 回滚入口
      this.eventSender?.(IPC_CHANNELS.EVENT_CORE_VERSION_CHANGED, {
        previousVersion: current,
        currentVersion: staged.version,
        hasBackup: this.hasBackup(),
      });
      this.emitAutoStatus();
      return 'applied';
    } catch (e) {
      this.logManager.addLog('error', `staged 落位失败: ${e}`, 'CoreUpdateService');
      this.emitAutoStatus();
      return 'failed';
    } finally {
      if (!lockHeld) this.isUpdating = false;
    }
  }

  /**
   * 用户点「立即应用」：唯一允许主动断流的路径。运行中则停代理→等2s→落位→重启代理（首启走稳定观察/自动回滚）。
   * 返回 tryApplyStaged 的枚举结果，供 UI 区分反馈（applied→成功 / failed→失败 / discarded→已作废 /
   * deferred→仍待生效）。修 M1：原 boolean「staged 是否清空」会把 discarded（已换过/known-bad）当成功、
   * 把 failed（install 失败、staged 保留）当成功（UI 误报「已应用」），且 wasRunning 在非 applied 分支不恢复
   * 代理，留停止态无反馈。
   */
  async applyStagedNow(): Promise<StagedApplyResult> {
    const staged = this.loadAutoState().staged;
    if (!staged) return 'noop';

    const wasRunning = this.proxyManager?.getStatus().running === true;
    if (wasRunning && this.proxyManager) {
      this.logManager.addLog(
        'info',
        '用户点「立即应用」，停止代理以落位新内核...',
        'CoreUpdateService'
      );
      await this.proxyManager.stop();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    const result = await this.tryApplyStaged('manual-apply');

    // 不变量：wasRunning 时无论落位结果都恢复代理，绝不留停止态（修 M1：install 失败/作废/重预检失败
    // 等非 applied 分支此前不恢复，代理被静默留停）。applied 走稳定观察/自动回滚链路（首启成功→
    // recordSuccessfulVersion+稳定观察；失败→'error'→autoRollbackIfPendingUpdate），其余分支以旧核心重启。
    if (wasRunning && this.proxyManager) {
      this.logManager.addLog(
        'info',
        result === 'applied' ? '新内核已落位，正在重启代理...' : '落位未生效，以原内核重启代理...',
        'CoreUpdateService'
      );
      const cfg = this.configProvider ? await this.configProvider() : null;
      if (cfg) {
        await this.proxyManager.start(cfg);
      }
    }
    return result;
  }

  /*
   * 带重试机制的文件复制，遇到 EBUSY 会尝试强制结束进程 (Windows)
   */
  private async copyFileWithRetry(src: string, dest: string, retries: number = 3): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        fs.copyFileSync(src, dest);
        return;
      } catch (error: any) {
        this.logManager.addLog(
          'warn',
          `Copy failed (attempt ${i + 1}/${retries}): ${error.message}`,
          'CoreUpdateService'
        );

        // 如果是最后一次尝试，直接抛出异常
        if (i === retries - 1) throw error;

        // Windows 下如果是 EBUSY 或 EPERM，尝试强制结束 sing-box 进程
        if (process.platform === 'win32' && (error.code === 'EBUSY' || error.code === 'EPERM')) {
          this.logManager.addLog(
            'info',
            'File locked, attempting to force kill sing-box.exe...',
            'CoreUpdateService'
          );
          try {
            require('child_process').execSync(`"${system32('taskkill.exe')}" /F /IM sing-box.exe`, {
              stdio: 'ignore',
            });
            // 杀进程后多等一会儿
            await new Promise((resolve) => setTimeout(resolve, 1000));
          } catch {
            // 忽略错误（可能进程不存在）
          }
        }

        // 等待后重试
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * 获取当前核心版本
   */
  async getCurrentVersion(force = true): Promise<string> {
    // 默认 force=true 读活二进制：版本记录/回滚/兼容带(verifiedCeiling)决策等准确性敏感点必须读真实当前核心——
    // 换核/回滚不经 startInternal 的 force 刷新，若吃 getCoreVersion 缓存会读到陈旧失败版本 → 记错版本、回滚 fail-safe 失效。
    // 仅「关于」页显示(version-handlers)显式传 false 走缓存，避免高频进入时 spawn 内核子进程致加载转圈。
    if (this.proxyManager) {
      return await this.proxyManager.getCoreVersion(force);
    }
    return '未知';
  }

  /**
   * 判定当前内核来源（official/fork/unknown）。fork=第三方内核 → 禁在线/自动更新（见 checkUpdate/updateCore/
   * tryApplyStaged 闸门）。读 `sing-box version` 原始行 → classifyCoreBuild（单一真值 shared/core-build）。
   * 不单独缓存 kind：版本行由 getCoreVersion 缓存/换核后 force 刷新，判定恒跟随当前实跑内核。
   */
  async getCoreBuild(force = false): Promise<CoreBuildKind> {
    try {
      if (!this.proxyManager) return 'unknown';
      // force=true：自行刷新版本行（不依赖调用方先 getCurrentVersion(force)），使守卫恒跟随当前实跑内核——
      // 否则会话内换核（官方→fork）后读到陈旧 official 行 → 守卫失效覆盖用户 fork。updateCore/tryApplyStaged
      // 传 true（它们守卫前无强制刷新）；checkUpdate/getVersionInfo 已先 getCurrentVersion(force) 刷新，传 false 复用。
      const line = await this.proxyManager.getCoreVersionLine(force);
      return classifyCoreBuild(line);
    } catch {
      return 'unknown';
    }
  }

  /**
   * 记录成功启动的版本（在代理成功启动后调用）
   */
  async recordSuccessfulVersion(): Promise<void> {
    try {
      const version = await this.getCurrentVersion();
      // 版本未知时不记录：避免把占位串 '未知' 当作可回滚的「可用版本」持久化
      if (!version || version === '未知') {
        return;
      }
      const versionFilePath = this.getVersionFilePath();
      const data = { version, recordedAt: new Date().toISOString() };
      fs.writeFileSync(versionFilePath, JSON.stringify(data, null, 2), 'utf-8');
      this.logManager.addLog('info', `已记录成功版本: ${version}`, 'CoreUpdateService');

      // 该版本成功运行 → 从问题版本名单移除（曾因瞬时原因误标记的版本恢复自动更新资格）
      this.clearKnownBad(version);

      // B0：成功运行即「实证兼容」该版本带 → 棘轮抬高 verifiedCeiling，让兼容带闸放行该带内后续更新。
      const enc = encodeMajorMinor(version);
      if (!isNaN(enc) && enc > (this.loadAutoState().verifiedCeiling ?? 0)) {
        this.saveAutoState({ verifiedCeiling: enc });
      }

      // 若处于"更新后待验证"窗口：'started' 仅代表存活 1s、可能假成功，不立即删备份；改启动稳定
      // 观察期，期内无 error 才判稳定→删备份（详见 startStabilityWatch / 修 review #3 假成功删备份）
      if (this.pendingUpdateVersion) {
        this.startStabilityWatch();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logManager.addLog('warn', `记录版本失败: ${msg}`, 'CoreUpdateService');
    }
  }

  /**
   * 获取上次记录的可用版本
   */
  getLastKnownGoodVersion(): string | null {
    try {
      const versionFilePath = this.getVersionFilePath();
      if (!fs.existsSync(versionFilePath)) return null;
      const data = JSON.parse(fs.readFileSync(versionFilePath, 'utf-8'));
      return data.version || null;
    } catch {
      return null;
    }
  }

  /**
   * 检查是否存在备份版本
   */
  hasBackup(): boolean {
    return fs.existsSync(this.getBackupPath());
  }

  /**
   * 获取备份版本号（运行 sing-box.bak version）
   */
  async getBackupVersion(): Promise<string | null> {
    const backupPath = this.getBackupPath();
    if (!fs.existsSync(backupPath)) return null;
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);
      const { stdout } = await execAsync(`"${backupPath}" version`);
      const match = stdout.match(/version\s+(\S+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * 获取当前核心版本信息（用于 UI 展示）
   */
  async getVersionInfo(): Promise<CoreVersionInfo> {
    const currentVersion = await this.getCurrentVersion();
    const hasBackup = this.hasBackup();
    const backupVersion = hasBackup ? await this.getBackupVersion() : null;
    const lastKnownVersion = this.getLastKnownGoodVersion();
    // getCurrentVersion(force) 已刷新版本行 → getCoreBuild 跟随当前实跑内核。
    const build = await this.getCoreBuild();
    return { currentVersion, backupVersion, hasBackup, lastKnownVersion, build };
  }

  /**
   * 用户触发的回滚：将 .bak 恢复为当前核心，并重新签名
   */
  async rollbackCore(): Promise<void> {
    if (!this.hasBackup()) {
      throw new Error('没有可用的备份版本');
    }

    if (this.proxyManager) {
      const status = this.proxyManager.getStatus();
      if (status.running) {
        this.logManager.addLog('info', '回滚前停止代理服务...', 'CoreUpdateService');
        await this.proxyManager.stop();
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    // core-swap 手动轴门控（补 F-1 缺口）：rollbackCore 经 installSingleCoreViaHelper/普通 copy 写核，不经
    // installCoreFromDir，需独立置位。无恢复性 start（写核后 record+return），try/finally 仅保证清位防闩挂死。
    this.proxyManager?.setCoreSwapInProgress(true);
    try {
      const backupPath = this.getBackupPath();
      // B 块 macOS（helper v5）：受保护目录 root-only，经 helper install-core 把 backup 写回（连带 libcronet）。普通
      // fs.copy 写不了；且读路径优先受保护目录，必须写那里，否则「写了读不到」（修 [HIGH-1]）。
      if (await this.isProtectedCoreActive()) {
        await this.installSingleCoreViaHelper(backupPath);
        try {
          fs.unlinkSync(backupPath);
        } catch {
          /* ignore */
        }
        this.logManager.addLog('info', '核心回滚成功（写回受保护目录）', 'CoreUpdateService');
        await this.recordSuccessfulVersion();
        const rolledEnc = encodeMajorMinor(await this.getCurrentVersion());
        if (!isNaN(rolledEnc)) this.saveAutoState({ verifiedCeiling: rolledEnc });
        return;
      }

      const currentPath = resourceManager.getSingBoxUpdateTargetPath();
      this.logManager.addLog(
        'info',
        `正在回滚核心: ${backupPath} → ${currentPath}`,
        'CoreUpdateService'
      );

      if (process.platform === 'win32') {
        await this.copyFileElevatedWindows(backupPath, currentPath);
      } else {
        fs.copyFileSync(backupPath, currentPath);
        fs.chmodSync(currentPath, 0o755);
      }

      // macOS: 重新签名
      if (process.platform === 'darwin') {
        try {
          const { execSync } = require('child_process');
          execSync(`xattr -cr "${currentPath}"`, { stdio: 'pipe' });
          execSync(`codesign --force --deep -s - "${currentPath}"`, { stdio: 'pipe' });
          this.logManager.addLog('info', '回滚：已完成 macOS 签名处理', 'CoreUpdateService');
        } catch (signError: any) {
          this.logManager.addLog(
            'warn',
            `回滚签名处理失败: ${signError.message}`,
            'CoreUpdateService'
          );
        }
      }

      this.logManager.addLog('info', '核心回滚成功', 'CoreUpdateService');

      // 删除备份（回滚后备份不再有意义）
      try {
        fs.unlinkSync(backupPath);
      } catch {
        // ignore
      }

      // 更新版本记录
      await this.recordSuccessfulVersion();

      // B0：回滚 = 被回滚版本带验证失败 → 把 verifiedCeiling 重置到回滚后实跑带（撤销更高带的「已验证」，兼容带闸
      // 不再放行那个出问题的更高带）。recordSuccessfulVersion 的棘轮 max 不会下降，故此处显式覆盖。
      const rolledEnc = encodeMajorMinor(await this.getCurrentVersion());
      if (!isNaN(rolledEnc)) this.saveAutoState({ verifiedCeiling: rolledEnc });
    } finally {
      this.proxyManager?.setCoreSwapInProgress(false);
    }
  }

  /**
   * 用户手动选择本地 sing-box 二进制并替换当前核心（也供 resetCoreToFactory 复用）。
   * @param opts.filePath 源文件路径（省略则弹系统文件选择器）
   * @param opts.force 跳过同版本短路（reset 到出厂常与现役同版本，仍要覆盖）
   * @param opts.skipBackup reset 到出厂时=true：跳过备份/验证闩/回退（现役核是用户要丢弃的，出厂核已知稳定）
   */
  async replaceManualCore(opts?: {
    filePath?: string;
    force?: boolean;
    skipBackup?: boolean; // reset 到出厂时跳过备份/验证闩（现役核是用户要丢弃的，出厂核已知稳定）
  }): Promise<{
    ok: boolean;
    needConfirm?: boolean;
    sameVersion?: string;
    baselineOverride?: boolean;
    uploadVersion?: string;
    bundledVersion?: string;
    build?: CoreBuildKind;
    filePath?: string;
    error?: string;
  }> {
    // 源文件：确认流程二次调用显式传入 filePath，否则弹系统文件选择器
    let sourcePath = opts?.filePath;
    if (!sourcePath) {
      const result = await dialog.showOpenDialog({
        title: '选择 sing-box 可执行文件',
        filters:
          process.platform === 'win32'
            ? [{ name: 'Executable', extensions: ['exe'] }]
            : [{ name: 'All Files', extensions: ['*'] }],
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false }; // 用户取消
      }
      sourcePath = result.filePaths[0];
    }

    // 预检源文件（可执行 + 解析当前配置）——在停代理前，预检失败时现役核心继续运行、不动。
    const preSrc = await this.preflightValidate(sourcePath);
    if (!preSrc.ok) {
      return {
        ok: false,
        error: `所选文件未通过核心预检（${preSrc.reason}）。\nMac 用户请注意：\n1. 请先双击解压下载的 .tar.gz，选择解压出的名为 sing-box 的 UNIX 可执行文件。\n2. 请确保架构 (arm64/amd64) 与当前 Mac 匹配。`,
      };
    }

    // 内核来源 + 可比较版本：uploadBuild 判官方/fork/unknown；uploadComparable 截断 fork/dev 尾段，与启动时
    // startInternal 的 reseed 决策（this.coreVersion 经 getCoreVersion 同款截断）喂进 compareSemver 的 token **同形**。
    // 否则官方 dev（X.Y.Z-alpha.N-hex）/ fork 的完整后缀会污染 prerelease 段比较，令预判与实际 reseed 分歧（B-2 空头支票复发）。
    const uploadBuild = classifyCoreBuild(preSrc.versionLine);
    const uploadComparable = comparableCoreVersion(preSrc.version ?? '');

    // B-2 基线预判（诚实告知，**先于同版本短路**：官方旧核即便与现役同版也应告知「会被刷回」，而非只弹同版本框）：
    // 上传的官方核旧于随包种子基线 → 下次连接 startInternal 必 reseed 打回随包核，「替换成功」将是空头支票。
    // 预判 decideCoreOverride（与 startInternal 同函数、同基线 coreManifest.bundledCoreVersion、同形 token），
    // 若会被 reseed 则返回 needConfirm+baselineOverride，前端弹框告知；用户确认（force）后照常替换，临时用到下次连接为止。
    // fork/unknown 不会被 reseed（decideCoreOverride 恒 keep）→ 不触发此闸，走后续短路/替换 + B-3 来源提示。
    const { reseed: willReseed } = decideCoreOverride(
      uploadBuild,
      uploadComparable,
      coreManifest.bundledCoreVersion
    );
    if (willReseed && !opts?.force) {
      return {
        ok: false,
        needConfirm: true,
        baselineOverride: true,
        uploadVersion: preSrc.version ?? undefined, // 展示用完整 token
        bundledVersion: coreManifest.bundledCoreVersion,
        filePath: sourcePath,
      };
    }

    // 同版本短路（提示确认）：可比较版本与当前一致且未 force → needConfirm 由前端弹确认框，保留「换不同 build /
    // 重签修损坏核」的能力。用 comparable 形两侧比较（current 侧 getCoreVersion 本就是截断形），使 fork / 官方 dev
    // 上传同一核也能正确短路（B-1 完整覆盖，不再只兑现 prerelease 半边）。
    const currentVersion = await this.getCurrentVersion();
    if (!opts?.force && preSrc.version && uploadComparable === currentVersion) {
      return { ok: false, needConfirm: true, sameVersion: preSrc.version, filePath: sourcePath };
    }

    // 停止代理（记录 wasRunning 供落位后重启——统一不变量：停了就在落位后恢复，不留停止态致断网）
    let wasRunning = false;
    if (this.proxyManager) {
      const status = this.proxyManager.getStatus();
      if (status.running) {
        this.logManager.addLog('info', '手动替换核心：停止代理服务...', 'CoreUpdateService');
        await this.proxyManager.stop();
        wasRunning = true;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    let backupMade = false;
    try {
      // core-swap 手动轴门控：标记「二进制替换窗口」开启——手动替换核心写入期间拒绝手动 start/restart/switchMode
      // （防撞半替换核 FATAL）。补 T1 覆盖缺口：replaceManualCore 走 installSingleCoreViaHelper/writeManualCoreToBundle，
      // 不经 installCoreFromDir，需独立置位。内层 try/finally 精确覆盖置位+backup+写核；清位后下方恢复性 start 放行（同 updateCore）。
      try {
        this.proxyManager?.setCoreSwapInProgress(true);
        // skipBackup（reset 到出厂）：不备份现役核（用户要丢弃的），写入失败直接抛错让用户重试
        if (!opts?.skipBackup) {
          await this.backupCurrentCore();
          backupMade = true;
        }

        // 写入新核心：macOS + helper v5 → install-core 进受保护目录；否则 → bundle 写入腿（含签名 + 落位后预检）。
        // 源已 preSrc 预检过；install-core 内 sha256 校验保证落位字节 == 预检源，无需二次预检。
        if ((process.platform === 'darwin' || process.platform === 'linux') && this.helperManager) {
          const st = await this.helperManager.getStatus();
          if (this.helperSupportsInstallCore(st)) {
            await this.installSingleCoreViaHelper(sourcePath);
            this.logManager.addLog(
              'info',
              '手动替换核心已写入受保护/受管核目录',
              'CoreUpdateService'
            );
          } else {
            await this.writeManualCoreToBundle(sourcePath);
          }
        } else {
          await this.writeManualCoreToBundle(sourcePath);
        }
      } finally {
        this.proxyManager?.setCoreSwapInProgress(false);
      }

      // 待验证闩 + 重启：之前运行 → arm（新版本），重启后由首启 'started' 记录版本+稳定观察、'error'（运行时首启崩溃）
      // → autoRollbackIfPendingUpdate 自动回滚（对齐 updateCore，手动换坏核运行时崩溃也有回滚网，修 M-1）；之前未运行
      // → 无首启可验证，直接 record。
      if (wasRunning && this.proxyManager) {
        // skipBackup（出厂核）：不 arm 验证闩（无备份可 autoRollback），直接 record + 重启
        if (!opts?.skipBackup) {
          this.armPendingValidation(preSrc.version);
        } else {
          await this.recordSuccessfulVersion();
        }
        this.logManager.addLog('info', '手动替换完成，正在重启代理服务...', 'CoreUpdateService');
        const cfg = this.configProvider ? await this.configProvider() : null;
        if (cfg) await this.proxyManager.start(cfg);
      } else {
        await this.recordSuccessfulVersion();
      }
      // B-3：回传内核来源（预检 versionLine 判定），前端替换成功后据此对 fork/unknown 追加来源提示。
      return { ok: true, build: uploadBuild };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logManager.addLog('error', `手动替换核心失败: ${msg}`, 'CoreUpdateService');
      // 撤销可能已 arm 的待验证闩（防下面以原核重启被首启钩子当新核记录/观察）
      this.disarmPendingValidation();
      // 失败回滚：恢复备份的原核心；之前在运行则尽力以原核心重启代理恢复网络
      if (backupMade) await this.restoreBackup();
      if (wasRunning && this.proxyManager) {
        try {
          const cfg = this.configProvider ? await this.configProvider() : null;
          if (cfg) await this.proxyManager.start(cfg);
        } catch {
          /* 尽力恢复，不掩盖原错误 */
        }
      }
      return { ok: false, error: msg };
    }
  }

  /** 手动换核的 bundle 写入腿（非 macOS-v5）：copy → 签名 → 落位后预检。失败抛出由 replaceManualCore 外层 catch 回滚。 */
  private async writeManualCoreToBundle(sourcePath: string): Promise<void> {
    const targetPath = resourceManager.getSingBoxUpdateTargetPath();
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    this.logManager.addLog(
      'info',
      `手动替换核心: ${sourcePath} → ${targetPath}`,
      'CoreUpdateService'
    );
    if (process.platform === 'win32') {
      await this.copyFileElevatedWindows(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
      fs.chmodSync(targetPath, 0o755);
    }
    // naive 依赖：libcronet 与新核心同目录（linux/win dlopen；macOS 静态编入为 no-op）
    await resourceManager.ensureCronetBeside(targetDir);
    if (process.platform === 'darwin') {
      try {
        const { execSync } = require('child_process');
        execSync(`xattr -cr "${targetPath}"`, { stdio: 'pipe' });
        execSync(`codesign --force --deep -s - "${targetPath}"`, { stdio: 'pipe' });
      } catch (signError: any) {
        this.logManager.addLog(
          'warn',
          `手动替换签名处理失败: ${signError.message}`,
          'CoreUpdateService'
        );
      }
    }
    // 落位 + 签名后预检（确认落位核能跑）；失败抛出 → 外层 catch restoreBackup。
    const preflight = await this.preflightValidate(targetPath);
    if (!preflight.ok) {
      throw new Error(`落位后核心预检失败（${preflight.reason}）`);
    }
    // record 不在此做——由 replaceManualCore 统一处理（wasRunning ? 待验证闩+首启钩子 : 直接 record）
  }

  /** 重置内核到出厂版本：把随 App 出厂的 bundled 核 force 落位回受保护目录（macOS-v5）/bundle。
   *  skipBackup=true：出厂核是用户要的终态，现役核是用户要丢弃的——不备份/不验证闩/不回退（去冗余）。
   *  force 跳过同版本短路（出厂核常与现役同版本，重置仍要覆盖回去）。 */
  async resetCoreToFactory(): Promise<{ ok: boolean; error?: string }> {
    this.logManager.addLog('info', '重置内核到出厂版本...', 'CoreUpdateService');
    const bundlePath = resourceManager.getBundledSingBoxPath();
    const r = await this.replaceManualCore({ filePath: bundlePath, force: true, skipBackup: true });
    if (r.ok) {
      this.pruneBackup(); // 清理旧备份（reset 到出厂 = 干净状态，残留 .bak 无意义）
      this.logManager.addLog('info', '内核已重置到出厂版本', 'CoreUpdateService');
    }
    return { ok: r.ok, error: r.error };
  }

  // === 核心更新健壮性：预检 / 问题版本跳过 / 备份生命周期 / 自动回滚 ===

  /**
   * 取任意 sing-box 二进制的版本（执行 `<bin> version` 解析）。返回 { version, versionLine }：
   * version=完整 token（保留 prerelease/fork 后缀，形状不符或不可执行 → null）、versionLine=原始首行（供来源判定）。
   */
  private async getBinaryVersion(
    binPath: string
  ): Promise<{ version: string | null; versionLine: string }> {
    try {
      const execFileAsync = require('util').promisify(require('child_process').execFile);
      const { stdout } = await execFileAsync(binPath, ['version']);
      // 保留完整后缀：同版本短路需精确匹配预览版、B-2 基线预判 / B-3 来源识别需原始行（单一真值 shared/core-build）。
      return parseUploadedCoreVersion(String(stdout));
    } catch {
      return { version: null, versionLine: '' };
    }
  }

  /** 标记问题版本（委托 CoreUpdateStateStore）：预检/启动失败的版本自动更新跳过，手动仍可强装。 */
  private markKnownBad(version: string): void {
    this.stateStore.markKnownBad(version);
  }

  isKnownBad(version: string): boolean {
    return this.stateStore.isKnownBad(version);
  }

  /** 从问题版本名单移除某版本（委托 CoreUpdateStateStore；该版本成功运行后调用，使误标记可恢复）。 */
  private clearKnownBad(version: string): void {
    this.stateStore.clearKnownBad(version);
  }

  private async isRestrictToCompatibleMinor(): Promise<boolean> {
    try {
      if (!this.configProvider) return true;
      const cfg = await this.configProvider();
      return cfg?.restrictCoreUpdateToCompatibleMinor !== false; // 默认 true
    } catch {
      return true;
    }
  }

  /**
   * 核心更新预检：新核心二进制可执行 + 能解析"针对其版本生成的"当前配置（sing-box check）。
   * 在替换现役核心之前调用 —— 不通过则现役核心不动、代理继续运行（永不 brick）。
   */
  private async preflightValidate(
    newCorePath: string
  ): Promise<{ ok: boolean; version: string | null; versionLine: string; reason?: string }> {
    const { version, versionLine } = await this.getBinaryVersion(newCorePath);
    if (!version) {
      return {
        ok: false,
        version: null,
        versionLine,
        reason: '新核心无法执行（架构不符或文件损坏）',
      };
    }

    const cfgJson = this.proxyManager ? this.proxyManager.buildPreflightConfigJson(version) : null;
    if (!cfgJson) {
      // 无活动配置（代理从未启动）→ 二进制可执行即视为通过
      this.logManager.addLog(
        'info',
        `预检：新核心 ${version} 可执行（无活动配置，跳过 check）`,
        'CoreUpdateService'
      );
      return { ok: true, version, versionLine };
    }

    const tmpCfg = path.join(app.getPath('temp'), `flowz-preflight-${Date.now()}.json`);
    try {
      fs.writeFileSync(tmpCfg, cfgJson, 'utf-8');
      const execFileAsync = require('util').promisify(require('child_process').execFile);
      await execFileAsync(newCorePath, ['check', '-c', tmpCfg]);
      this.logManager.addLog(
        'info',
        `预检通过：新核心 ${version} 可解析当前配置`,
        'CoreUpdateService'
      );
      return { ok: true, version, versionLine };
    } catch (e: any) {
      const detail = String(e?.stderr || e?.message || e).split('\n')[0];
      return { ok: false, version, versionLine, reason: `新核心无法解析当前配置：${detail}` };
    } finally {
      try {
        fs.unlinkSync(tmpCfg);
      } catch {
        /* ignore */
      }
    }
  }

  /** 删除旧核心备份（新核心已稳定运行后调用 —— 稳定即不再回滚，省磁盘）。 */
  private pruneBackup(): void {
    try {
      const bak = this.getBackupPath();
      if (fs.existsSync(bak)) {
        fs.unlinkSync(bak);
        this.logManager.addLog('info', '新核心已稳定运行，已删除旧核心备份', 'CoreUpdateService');
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * 新核心首启成功后启动"稳定观察期"：STABILITY_DWELL_MS 内无 'error' 才判定稳定 → 删旧备份、清待
   * 验证标记、恢复自动重启。期内若 'error' 触发 autoRollback 会先取消本计时器（备份仍在，可回滚）。
   */
  private startStabilityWatch(): void {
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    const watching = this.pendingUpdateVersion;
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      if (this.pendingUpdateVersion !== watching) return; // 已被回滚/其它路径清除
      this.logManager.addLog(
        'info',
        `新核心 ${watching} 已稳定运行 ${CoreUpdateService.STABILITY_DWELL_MS / 1000}s，删除旧核心备份`,
        'CoreUpdateService'
      );
      this.pruneBackup();
      if (this.pendingFallbackTimer) clearTimeout(this.pendingFallbackTimer);
      this.pendingFallbackTimer = null;
      this.pendingUpdateVersion = null;
      this.proxyManager?.setAutoRestartSuppressed(false);
    }, CoreUpdateService.STABILITY_DWELL_MS);
  }

  /**
   * 更新后新核心"首次启动失败"时调用（由上层在 proxy 'error' 事件中触发）：回滚到备份核心并标记
   * 问题版本。返回 true 表示已回滚（调用方应以旧核心重启代理）。先清除待验证标记防重入/回滚循环。
   */
  async autoRollbackIfPendingUpdate(): Promise<boolean> {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    if (this.pendingFallbackTimer) {
      clearTimeout(this.pendingFallbackTimer);
      this.pendingFallbackTimer = null;
    }
    const pending = this.pendingUpdateVersion;
    const pendingAge = Date.now() - this.pendingUpdateAt;
    this.pendingUpdateVersion = null;
    this.proxyManager?.setAutoRestartSuppressed(false); // 回滚后旧核心恢复正常自动重启
    if (!pending) return false;
    // 过期保护：距本次更新过久仍未成功运行，此刻的 error 多半与核心更新无关（如用户改了配置）→ 不回滚
    if (pendingAge > CoreUpdateService.PENDING_MAX_AGE_MS) {
      this.logManager.addLog(
        'info',
        `待验证版本 ${pending} 距更新已超 ${CoreUpdateService.PENDING_MAX_AGE_MS / 60000} 分钟仍未成功运行，本次错误不触发回滚`,
        'CoreUpdateService'
      );
      return false;
    }
    if (!this.hasBackup()) return false;
    this.logManager.addLog(
      'error',
      `新核心 ${pending} 启动失败，自动回滚到备份核心`,
      'CoreUpdateService'
    );
    try {
      await this.rollbackCore(); // 恢复 .bak → 现役（内部停代理 + 删备份 + 记录版本）
      this.markKnownBad(pending);
      return true;
    } catch (e) {
      this.logManager.addLog('error', `自动回滚失败: ${e}`, 'CoreUpdateService');
      return false;
    }
  }

  /**
   * 版本记录文件路径
   */
  private getVersionFilePath(): string {
    return path.join(app.getPath('userData'), 'core-version.json');
  }

  // --- 私有辅助方法 ---

  // 版本比较收口到 shared/version.compareSemver（与 UpdateService.isNewerVersion 共用单一权威）。
  // 保留薄包装：内部 3 处调用 this.compareVersions 签名不变，行为等价（容忍前导 v 与 -/+ 后缀）。
  private compareVersions(v1: string, v2: string): number {
    return compareSemver(v1, v2);
  }

  private getBackupPath(): string {
    // Windows: store backup in userData (user-writable), NOT in Program Files
    // macOS/Linux: keep it alongside the binary (we have write access there)
    if (process.platform === 'win32') {
      return path.join(app.getPath('userData'), 'sing-box.exe.bak');
    }
    // macOS 受保护目录 / Linux root 受管核目录都是 root-only，.bak 不能落那 → 统一放 userData（用户可写）；备份内容
    // 从 getSingBoxPath（受保护/受管核或 bundle，均可读）复制来。（Linux setcap 兜底态核在 userData 亦可读，一致。）
    if (process.platform === 'darwin' || process.platform === 'linux') {
      return path.join(app.getPath('userData'), 'core-backup', 'sing-box.bak');
    }
    return resourceManager.getSingBoxPath() + '.bak';
  }

  private async backupCurrentCore(): Promise<void> {
    const currentPath = resourceManager.getSingBoxPath();
    const backupPath = this.getBackupPath();
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });

    if (fs.existsSync(currentPath)) {
      if (process.platform === 'win32') {
        // On Windows copy to userData dir (no UAC needed)
        await this.copyFileElevatedWindows(currentPath, backupPath);
      } else {
        fs.copyFileSync(currentPath, backupPath);
      }
      this.logManager.addLog('info', `已备份当前核心到: ${backupPath}`, 'CoreUpdateService');
    }
  }

  private async restoreBackup(): Promise<void> {
    const backupPath = this.getBackupPath();
    if (!fs.existsSync(backupPath)) return;
    try {
      // B 块 macOS（helper v5）：经 helper install-core 把 backup 写回受保护目录（与 rollbackCore 同源，[HIGH-1]）。
      if (await this.isProtectedCoreActive()) {
        await this.installSingleCoreViaHelper(backupPath);
        this.logManager.addLog('info', '已从备份恢复核心（受保护目录）', 'CoreUpdateService');
        return;
      }
      const currentPath = resourceManager.getSingBoxUpdateTargetPath();
      if (process.platform === 'win32') {
        await this.copyFileElevatedWindows(backupPath, currentPath);
      } else {
        fs.copyFileSync(backupPath, currentPath);
        fs.chmodSync(currentPath, 0o755);
      }
      this.logManager.addLog('info', '已从备份恢复核心', 'CoreUpdateService');
    } catch {
      this.logManager.addLog('error', '恢复备份失败', 'CoreUpdateService');
    }
  }

  /**
   * Windows 专用：通过 PowerShell 以管理员权限复制文件
   * 解决将文件写入 C:\Program Files (UAC 保护目录) 时的 EPERM 问题
   */
  private async copyFileElevatedWindows(src: string, dest: string): Promise<void> {
    // delegate → PlatformPrivilegeService.copyFileElevated（T16 子 commit 1：PowerShell RunAs 逻辑原样保留，
    // this.logManager.addLog → ctx.log）；未注入时保留原实现兜底。
    if (this.privilegeService) return this.privilegeService.copyFileElevated(src, dest);
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

      this.logManager.addLog(
        'info',
        `Direct copy failed (${directErr.code}), attempting elevated PowerShell copy...`,
        'CoreUpdateService'
      );

      // Fall back: use PowerShell with -Verb RunAs to elevate.
      const scriptPath = path.join(app.getPath('temp'), `flowz-copy-${Date.now()}.ps1`);
      // 使用 $ErrorActionPreference = 'Stop' 确保出错时非 0 退出
      // 增加 Stop-Process 防御，防止因为 TUN 模式的高权限占用导致无法覆盖
      fs.writeFileSync(
        scriptPath,
        `$ErrorActionPreference = 'Stop'\nStop-Process -Name "sing-box" -Force -ErrorAction SilentlyContinue\nStart-Sleep -Seconds 1\nCopy-Item -Path '${escapedSrc}' -Destination '${escapedDest}' -Force\n`
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
}
