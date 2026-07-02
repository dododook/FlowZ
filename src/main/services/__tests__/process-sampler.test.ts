/**
 * process-sampler 单测（issue #242 §6 观测随包）：
 *  1) /proc/status VmRSS、/proc/stat utime/stime 解析（comm 含空格/括号的鲁棒性）；
 *  2) CPU% 两次采样差分算术（含墙钟 0、计数器回绕）；
 *  3) sampleCoreProcess / sampleProcessRssMb 平台分支 + 进程消失返回 null 不抛（io 注入 fixture）；
 *  4) MemoryTimelineRing 上限环绕 + serializeMemoryTimelineCsv 格式；
 *  5) mapRendererHeapSample 单位换算/字段存在性；collectRendererHeap 成功/空/异常/**超时**分支。
 * 纯解析/算术 + io 注入，无需真实进程/electron。
 */
import {
  parseVmRssKb,
  parseProcStat,
  cpuPercentFromDelta,
  sampleCoreProcess,
  sampleProcessRssMb,
  MemoryTimelineRing,
  serializeMemoryTimelineCsv,
  mapRendererHeapSample,
  collectRendererHeap,
  type ProcessSamplerIo,
  type MemoryTimelineFrame,
} from '../process-sampler';
import type { RendererHeapSample } from '../../../shared/process-metrics';

// ── fixtures ──────────────────────────────────────────────────────────────────
const STATUS = [
  'Name:\tsing-box',
  'Umask:\t0022',
  'State:\tS (sleeping)',
  'VmPeak:\t  300000 kB',
  'VmRSS:\t  262144 kB', // 256 MB
  'Threads:\t12',
].join('\n');

// /proc/<pid>/stat：comm 故意含空格与括号，验证「最后一个 )」定位。字段 14=utime、15=stime。
const STAT1 = '1234 (sing box (rev)) S 1 1234 1234 0 -1 4194560 100 0 0 0 500 200 0 0 20 0 1 0 999';
const STAT2 = '1234 (sing box (rev)) S 1 1234 1234 0 -1 4194560 110 0 0 0 505 205 0 0 20 0 1 0 999';

function linuxIo(overrides?: Partial<ProcessSamplerIo>): Partial<ProcessSamplerIo> {
  let statCall = 0;
  let nowCall = 0;
  return {
    platform: 'linux',
    clockHz: 100,
    delay: () => Promise.resolve(),
    now: () => (nowCall++ === 0 ? 1000 : 1200), // wallMs = 200
    readTextFile: (p: string) => {
      if (p.endsWith('/status')) return Promise.resolve(STATUS);
      statCall++;
      return Promise.resolve(statCall === 1 ? STAT1 : STAT2);
    },
    run: () => Promise.resolve(''),
    ...overrides,
  };
}

describe('parseVmRssKb', () => {
  it('解析 VmRSS 行（KB）', () => {
    expect(parseVmRssKb(STATUS)).toBe(262144);
  });
  it('无 VmRSS 行 → null', () => {
    expect(parseVmRssKb('Name:\tx\nState:\tS')).toBeNull();
  });
});

describe('parseProcStat', () => {
  it('comm 含空格/括号：按最后一个 ) 定位 utime(14)/stime(15)', () => {
    expect(parseProcStat(STAT1)).toEqual({ utimeTicks: 500, stimeTicks: 200 });
    expect(parseProcStat(STAT2)).toEqual({ utimeTicks: 505, stimeTicks: 205 });
  });
  it('无 ) → null', () => {
    expect(parseProcStat('1234 no-paren S 1 1')).toBeNull();
  });
  it('utime/stime 非数字 → null', () => {
    expect(parseProcStat('1 (c) S a b c d e f g h i j k l')).toBeNull();
  });
});

describe('cpuPercentFromDelta', () => {
  it('Δ10 节拍 / 100Hz = 0.1s cpu ÷ 0.2s 墙钟 = 50%', () => {
    expect(cpuPercentFromDelta(700, 710, 200, 100)).toBe(50);
  });
  it('墙钟 0 → 0（不除零）', () => {
    expect(cpuPercentFromDelta(700, 710, 0, 100)).toBe(0);
  });
  it('计数器回绕（next < prev）→ 0（不出负值）', () => {
    expect(cpuPercentFromDelta(710, 700, 200, 100)).toBe(0);
  });
  it('满载一核：Δ100 节拍 / 100Hz = 1s ÷ 1s = 100%', () => {
    expect(cpuPercentFromDelta(0, 100, 1000, 100)).toBe(100);
  });
});

describe('sampleCoreProcess', () => {
  it('Linux：RSS(MB) + 两次差分 CPU%', async () => {
    // t0=500+200=700, t1=505+205=710, Δ=10 节拍/100Hz=0.1s, 墙钟 200ms=0.2s → 50%
    const s = await sampleCoreProcess(1234, linuxIo());
    expect(s).toEqual({ pid: 1234, rssMb: 256, cpuPercent: 50 });
  });

  it('Linux：进程消失（readTextFile 抛 ENOENT）→ null 不抛', async () => {
    const io = linuxIo({
      readTextFile: () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    });
    await expect(sampleCoreProcess(1234, io)).resolves.toBeNull();
  });

  it('macOS：ps -o rss=,pcpu= → RSS(MB) + CPU%', async () => {
    const io: Partial<ProcessSamplerIo> = {
      platform: 'darwin',
      run: () => Promise.resolve('  262144 12.7 \n'),
    };
    const s = await sampleCoreProcess(1234, io);
    expect(s).toEqual({ pid: 1234, rssMb: 256, cpuPercent: 13 });
  });

  it('macOS：ps 空输出（进程消失）→ null', async () => {
    const io: Partial<ProcessSamplerIo> = { platform: 'darwin', run: () => Promise.resolve('\n') };
    await expect(sampleCoreProcess(1234, io)).resolves.toBeNull();
  });

  it('Windows：本批不采 → null', async () => {
    await expect(sampleCoreProcess(1234, { platform: 'win32' })).resolves.toBeNull();
  });
});

describe('sampleProcessRssMb（ring 用单读）', () => {
  it('Linux VmRSS → MB', async () => {
    const io: Partial<ProcessSamplerIo> = {
      platform: 'linux',
      readTextFile: () => Promise.resolve(STATUS),
    };
    expect(await sampleProcessRssMb(1234, io)).toBe(256);
  });
  it('Linux 进程消失 → null', async () => {
    const io: Partial<ProcessSamplerIo> = {
      platform: 'linux',
      readTextFile: () => Promise.reject(new Error('ENOENT')),
    };
    expect(await sampleProcessRssMb(1234, io)).toBeNull();
  });
  it('macOS ps -o rss= → MB', async () => {
    const io: Partial<ProcessSamplerIo> = {
      platform: 'darwin',
      run: () => Promise.resolve('262144\n'),
    };
    expect(await sampleProcessRssMb(1234, io)).toBe(256);
  });
  it('Windows → null', async () => {
    expect(await sampleProcessRssMb(1234, { platform: 'win32' })).toBeNull();
  });
});

describe('MemoryTimelineRing', () => {
  const frame = (t: number): MemoryTimelineFrame => ({
    t,
    procs: [{ label: 'Browser', pid: 100, rssMb: t }],
  });

  it('未满：按序保留，size 递增', () => {
    const ring = new MemoryTimelineRing(3);
    ring.push(frame(1));
    ring.push(frame(2));
    expect(ring.size).toBe(2);
    expect(ring.frames().map((f) => f.t)).toEqual([1, 2]);
  });

  it('满后环绕覆盖最老（cap=3，推 5 帧 → 保留最新 3 帧、按序）', () => {
    const ring = new MemoryTimelineRing(3);
    for (let t = 1; t <= 5; t++) ring.push(frame(t));
    expect(ring.size).toBe(3);
    expect(ring.frames().map((f) => f.t)).toEqual([3, 4, 5]);
  });

  it('默认上限 288：推 290 帧 → 保留 288 帧（第 3..290）', () => {
    const ring = new MemoryTimelineRing();
    for (let t = 1; t <= 290; t++) ring.push(frame(t));
    expect(ring.size).toBe(288);
    const ts = ring.frames().map((f) => f.t);
    expect(ts).toHaveLength(288);
    expect(ts[0]).toBe(3); // 最老保留帧
    expect(ts[287]).toBe(290); // 最新
  });
});

describe('serializeMemoryTimelineCsv', () => {
  it('长表 CSV：表头 + 每 (帧,进程) 一行（t 为 ISO）', () => {
    const t = Date.UTC(2026, 6, 2, 10, 0, 0);
    const iso = new Date(t).toISOString();
    const csv = serializeMemoryTimelineCsv([
      {
        t,
        procs: [
          { label: 'Browser', pid: 100, rssMb: 300 },
          { label: 'sing-box', pid: 200, rssMb: 90 },
        ],
      },
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('t,label,pid,rssMb');
    expect(lines[1]).toBe(`${iso},Browser,100,300`);
    expect(lines[2]).toBe(`${iso},sing-box,200,90`);
  });

  it('空帧 → 仅表头', () => {
    expect(serializeMemoryTimelineCsv([])).toBe('t,label,pid,rssMb');
  });

  it('label 含逗号 → 替换为空格防破坏列', () => {
    const csv = serializeMemoryTimelineCsv([{ t: 0, procs: [{ label: 'a,b', pid: 1, rssMb: 5 }] }]);
    expect(csv.split('\n')[1]).toContain('a b,1,5');
  });
});

describe('mapRendererHeapSample', () => {
  it('KB→MB / bytes→MB 换算 + 字段存在', () => {
    const raw: RendererHeapSample = {
      heap: { usedHeapSize: 2048, totalHeapSize: 4096, heapSizeLimit: 8192 }, // KB
      processMemory: { residentSet: 1048576 }, // KB → 1024 MB
      resources: {
        images: { count: 1, size: 3 * 1024 * 1024, liveSize: 2 * 1024 * 1024 },
        fonts: { count: 1, size: 1024 * 1024, liveSize: 1024 * 1024 },
      },
    };
    expect(mapRendererHeapSample(raw)).toEqual({
      usedHeapMb: 2,
      totalHeapMb: 4,
      heapLimitMb: 8,
      residentSetMb: 1024,
      blinkResourceMb: 3, // (2+1) MB liveSize 汇总
    });
  });

  it('空样本 {}（preload 取数全失败）→ unavailable，不渲染空节', () => {
    const r = mapRendererHeapSample({});
    expect(r.unavailable).toContain('渲染进程取数为空');
    expect(r.usedHeapMb).toBeUndefined();
    expect(r.blinkResourceMb).toBeUndefined();
  });

  it('部分样本（仅 heap、无 resources）→ 正常映射、blinkResourceMb 缺省、非 unavailable', () => {
    const r = mapRendererHeapSample({ heap: { usedHeapSize: 2048 } });
    expect(r.unavailable).toBeUndefined();
    expect(r.usedHeapMb).toBe(2);
    expect(r.blinkResourceMb).toBeUndefined();
  });
});

describe('collectRendererHeap', () => {
  it('introspect 缺失 → unavailable', async () => {
    const r = await collectRendererHeap(undefined);
    expect(r.unavailable).toContain('无渲染窗口');
  });

  it('introspect 返回 null（无窗口）→ unavailable', async () => {
    const r = await collectRendererHeap(async () => null);
    expect(r.unavailable).toBeDefined();
  });

  it('introspect 成功 → 映射后的报告（字段存在）', async () => {
    const r = await collectRendererHeap(async () => ({
      heap: { usedHeapSize: 2048 },
    }));
    expect(r.unavailable).toBeUndefined();
    expect(r.usedHeapMb).toBe(2);
  });

  it('introspect 抛异常 → unavailable（不外抛）', async () => {
    const r = await collectRendererHeap(async () => {
      throw new Error('boom');
    });
    expect(r.unavailable).toContain('boom');
  });

  it('introspect 超时（never resolve）→ unavailable（超时兜底，绝不挂住）', async () => {
    const r = await collectRendererHeap(() => new Promise(() => {}), 20);
    expect(r.unavailable).toContain('超时');
  });
});
