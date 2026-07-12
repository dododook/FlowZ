/**
 * 聚合测速 toast 协调器单测（纯逻辑，mock sonner + api.onSpeedTestResult）：多入口/多组并发测速收敛为单个 toast——
 * 去重并集节点进度（union 去重、result serverId 去重）、全部结束一次 success/error、批次间隔离、归零退订。
 */
jest.mock('sonner', () => ({
  toast: { loading: jest.fn(), success: jest.fn(), error: jest.fn() },
}));

let resultCb: ((d: { serverId: string; latency: number }) => void) | null = null;
const unsubResult = jest.fn();
jest.mock('../../../ipc/api-client', () => ({
  api: {
    server: {
      onSpeedTestResult: (cb: (d: { serverId: string; latency: number }) => void) => {
        resultCb = cb;
        return unsubResult;
      },
    },
  },
}));

import { toast } from 'sonner';
import {
  beginAggSpeedTest,
  endAggSpeedTest,
  __resetAggSpeedTestForTest,
} from '../speed-test-toast';

const labels = {
  running: (tested: number, total: number) => `RUN:${tested}/${total}`,
  done: 'DONE',
  fail: 'FAIL',
  interrupted: 'INTERRUPTED',
};
const ID = { id: 'speedtest-aggregate' };
const result = (serverId: string) => resultCb?.({ serverId, latency: 10 });

beforeEach(() => {
  __resetAggSpeedTestForTest();
  resultCb = null;
  unsubResult.mockClear();
  (toast.loading as jest.Mock).mockClear();
  (toast.success as jest.Mock).mockClear();
  (toast.error as jest.Mock).mockClear();
});

describe('聚合测速 toast 协调器（去重并集节点进度）', () => {
  it('单次：begin(3 节点)→loading 0/3，每 result 递增，end→success + 退订', () => {
    beginAggSpeedTest(['a', 'b', 'c'], labels);
    expect(toast.loading).toHaveBeenLastCalledWith('RUN:0/3', ID);
    result('a');
    expect(toast.loading).toHaveBeenLastCalledWith('RUN:1/3', ID);
    result('b');
    result('c');
    expect(toast.loading).toHaveBeenLastCalledWith('RUN:3/3', ID);
    endAggSpeedTest(false);
    expect(toast.success).toHaveBeenCalledWith('DONE', ID);
    expect(unsubResult).toHaveBeenCalledTimes(1);
  });

  it('并集去重：本组[a,b,c] + 单节点[b] → total=3（b 不重复），同 serverId 二测不重复计', () => {
    beginAggSpeedTest(['a', 'b', 'c'], labels);
    beginAggSpeedTest(['b'], labels); // b ⊆ 已有 → 并集仍 3
    expect(toast.loading).toHaveBeenLastCalledWith('RUN:0/3', ID);
    result('a');
    result('b');
    result('b'); // b 二测：tested 去重仍 2
    expect(toast.loading).toHaveBeenLastCalledWith('RUN:2/3', ID);
    endAggSpeedTest(false); // active 2→1，仍 loading
    expect(toast.success).not.toHaveBeenCalled();
    result('c');
    endAggSpeedTest(false); // active 0 → success
    expect(toast.success).toHaveBeenCalledWith('DONE', ID);
  });

  it('本组A + 全部：并集=全部总数（A 被吞），非 2+4', () => {
    beginAggSpeedTest(['a', 'b'], labels); // 本组 A(2)
    beginAggSpeedTest(['a', 'b', 'c', 'd'], labels); // 全部(4，含 A)
    expect(toast.loading).toHaveBeenLastCalledWith('RUN:0/4', ID);
    result('a');
    result('b');
    result('c');
    result('d');
    expect(toast.loading).toHaveBeenLastCalledWith('RUN:4/4', ID);
    endAggSpeedTest(false);
    endAggSpeedTest(false);
    expect(toast.success).toHaveBeenCalledWith('DONE', ID);
  });

  it('任一失败：归零弹 error（带描述），不弹 success', () => {
    beginAggSpeedTest(['a'], labels);
    beginAggSpeedTest(['b'], labels);
    endAggSpeedTest(true, 'boom');
    endAggSpeedTest(false);
    expect(toast.error).toHaveBeenCalledWith('FAIL', {
      id: 'speedtest-aggregate',
      description: 'boom',
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('批次隔离 + 复位：上批失败/已测不污染下批，归零退订', () => {
    beginAggSpeedTest(['a', 'b'], labels);
    result('a');
    endAggSpeedTest(true, 'e1'); // 批1 归零（失败）
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(unsubResult).toHaveBeenCalledTimes(1);
    beginAggSpeedTest(['x'], labels); // 批2：union/tested/anyFailed 全复位
    expect(toast.loading).toHaveBeenLastCalledWith('RUN:0/1', ID); // total=1（非承接批1的 2）
    result('x');
    endAggSpeedTest(false);
    expect(toast.success).toHaveBeenCalledWith('DONE', ID); // 批2 成功，不受批1失败污染
  });
});
