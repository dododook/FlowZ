/**
 * 聚合测速 toast 协调器（跨 useSpeedTest 实例共享的模块级单例）。
 *
 * 动机：多入口/多组并发测速（首页全部 / 页级全部 / 各组本组 / 单节点⚡ / 快速连点）时，若每次各自弹独立
 * loading→success toast 会堆叠。此处用**引用计数 + 固定 toast id + 去重并集节点进度**收敛为一个 toast：
 * 首个开始订阅 per-node result 事件，以「已测唯一节点 / 全部请求节点并集」显进度，全部结束再弹一次 success/error。
 *
 * 去重并集：各次测速的 serverIds 并入 union（重叠/子集不重复计——如「本组 A 再点全部」并集=全部；coalesce B⊆A
 * 并集=A）；已测节点按 result 事件 serverId 入 Set 去重（节点被二测不重复计）。天然处理 本组×本组 / 本组×全部 /
 * coalesce / 托盘并发。保留排队多组能力（不禁按钮），纯以 toast 反映总体进度。
 */
import { toast } from 'sonner';
// 相对路径（非 @/ 别名）：jest 无 @/ moduleNameMapper，别名会致本模块单测无法解析/mock。
import { api } from '../../ipc/api-client';
import type { SpeedTestOutcome } from '../../../shared/speed-test';

const TOAST_ID = 'speedtest-aggregate';

/** 聚合 toast 文案（调用方按当前语言解析后传入；running 依已测/并集节点数动态生成）。 */
export interface AggSpeedToastLabels {
  /** 进行中：已测 tested / 并集 total 节点。 */
  running: (tested: number, total: number) => string;
  /** 全部结束、无失败。 */
  done: string;
  /** 全部结束、有失败。 */
  fail: string;
  /** 全部结束、被核生命周期跃迁打断（§16.2 interrupted）。 */
  interrupted: string;
  /** done 副行：n 个节点未纳入本轮（波前缺席，§16 Layer2）。缺省不显副行。 */
  skippedSummary?: (n: number) => string;
  /** interrupted 副行：已完成 tested/total 节点，其余保留原值。 */
  interruptedSummary?: (tested: number, total: number) => string;
}

// 模块级共享态：active=在跑+排队的测速次数；union=全部请求节点并集（去重）；tested=已测唯一节点（result 去重）。
let active = 0;
let anyFailed = false;
// §16.2：任一次测速 outcome=interrupted（核跃迁/崩溃打断）→ 归零时按优先级 fail>interrupted>done 弹 warning。
let anyInterrupted = false;
let lastError: string | undefined;
let labels: AggSpeedToastLabels | null = null;
const union = new Set<string>();
const tested = new Set<string>();
// §16 Layer2：本聚合窗口内「波前缺席」节点并集（not-in-pool + ts-not-ready），归零时 done toast 副行「N 未纳入」。
const skipped = new Set<string>();
let unsubResult: (() => void) | null = null;

function render(): void {
  if (!labels || active === 0) return;
  // description: undefined 是必需的显式清空——sonner 按 id 更新 toast 走浅合并（{...旧, ...新}），
  // 不带的字段保留旧值。若上一批以 interrupted/skipped 收尾写过副行 description，loading 态
  // （duration:Infinity 不自动消失）会一直残留那行「已完成 x/y 节点」并跨订阅黏死（#308）。
  toast.loading(labels.running(tested.size, union.size), { id: TOAST_ID, description: undefined });
}

/** 一次测速开始：serverIds 并入 union、引用计数++；首个订阅 per-node result 事件累计已测唯一节点。 */
export function beginAggSpeedTest(serverIds: string[], l: AggSpeedToastLabels): void {
  labels = l;
  if (active === 0) {
    anyFailed = false;
    anyInterrupted = false;
    lastError = undefined;
    union.clear();
    tested.clear();
    skipped.clear();
    // 首个测速：订阅 result 事件（每测完一个节点回 serverId），去重累计已测唯一节点。
    unsubResult = api.server.onSpeedTestResult(({ serverId }) => {
      tested.add(serverId);
      render();
    });
  }
  active += 1;
  for (const id of serverIds) union.add(id);
  render();
}

/** 一次测速结束：引用计数--；归零则一次 success/warning/error + 复位并退订，否则更新进度、保持 loading。
 *  skippedIds（§16 Layer2）：本次波前缺席节点 id（not-in-pool + ts-not-ready），并入 skipped 集供 done 副行。 */
export function endAggSpeedTest(
  failed: boolean,
  error?: string,
  outcome?: SpeedTestOutcome,
  skippedIds?: string[]
): void {
  if (failed) {
    anyFailed = true;
    lastError = error ?? lastError;
  }
  if (outcome === 'interrupted') anyInterrupted = true;
  for (const id of skippedIds ?? []) skipped.add(id);
  active = Math.max(0, active - 1);
  if (active > 0) {
    render();
    return;
  }
  // 全部结束：一次 toast + 复位 + 退订。优先级 fail > interrupted > done（§16.2）：真实异常最高，核跃迁打断次之
  // （已测保留、未测原值），全成功最低。interrupted/done 带 §16 Layer2 副行（已完成 x/y / N 未纳入）。
  if (labels) {
    if (anyFailed) {
      toast.error(labels.fail, { id: TOAST_ID, description: lastError });
    } else if (anyInterrupted) {
      const desc = labels.interruptedSummary?.(tested.size, union.size);
      toast.warning(labels.interrupted, { id: TOAST_ID, ...(desc ? { description: desc } : {}) });
    } else {
      const desc = skipped.size > 0 ? labels.skippedSummary?.(skipped.size) : undefined;
      toast.success(labels.done, { id: TOAST_ID, ...(desc ? { description: desc } : {}) });
    }
  }
  labels = null;
  union.clear();
  tested.clear();
  skipped.clear();
  unsubResult?.();
  unsubResult = null;
}

/** 仅供单测复位模块级态（生产不用）。 */
export function __resetAggSpeedTestForTest(): void {
  active = 0;
  anyFailed = false;
  anyInterrupted = false;
  lastError = undefined;
  skipped.clear();
  labels = null;
  union.clear();
  tested.clear();
  unsubResult?.();
  unsubResult = null;
}
