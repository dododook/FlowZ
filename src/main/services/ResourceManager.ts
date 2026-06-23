import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { LogLevel } from '../../shared/types';
import type { LogManager } from './LogManager';
import { sha256File } from '../../shared/file-hash';

/** libcronet 自愈动作：ok=已就位无需动 / restored=刚从内置 bundle 重拷 / failed=拷贝失败（已告警，调用方降级）。 */
export type CronetHealAction = 'ok' | 'restored' | 'failed';

/**
 * 资源文件管理器
 * 根据平台和架构返回对应的资源文件路径
 */
export class ResourceManager {
  private _isDev?: boolean;
  private readonly platform: string;
  private readonly arch: string;
  private logManager?: LogManager;

  constructor() {
    this.platform = process.platform;
    this.arch = process.arch;
  }

  /**
   * 注入 LogManager（由主流程在 index.ts 统一注入）。注入前日志走 console fallback。
   */
  setLogManager(lm: LogManager): void {
    this.logManager = lm;
  }

  /**
   * 统一日志出口：已注入 LogManager 则转发，否则按级别 fallback 到 console。
   */
  private log(level: LogLevel, message: string): void {
    if (this.logManager) {
      this.logManager.addLog(level, message, 'ResourceManager');
      return;
    }
    if (level === 'error' || level === 'fatal') console.error(message);
    else if (level === 'warn') console.warn(message);
    else console.log(message);
  }

  private get isDev(): boolean {
    if (this._isDev === undefined) {
      // Use optional chaining just in case app is undefined during an early evaluation
      this._isDev = !(app?.isPackaged ?? true);
    }
    return this._isDev;
  }

  /**
   * 获取 sing-box 可执行文件路径
   */
  getSingBoxPath(): string {
    // Windows 平台需要 .exe 扩展名
    const filename = this.platform === 'win32' ? 'sing-box.exe' : 'sing-box';

    // Windows Portable 模式特殊处理：优先使用 userData 下的核心
    if (this.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_DIR) {
      const fs = require('fs');
      const portableCorePath = path.join(app.getPath('userData'), 'core_update', filename);
      if (fs.existsSync(portableCorePath)) {
        return portableCorePath;
      }
    }

    // Linux 模式特殊处理：优先使用 userData 下的核心，以便支持 setcap 和规避 AppImage EROFS
    if (this.platform === 'linux') {
      const fs = require('fs');
      const linuxCorePath = path.join(app.getPath('userData'), 'core_update', filename);
      if (fs.existsSync(linuxCorePath)) {
        return linuxCorePath;
      }
    }

    // macOS 内核持久化（B 块）：优先受保护目录下的内核（存在且可执行——持久化更新写入处），否则回落 bundle 出厂
    // 内核。受保护目录惰性创建（仅首次内核更新时），未创建时此处自然 fallback，行为与改动前一致、永不 brick。
    if (this.platform === 'darwin') {
      const fs = require('fs');
      const protectedCore = path.join(this.getProtectedCoreDir(), filename);
      try {
        fs.accessSync(protectedCore, fs.constants.X_OK);
        return protectedCore;
      } catch {
        /* 受保护目录无内核/不可执行 → 用 bundle 出厂内核 */
      }
    }

    const platformDir = this.getPlatformResourceDir();
    const singboxPath = path.join(platformDir, filename);

    return singboxPath;
  }

  /**
   * 获取核心更新时的目标写入路径
   * 专为解决 Portable 版本每次启动清空临时目录导致更新失效的问题
   */
  getSingBoxUpdateTargetPath(): string {
    const filename = this.platform === 'win32' ? 'sing-box.exe' : 'sing-box';

    // Windows Portable 模式特殊处理：更新文件必须写入 userData 才能持久化
    if (this.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_DIR) {
      return path.join(app.getPath('userData'), 'core_update', filename);
    }

    // Linux 下特殊处理：AppImage 是只读文件系统 (EROFS)，更新核心必须写入 userData
    if (this.platform === 'linux') {
      return path.join(app.getPath('userData'), 'core_update', filename);
    }

    // macOS：fallback 写路径显式回 bundle（与 getSingBoxPath 受保护目录优先解耦）。受保护目录是 root-only，普通用户
    // 写不了；持久化更新经 helper v5 install-core 由 root 写（CoreUpdateService 改道），非 helper-v5 路径才回落此 bundle 写。
    if (this.platform === 'darwin') {
      return this.getBundledSingBoxPath();
    }

    return this.getSingBoxPath();
  }

  /**
   * 获取随包内置的 macOS 提权 helper 二进制路径（与 sing-box 同目录）。
   * 生产环境：<App>/Contents/Resources/mac/com.flowz.helper；开发环境：resources/mac-${arch}/com.flowz.helper。
   * 仅 macOS 有意义；安装时由 HelperManager 复制到 /Library/PrivilegedHelperTools/。
   */
  getMacHelperPath(): string {
    return path.join(this.getPlatformResourceDir(), 'com.flowz.helper');
  }

  /**
   * 获取随包内置的 Windows 提权 helper 服务二进制路径（与 sing-box.exe 同目录，安装期的**复制源**）。
   * 生产/开发：<resources>/win/com.flowz.helper.exe。仅 Windows 有意义。
   * 安装时由 WindowsServiceHelper 把它**复制外置**到 ProgramData\FlowZ 再注册为 LocalSystem 服务，binPath 指向
   * 外置副本（非此 app 内路径）——故 app 更新/移动不影响服务、卸载由 helper 自卸载/NSIS 钩子清外置副本。
   * 镜像 macOS HelperManager 把 helper 复制出 .app 到 /Library/PrivilegedHelperTools 的范式。
   */
  getWinHelperPath(): string {
    return path.join(this.getPlatformResourceDir(), 'com.flowz.helper.exe');
  }

  /** macOS 内核持久化的受保护目录（root-only 写，App 升级不覆盖；B 块）。helper 安装时经 --coredir 锁定它，
   *  install-core 只写此目录。仅 macOS 有意义。 */
  getProtectedCoreDir(): string {
    return '/Library/Application Support/FlowZ/core';
  }

  /** 始终指向随 App 出厂的 bundle 内核（B 块 App 升级仲裁 / 受保护目录种子用，绕过受保护目录优先逻辑）。 */
  getBundledSingBoxPath(): string {
    const filename = this.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
    return path.join(this.getPlatformResourceDir(), filename);
  }

  /**
   * 获取应用图标路径（统一使用 app.png）
   */
  getAppIconPath(): string {
    if (this.isDev) {
      return path.join(process.cwd(), 'resources', 'app.png');
    }
    // 生产环境：app.png 在 process.resourcesPath 根目录
    return path.join(process.resourcesPath, 'app.png');
  }

  /**
   * 获取托盘图标路径
   * @param connected 是否已连接，true 返回彩色图标，false 返回灰色图标
   */
  getTrayIconPath(connected: boolean = false): string {
    const filename = connected ? 'app.png' : 'app-gray.png';
    if (this.isDev) {
      return path.join(process.cwd(), 'resources', filename);
    }
    return path.join(process.resourcesPath, filename);
  }

  /** 随包 data 目录内任意资源文件的出厂路径（供内置 app 分流 geo .srs 等通用 bundle 项取 bundledPath）。 */
  getDataResourcePath(fileName: string): string {
    return path.join(this.getDataResourceDir(), fileName);
  }

  /**
   * sing-box 官方面板**随包内置**目录（SagerNet/sing-box-dashboard 的 gh-pages 构建，scripts/fetch-dashboard.mjs 拉取）。
   * 生产：<resources>/dashboard；开发：<cwd>/resources/dashboard。electron-builder extraResources 直拷到 resources/dashboard。
   * sing-box services[].dashboard.path 指向它（或运行时下载覆盖目录）→ 核直接 serve 本地、零联网下载、打开即时（dashboard #55）。
   */
  getBundledDashboardDir(): string {
    return path.join(this.getResourcesBaseDir(), 'dashboard');
  }

  /** 目录是否含 index.html（同步存在性探测，异常→false）。面板「就绪」判定的单一口径。 */
  private hasIndex(dir: string): boolean {
    try {
      return require('fs').existsSync(path.join(dir, 'index.html'));
    } catch {
      return false;
    }
  }

  /** 内置面板是否就绪（含 index.html）：异常打包/未跑 fetch:dashboard 时可能缺失 → serve 决策据此回落（不注入 path 则核走联网下载兜底）。 */
  hasBundledDashboard(): boolean {
    return this.hasIndex(this.getBundledDashboardDir());
  }

  /**
   * 解析面板「实际 serve 目录」：**运行时下载覆盖优先**（overrideDir 含 index.html）→ 否则随包内置目录。
   * 返回 null = 两者皆无（异常打包且未下载）→ 调用方不注入 dashboard.path，由 sing-box 联网下载兜底（保旧行为不 brick）。
   * 纯路径决策（仅 existsSync 探测），无副作用；与内置 geo 的「下载优先、内置兜底」语义对齐。
   */
  resolveDashboardServeDir(overrideDir: string): string | null {
    if (this.hasIndex(overrideDir)) return overrideDir;
    const bundled = this.getBundledDashboardDir();
    return this.hasIndex(bundled) ? bundled : null;
  }

  /**
   * 获取 GeoIP 数据文件路径
   */
  getGeoIPPath(): string {
    const dataDir = this.getDataResourceDir();
    return path.join(dataDir, 'geoip-cn.srs');
  }

  /**
   * 获取 GeoSite 中国数据文件路径
   */
  getGeoSiteCNPath(): string {
    const dataDir = this.getDataResourceDir();
    return path.join(dataDir, 'geosite-cn.srs');
  }

  /**
   * 获取 GeoSite 非中国数据文件路径
   */
  getGeoSiteNonCNPath(): string {
    const dataDir = this.getDataResourceDir();
    return path.join(dataDir, 'geosite-geolocation-!cn.srs');
  }

  /**
   * 检查资源文件是否存在
   */
  async checkResourcesExist(): Promise<{ exists: boolean; missing: string[] }> {
    const missing: string[] = [];

    // 检查 sing-box 可执行文件
    const singboxPath = this.getSingBoxPath();
    if (!(await this.fileExists(singboxPath))) {
      missing.push(`sing-box executable: ${singboxPath}`);
    }

    // 检查 GeoIP/GeoSite 数据文件
    const geoFiles = [
      { name: 'GeoIP CN', path: this.getGeoIPPath() },
      { name: 'GeoSite CN', path: this.getGeoSiteCNPath() },
      { name: 'GeoSite Non-CN', path: this.getGeoSiteNonCNPath() },
    ];

    for (const file of geoFiles) {
      if (!(await this.fileExists(file.path))) {
        missing.push(`${file.name}: ${file.path}`);
      }
    }

    return {
      exists: missing.length === 0,
      missing,
    };
  }

  /**
   * 获取平台特定的资源目录
   */
  private getPlatformResourceDir(): string {
    const baseDir = this.getResourcesBaseDir();

    if (this.platform === 'win32') {
      return path.join(baseDir, 'win');
    } else if (this.platform === 'darwin') {
      if (this.isDev) {
        // 开发环境：根据架构选择不同的目录
        if (this.arch === 'arm64') {
          return path.join(baseDir, 'mac-arm64');
        } else {
          return path.join(baseDir, 'mac-x64');
        }
      } else {
        // 生产环境：打包后统一使用 mac 目录
        return path.join(baseDir, 'mac');
      }
    } else if (this.platform === 'linux') {
      if (this.isDev) {
        // 开发环境：优先根据架构选择目录，如果找不到则回退到 linux 目录
        const fs = require('fs');
        const archDir = this.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
        const fullArchDirPath = path.join(baseDir, archDir);

        if (fs.existsSync(fullArchDirPath)) {
          return fullArchDirPath;
        }
        return path.join(baseDir, 'linux');
      } else {
        // 生产环境：打包后统一使用 linux 目录
        return path.join(baseDir, 'linux');
      }
    }

    throw new Error(`Unsupported platform: ${this.platform}`);
  }

  /**
   * 获取数据文件目录
   */
  private getDataResourceDir(): string {
    const baseDir = this.getResourcesBaseDir();
    return path.join(baseDir, 'data');
  }

  /**
   * 获取资源文件基础目录
   * 开发环境和生产环境路径不同
   */
  private getResourcesBaseDir(): string {
    if (this.isDev) {
      // 开发环境：项目根目录下的 resources
      return path.join(process.cwd(), 'resources');
    } else {
      // 生产环境：打包后的 resources 目录
      // process.resourcesPath 指向 app.asar 所在的 resources 目录
      // extraResources 直接复制到 process.resourcesPath 下
      return process.resourcesPath;
    }
  }

  /**
   * 检查文件是否存在
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 确保「现役核」就位并返回其路径——平台感知的随包核播种入口（§5 两平台统一调用 ensureWritableCore(true)）：
   *  - linux：用户目录可写核（解决 AppImage EROFS + setcap），force 时随包核覆盖刷新；
   *  - darwin：受保护目录 root-only，force 时经已装 helper install-core 重播种随包核（免密码）——复制到干净临时
   *    目录再装（避免带入同目录 helper/LICENSE），macOS 无 libcronet 静态编入只播 sing-box。需注入 deps.installCore
   *    （由 ProxyManager 传 HelperManager.installCore，保持本模块零 HelperManager 依赖）；缺注入 / 非 force → no-op
   *    回落 getSingBoxPath（行为同改动前：受保护目录无核则用 bundle 出厂核）；
   *  - 其它平台：no-op 返回 getSingBoxPath。
   *
   * @param deps.installCore darwin 重播种用——把 seedDir 内的随包核经提权 helper 装进受保护目录（{ok,error}）。
   */
  async ensureWritableCore(
    force = false,
    deps?: { installCore?: (seedDir: string) => Promise<{ ok: boolean; error?: string }> }
  ): Promise<string> {
    if (this.platform === 'darwin') {
      // 仅 force（§5 reseed 决策）+ 注入了 helper installCore 时才重播种；否则 no-op（保持改动前行为）。
      if (force && deps?.installCore) {
        try {
          const os = require('os') as typeof import('os');
          const seedDir = path.join(os.tmpdir(), 'flowz-core-reseed');
          await fs.mkdir(seedDir, { recursive: true });
          await fs.copyFile(this.getBundledSingBoxPath(), path.join(seedDir, 'sing-box'));
          const r = await deps.installCore(seedDir);
          if (!r.ok) this.log('warn', `随包内核重播种失败: ${r.error ?? ''}`);
        } catch (e) {
          this.log('warn', `随包内核刷新失败: ${(e as Error)?.message ?? e}`);
        }
      }
      return this.getSingBoxPath();
    }
    if (this.platform !== 'linux') {
      return this.getSingBoxPath();
    }

    const userDataPath = app.getPath('userData');
    const updateDir = path.join(userDataPath, 'core_update');
    const targetPath = path.join(updateDir, 'sing-box');

    // 检查是否已经有可写核心（force=true 跳过复用、强制用随包核覆盖——§5 最低版本守卫：升级遗留的旧可写核
    // 会被硬切 1.14 的配置 FATAL，须随包 1.14 核覆盖刷新）
    if (!force && (await this.fileExists(targetPath))) {
      // 已有可写核心：仍需确保 libcronet 在旁（naive 出站靠 purego 同目录/系统库路径加载）
      await this.ensureCronetBeside(updateDir);
      return targetPath;
    }

    // 创建目录
    await fs.mkdir(updateDir, { recursive: true });

    // 从应用内置的包中复制（force 时 copyFile 覆盖旧核）
    const platformDir = this.getPlatformResourceDir();
    const sourcePath = path.join(platformDir, 'sing-box');

    if (await this.fileExists(sourcePath)) {
      // 原子替换（写 targetPath.tmp → chmod 0o755 → rename），非原地 copyFile 覆盖：force 重播种时 targetPath
      // 可能正被运行中的 sing-box 执行，原地 O_TRUNC 打开会 ETXTBSY（text file busy）致覆盖失败、旧核残留
      //（issue #150）。rename 只把旧 inode unlink（在用进程继续持有旧 inode 不受影响），文件名指向全新核 →
      // 根除 ETXTBSY。与 ensureCronetHealthy 的 libcronet 写盘同款原子语义。
      await this.atomicCopy(sourcePath, targetPath);
    }

    // naive 节点需要 libcronet 与 sing-box 同目录（purego 加载），随核心一并放过去
    await this.ensureCronetBeside(updateDir);

    return targetPath;
  }

  /** 各平台 NaiveProxy 核心库文件名（purego 期望的名字） */
  getCronetLibFilename(): string {
    if (this.platform === 'win32') return 'libcronet.dll';
    if (this.platform === 'darwin') return 'libcronet.dylib';
    return 'libcronet.so';
  }

  /**
   * libcronet（naive 出站依赖库）的可用性状态：
   * - 'available'：可加载（macOS 静态编入，或 linux/win 核心同目录已有库）→ naive 可用
   * - 'copy-failed'：linux/win 内置了库、但核心同目录缺库（ensureCronetBeside 拷贝失败：EACCES/磁盘满/
   *   AV 锁等瞬时原因）→ 非永久"无库"，应提示拷贝/权限问题而非"无预编译库"
   * - 'no-lib'：内置就没有该平台的库（如 mac-x64 未编入、或未跑 fetch-cronet）→ 真·不可用
   */
  getCronetLibStatus(): 'available' | 'copy-failed' | 'no-lib' {
    try {
      // macOS：cronet 由 sing-box 二进制静态编入（CGO，无 .dylib）。打包的 mac-arm64 与 mac-x64
      // 核心（均 ≥1.13.13，with_naive_outbound）都含静态 cronet → naive 两 arch 皆可用、无需外部库。
      if (this.platform === 'darwin') {
        return 'available';
      }
      const fsSync = require('fs');
      const libName = this.getCronetLibFilename();
      // linux/windows：cronet 走 dlopen 动态加载。检查 libcronet 是否在 sing-box 实际加载目录
      // （purego 从二进制同目录加载）：Linux/便携=可写核心目录(已由 ensureCronetBeside 拷入)，
      // 非便携 win=内置 resources 目录。不以"内置存在"直接判可用——否则 beside 拷贝失败仍误判"可用"→ FATAL。
      const coreDir = path.dirname(this.getSingBoxPath());
      const dstLib = path.join(coreDir, libName);
      const bundledLib = path.join(this.getPlatformResourceDir(), libName);
      if (fsSync.existsSync(dstLib)) {
        // 存在但损坏（0 字节/截断/版本错位 → size≠bundle）判 copy-failed：当前不可用，可经自愈恢复（语义同瞬时故障）。
        // 仅在内置存在时比对（无内置=无权威源，回落原存在性判定，避免把可用库误判损坏）。
        if (
          fsSync.existsSync(bundledLib) &&
          fsSync.statSync(dstLib).size !== fsSync.statSync(bundledLib).size
        ) {
          return 'copy-failed';
        }
        return 'available';
      }
      // 加载目录缺库：区分"内置压根没有"（真·无库）与"内置有但 ensureCronetBeside 拷贝失败"（瞬时故障）。
      // 后者不应永久按"无库/macOS 无预编译库"拒用 naive，应提示拷贝/权限问题，可通过重试/修权限恢复。
      return fsSync.existsSync(bundledLib) ? 'copy-failed' : 'no-lib';
    } catch {
      return 'no-lib';
    }
  }

  /** 内置的 libcronet 是否可用（用于 naive 可用性判断）。copy-failed 也视为当前不可用（库未就位）。 */
  hasCronetLib(): boolean {
    return this.getCronetLibStatus() === 'available';
  }

  /**
   * 把内置的 libcronet 复制到与（可写/已更新）核心同一目录，供 naive 出站(purego) 加载。
   * 供 ensureWritableCore 与核心更新写盘后调用。薄 wrapper → ensureCronetHealthy（strong=false 热路径，
   * 仅 size 快筛，零 hash 成本）。旧名保留：既有调用点（ensureWritableCore / CoreUpdateService）零改动。
   */
  async ensureCronetBeside(coreDir: string): Promise<void> {
    await this.ensureCronetHealthy(coreDir);
  }

  /**
   * libcronet 缺失/损坏自愈（完整性感知的播种）：从内置 bundle 把 libcronet 恢复到核心同目录。
   * 权威源恒为内置 bundle（与 sing-box 同包、版本天然一致），离线可恢复——不联网下载。
   *
   * 判据（见 cronetNeedsRestore）：dst 缺失 / size(dst)≠size(src)（热路径快筛，抓 0 字节/截断/版本错位）；
   * strong=true 时额外比 sha256（冷路径，启动失败后强校验）。修复走 atomicCopy（dst.tmp + rename，原子规避半写/AV 锁）。
   *
   * @returns action：ok（无需动，含 mac-x64 等无内置库 reason='no-bundled-lib'）/ restored（已重拷）/
   *          failed（拷贝失败，已告警，调用方回落 naive 降级，不裸崩）。
   */
  async ensureCronetHealthy(
    coreDir: string,
    opts: { strong?: boolean } = {}
  ): Promise<{ action: CronetHealAction; reason?: string }> {
    const name = this.getCronetLibFilename();
    const src = path.join(this.getPlatformResourceDir(), name);
    const dst = path.join(coreDir, name);
    // 内置无该平台库（mac-x64 等）→ 无权威源、无可恢复对象，按现状跳过（与改动前 ensureCronetBeside 行为一致）。
    if (!(await this.fileExists(src))) return { action: 'ok', reason: 'no-bundled-lib' };
    try {
      const need = await this.cronetNeedsRestore(src, dst, opts.strong === true);
      if (!need) return { action: 'ok' };
      await this.atomicCopy(src, dst);
      this.log('info', `libcronet 自愈：restored（${opts.strong ? 'hash' : 'size'}）→ ${dst}`);
      return { action: 'restored' };
    } catch (error) {
      // 复制失败不阻断启动（naive 不可用时 sing-box 会自报 cronet 错误），但必须告警而非静默吞掉：
      // 否则 dst 缺库会被 getCronetLibStatus 判为 'copy-failed'，需要这条日志定位 EACCES/磁盘满/AV 锁等真因。
      const msg = error instanceof Error ? error.message : String(error);
      this.log('warn', `libcronet 自愈失败（naive 暂不可用）：${src} → ${dst}：${msg}`);
      return { action: 'failed', reason: msg };
    }
  }

  /**
   * 判定是否需要从内置 bundle 重拷 libcronet：
   * - dst 缺失 → true；
   * - size(src)≠size(dst) → true（0 字节/截断/跨版本大小必变，命中绝大多数损坏，成本仅 2×stat）；
   * - !strong → 热路径到此即止（零 hash 成本，正常启动每次只 stat）；
   * - strong → 再比 sha256（冷路径强校验，仅启动失败重试时付费）。
   */
  private async cronetNeedsRestore(src: string, dst: string, strong: boolean): Promise<boolean> {
    if (!(await this.fileExists(dst))) return true;
    const [s, d] = [await fs.stat(src), await fs.stat(dst)];
    if (s.size !== d.size) return true;
    if (!strong) return false;
    return sha256File(src) !== sha256File(dst);
  }

  /**
   * 原子拷贝 src→dst：写 dst.tmp → chmod → rename。rename 同盘原子——避免 sing-box 启动时读到半写文件；
   * tmp 失败/rename 被 AV 锁 → 抛给上层 catch 告警回落降级（不留半残破文件占着 dst 位）。
   */
  private async atomicCopy(src: string, dst: string): Promise<void> {
    const tmp = `${dst}.tmp`;
    try {
      await fs.copyFile(src, tmp);
      await fs.chmod(tmp, 0o755);
      await fs.rename(tmp, dst);
    } catch (e) {
      // chmod/rename 失败（如 Windows AV 持 .tmp 扫描锁）→ 清理半残 .tmp 防跨重启累积，再抛给调用方降级。
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
  }

  /**
   * 获取资源信息（用于调试）
   */
  getResourceInfo(): {
    isDev: boolean;
    platform: string;
    arch: string;
    baseDir: string;
    singboxPath: string;
    geoIPPath: string;
    geoSiteCNPath: string;
    geoSiteNonCNPath: string;
  } {
    return {
      isDev: this.isDev,
      platform: this.platform,
      arch: this.arch,
      baseDir: this.getResourcesBaseDir(),
      singboxPath: this.getSingBoxPath(),
      geoIPPath: this.getGeoIPPath(),
      geoSiteCNPath: this.getGeoSiteCNPath(),
      geoSiteNonCNPath: this.getGeoSiteNonCNPath(),
    };
  }
}

// 导出单例实例
export const resourceManager = new ResourceManager();
