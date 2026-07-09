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

const TOAST_ID = 'speedtest-aggregate';

/** 聚合 toast 文案（调用方按当前语言解析后传入；running 依已测/并集节点数动态生成）。 */
export interface AggSpeedToastLabels {
  /** 进行中：已测 tested / 并集 total 节点。 */
  running: (tested: number, total: number) => string;
  /** 全部结束、无失败。 */
  done: string;
  /** 全部结束、有失败。 */
  fail: string;
}

// 模块级共享态：active=在跑+排队的测速次数；union=全部请求节点并集（去重）；tested=已测唯一节点（result 去重）。
let active = 0;
let anyFailed = false;
let lastError: string | undefined;
let labels: AggSpeedToastLabels | null = null;
const union = new Set<string>();
const tested = new Set<string>();
let unsubResult: (() => void) | null = null;

function render(): void {
  if (!labels || active === 0) return;
  toast.loading(labels.running(tested.size, union.size), { id: TOAST_ID });
}

/** 一次测速开始：serverIds 并入 union、引用计数++；首个订阅 per-node result 事件累计已测唯一节点。 */
export function beginAggSpeedTest(serverIds: string[], l: AggSpeedToastLabels): void {
  labels = l;
  if (active === 0) {
    anyFailed = false;
    lastError = undefined;
    union.clear();
    tested.clear();
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

/** 一次测速结束：引用计数--；归零则一次 success/error + 复位并退订，否则更新进度、保持 loading。 */
export function endAggSpeedTest(failed: boolean, error?: string): void {
  if (failed) {
    anyFailed = true;
    lastError = error ?? lastError;
  }
  active = Math.max(0, active - 1);
  if (active > 0) {
    render();
    return;
  }
  // 全部结束：一次 success/error + 复位 + 退订。
  if (labels) {
    if (anyFailed) toast.error(labels.fail, { id: TOAST_ID, description: lastError });
    else toast.success(labels.done, { id: TOAST_ID });
  }
  labels = null;
  union.clear();
  tested.clear();
  unsubResult?.();
  unsubResult = null;
}

/** 仅供单测复位模块级态（生产不用）。 */
export function __resetAggSpeedTestForTest(): void {
  active = 0;
  anyFailed = false;
  lastError = undefined;
  labels = null;
  union.clear();
  tested.clear();
  unsubResult?.();
  unsubResult = null;
}
