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
import * as crypto from 'crypto';
import type { LogManager } from './LogManager';
import { WarpService } from './WarpService';
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
  /**
   * 队列「读改写」串行化链（critical section mutex）。drain 的写回阶段与 enqueue 全程都排进此链 →
   * 杜绝二者 read-modify-write 交错导致的 lost-update：drain 进行中（await unregister 网络往返数秒）用户删
   * 新节点触发 enqueue，若无串行化，drain 用旧快照 keep 全量覆盖会抹掉 enqueue 刚追加的新凭据 → 永久孤儿。
   * 注意：drain 的网络往返**不**占此链（否则 enqueue 被阻塞数秒），只有最终写回的「重读-合并-写」临界区进链。
   */
  private opChain: Promise<unknown> = Promise.resolve();

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

  /**
   * 把一段「读改写」临界区排进串行链，保证与其它入链操作（drain 写回 / enqueue）互不交错。
   * 返回该段的结果。链上前序失败不污染后续（catch 续接），但本段异常照常向调用方抛出。
   */
  private runSerial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(op, op);
    // 链尾吞掉结果与异常，避免一段失败阻断后续；本段真实结果/异常经 run 单独传给调用方。
    this.opChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** 从磁盘读队列；文件缺失 → []（失败安全）；损坏 JSON → warn 后 []（纵深兜底，唯一 .tmp 后缀已根除并发损坏来源）。 */
  private async readQueueFromDisk(): Promise<PendingDeregisterEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return []; // 文件缺失（ENOENT）或不可读 → 空队列，正常路径。
    }
    try {
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
      // 文件存在但 JSON 损坏：极罕见（唯一 .tmp 后缀 + 原子 rename 已杜绝并发写坏正本）。warn 帮人工发现；
      // 返 [] 维持失败安全（不阻断删除/启动），坏文件将被下次原子写正常覆盖。
      this.log('warn', 'WARP 待注销队列文件损坏（JSON 解析失败），按空队列处理');
      return [];
    }
  }

  /**
   * 原子写队列：写**唯一后缀** .tmp（pid+随机）再 rename。唯一后缀杜绝多 writer（跨实例/未来多 writer）
   * 并发写同一 .tmp 致字节交错损坏正本——各 writer 写各自临时文件，rename 各自原子落地（同分区 POSIX 原子）。
   */
  private async writeQueueToDisk(queue: PendingDeregisterEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(queue, null, 2), 'utf8');
      await fs.rename(tmp, this.filePath);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {}); // 失败清理临时文件，不留孤儿
      throw e;
    }
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

      const { plan } = planDeregisterDrain(queue, this.now());
      // 本次「处理后出队」的 deviceId 集合（done/drop/expire）。retry 与 deferred 不入此集（留队）。
      // 网络往返（unregister）期间用户可能 enqueue 新条目；故写回**不**用旧快照覆盖，而是按此集从最新磁盘队列剔除。
      const removeIds = new Set<string>();

      for (const item of plan) {
        const idPrefix = item.entry.deviceId.slice(0, 8);
        if (item.action === 'expire') {
          // 超龄放弃：本地节点早已删、孤儿零计费，warn 后出队（不再消耗预算）。
          const ageDays = Math.floor((this.now() - item.entry.enqueuedAt) / 86_400_000);
          this.log(
            'warn',
            `WARP 设备 ${idPrefix}… 入队 ${ageDays} 天仍未注销，超阈值放弃（本地节点早已删、可忽略）`
          );
          removeIds.add(item.entry.deviceId);
          stats.expired += 1;
          continue;
        }
        // eligible：调远端注销（网络往返，不占串行链）。unregister 内部已不抛（按返回值分类）；仍兜底 catch 防注入实现抛出。
        let result: DeregisterResult;
        try {
          result = await this.unregister(item.entry.deviceId, item.entry.token);
        } catch {
          result = 'retry';
        }
        if (result === 'done') {
          this.log('info', `WARP 设备 ${idPrefix}… 已注销，出队`);
          removeIds.add(item.entry.deviceId);
          stats.done += 1;
        } else if (result === 'drop') {
          this.log('info', `WARP 设备 ${idPrefix}… 凭据失效，放弃出队`);
          removeIds.add(item.entry.deviceId);
          stats.dropped += 1;
        } else {
          // retry：留队等下个触发点（启动间隔即天然退避）。不入 removeIds。
          stats.retried += 1;
        }
      }

      // 写回临界区（进串行链，与 enqueue 互斥）：重读最新磁盘队列，仅剔除本次处理掉的 deviceId →
      // 保留 retry 条目 + 网络往返期间 enqueue 新增的条目（杜绝旧快照覆盖致 lost-update）。无变化则跳过写（省 IO）。
      let keepLen = queue.length;
      if (removeIds.size > 0) {
        keepLen = await this.runSerial(async () => {
          const latest = await this.readQueueImpl();
          const keep = latest.filter((e) => !removeIds.has(e.deviceId));
          if (keep.length !== latest.length) {
            await this.writeQueueImpl(keep);
          }
          return keep.length;
        });
      }
      if (stats.done + stats.dropped + stats.expired > 0) {
        this.log(
          'info',
          `WARP 待注销 drain：done=${stats.done} drop=${stats.dropped} expire=${stats.expired} retry=${stats.retried}（剩 ${keepLen}，本次至多 ${WARP_DEREGISTER_MAX_PER_DRAIN}）`
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

  /**
   * 入队一条待注销凭据（删除节点时调）；受 MAX_QUEUE 护栏，超则丢最旧 + 日志。
   * 整个「读改写」进串行链，与并发 drain 的写回互斥——杜绝 drain 用旧快照覆盖抹掉本次入队（lost-update）。
   */
  async enqueue(entry: PendingDeregisterEntry): Promise<void> {
    await this.runSerial(async () => {
      const queue = await this.readQueueImpl();
      const { queue: next, dropped } = enqueuePendingDeregister(queue, entry);
      for (const d of dropped) {
        this.log('warn', `WARP 待注销队列已满，丢弃最旧条目 ${d.deviceId.slice(0, 8)}…`);
      }
      await this.writeQueueImpl(next);
      this.log(
        'info',
        `WARP 设备 ${entry.deviceId.slice(0, 8)}… 入待注销队列（剩 ${next.length}）`
      );
    });
  }
}

// ── 进程内单例 ──────────────────────────────────────────────────────────
// 删除入队（server-handlers）、成功注册后 drain（server-handlers）、启动 8s drain（startup-tasks）三处必须**共用同一
// 实例**：实例级串行链（opChain）是 lost-update / 并发写防护的载体；若各处 new 独立实例，跨实例并发读改写同一磁盘队列
// 文件仍会交错（旧快照覆盖 / 写竞争）。故收敛为单例，所有触发点经此获取。
let singleton: WarpDeregisterQueue | null = null;

/**
 * 获取进程内唯一的 WARP 待注销队列实例（首次惰性创建，注入 WarpService.unregister + logManager）。
 * unregister 每次 new 一个无状态 WarpService（仅持 logManager），等价纯函数封装。
 */
export function getWarpDeregisterQueue(logManager?: LogManager): WarpDeregisterQueue {
  if (!singleton) {
    singleton = new WarpDeregisterQueue({
      unregister: (deviceId: string, token: string) =>
        new WarpService(logManager).unregister(deviceId, token),
      logManager,
    });
  }
  return singleton;
}

/** 仅供测试：重置单例（隔离用例间状态）。 */
export function __resetWarpDeregisterQueueSingleton(): void {
  singleton = null;
}
