/**
 * 聚合测速 toast 协调器（跨 useSpeedTest 实例共享的模块级单例）。
 *
 * 动机：多入口/多组并发测速（首页全部 / 页级全部 / 各组本组 / 快速连点不同分组）时，若每次 handleSpeedTest 各自
 * 弹独立 loading→success toast，会堆叠出 N 个「开始测速」+ N 个「测速完成」。此处用**引用计数 + 固定 toast id**
 * 收敛为一个 toast：首个开始弹 loading，仍有在跑则更新剩余组数文案，全部结束再弹一次 success/error。
 *
 * 保留「排队多组」能力（不走禁用全部按钮的捷径）：并发/排队的每组测速都各自 begin/end，聚合 toast 反映总体进度。
 * 纯逻辑、不依赖 i18n（文案由调用方传入），便于单测。
 */
import { toast } from 'sonner';

const TOAST_ID = 'speedtest-aggregate';

/** 聚合 toast 文案（调用方按当前语言解析后传入；running 依剩余组数动态生成）。 */
export interface AggSpeedToastLabels {
  /** 仅一组在跑：开始测速。 */
  start: string;
  /** 多组并发/排队：n 组测速中。 */
  running: (n: number) => string;
  /** 全部结束、无失败：测速完成。 */
  done: string;
  /** 全部结束、有失败：测速失败。 */
  fail: string;
}

// 模块级共享态：active=在跑+排队的测速次数；anyFailed/lastError 累计本批失败信息（active 归零时消费）。
let active = 0;
let anyFailed = false;
let lastError: string | undefined;
let labels: AggSpeedToastLabels | null = null;

/** 一次测速开始：引用计数++，首个弹 loading，多组则更新剩余组数文案。 */
export function beginAggSpeedTest(l: AggSpeedToastLabels): void {
  labels = l;
  if (active === 0) {
    // 新一批：清空上一批的失败累计。
    anyFailed = false;
    lastError = undefined;
  }
  active += 1;
  toast.loading(active > 1 ? l.running(active) : l.start, { id: TOAST_ID });
}

/** 一次测速结束：引用计数--，归零则按 anyFailed 弹一次 success/error；否则更新剩余组数、保持 loading。 */
export function endAggSpeedTest(failed: boolean, error?: string): void {
  if (failed) {
    anyFailed = true;
    lastError = error ?? lastError;
  }
  active = Math.max(0, active - 1);
  const l = labels;
  if (!l) return;
  if (active === 0) {
    if (anyFailed) toast.error(l.fail, { id: TOAST_ID, description: lastError });
    else toast.success(l.done, { id: TOAST_ID });
    labels = null;
  } else {
    // 仍有在跑/排队：保持同一 toast、更新剩余组数（保留排队可见性）。
    toast.loading(l.running(active), { id: TOAST_ID });
  }
}

/** 仅供单测复位模块级态（生产不用）。 */
export function __resetAggSpeedTestForTest(): void {
  active = 0;
  anyFailed = false;
  lastError = undefined;
  labels = null;
}
