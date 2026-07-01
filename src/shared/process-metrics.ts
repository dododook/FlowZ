/**
 * 逐进程内存/CPU 指标的纯分析（issue #242 诊断可靠性）。
 *
 * 背景：#242 报告 Linux 下 FlowZ 单个子进程内存涨到 2GB+，但系统监视器只显示 basename「flowz」重复多行、
 * 分不清是主进程 / 渲染进程 / GPU / utility 里的哪一个。app.getAppMetrics() 天然按进程给出 type/pid/内存/CPU，
 * 一次采样即可定位是哪个子进程在涨。本模块把 getAppMetrics() 的结果做纯分析（汇总排序 / 超阈值筛查），
 * 供「诊断导出的逐进程表」与「ProxyManager 周期自检的告警」共用，纯函数、无 electron 依赖、可单测。
 */

/**
 * app.getAppMetrics() 单进程指标的最小子集。刻意不 import electron 的 ProcessMetric 类型——
 * 本模块在 shared/ 下（主/渲染/单测共用），保持零平台依赖；调用方直接传 getAppMetrics() 结果即结构兼容。
 * 注意 memory.workingSetSize 是 **KB**（Electron 口径），非字节。
 */
export interface ProcessMetricLike {
  pid: number;
  type: string; // 'Browser'（主）/ 'Renderer'|'Tab' / 'GPU' / 'Utility' / ...
  memory: { workingSetSize: number }; // KB
  cpu?: { percentCPUUsage?: number };
  serviceName?: string; // utility 子类型名（如 stats worker 的 serviceName），辨识用
  name?: string;
}

export interface ProcessMetricRow {
  type: string;
  pid: number;
  memoryMb: number; // 四舍五入 MB
  cpuPercent: number; // 四舍五入整数百分比
  label?: string; // serviceName / name（utility 辨识用），无则省略
}

export interface ProcessMetricsSummary {
  totalMemoryMb: number;
  rows: ProcessMetricRow[]; // 按内存降序（最大的排最前，一眼看出谁在涨）
}

const KB_PER_MB = 1024;

function toRow(m: ProcessMetricLike): ProcessMetricRow {
  const memoryMb = Math.round((m.memory?.workingSetSize ?? 0) / KB_PER_MB);
  const cpuPercent = Math.round(m.cpu?.percentCPUUsage ?? 0);
  const label = m.serviceName || m.name || undefined;
  return { type: m.type, pid: m.pid, memoryMb, cpuPercent, ...(label ? { label } : {}) };
}

/** 汇总逐进程内存/CPU，按内存降序。诊断导出表与自检共用。 */
export function summarizeProcessMetrics(
  metrics: readonly ProcessMetricLike[]
): ProcessMetricsSummary {
  const rows = metrics.map(toRow).sort((a, b) => b.memoryMb - a.memoryMb);
  const totalMemoryMb = rows.reduce((sum, r) => sum + r.memoryMb, 0);
  return { totalMemoryMb, rows };
}

/**
 * 筛出内存超 thresholdBytes 的进程行（自检告警用），按内存降序。
 * 阈值以字节传入，与 workingSetSize（KB）换算比较；空/无超标返回 []。
 */
export function findMemoryOffenders(
  metrics: readonly ProcessMetricLike[],
  thresholdBytes: number
): ProcessMetricRow[] {
  return metrics
    .filter((m) => (m.memory?.workingSetSize ?? 0) * 1024 >= thresholdBytes)
    .map(toRow)
    .sort((a, b) => b.memoryMb - a.memoryMb);
}
