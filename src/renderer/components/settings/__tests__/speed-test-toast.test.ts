/**
 * 聚合测速 toast 协调器单测（纯逻辑，mock sonner）：多入口/多组并发测速收敛为单个 toast——
 * 引用计数首个→loading、仍在跑显剩余组数、全部结束一次 success/error、批次间失败态隔离。
 */
jest.mock('sonner', () => ({
  toast: { loading: jest.fn(), success: jest.fn(), error: jest.fn() },
}));
import { toast } from 'sonner';
import {
  beginAggSpeedTest,
  endAggSpeedTest,
  __resetAggSpeedTestForTest,
} from '../speed-test-toast';

const labels = {
  start: 'START',
  running: (n: number) => `RUN:${n}`,
  done: 'DONE',
  fail: 'FAIL',
};
const ID = { id: 'speedtest-aggregate' };

beforeEach(() => {
  __resetAggSpeedTestForTest();
  (toast.loading as jest.Mock).mockClear();
  (toast.success as jest.Mock).mockClear();
  (toast.error as jest.Mock).mockClear();
});

describe('聚合测速 toast 协调器', () => {
  it('单组：begin→loading(start)，end→success(done)，同一固定 id', () => {
    beginAggSpeedTest(labels);
    expect(toast.loading).toHaveBeenCalledWith('START', ID);
    endAggSpeedTest(false);
    expect(toast.success).toHaveBeenCalledWith('DONE', ID);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('多组并发：第二个 begin 显剩余组数、只一个 toast，全部结束才 success', () => {
    beginAggSpeedTest(labels); // active 1
    beginAggSpeedTest(labels); // active 2
    expect(toast.loading).toHaveBeenLastCalledWith('RUN:2', ID);
    endAggSpeedTest(false); // active 1 → 仍 loading（剩余组数）
    expect(toast.loading).toHaveBeenLastCalledWith('RUN:1', ID);
    expect(toast.success).not.toHaveBeenCalled();
    endAggSpeedTest(false); // active 0 → success（仅一次）
    expect(toast.success).toHaveBeenCalledWith('DONE', ID);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('任一失败：归零弹 error（带描述），不弹 success', () => {
    beginAggSpeedTest(labels);
    beginAggSpeedTest(labels);
    endAggSpeedTest(true, 'boom'); // 记本批失败
    endAggSpeedTest(false); // 归零
    expect(toast.error).toHaveBeenCalledWith('FAIL', {
      id: 'speedtest-aggregate',
      description: 'boom',
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('批次隔离：上批失败不污染下批', () => {
    beginAggSpeedTest(labels);
    endAggSpeedTest(true, 'e1'); // 批1 失败
    expect(toast.error).toHaveBeenCalledTimes(1);
    beginAggSpeedTest(labels); // 批2
    endAggSpeedTest(false); // 批2 成功
    expect(toast.success).toHaveBeenCalledWith('DONE', ID);
  });

  it('end 多于 begin：计数不为负、无 labels 时 no-op（不误弹）', () => {
    endAggSpeedTest(false); // 无在飞、labels 已复位 → no-op
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
