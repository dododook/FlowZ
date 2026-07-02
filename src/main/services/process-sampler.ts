/**
 * process-sampler —— sing-box 核进程采样 + 内存时间线 ring + 渲染进程堆内省收集（issue #242 §6 观测随包）。
 *
 * 三件事，均为「随包观测」的取数/纯逻辑，与业务行为无关：
 *  1) sing-box 核进程 RSS/CPU 采样：核不在 Electron 进程树（getAppMetrics 覆盖不到），#242 的 53% CPU 全靠
 *     reporter 截图偶然带出。Linux 读 /proc/<pid>/status(VmRSS) + /proc/<pid>/stat(utime/stime) 两次差分算 CPU%；
 *     macOS 用 `ps -o rss=,pcpu=`；Windows 本批不做（见 sampleCoreProcess 的 TODO）。
 *  2) 内存时间线 ring：每 5min 一帧（Electron 全进程 + 核的 RSS），环形上限 288 帧（24h）——斜率比单点更能区分
 *     泄漏/高水位。序列化成紧凑 CSV 供诊断导出。
 *  3) 渲染进程堆内省收集：main 经注入的 introspect 回调向 renderer 取一次堆分层，**带超时兜底**（renderer 卡死
 *     正是 #242 场景，绝不能挂住诊断导出）。
 *
 * IO 经可注入接口，纯解析/算术与超时逻辑均可单测（无需真实进程/electron）。
 */
import { readFile } from 'fs/promises';
import { execFile } from 'child_process';
import type { RendererHeapSample } from '../../shared/process-metrics';
import type { RendererHeapReport } from '../../shared/diagnostic-redact';

// ── 可注入 IO（默认真实实现；测试注入 fixture）────────────────────────────────
export interface ProcessSamplerIo {
  /** 读文本文件（默认 fs.promises.readFile utf8）。 */
  readTextFile(path: string): Promise<string>;
  /** 跑命令取 stdout（默认 child_process.execFile；macOS ps 用）。 */
  run(cmd: string, args: string[]): Promise<string>;
  /** 睡眠（CPU 两次采样之间；测试注入 no-op）。 */
  delay(ms: number): Promise<void>;
  now(): number;
  platform: NodeJS.Platform;
  /** 时钟节拍/秒（Linux USER_HZ，几乎恒为 100；Node 不暴露 sysconf，故硬编码兜底）。 */
  clockHz: number;
}

const defaultIo: ProcessSamplerIo = {
  readTextFile: (p) => readFile(p, 'utf8'),
  run: (cmd, args) =>
    new Promise<string>((resolve, reject) => {
      execFile(cmd, args, { timeout: 3000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    }),
  delay: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  platform: process.platform,
  clockHz: 100,
};

function io(override?: Partial<ProcessSamplerIo>): ProcessSamplerIo {
  return override ? { ...defaultIo, ...override } : defaultIo;
}

// ── 纯解析 / 算术 ─────────────────────────────────────────────────────────────

/** 从 /proc/<pid>/status 文本解析 VmRSS（KB）。无该行/非法 → null。 */
export function parseVmRssKb(statusText: string): number | null {
  const m = statusText.match(/^VmRSS:\s+(\d+)\s*kB/m);
  if (!m) return null;
  const kb = Number.parseInt(m[1], 10);
  return Number.isFinite(kb) ? kb : null;
}

/**
 * 从 /proc/<pid>/stat 解析 utime/stime（时钟节拍）。comm(字段2)在括号内且可含空格/括号，故按**最后一个** ')'
 * 定位——其后空格分隔的第 0 段是 state(字段3)，utime=字段14→索引11、stime=字段15→索引12。
 */
export function parseProcStat(statText: string): { utimeTicks: number; stimeTicks: number } | null {
  const rp = statText.lastIndexOf(')');
  if (rp < 0) return null;
  const rest = statText
    .slice(rp + 1)
    .trim()
    .split(/\s+/);
  // rest[0]=state(字段3) → 字段 N 落在 rest[N-3]
  const utime = Number.parseInt(rest[11], 10);
  const stime = Number.parseInt(rest[12], 10);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { utimeTicks: utime, stimeTicks: stime };
}

/** 两次采样的 CPU%：Δ(utime+stime) 节拍 ÷ 节拍/秒 ÷ 墙钟秒 ×100。墙钟 ≤0 → 0。四舍五入整数。 */
export function cpuPercentFromDelta(
  prevTicks: number,
  nextTicks: number,
  wallMs: number,
  clockHz: number
): number {
  if (wallMs <= 0 || clockHz <= 0) return 0;
  const cpuSeconds = (nextTicks - prevTicks) / clockHz;
  const wallSeconds = wallMs / 1000;
  const pct = (cpuSeconds / wallSeconds) * 100;
  return pct > 0 ? Math.round(pct) : 0;
}

// ── 核进程采样 ────────────────────────────────────────────────────────────────

export interface CoreProcessSample {
  pid: number;
  rssMb: number;
  cpuPercent: number;
}

/** 单次 RSS（MB）：内存时间线 ring 用（无需 CPU，单读即可）。进程消失/平台不支持 → null，绝不抛。 */
export async function sampleProcessRssMb(
  pid: number,
  override?: Partial<ProcessSamplerIo>
): Promise<number | null> {
  const h = io(override);
  try {
    if (h.platform === 'linux') {
      const kb = parseVmRssKb(await h.readTextFile(`/proc/${pid}/status`));
      return kb == null ? null : Math.round(kb / 1024);
    }
    if (h.platform === 'darwin') {
      const out = await h.run('ps', ['-o', 'rss=', '-p', String(pid)]);
      const kb = Number.parseInt(out.trim(), 10);
      return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : null;
    }
    return null; // Windows 本批不做
  } catch {
    return null;
  }
}

/**
 * 核进程 RSS + CPU%。Linux：VmRSS(单读) + stat 两次差分算 CPU%；macOS：ps -o rss=,pcpu=（pcpu 已是 %）；
 * Windows 本批不做（TODO：后续可用 typeperf / Get-Process 或原生 API 采 WorkingSet + CPU）。任何异常
 * （进程消失 ENOENT / 命令失败）→ null，绝不抛（best-effort 观测，不阻断诊断导出）。
 */
export async function sampleCoreProcess(
  pid: number,
  override?: Partial<ProcessSamplerIo>
): Promise<CoreProcessSample | null> {
  const h = io(override);
  try {
    if (h.platform === 'linux') {
      const rssKb = parseVmRssKb(await h.readTextFile(`/proc/${pid}/status`));
      if (rssKb == null) return null;
      const t0 = parseProcStat(await h.readTextFile(`/proc/${pid}/stat`));
      const w0 = h.now();
      await h.delay(200);
      const t1 = parseProcStat(await h.readTextFile(`/proc/${pid}/stat`));
      const w1 = h.now();
      let cpuPercent = 0;
      if (t0 && t1) {
        cpuPercent = cpuPercentFromDelta(
          t0.utimeTicks + t0.stimeTicks,
          t1.utimeTicks + t1.stimeTicks,
          w1 - w0,
          h.clockHz
        );
      }
      return { pid, rssMb: Math.round(rssKb / 1024), cpuPercent };
    }
    if (h.platform === 'darwin') {
      const out = await h.run('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)]);
      const parts = out.trim().split(/\s+/);
      const rssKb = Number.parseInt(parts[0], 10);
      const pcpu = Number.parseFloat(parts[1]);
      if (!Number.isFinite(rssKb) || rssKb <= 0) return null;
      return {
        pid,
        rssMb: Math.round(rssKb / 1024),
        cpuPercent: Number.isFinite(pcpu) ? Math.round(pcpu) : 0,
      };
    }
    return null; // Windows 本批不做（TODO）
  } catch {
    return null;
  }
}

// ── 内存时间线 ring ───────────────────────────────────────────────────────────

export interface MemoryTimelineProc {
  label: string;
  pid: number;
  rssMb: number;
}

export interface MemoryTimelineFrame {
  t: number; // epoch ms
  procs: MemoryTimelineProc[];
}

/**
 * 环形缓冲：满后覆盖最老。默认上限 288 帧（每 5min 一帧 = 24h）。存小对象，内存占用 O(帧×进程)，
 * 稳态 ~7 进程 × 288 帧的量级（几十 KB），相对 #242 的 2GB 可忽略。
 */
export class MemoryTimelineRing {
  private readonly cap: number;
  private readonly buf: MemoryTimelineFrame[] = [];
  private start = 0; // 最老帧索引（满后环绕）

  constructor(capacity = 288) {
    this.cap = Math.max(1, Math.floor(capacity));
  }

  push(frame: MemoryTimelineFrame): void {
    if (this.buf.length < this.cap) {
      this.buf.push(frame);
    } else {
      this.buf[this.start] = frame;
      this.start = (this.start + 1) % this.cap;
    }
  }

  /** 按时间先后返回全部帧（最老→最新）。 */
  frames(): MemoryTimelineFrame[] {
    if (this.buf.length < this.cap) return this.buf.slice();
    return [...this.buf.slice(this.start), ...this.buf.slice(0, this.start)];
  }

  get size(): number {
    return this.buf.length;
  }
}

/** 内存时间线 → 紧凑 CSV（长表：一行一 (帧, 进程)）。诊断导出以 csv 代码块承载，便于外部画斜率。 */
export function serializeMemoryTimelineCsv(frames: readonly MemoryTimelineFrame[]): string {
  const rows: string[] = ['t,label,pid,rssMb'];
  for (const f of frames) {
    const iso = new Date(f.t).toISOString();
    for (const p of f.procs) {
      // label 去逗号防破坏 CSV 列（进程名理论上不含逗号，防御性替换）。
      const label = p.label.replace(/,/g, ' ');
      rows.push(`${iso},${label},${p.pid},${p.rssMb}`);
    }
  }
  return rows.join('\n');
}

// ── 渲染进程堆内省收集 ────────────────────────────────────────────────────────

/** 渲染端原始内省样本（KB/bytes，Electron 口径）→ 报告用 RendererHeapReport（MB）。纯映射，可单测。 */
export function mapRendererHeapSample(raw: RendererHeapSample): RendererHeapReport {
  const kbToMb = (kb?: number): number | undefined =>
    typeof kb === 'number' ? Math.round(kb / 1024) : undefined;
  const out: RendererHeapReport = {
    usedHeapMb: kbToMb(raw.heap?.usedHeapSize),
    totalHeapMb: kbToMb(raw.heap?.totalHeapSize),
    heapLimitMb: kbToMb(raw.heap?.heapSizeLimit),
    residentSetMb: kbToMb(raw.processMemory?.residentSet),
  };
  const res = raw.resources;
  if (res) {
    let liveBytes = 0;
    let any = false;
    for (const v of Object.values(res)) {
      if (v && typeof v.liveSize === 'number') {
        liveBytes += v.liveSize;
        any = true;
      }
    }
    if (any) out.blinkResourceMb = Math.round(liveBytes / 1024 / 1024);
  }
  // 全字段为空（preload 两个 try/catch 全失败 → 传入 {}）：置 unavailable，否则诊断报告会渲染出只有
  // 「渲染进程堆分层」标题、无任何内容的空节。
  if (
    out.usedHeapMb === undefined &&
    out.totalHeapMb === undefined &&
    out.heapLimitMb === undefined &&
    out.residentSetMb === undefined &&
    out.blinkResourceMb === undefined
  ) {
    return { unavailable: 'unavailable（渲染进程取数为空）' };
  }
  return out;
}

/**
 * 向 renderer 取一次堆分层，**带超时兜底**：introspect 未在 timeoutMs 内返回（renderer 卡死 = #242 场景）→
 * 返回 unavailable，绝不挂住诊断导出。introspect 缺失/返回 null（无窗口）/抛异常 → 同样 unavailable。
 */
export async function collectRendererHeap(
  introspect: (() => Promise<RendererHeapSample | null>) | undefined,
  timeoutMs = 2000
): Promise<RendererHeapReport> {
  if (!introspect) return { unavailable: 'unavailable（无渲染窗口）' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RendererHeapReport>((resolve) => {
    timer = setTimeout(
      () => resolve({ unavailable: `unavailable（渲染进程内省超时 >${timeoutMs}ms，疑窗口卡死）` }),
      timeoutMs
    );
  });
  const attempt = (async (): Promise<RendererHeapReport> => {
    try {
      const raw = await introspect();
      if (!raw) return { unavailable: 'unavailable（窗口不存在或取数为空）' };
      return mapRendererHeapSample(raw);
    } catch (e) {
      return { unavailable: `unavailable（内省失败: ${(e as Error)?.message ?? e}）` };
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
