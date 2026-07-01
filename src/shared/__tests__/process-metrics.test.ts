/**
 * process-metrics 纯分析单测（issue #242）：summarizeProcessMetrics 汇总/降序/MB 换算/label；
 * findMemoryOffenders 阈值筛查（KB↔字节换算、空/无超标）。
 */
import {
  summarizeProcessMetrics,
  findMemoryOffenders,
  type ProcessMetricLike,
} from '../process-metrics';

const KB = 1024;
const MB_IN_KB = 1024;

function proc(
  type: string,
  pid: number,
  memKb: number,
  extra?: { cpu?: number; serviceName?: string; name?: string }
): ProcessMetricLike {
  return {
    type,
    pid,
    memory: { workingSetSize: memKb },
    ...(extra?.cpu !== undefined ? { cpu: { percentCPUUsage: extra.cpu } } : {}),
    ...(extra?.serviceName ? { serviceName: extra.serviceName } : {}),
    ...(extra?.name ? { name: extra.name } : {}),
  };
}

describe('summarizeProcessMetrics', () => {
  it('按内存降序 + MB 换算 + 合计', () => {
    const s = summarizeProcessMetrics([
      proc('Browser', 1, 300 * MB_IN_KB),
      proc('Utility', 2, 2048 * MB_IN_KB), // 2GB
      proc('GPU', 3, 80 * MB_IN_KB),
    ]);
    expect(s.rows.map((r) => r.pid)).toEqual([2, 1, 3]); // 降序：2048/300/80
    expect(s.rows[0]).toMatchObject({ type: 'Utility', pid: 2, memoryMb: 2048 });
    expect(s.rows[1].memoryMb).toBe(300);
    expect(s.totalMemoryMb).toBe(2048 + 300 + 80);
  });

  it('cpu 四舍五入整数；label 取 name 优先、其次 serviceName、都无则省略', () => {
    // 优先级坐实自本机 xvfb 探针实测 getAppMetrics() 真实字段（非猜测）：Electron utilityProcess.fork
    // 传入的自定义 serviceName 选项最终落在 `.name`，而 `.serviceName` 恒是 Chromium 通用接口名
    // （如 FlowZ 实际 stats worker 的 name='flowz-stats' / serviceName='node.mojom.NodeService'）——
    // 对所有 Electron 自 fork 的 utilityProcess 都是这个泛型值，分不出具体是哪一个，故不能优先取它。
    const s = summarizeProcessMetrics([
      proc('Utility', 1, 10 * MB_IN_KB, {
        cpu: 53.7,
        name: 'flowz-stats',
        serviceName: 'node.mojom.NodeService',
      }),
      proc('Utility', 2, 10 * MB_IN_KB, { serviceName: 'network.mojom.NetworkService' }),
      proc('GPU', 3, 10 * MB_IN_KB),
    ]);
    const byPid = Object.fromEntries(s.rows.map((r) => [r.pid, r]));
    expect(byPid[1].cpuPercent).toBe(54);
    expect(byPid[1].label).toBe('flowz-stats'); // name 优先（FlowZ 自己 fork 的 worker，有辨识度）
    expect(byPid[2].label).toBe('network.mojom.NetworkService'); // 无 name → serviceName 兜底
    expect(byPid[3].label).toBeUndefined(); // 都无
  });

  it('空输入 → 合计 0、空行', () => {
    const s = summarizeProcessMetrics([]);
    expect(s.totalMemoryMb).toBe(0);
    expect(s.rows).toEqual([]);
  });
});

describe('findMemoryOffenders', () => {
  const oneGb = 1024 * 1024 * 1024;

  it('仅返回 >= 阈值（字节）的进程，按内存降序', () => {
    const off = findMemoryOffenders(
      [
        proc('Browser', 1, 300 * MB_IN_KB), // 300MB < 1GB
        proc('Utility', 2, 2048 * MB_IN_KB), // 2GB >= 1GB
        proc('Renderer', 3, 1536 * MB_IN_KB), // 1.5GB >= 1GB
      ],
      oneGb
    );
    expect(off.map((r) => r.pid)).toEqual([2, 3]); // 降序，300MB 的被排除
  });

  it('全部低于阈值 → 空数组', () => {
    expect(findMemoryOffenders([proc('Browser', 1, 500 * MB_IN_KB)], oneGb)).toEqual([]);
  });

  it('KB↔字节换算正确：workingSetSize 恰好等于阈值 → 命中', () => {
    const thresholdKb = oneGb / KB; // 阈值对应的 KB 数
    const off = findMemoryOffenders([proc('GPU', 9, thresholdKb)], oneGb);
    expect(off).toHaveLength(1);
    expect(off[0].pid).toBe(9);
  });

  it('空输入 → 空数组', () => {
    expect(findMemoryOffenders([], oneGb)).toEqual([]);
  });
});
