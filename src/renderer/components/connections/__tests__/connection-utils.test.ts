/**
 * 连接信息页纯逻辑单测：per-conn 速率差分 + 隐私屏蔽判定 + 各列展示派生。
 */
import {
  computeConnSpeeds,
  shouldHideForPrivacy,
  destOf,
  sourceOf,
  typeOf,
  chainOf,
  durationSec,
  fmtDuration,
  parseRule,
  isBlockedAction,
  type RateState,
} from '../connection-utils';
import type { ConnectionEntry } from '../../../../shared/types';

const conn = (id: string, upload: number, download: number): ConnectionEntry => ({
  id,
  chains: [],
  rule: '',
  rulePayload: '',
  upload,
  download,
});

/** 构造一条带 metadata / chains / start 的连接（展示派生函数用）。 */
const entry = (over: Partial<ConnectionEntry> = {}): ConnectionEntry => ({
  id: 'x',
  chains: [],
  rule: '',
  rulePayload: '',
  ...over,
});

describe('computeConnSpeeds (per-conn 速率差分)', () => {
  it('两帧差分得出 B/s 速率', () => {
    const t0 = 1_000_000;
    const t1 = t0 + 2000; // 2s 后
    // 帧1：建立基准（新连接首帧速率 0）
    const f1 = computeConnSpeeds([conn('a', 1000, 2000)], new Map(), t0);
    expect(f1.speeds.get('a')).toEqual({ up: 0, down: 0 });
    // 帧2：a 上行 +2000B / 下行 +6000B over 2s → up=1000 B/s, down=3000 B/s
    const f2 = computeConnSpeeds([conn('a', 3000, 8000)], f1.next, t1);
    const s = f2.speeds.get('a')!;
    expect(s.up).toBeCloseTo(1000, 5);
    expect(s.down).toBeCloseTo(3000, 5);
  });

  it('新连接首帧速率为 0（无基准）', () => {
    const { speeds } = computeConnSpeeds([conn('new', 500, 500)], new Map(), 1000);
    expect(speeds.get('new')).toEqual({ up: 0, down: 0 });
  });

  it('累计回绕（核重启）clamp 至 0，不出负速率', () => {
    const prev: RateState = new Map([['a', { up: 9999, down: 9999, at: 1000 }]]);
    // 当前帧累计 < 上一帧（回绕）
    const { speeds } = computeConnSpeeds([conn('a', 10, 20)], prev, 3000);
    const s = speeds.get('a')!;
    expect(s.up).toBe(0);
    expect(s.down).toBe(0);
  });

  it('消失的连接从 next 缓存清出', () => {
    const f1 = computeConnSpeeds([conn('a', 1, 1), conn('b', 1, 1)], new Map(), 1000);
    expect(f1.next.has('a')).toBe(true);
    expect(f1.next.has('b')).toBe(true);
    // 帧2 只剩 a → b 应不在 next
    const f2 = computeConnSpeeds([conn('a', 2, 2)], f1.next, 2000);
    expect(f2.next.has('a')).toBe(true);
    expect(f2.next.has('b')).toBe(false);
  });

  it('upload/download 缺失按 0 处理（不产生 NaN）', () => {
    const c: ConnectionEntry = { id: 'a', chains: [], rule: '', rulePayload: '' };
    const { speeds, next } = computeConnSpeeds([c], new Map(), 1000);
    expect(speeds.get('a')).toEqual({ up: 0, down: 0 });
    expect(next.get('a')).toEqual({ up: 0, down: 0, at: 1000 });
  });
});

describe('shouldHideForPrivacy (隐私屏蔽判定)', () => {
  it('隐私模式激活 → 屏蔽连接明细', () => {
    expect(shouldHideForPrivacy(true)).toBe(true);
  });
  it('非隐私模式 → 正常展示', () => {
    expect(shouldHideForPrivacy(false)).toBe(false);
  });
});

describe('destOf (目标展示)', () => {
  it('host 优先（即便也有 destinationIP）', () => {
    expect(destOf(entry({ metadata: { host: 'example.com', destinationIP: '1.2.3.4' } }))).toBe(
      'example.com'
    );
  });
  it('无 host → 回落 destinationIP', () => {
    expect(destOf(entry({ metadata: { destinationIP: '1.2.3.4' } }))).toBe('1.2.3.4');
  });
  it('带目标端口', () => {
    expect(destOf(entry({ metadata: { host: 'example.com', destinationPort: '443' } }))).toBe(
      'example.com:443'
    );
    expect(destOf(entry({ metadata: { destinationIP: '1.2.3.4', destinationPort: '80' } }))).toBe(
      '1.2.3.4:80'
    );
  });
  it('host 与 destinationIP 都缺 → "-"（含 metadata 整体缺失）', () => {
    expect(destOf(entry({ metadata: { destinationPort: '443' } }))).toBe('-');
    expect(destOf(entry({}))).toBe('-');
  });
});

describe('sourceOf (源展示)', () => {
  it('sourceIP:sourcePort', () => {
    expect(sourceOf(entry({ metadata: { sourceIP: '10.0.0.2', sourcePort: '51234' } }))).toBe(
      '10.0.0.2:51234'
    );
  });
  it('有 sourceIP 无 sourcePort → 仅 IP', () => {
    expect(sourceOf(entry({ metadata: { sourceIP: '10.0.0.2' } }))).toBe('10.0.0.2');
  });
  it('缺 sourceIP → "-"（含 metadata 整体缺失）', () => {
    expect(sourceOf(entry({ metadata: { sourcePort: '51234' } }))).toBe('-');
    expect(sourceOf(entry({}))).toBe('-');
  });
});

describe('typeOf (类型展示)', () => {
  it('network/type 拼接', () => {
    expect(typeOf(entry({ metadata: { network: 'tcp', type: 'Tun' } }))).toBe('tcp/Tun');
  });
  it('仅 network 或仅 type', () => {
    expect(typeOf(entry({ metadata: { network: 'udp' } }))).toBe('udp');
    expect(typeOf(entry({ metadata: { type: 'HTTP' } }))).toBe('HTTP');
  });
  it('两者皆缺 → "-"（含 metadata 整体缺失）', () => {
    expect(typeOf(entry({ metadata: {} }))).toBe('-');
    expect(typeOf(entry({}))).toBe('-');
  });
});

describe('chainOf (节点链展示)', () => {
  it('多节点链按 " / " 连接', () => {
    expect(chainOf(entry({ chains: ['HK-01', 'auto', 'GLOBAL'] }))).toBe('HK-01 / auto / GLOBAL');
  });
  it('单节点链', () => {
    expect(chainOf(entry({ chains: ['DIRECT'] }))).toBe('DIRECT');
  });
  it('空链 → "-"', () => {
    expect(chainOf(entry({ chains: [] }))).toBe('-');
  });
});

describe('isBlockedAction (阻断类去向判定)', () => {
  it('block / reject / reject-drop / drop → true', () => {
    expect(isBlockedAction('block')).toBe(true);
    expect(isBlockedAction('reject')).toBe(true);
    expect(isBlockedAction('reject-drop')).toBe(true);
    expect(isBlockedAction('drop')).toBe(true);
  });
  it('大小写不敏感', () => {
    expect(isBlockedAction('BLOCK')).toBe(true);
    expect(isBlockedAction('Reject-Drop')).toBe(true);
  });
  it('proxy / direct / 具体节点名 → false', () => {
    expect(isBlockedAction('proxy')).toBe(false);
    expect(isBlockedAction('direct')).toBe(false);
    expect(isBlockedAction('香港 IEPL · 01')).toBe(false);
  });
  it('空 / undefined 输入 → false（永不崩）', () => {
    expect(isBlockedAction('')).toBe(false);
    expect(isBlockedAction(undefined as unknown as string)).toBe(false);
  });
});

describe('durationSec (时长秒)', () => {
  it('正常：now - start（秒）', () => {
    const start = '2026-06-12T00:00:00.000Z';
    const now = Date.parse(start) + 5000;
    expect(durationSec(entry({ start }), now)).toBeCloseTo(5, 5);
  });
  it('缺 start → -1', () => {
    expect(durationSec(entry({}), Date.now())).toBe(-1);
  });
  it('非法日期字符串 → -1', () => {
    expect(durationSec(entry({ start: 'not-a-date' }), Date.now())).toBe(-1);
  });
  it('start 晚于 now（时钟回拨/核重启）→ clamp ≥ 0', () => {
    const start = '2026-06-12T00:00:00.000Z';
    const now = Date.parse(start) - 5000; // now 在 start 之前
    expect(durationSec(entry({ start }), now)).toBe(0);
  });
});

describe('fmtDuration (时长格式化)', () => {
  it('<60s → 秒', () => {
    expect(fmtDuration(0)).toBe('0s');
    expect(fmtDuration(5.9)).toBe('5s'); // floor
    expect(fmtDuration(59)).toBe('59s');
  });
  it('60s 边界 → 分秒', () => {
    expect(fmtDuration(60)).toBe('1m0s');
    expect(fmtDuration(125)).toBe('2m5s');
    expect(fmtDuration(3599)).toBe('59m59s');
  });
  it('3600s 边界 → 时分', () => {
    expect(fmtDuration(3600)).toBe('1h0m');
    expect(fmtDuration(3661)).toBe('1h1m');
    expect(fmtDuration(7325)).toBe('2h2m');
  });
  it('负数（无 start）→ "-"', () => {
    expect(fmtDuration(-1)).toBe('-');
    expect(fmtDuration(-0.5)).toBe('-');
  });
});

describe('parseRule — 规则列展示拆解（方案 B）', () => {
  it('完整规则串：提尾部 action + 首字段类型', () => {
    const r = parseRule('process_name=[Surge clash sing-box] => route(direct)');
    expect(r.type).toBe('process_name');
    expect(r.action).toBe('direct');
    expect(r.full).toContain('process_name');
  });
  it('无条件、仅 action', () => {
    const r = parseRule('=> route(block)');
    expect(r.action).toBe('block');
    expect(r.type).toBe('');
  });
  it('多个 => 取最后一段 action', () => {
    expect(parseRule('a=1 => b=2 => route(proxy)').action).toBe('proxy');
  });
  it('嵌套括号 action → 正确解析（含括号不误截）', () => {
    // B-m3：旧正则 [^()=>]+? 排除括号，含括号 action 失配；现支持括号平衡的嵌套 action
    const r = parseRule('domain=x => route(nested(inner))');
    expect(r.action).toBe('nested(inner)');
    expect(r.type).toBe('domain');
    expect(r.full).toContain('nested');
  });
  it('含逗号 action（proxy,ss 等边界）→ 正确解析', () => {
    const r = parseRule('domain=x => route(proxy,ss)');
    expect(r.action).toBe('proxy,ss');
    expect(r.type).toBe('domain');
  });
  it('多层嵌套括号 action → 取整体括号平衡内容', () => {
    const r = parseRule('domain=x => route(foo(bar(baz)))');
    expect(r.action).toBe('foo(bar(baz))');
  });
  it('裸 action（无 route 包裹）→ 正确解析', () => {
    expect(parseRule('a=1 => proxy').action).toBe('proxy');
  });
  it('括号失衡（格式异常）→ action 留空，full 不丢信息', () => {
    const r = parseRule('=> route(a(b)');
    expect(r.action).toBe('');
    expect(r.full).toContain('route(a(b)');
  });
  it('rule=类型 / rulePayload=值（无 =>）→ 组合展示', () => {
    const r = parseRule('rule_set', 'geosite-cn');
    expect(r.type).toBe('rule_set');
    expect(r.action).toBe('');
    expect(r.full).toBe('rule_set: geosite-cn');
  });
  it('空输入 → 全空，永不崩', () => {
    expect(parseRule('', '')).toEqual({ type: '', action: '', full: '' });
  });
  it('ReDoS 防护：超长无分隔串快速返回（type 正则限长，不灾难性回溯）', () => {
    const evil = 'a'.repeat(200000) + ' => route(x)';
    const t0 = Date.now();
    const r = parseRule(evil);
    expect(Date.now() - t0).toBeLessThan(100); // 修前实测 ~31s，限长后应 < 100ms
    expect(r.action).toBe('x');
  });
});
