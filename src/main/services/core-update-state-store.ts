import * as fs from 'fs';
import * as path from 'path';
import type { LogManager } from './LogManager';

/** 已下载预检通过、待落位的内核（代理运行中暂存，延到安全窗口落位）。 */
export interface StagedCoreInfo {
  version: string;
  dir: string; // userData/core-staged，含解压后的 sing-box + 配套文件
  stagedAt: string; // ISO
}

/** 内核自动更新持久状态（userData/core-update-state.json，不进 config，避免每次 check 触发配置原子写）。 */
export interface CoreAutoUpdateState {
  lastCheckAt?: number;
  staged?: StagedCoreInfo;
  crossBandNotifiedVersion?: string; // 已就此跨带版本提示过，避免每轮重复弹
  // 启动期已就此随包版本弹过 macOS 孤儿态 osascript 授权（授权成功 → 下次 decideCoreOverride 判 keep 本不进；
  // 用户取消 → 本版本不再自动弹，防每启弹）。随包版本升级后清零重弹。同 crossBandNotifiedVersion 的一次性防重弹语义。
  startupReseedDeclinedVersion?: string;
  // 内核版本变更「待展示通知」（push 型）：由产生通知的动作（staged 落位 / 立即应用）显式创建，banner 展示即 ack 清除。
  // 取代旧「lastKnownVersion !== currentVersion 推断式比对」——静默 reseed/基线对齐不创建通知即不弹（根治每启误报）。
  pendingChangeNotice?: { previousVersion: string; currentVersion: string };
  // B0：已成功稳定运行、实证兼容过的最高版本带（编码）。棘轮：成功运行抬高、回滚重置到回滚后带。参与有效兼容上限。
  verifiedCeiling?: number;
}

/**
 * 内核自动更新的持久状态读写（从 CoreUpdateService 抽出，便于独立单测；行为逐字保留）。
 * 两个 JSON 文件：core-update-state.json(autoState) + core-known-bad.json(问题版本名单)。
 * 全部失败安全（损坏/缺失→空）；autoState 原子写（tmp+rename）防进程崩在写盘中途留半截 JSON。
 */
export class CoreUpdateStateStore {
  // userDataDir 注入（非内部 app.getPath）：使本 store 不依赖 electron、可独立单测。
  constructor(
    private readonly logManager: LogManager,
    private readonly userDataDir: string
  ) {}

  private getAutoStatePath(): string {
    return path.join(this.userDataDir, 'core-update-state.json');
  }

  /** 读自动更新持久状态（损坏/缺失→空对象，失败安全）。 */
  loadAutoState(): CoreAutoUpdateState {
    try {
      const p = this.getAutoStatePath();
      if (!fs.existsSync(p)) return {};
      const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return d && typeof d === 'object' ? (d as CoreAutoUpdateState) : {};
    } catch {
      return {};
    }
  }

  /** 合并写入自动更新持久状态（仅覆盖传入字段）。原子写：tmp+rename，崩溃一致性。 */
  saveAutoState(patch: Partial<CoreAutoUpdateState>): void {
    try {
      const next = { ...this.loadAutoState(), ...patch };
      const p = this.getAutoStatePath();
      const tmp = `${p}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
      fs.renameSync(tmp, p);
    } catch (e) {
      this.logManager.addLog('warn', `写入内核自动更新状态失败: ${e}`, 'CoreUpdateService');
    }
  }

  private getKnownBadPath(): string {
    return path.join(this.userDataDir, 'core-known-bad.json');
  }

  private loadKnownBad(): string[] {
    try {
      const p = this.getKnownBadPath();
      if (!fs.existsSync(p)) return [];
      const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return Array.isArray(d?.versions) ? d.versions : [];
    } catch {
      return [];
    }
  }

  /** 标记某版本为"问题版本"（预检/启动失败），自动更新将跳过；手动更新仍可强制安装。 */
  markKnownBad(version: string): void {
    try {
      const list = this.loadKnownBad();
      if (!list.includes(version)) list.push(version);
      fs.writeFileSync(
        this.getKnownBadPath(),
        JSON.stringify({ versions: list }, null, 2),
        'utf-8'
      );
      this.logManager.addLog(
        'warn',
        `已标记问题版本 ${version}，自动更新将跳过`,
        'CoreUpdateService'
      );
    } catch {
      /* ignore */
    }
  }

  isKnownBad(version: string): boolean {
    return this.loadKnownBad().includes(version);
  }

  /** 从问题版本名单移除某版本（该版本成功运行后调用，使误标记可恢复）。 */
  clearKnownBad(version: string): void {
    try {
      const list = this.loadKnownBad();
      if (!list.includes(version)) return;
      const next = list.filter((v) => v !== version);
      fs.writeFileSync(
        this.getKnownBadPath(),
        JSON.stringify({ versions: next }, null, 2),
        'utf-8'
      );
    } catch {
      /* ignore */
    }
  }
}
