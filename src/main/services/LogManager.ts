/**
 * 日志管理服务
 * 负责日志记录、存储、查询和级别过滤
 */

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { LogEntry, LogLevel } from '../../shared/types';
import { getLogsPath } from '../utils/paths';

export interface ILogManager {
  addLog(level: LogLevel, message: string, source: string, stack?: string): void;
  getLogs(limit?: number): LogEntry[];
  clearLogs(): void;
  setLogLevel(level: LogLevel): void;
  getLogLevel(): LogLevel;
  on(event: 'log', listener: (log: LogEntry) => void): void;
  off(event: 'log', listener: (log: LogEntry) => void): void;
}

export class LogManager extends EventEmitter implements ILogManager {
  private logs: LogEntry[] = [];
  private maxLogs = 1000;
  private logFilePath: string;
  private currentLogLevel: LogLevel = 'info';
  private logLevelPriority: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    fatal: 4,
  };
  private maxLogFileSize = 10 * 1024 * 1024; // 10MB
  private maxLogFiles = 5;

  private initPromise: Promise<void>;
  private pendingWrites: Set<Promise<void>> = new Set();
  // 写盘背压上限（issue #210 根因 #1）：日志产生速度 > appendFile 写盘速度时（Linux TUN 下 stdout 全量直喂、
  // 爆发连接风暴、慢盘/磁盘满），pendingWrites 无界增长会撑爆内存（每条 Promise 持有 entry + 闭包，GC 无法回收）。
  // 超过此上限即丢弃本条【落盘】（内存 logs 缓冲仍保留，受 maxLogs=1000 上限，UI 可见性不受影响）——丢盘优先于堆内存。
  // 正常运行远低于此值（写盘微秒级），仅在异常积压时触发兜底。
  private static readonly MAX_PENDING_WRITES = 200;
  // 背压丢弃计数（issue #210 可观测性）：被背压丢弃落盘的日志条数。累积只增不减（进程生命周期内），
  // 供 P4 内存自检 warn 日志/诊断报告引用——若此值持续增长，说明写盘持续跟不上（慢盘/磁盘满/日志风暴）。
  private droppedDueToBackpressure = 0;
  // 连续相同日志折叠：上游重试/风暴/多源(stderr+文件监听)可能短时间刷同一行（level+source+message）。
  // 仅折叠「严格连续」的相同行（被任意不同行打断即重置），3s 内重复丢弃 → 同一 FATAL 不再刷 5-6 行；
  // 持续重复每 ~3s 仍放行一次，保留对「仍在发生」的可见性。distinct/交错日志不受影响。
  private lastFoldKey = '';
  private lastFoldAt = 0;
  private static readonly FOLD_WINDOW_MS = 3000;

  constructor(logDir?: string) {
    super();
    // 使用统一的路径工具，确保始终使用正确的用户数据路径
    const baseLogDir = logDir || getLogsPath();
    this.logFilePath = path.join(baseLogDir, 'app.log');
    this.initPromise = this.ensureLogDirectory();
  }

  /**
   * 确保日志目录存在
   */
  private async ensureLogDirectory(): Promise<void> {
    const logDir = path.dirname(this.logFilePath);
    try {
      await fs.mkdir(logDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create log directory:', error);
    }
  }

  /**
   * 设置日志级别
   */
  setLogLevel(level: LogLevel): void {
    this.currentLogLevel = level;
  }

  /**
   * 获取当前日志级别
   */
  getLogLevel(): LogLevel {
    return this.currentLogLevel;
  }

  /**
   * 检查日志级别是否应该被记录
   */
  private shouldLog(level: LogLevel): boolean {
    return this.logLevelPriority[level] >= this.logLevelPriority[this.currentLogLevel];
  }

  /**
   * 添加日志条目
   */
  addLog(level: LogLevel, message: string, source: string, stack?: string): void {
    // 折叠连续相同日志（防同一行被风暴/重试/多源短时间刷屏）——文件与 UI 都受益，故置于级别过滤之前。
    const foldKey = `${level}|${source}|${message}`;
    const nowMs = Date.now();
    if (foldKey === this.lastFoldKey && nowMs - this.lastFoldAt < LogManager.FOLD_WINDOW_MS) {
      return;
    }
    this.lastFoldKey = foldKey;
    this.lastFoldAt = nowMs;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      source,
      stack,
    };

    // app.log 落盘级别完全跟随用户设置的 logLevel（去掉原 min(level, info) 的 info 保底硬编码）——所见即所得：
    // 用户调高(error/fatal)即文件与界面一同安静、调低(debug)即一同更详细。默认 currentLogLevel=info 保证开箱
    // 排障够；主动调高是知情选择（设置页已提示「调高会减少排障日志」）。file 与 UI 统一受 currentLogLevel 过滤。
    if (!this.shouldLog(level)) {
      return;
    }

    // 文件 sink（app.log，writeToFile 内含按 maxLogFileSize 轮转）
    // 背压保护（issue #210 根因 #1）：写盘积压超 MAX_PENDING_WRITES 时丢弃本条落盘，防 pendingWrites
    // 无界增长撑爆内存——内存 logs 缓冲 + UI 事件在下文照常处理（UI 可见性不受影响），仅跳过 appendFile。
    // 例外：fatal/error 关键级别**绕过上限直写**。崩溃复盘依赖 app.log 的 FATAL/error 行，而背压风暴正是
    // 本 PR 目标场景（慢盘/磁盘满/连接风暴）——此刻把 FATAL 一并丢弃，事后导出恰缺最关键一行、根因不可复原。
    // fatal/error 相对 sing-box stdout 的 info/debug 洪流是低频，豁免不会重新引入无界增长。
    const critical = level === 'fatal' || level === 'error';
    if (critical || this.pendingWrites.size < LogManager.MAX_PENDING_WRITES) {
      const writePromise = this.writeToFile(entry)
        .catch((error) => {
          console.error('Failed to write log to file:', error);
        })
        .finally(() => {
          this.pendingWrites.delete(writePromise);
        });
      this.pendingWrites.add(writePromise);
    } else {
      this.droppedDueToBackpressure++;
    }

    // 内存缓冲 + UI 事件
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    this.emit('log', entry);
  }

  /**
   * 等待所有待处理的写入操作完成
   * 主要用于测试和优雅关闭
   */
  async flush(): Promise<void> {
    await Promise.all(Array.from(this.pendingWrites));
  }

  /**
   * 被背压丢弃落盘的日志累计条数（issue #210 可观测性）。
   * 0 = 写盘始终跟得上；持续增长 = 写盘瓶颈（慢盘/磁盘满/日志风暴），需关注。
   */
  getDroppedDueToBackpressure(): number {
    return this.droppedDueToBackpressure;
  }

  /**
   * 获取日志条目
   */
  getLogs(limit?: number): LogEntry[] {
    if (limit === undefined || limit <= 0) {
      return [...this.logs];
    }
    return this.logs.slice(-limit);
  }

  /**
   * 清空日志（内存和文件）
   */
  clearLogs(): void {
    this.logs = [];
    // 异步清空日志文件
    this.clearLogFiles().catch((error) => {
      console.error('Failed to clear log files:', error);
    });
  }

  /**
   * 清空所有日志文件
   */
  private async clearLogFiles(): Promise<void> {
    try {
      await this.initPromise;
      const logDir = path.dirname(this.logFilePath);
      const logBaseName = path.basename(this.logFilePath, '.log');

      // 清空主日志文件（截断为空）
      try {
        await fs.writeFile(this.logFilePath, '', 'utf-8');
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          console.error('Failed to clear main log file:', error);
        }
      }

      // 删除所有轮转的日志文件
      for (let i = 1; i <= this.maxLogFiles; i++) {
        const rotatedLogFile = path.join(logDir, `${logBaseName}.${i}.log`);
        try {
          await fs.unlink(rotatedLogFile);
        } catch (error: any) {
          // 文件不存在，忽略
          if (error.code !== 'ENOENT') {
            console.error(`Failed to delete rotated log file ${rotatedLogFile}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Failed to clear log files:', error);
    }
  }

  /**
   * 写入日志到文件
   */
  private async writeToFile(entry: LogEntry): Promise<void> {
    try {
      // 等待初始化完成
      await this.initPromise;

      // 检查文件大小，如果超过限制则轮转
      await this.rotateLogIfNeeded();

      const line = this.formatLogEntry(entry);
      await fs.appendFile(this.logFilePath, line + '\n', 'utf-8');
    } catch (error) {
      console.error('Failed to write log entry:', error);
    }
  }

  /**
   * 格式化日志条目
   */
  private formatLogEntry(entry: LogEntry): string {
    const timestamp = entry.timestamp; // 已经是 ISO 字符串
    const level = entry.level.toUpperCase().padEnd(5);
    const source = entry.source.slice(0, 20).padEnd(20);
    let line = `[${timestamp}] [${level}] [${source}] ${entry.message}`;

    if (entry.stack) {
      line += `\n${entry.stack}`;
    }

    return line;
  }

  /**
   * 检查并轮转日志文件
   */
  private async rotateLogIfNeeded(): Promise<void> {
    try {
      const stats = await fs.stat(this.logFilePath);
      if (stats.size >= this.maxLogFileSize) {
        await this.rotateLogFiles();
      }
    } catch (error: any) {
      // 文件不存在，不需要轮转
      if (error.code !== 'ENOENT') {
        console.error('Failed to check log file size:', error);
      }
    }
  }

  /**
   * 轮转日志文件
   */
  private async rotateLogFiles(): Promise<void> {
    try {
      const logDir = path.dirname(this.logFilePath);
      const logBaseName = path.basename(this.logFilePath, '.log');

      // 删除最旧的日志文件
      const oldestLog = path.join(logDir, `${logBaseName}.${this.maxLogFiles}.log`);
      try {
        await fs.unlink(oldestLog);
      } catch (error: any) {
        // 文件不存在，忽略
        if (error.code !== 'ENOENT') {
          console.error('Failed to delete oldest log file:', error);
        }
      }

      // 重命名现有日志文件
      for (let i = this.maxLogFiles - 1; i >= 1; i--) {
        const oldPath = path.join(logDir, `${logBaseName}.${i}.log`);
        const newPath = path.join(logDir, `${logBaseName}.${i + 1}.log`);
        try {
          await fs.rename(oldPath, newPath);
        } catch (error: any) {
          // 文件不存在，忽略
          if (error.code !== 'ENOENT') {
            console.error(`Failed to rename log file ${oldPath}:`, error);
          }
        }
      }

      // 重命名当前日志文件
      const newPath = path.join(logDir, `${logBaseName}.1.log`);
      await fs.rename(this.logFilePath, newPath);
    } catch (error) {
      console.error('Failed to rotate log files:', error);
    }
  }
}
