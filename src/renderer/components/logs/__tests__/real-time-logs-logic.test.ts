import {
  logMatchesSearch,
  truncateToBuffer,
  getLevelColorClass,
  getLevelRowClass,
} from '../real-time-logs-logic';

describe('logMatchesSearch', () => {
  const row = { message: 'outbound/vless connected to 203.0.113.42', level: 'info' as const };

  it('空 term 命中全部', () => {
    expect(logMatchesSearch(row, '')).toBe(true);
  });

  it('消息子串命中（大小写不敏感）', () => {
    expect(logMatchesSearch(row, 'VLESS')).toBe(true);
    expect(logMatchesSearch(row, '203.0.113')).toBe(true);
  });

  it('级别子串命中（充当级别过滤）', () => {
    expect(logMatchesSearch(row, 'info')).toBe(true);
    expect(logMatchesSearch({ message: 'x', level: 'error' }, 'ERR')).toBe(true);
    expect(logMatchesSearch({ message: 'x', level: 'warn' }, 'warn')).toBe(true);
  });

  it('消息与级别都不含时不命中', () => {
    expect(logMatchesSearch(row, 'debug')).toBe(false);
    expect(logMatchesSearch(row, 'zzz')).toBe(false);
  });
});

describe('truncateToBuffer', () => {
  it('超限时仅保留最新 max 条', () => {
    expect(truncateToBuffer([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
  });

  it('恰好等于 max 时原样返回同一引用', () => {
    const rows = [1, 2, 3];
    expect(truncateToBuffer(rows, 3)).toBe(rows);
  });

  it('未超限时原样返回同一引用（保持 setState 幂等）', () => {
    const rows = [1, 2];
    expect(truncateToBuffer(rows, 5)).toBe(rows);
  });

  it('空数组安全', () => {
    expect(truncateToBuffer([], 500)).toEqual([]);
  });
});

describe('getLevelColorClass', () => {
  it('error/fatal → destructive', () => {
    expect(getLevelColorClass('error')).toBe('text-destructive');
    expect(getLevelColorClass('fatal')).toBe('text-destructive');
  });
  it('warn → warning, info → info, debug → muted', () => {
    expect(getLevelColorClass('warn')).toBe('text-warning');
    expect(getLevelColorClass('info')).toBe('text-info');
    expect(getLevelColorClass('debug')).toBe('text-muted-foreground');
  });
});

describe('getLevelRowClass', () => {
  it('error/fatal 带 destructive 左脊 + 底色', () => {
    expect(getLevelRowClass('error')).toContain('border-destructive');
    expect(getLevelRowClass('error')).toContain('bg-destructive/5');
    expect(getLevelRowClass('fatal')).toContain('border-destructive');
  });
  it('warn 带 warning 左脊', () => {
    expect(getLevelRowClass('warn')).toContain('border-warning/60');
  });
  it('info/debug 透明左脊占位（不跳动对齐）', () => {
    expect(getLevelRowClass('info')).toContain('border-transparent');
    expect(getLevelRowClass('debug')).toContain('border-transparent');
  });
});
