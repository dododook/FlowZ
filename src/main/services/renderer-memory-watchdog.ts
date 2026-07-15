/**
 * 渲染进程内存 watchdog 的纯决策内核（issue #242 §4 视图生命周期策略）。
 *
 * 定位：**lifecycle hygiene（同浏览器 tab discard），不是泄漏修复**。批次 2/3 的 change-driven / 订阅驱动
 * 只把更新「降频」，泄漏本体（若在 Blink/V8/Electron 层）未根除；本模块是对其的**确定性防线**——渲染进程 RSS
 * 超阈值时：窗口隐藏 → 走既有轻量原语 destroy 窗口全额回收（重建成本=首屏，用户无感）；窗口可见 → 只告警
 * （绝不销毁用户正在看的窗口）。目标：「用户永远看不到 2GB」。
 *
 * 纯函数、无 electron 依赖（ProcessMetricLike 结构兼容 app.getAppMetrics() 结果），全可单测；副作用（取窗口 pid /
 * 采样 / destroy / 日志 / 计数）留在 index.ts 的接线层。
 */
import type { ProcessMetricLike } from '../../shared/process-metrics';

/**
 * 默认阈值 1536 MB = 1.5 GB。远超正常渲染工作集（~250 MB），是「防 2GB」的兜底红线而非日常门——高阈值确保
 * 只在真正失控时触发，隐藏态回收对用户透明。可经 FLOWZ_RENDERER_RSS_LIMIT_MB 覆盖（测试降阈值触发两分支）。
 */
export const DEFAULT_RENDERER_RSS_LIMIT_MB = 1536;

/**
 * 解析 FLOWZ_RENDERER_RSS_LIMIT_MB 环境覆盖。非正整数（NaN / 空 / 0 / 负 / 小数 / 非数字）一律回退默认——
 * 防御：绝不让污染的环境变量把阈值降到 0（每轮误触发回收）或抬成 NaN（永不触发、兜底失效）。
 */
export function parseRendererRssLimitMb(env: string | undefined): number {
  if (env === undefined) return DEFAULT_RENDERER_RSS_LIMIT_MB;
  const n = Number(env);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_RENDERER_RSS_LIMIT_MB;
  return n;
}

/**
 * 从 getAppMetrics() 结果里找渲染主窗口进程的 RSS（MB）。按 pid 精确匹配；pid 为 null（窗口已销毁/轻量态）或
 * 采样里找不到该 pid（进程在途重建等）→ 返回 null（决策层据 null 判 'none'，不误触发）。
 * 注意 workingSetSize 是 KB（Electron 口径），故 /1024 得 MB。
 */
export function rendererRssMbFromMetrics(
  metrics: readonly ProcessMetricLike[],
  rendererPid: number | null
): number | null {
  if (rendererPid == null) return null;
  const m = metrics.find((x) => x.pid === rendererPid);
  if (!m) return null;
  return Math.round((m.memory?.workingSetSize ?? 0) / 1024);
}

/** watchdog 决策结果：销毁回收 / 可见告警 / 无动作。 */
export type RendererMemoryAction = 'discard' | 'warn' | 'none';

export interface RendererMemoryDecisionInput {
  /** 渲染主窗口 RSS（MB）；采样不可得为 null。 */
  rssMb: number | null;
  thresholdMb: number;
  /** 主窗口是否存在（!null && !destroyed）。 */
  windowExists: boolean;
  /** 主窗口是否对用户可见（可见 = isVisible && !minimized；隐藏/最小化/Cmd+H 均为 false）。 */
  windowVisible: boolean;
  /** 上次可见告警时刻（epoch ms）。 */
  lastWarnAt: number;
  /** 当前时刻（epoch ms）。 */
  now: number;
  /** 可见告警冷却（ms），防刷屏。 */
  warnCooldownMs: number;
}

/**
 * watchdog 决策（纯函数）：
 * - 无窗口 / RSS 不可得 / 未超阈值 → 'none'。
 * - 超阈值 且窗口隐藏 → 'discard'（销毁窗口全额回收，ensureWindow 下次 show 重建，透明）。
 * - 超阈值 且窗口可见 → 冷却已过 'warn'（只告警，绝不销毁用户在看的窗口），冷却内 'none'（防刷屏）。
 */
export function decideRendererMemoryAction(
  input: RendererMemoryDecisionInput
): RendererMemoryAction {
  const { rssMb, thresholdMb, windowExists, windowVisible, lastWarnAt, now, warnCooldownMs } =
    input;
  if (!windowExists) return 'none';
  if (rssMb == null) return 'none';
  if (rssMb <= thresholdMb) return 'none';
  // 超阈值
  if (!windowVisible) return 'discard';
  return now - lastWarnAt >= warnCooldownMs ? 'warn' : 'none';
}
