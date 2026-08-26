/**
 * 起核阶段耗时埋点（B0：先量化再优化）。
 *
 * 背景：Windows TUN 起核慢的**分阶段耗时目前没有任何实测数据**——已知的两个真机数字（PowerShell 探测单次
 * ~950ms、sing-box 自报 `started (2.12s)`）来自两次不同排查，其余全是按代码路径静态推算的。在没有分布之前
 * 按推算去改，重演的就是「嫌疑清单 5 条错 3 条、真因不在清单里」那类返工。
 *
 * 本模块只做一件事：把一次 start 的各阶段墙钟增量攒起来，收尾时输出**一行**汇总进 app.log（并进诊断报告），
 * 使真机跑一次即可拿到分布。**零新增 syscall / 零 spawn / 不改控制流**——只有数组 push 与减法。
 *
 * 设计取舍：
 *  - [选：一行汇总] 每阶段各记一行会刷屏，且与「状态未变化禁重复进度提示」冲突；一行汇总便于用户一次性回传。
 *  - [不选：只在 debug 级输出] 起核慢是用户主动报的问题，等他先去调日志级别再复现一次，等于多一轮往返。
 *    单行 INFO 的代价可忽略。
 *  - [选：单调时钟 `performance.now()`] 起核跨秒级窗口，`Date.now()` 遇系统时钟跳变/NTP 校正会给出负增量或
 *    离谱值，而这个数据的用途正是判断某阶段是否异常——被污染就失去意义。
 *  - [选：注入 now] 纯逻辑可单测，无需假计时器。
 *
 * 重试腿：起核失败重试时每腿的耗时必须可分辨（同名阶段在 3 条腿上各出现一次），故 `beginLeg()` 之后所有
 * 标记自动带 `L<n>.` 前缀；`L<n>.begin` 这一格本身即「上一腿失败 → 本腿开始」之间的退避等待。
 */
import { performance } from 'perf_hooks';

/** 单个阶段：label + 相对上一个标记的毫秒增量（已取整）。 */
export interface StartPhase {
  label: string;
  ms: number;
}

/** 注入依赖（单测替换时钟用）。 */
export interface StartTimelineDeps {
  /** 单调毫秒时钟。缺省 `performance.now()`。 */
  now?: () => number;
}

/**
 * 阶段数硬上限。正常一次 start ≤ ~40 格；设上限是防「起核失败 → 无界重试」的病态路径把数组撑大
 * （每腿约 5 格，200 格 ≈ 30+ 腿，真实预算远达不到）。触顶后只累加 dropped 计数、不再入格；`mark` 仍推进
 * 时钟基准，但那之后已无任何格会被推入，故这一点在输出上不可观测（单测里不为它立判据）。
 */
export const START_TIMELINE_MAX_PHASES = 200;

/**
 * 一次 start 的阶段耗时收集器。**绝不抛异常**（调用点遍布起核关键路径，埋点自身出错代价远大于收益）。
 */
export class StartTimeline {
  private readonly now: () => number;
  private readonly t0: number;
  /** 上一个标记的时刻——增量基准。 */
  private last: number;
  /** 当前起核腿序号；0 = 尚未进入起核（前置准备阶段），≥1 = 第 n 条 startSingBoxProcess 腿。 */
  private legIndex = 0;
  private droppedCount = 0;
  private readonly items: StartPhase[] = [];

  constructor(deps: StartTimelineDeps = {}) {
    this.now = deps.now ?? ((): number => performance.now());
    this.t0 = this.now();
    this.last = this.t0;
  }

  /**
   * 记一个阶段：label 记录的是「从上一个标记到现在」的耗时，故调用点应放在被测步骤**之后**。
   * 进入起核腿后自动加 `L<n>.` 前缀。
   */
  mark(label: string): void {
    const at = this.now();
    // 汇总行整行原文会被 push 进诊断报告且**不过脱敏**——「不含用户数据」这条不变量是它免脱敏的唯一理由，
    // 故必须落成代码而不是只写在文档里。今天所有调用点传的都是字面量或受控枚举，本行是防将来某处写出
    // `markStart(\`x:${serverName}\`)`：越界字符一律替成 `?`，宁可让标签变难看也不让节点名/域名漏进报告。
    const safe = label.replace(/[^A-Za-z0-9_.:-]/g, '?');
    const ms = Math.round(at - this.last);
    this.last = at;
    if (this.items.length >= START_TIMELINE_MAX_PHASES) {
      this.droppedCount++;
      return;
    }
    this.items.push({ label: this.legIndex > 0 ? `L${this.legIndex}.${safe}` : safe, ms });
  }

  /**
   * 进入下一条起核腿。产出的 `L<n>.begin` 格 = 上一个标记到本腿开始之间的耗时：
   * 第 1 腿是起核前最后一步到 spawn 前的间隙，第 2 腿起则是 retry 退避。
   */
  beginLeg(): void {
    this.legIndex++;
    this.mark('begin');
  }

  /** 自 start 起的总墙钟毫秒（取整）。 */
  totalMs(): number {
    return Math.round(this.now() - this.t0);
  }

  /** 已记录的阶段快照（副本，调用方改不动内部状态）。 */
  phases(): StartPhase[] {
    return this.items.slice();
  }

  /** 因超上限被丢弃的阶段数（正常恒 0）。 */
  dropped(): number {
    return this.droppedCount;
  }

  /**
   * 一行汇总，形如：
   * `起核阶段耗时 total=8421ms outcome=ok | killOrphans=181 coreVersion=642 … L1.adapterRelease=962 …`
   * @param outcome 本次 start 的终态（ok / failed / superseded），便于把失败腿的分布与成功的分开看。
   */
  summarize(outcome: string): string {
    const body = this.items.map((p) => `${p.label}=${p.ms}`).join(' ');
    const tail = this.droppedCount > 0 ? ` (+${this.droppedCount} 格超限未记)` : '';
    const head = `起核阶段耗时 total=${this.totalMs()}ms outcome=${outcome}`;
    // 一格没记时（如 rejectIfCoreSwapInProgress 在首个标记之前就抛）不留空尾巴 `| `——那是条零信息量的行，
    // 而它每次 start 都会进 app.log 与诊断报告。
    return body || tail ? `${head} | ${body}${tail}` : head;
  }
}
