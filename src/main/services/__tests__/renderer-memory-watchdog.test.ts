/**
 * renderer-memory-watchdog 纯决策内核单测（issue #242 §4 视图生命周期）。
 * 覆盖：env 阈值解析（合法/非法/缺省）、从 getAppMetrics 取渲染 RSS（匹配/pid null/未找到）、
 * 决策全分支（无窗口/低于阈值/超阈值+隐藏→discard/超阈值+可见+冷却内→none/超阈值+可见+冷却过→warn）。
 */
import type { ProcessMetricLike } from '../../../shared/process-metrics';
import {
  DEFAULT_RENDERER_RSS_LIMIT_MB,
  parseRendererRssLimitMb,
  rendererRssMbFromMetrics,
  decideRendererMemoryAction,
} from '../renderer-memory-watchdog';

function metric(pid: number, workingSetKb: number, type = 'Renderer'): ProcessMetricLike {
  return { pid, type, memory: { workingSetSize: workingSetKb } };
}

describe('parseRendererRssLimitMb', () => {
  it('缺省（undefined）→ 默认 1536', () => {
    expect(parseRendererRssLimitMb(undefined)).toBe(DEFAULT_RENDERER_RSS_LIMIT_MB);
    expect(DEFAULT_RENDERER_RSS_LIMIT_MB).toBe(1536);
  });

  it('合法正整数字符串 → 解析值（便于测试降阈值）', () => {
    expect(parseRendererRssLimitMb('512')).toBe(512);
    expect(parseRendererRssLimitMb('2048')).toBe(2048);
  });

  it('非正整数（0/负/小数/非数字/空）→ 回退默认（防污染阈值误触发或永不触发）', () => {
    expect(parseRendererRssLimitMb('0')).toBe(DEFAULT_RENDERER_RSS_LIMIT_MB);
    expect(parseRendererRssLimitMb('-100')).toBe(DEFAULT_RENDERER_RSS_LIMIT_MB);
    expect(parseRendererRssLimitMb('768.5')).toBe(DEFAULT_RENDERER_RSS_LIMIT_MB);
    expect(parseRendererRssLimitMb('abc')).toBe(DEFAULT_RENDERER_RSS_LIMIT_MB);
    expect(parseRendererRssLimitMb('')).toBe(DEFAULT_RENDERER_RSS_LIMIT_MB);
    expect(parseRendererRssLimitMb('  ')).toBe(DEFAULT_RENDERER_RSS_LIMIT_MB);
  });
});

describe('rendererRssMbFromMetrics', () => {
  const metrics = [
    metric(100, 300 * 1024, 'Browser'),
    metric(200, 1536 * 1024, 'Renderer'),
    metric(300, 80 * 1024, 'GPU'),
  ];

  it('按 pid 匹配渲染进程 → RSS（KB→MB 四舍五入）', () => {
    expect(rendererRssMbFromMetrics(metrics, 200)).toBe(1536);
    expect(rendererRssMbFromMetrics(metrics, 100)).toBe(300);
  });

  it('pid 为 null（窗口已销毁/轻量态）→ null', () => {
    expect(rendererRssMbFromMetrics(metrics, null)).toBeNull();
  });

  it('pid 采样里找不到（进程在途重建）→ null', () => {
    expect(rendererRssMbFromMetrics(metrics, 999)).toBeNull();
  });

  it('KB 非整 MB → 四舍五入', () => {
    // 1536.5 MB 的 KB 值 → 四舍五入到 1537（Math.round）
    expect(rendererRssMbFromMetrics([metric(1, 1536.5 * 1024)], 1)).toBe(1537);
  });
});

describe('decideRendererMemoryAction', () => {
  const base = {
    thresholdMb: 1536,
    windowExists: true,
    windowVisible: true,
    lastWarnAt: 0,
    now: 10 * 60 * 1000, // 10min，远超冷却
    warnCooldownMs: 5 * 60 * 1000,
  };

  it('无窗口（windowExists false）→ none', () => {
    expect(
      decideRendererMemoryAction({
        ...base,
        windowExists: false,
        rssMb: 9999,
        windowVisible: false,
      })
    ).toBe('none');
  });

  it('RSS 不可得（null）→ none', () => {
    expect(decideRendererMemoryAction({ ...base, rssMb: null, windowVisible: false })).toBe('none');
  });

  it('未超阈值（含恰等于阈值）→ none', () => {
    expect(decideRendererMemoryAction({ ...base, rssMb: 1000, windowVisible: false })).toBe('none');
    expect(decideRendererMemoryAction({ ...base, rssMb: 1536, windowVisible: false })).toBe('none');
  });

  it('超阈值 + 窗口隐藏 → discard（销毁回收）', () => {
    expect(decideRendererMemoryAction({ ...base, rssMb: 1600, windowVisible: false })).toBe(
      'discard'
    );
  });

  it('超阈值 + 窗口可见 + 冷却已过 → warn（只告警，不销毁用户在看的窗口）', () => {
    expect(decideRendererMemoryAction({ ...base, rssMb: 1600, windowVisible: true })).toBe('warn');
  });

  it('超阈值 + 窗口可见 + 冷却内 → none（防刷屏）', () => {
    expect(
      decideRendererMemoryAction({
        ...base,
        rssMb: 1600,
        windowVisible: true,
        lastWarnAt: 9 * 60 * 1000, // 上次告警在 9min，距 now(10min) 仅 1min < 5min 冷却
      })
    ).toBe('none');
  });

  it('超阈值 + 可见 + 冷却边界（恰 == cooldown）→ warn', () => {
    expect(
      decideRendererMemoryAction({
        ...base,
        rssMb: 1600,
        windowVisible: true,
        lastWarnAt: 5 * 60 * 1000, // now - lastWarnAt == 冷却 → 允许告警
      })
    ).toBe('warn');
  });
});
