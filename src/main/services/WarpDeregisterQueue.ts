/**
 * WARP 待注销队列（机会式后台 drain）。
 *
 * 删除带 warpDevice 凭据的 WARP 节点时，凭据 {deviceId, token, enqueuedAt} 入 <userData>/warp/pending-deregister.json
 * （删除恒瞬时、不阻断；见 server-handlers SERVER_DELETE）。本服务在 **app 启动 + 每次成功注册 WARP 后** 机会式
 * drain：逐条按年龄/失败分类决定 done/drop/retry——done/drop/超龄出队，retry 留队等下个触发点。**无常驻定时器**
 * （从不重开 app 者既不 drain 也不产生新孤儿，副作用自洽）。
 *
 * 纯逻辑（入队护栏 / 年龄判定 / MAX_PER_DRAIN 截断 / 失败分类）在 shared/warp.ts 且有单测；本服务只做 IO +
 * 注入式编排。网络（unregister）与文件读写经构造注入，便于单测不触网/不碰真实 FS。
 *
 * 日志红线：只打 deviceId 前缀，绝不打 token。
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import type { LogManager } from './LogManager';
import { getUserDataPath } from '../utils/paths';
import {
  planDeregisterDrain,
  enqueuePendingDeregister,
  WARP_DEREGISTER_MAX_PER_DRAIN,
  type PendingDeregisterEntry,
  type DeregisterResult,
} from '../../shared/warp';

/** 注入依赖：注销实现 + 文件读写 + 时钟（单测全可替换，不触网/不碰真实 FS）。 */
export interface WarpDeregisterQueueDeps {
  /** 调远端注销（默认 WarpService.unregister）。返回 done/drop/retry。 */
  unregister: (deviceId: string, token: string) => Promise<DeregisterResult>;
  logManager?: LogManager;
  /** 队列文件路径（默认 <userData>/warp/pending-deregister.json）。 */
  queueFilePath?: string;
  /** 当前时间（默认 Date.now，单测注入固定值判年龄）。 */
  now?: () => number;
  /** 读队列文件（默认 fs.readFile，缺失→[]）。注入便于单测。 */
  readQueue?: () => Promise<PendingDeregisterEntry[]>;
  /** 写队列文件（默认原子写 <userData>/warp/pending-deregister.json）。 */
  writeQueue?: (queue: PendingDeregisterEntry[]) => Promise<void>;
}

/** 默认队列文件：<userData>/warp/pending-deregister.json。 */
export function defaultQueueFilePath(): string {
  return path.join(getUserDataPath(), 'warp', 'pending-deregister.json');
}

export class WarpDeregisterQueue {
  private readonly unregister: WarpDeregisterQueueDeps['unregister'];
  private readonly logManager?: LogManager;
  // filePath 惰性解析：默认值经 getUserDataPath()（依赖 electron app）——注入 readQueue/writeQueue 的单测无需它，
  // 故不在构造期 eager 求值（否则 jest 无 app 即崩）。仅磁盘 IO 路径访问 filePath 时才解析默认。
  private readonly filePathOverride?: string;
  private readonly now: () => number;
  private readonly readQueueImpl: () => Promise<PendingDeregisterEntry[]>;
  private readonly writeQueueImpl: (queue: PendingDeregisterEntry[]) => Promise<void>;
  /** 防并发重入（启动 drain 与注册后 drain 可能并发）：同一时刻只跑一次 drain。 */
  private draining = false;

  constructor(deps: WarpDeregisterQueueDeps) {
    this.unregister = deps.unregister;
    this.logManager = deps.logManager;
    this.filePathOverride = deps.queueFilePath;
    this.now = deps.now ?? (() => Date.now());
    this.readQueueImpl = deps.readQueue ?? (() => this.readQueueFromDisk());
    this.writeQueueImpl = deps.writeQueue ?? ((q) => this.writeQueueToDisk(q));
  }

  /** 队列文件路径（惰性：仅磁盘 IO 时解析默认 <userData>/warp/pending-deregister.json）。 */
  private get filePath(): string {
    return this.filePathOverride ?? defaultQueueFilePath();
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.logManager?.addLog(level, message, 'WarpDeregisterQueue');
  }

  /** 从磁盘读队列；文件缺失/损坏 → []（失败安全，不阻断）。 */
  private async readQueueFromDisk(): Promise<PendingDeregisterEntry[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (e): e is PendingDeregisterEntry =>
          e &&
          typeof e.deviceId === 'string' &&
          typeof e.token === 'string' &&
          typeof e.enqueuedAt === 'number'
      );
    } catch {
      return [];
    }
  }

  /** 原子写队列（先写 .tmp 再 rename），确保目录存在。 */
  private async writeQueueToDisk(queue: PendingDeregisterEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(queue, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }

  /**
   * 机会式 drain：读队列 → 按年龄/MAX_PER_DRAIN 计划 → 逐 eligible 调 unregister →
   * done/drop/超龄出队、retry 留队 → 写回。fire-and-forget 调用方不 await 也安全（自吞异常）。
   */
  async drain(): Promise<{ done: number; dropped: number; retried: number; expired: number }> {
    const stats = { done: 0, dropped: 0, retried: 0, expired: 0 };
    if (this.draining) return stats; // 并发重入保护
    this.draining = true;
    try {
      const queue = await this.readQueueImpl();
      if (queue.length === 0) return stats;

      const { plan, deferred } = planDeregisterDrain(queue, this.now());
      // 留队集合：deferred（本次未轮到的在龄条目）+ 处理后判定 retry 的条目。
      const keep: PendingDeregisterEntry[] = [...deferred];

      for (const item of plan) {
        const idPrefix = item.entry.deviceId.slice(0, 8);
        if (item.action === 'expire') {
          // 超龄放弃：本地节点早已删、孤儿零计费，warn 后出队（不再消耗预算）。
          const ageDays = Math.floor((this.now() - item.entry.enqueuedAt) / 86_400_000);
          this.log(
            'warn',
            `WARP 设备 ${idPrefix}… 入队 ${ageDays} 天仍未注销，超阈值放弃（本地节点早已删、可忽略）`
          );
          stats.expired += 1;
          continue;
        }
        // eligible：调远端注销。unregister 内部已不抛（按返回值分类）；仍兜底 catch 防注入实现抛出。
        let result: DeregisterResult;
        try {
          result = await this.unregister(item.entry.deviceId, item.entry.token);
        } catch {
          result = 'retry';
        }
        if (result === 'done') {
          this.log('info', `WARP 设备 ${idPrefix}… 已注销，出队`);
          stats.done += 1;
        } else if (result === 'drop') {
          this.log('info', `WARP 设备 ${idPrefix}… 凭据失效，放弃出队`);
          stats.dropped += 1;
        } else {
          // retry：留队等下个触发点（启动间隔即天然退避）。
          keep.push(item.entry);
          stats.retried += 1;
        }
      }

      // 只在队列实际变化时写回（全 retry 且无 expire/done/drop 时跳过写，省一次 IO）。
      if (keep.length !== queue.length) {
        await this.writeQueueImpl(keep);
      }
      if (stats.done + stats.dropped + stats.expired > 0) {
        this.log(
          'info',
          `WARP 待注销 drain：done=${stats.done} drop=${stats.dropped} expire=${stats.expired} retry=${stats.retried}（剩 ${keep.length}，本次至多 ${WARP_DEREGISTER_MAX_PER_DRAIN}）`
        );
      }
      return stats;
    } catch (e: any) {
      this.log('warn', `WARP 待注销 drain 异常（忽略，下次重试）: ${e?.message ?? e}`);
      return stats;
    } finally {
      this.draining = false;
    }
  }

  /** fire-and-forget drain：启动/注册后触发，绝不阻塞主流程、绝不抛。 */
  drainInBackground(): void {
    void this.drain().catch(() => {});
  }

  /** 入队一条待注销凭据（删除节点时调）；受 MAX_QUEUE 护栏，超则丢最旧 + 日志。 */
  async enqueue(entry: PendingDeregisterEntry): Promise<void> {
    const queue = await this.readQueueImpl();
    const { queue: next, dropped } = enqueuePendingDeregister(queue, entry);
    for (const d of dropped) {
      this.log('warn', `WARP 待注销队列已满，丢弃最旧条目 ${d.deviceId.slice(0, 8)}…`);
    }
    await this.writeQueueImpl(next);
    this.log('info', `WARP 设备 ${entry.deviceId.slice(0, 8)}… 入待注销队列（剩 ${next.length}）`);
  }
}
