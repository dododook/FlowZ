/**
 * StartTimeline 纯逻辑单测（B0 起核阶段耗时埋点）。
 *
 * 时钟经 deps 注入，零真实计时器；断言全部针对「增量语义 / 腿前缀 / 上限行为 / 汇总格式」这四条会被误改的性质。
 */
import { StartTimeline, START_TIMELINE_MAX_PHASES } from '../start-timeline';

/** 可编排的假时钟：每次读取吐出队列里的下一个值，耗尽后维持最后一个值。 */
function fakeClock(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[Math.min(i, values.length - 1)];
    i++;
    return v;
  };
}

describe('StartTimeline — 增量语义', () => {
  it('每格记的是「相对上一个标记」的增量，不是自 start 起的绝对耗时', () => {
    // 构造读 0；三次 mark 分别读 100 / 250 / 300
    const tl = new StartTimeline({ now: fakeClock([0, 100, 250, 300]) });
    tl.mark('a');
    tl.mark('b');
    tl.mark('c');
    // 变异守卫：若实现改成绝对耗时，这里会是 100/250/300
    expect(tl.phases()).toEqual([
      { label: 'a', ms: 100 },
      { label: 'b', ms: 150 },
      { label: 'c', ms: 50 },
    ]);
  });

  it('首格的基准是构造时刻（不是 0，也不是第一次 mark）', () => {
    const tl = new StartTimeline({ now: fakeClock([40, 100]) });
    tl.mark('first');
    expect(tl.phases()).toEqual([{ label: 'first', ms: 60 }]);
  });

  it('增量四舍五入到整毫秒', () => {
    const tl = new StartTimeline({ now: fakeClock([0, 0.4, 2.0]) });
    tl.mark('tiny'); // 0.4 → 0
    tl.mark('next'); // 1.6 → 2
    expect(tl.phases().map((p) => p.ms)).toEqual([0, 2]);
  });

  it('totalMs 是自构造起的绝对耗时（与逐格增量之和相互独立）', () => {
    const tl = new StartTimeline({ now: fakeClock([0, 10, 30, 999]) });
    tl.mark('a');
    tl.mark('b');
    expect(tl.totalMs()).toBe(999);
  });

  it('phases() 返回副本——调用方改不动内部状态', () => {
    const tl = new StartTimeline({ now: fakeClock([0, 5]) });
    tl.mark('a');
    tl.phases().push({ label: '注入', ms: 12345 });
    expect(tl.phases()).toHaveLength(1);
  });
});

describe('StartTimeline — 起核腿前缀', () => {
  it('beginLeg 之前无前缀，之后带 L<n>. 前缀且逐腿递增', () => {
    const tl = new StartTimeline({ now: fakeClock([0, 10, 20, 30, 40, 50]) });
    tl.mark('prep');
    tl.beginLeg();
    tl.mark('adapterRelease');
    tl.beginLeg();
    tl.mark('adapterRelease');
    expect(tl.phases().map((p) => p.label)).toEqual([
      'prep',
      'L1.begin',
      'L1.adapterRelease',
      'L2.begin',
      'L2.adapterRelease',
    ]);
  });

  it('L<n>.begin 这一格 = 上一个标记到本腿开始的耗时（第 2 腿起即 retry 退避）', () => {
    // 0 构造 → mark prep@10 → beginLeg@15 → mark ready@20 → beginLeg@3020（退避 3s）
    const tl = new StartTimeline({ now: fakeClock([0, 10, 15, 20, 3020]) });
    tl.mark('prep');
    tl.beginLeg();
    tl.mark('coreReady');
    tl.beginLeg();
    const byLabel = Object.fromEntries(tl.phases().map((p) => [p.label, p.ms]));
    expect(byLabel['L1.begin']).toBe(5);
    expect(byLabel['L2.begin']).toBe(3000);
  });
});

describe('StartTimeline — 上限与汇总', () => {
  // 注：「丢格时是否仍推进时钟基准」在公开 API 上**不可观测**——一旦触顶就再不推入任何格，`last` 此后不影响
  // 任何输出（实测：把 `this.last = at` 挪到 cap 检查之后，本文件 11 条全绿 ⇒ 等价变异）。故此处只断言真正能
  // 观测到的三条：触顶后不再增长、dropped 计数、已入格的历史不被回溯改写。不写「变异守卫」以免立一个无牙的判据。
  it('触顶后只计数不再入格，且不回溯改写已记录的格', () => {
    let t = 0;
    const tl = new StartTimeline({ now: () => t });
    for (let i = 0; i < START_TIMELINE_MAX_PHASES; i++) {
      t += 1;
      tl.mark(`p${i}`);
    }
    expect(tl.phases()).toHaveLength(START_TIMELINE_MAX_PHASES);
    expect(tl.dropped()).toBe(0);
    // 再来两格：都被丢，但基准必须跟着走
    t += 100;
    tl.mark('dropped-1');
    t += 7;
    tl.mark('dropped-2');
    expect(tl.dropped()).toBe(2);
    expect(tl.phases()).toHaveLength(START_TIMELINE_MAX_PHASES);
    // 触顶后的两次 mark 不得回头改写末格
    expect(tl.phases()[START_TIMELINE_MAX_PHASES - 1]).toEqual({
      label: `p${START_TIMELINE_MAX_PHASES - 1}`,
      ms: 1,
    });
  });

  it('summarize 含 total / outcome / 逐格', () => {
    const tl = new StartTimeline({ now: fakeClock([0, 100, 300, 350]) });
    tl.mark('killOrphans');
    tl.mark('coreVersion');
    expect(tl.summarize('ok')).toBe(
      '起核阶段耗时 total=350ms outcome=ok | killOrphans=100 coreVersion=200'
    );
  });

  it('summarize 在有丢格时自曝，不静默截断', () => {
    let t = 0;
    const tl = new StartTimeline({ now: () => t });
    for (let i = 0; i < START_TIMELINE_MAX_PHASES + 3; i++) {
      t += 1;
      tl.mark(`p${i}`);
    }
    expect(tl.summarize('failed')).toContain('(+3 格超限未记)');
  });

  it('一格没记时不留空尾巴 `| `（那是条零信息量的行，却每次 start 都进 app.log 与诊断报告）', () => {
    const tl = new StartTimeline({ now: fakeClock([0, 12]) });
    expect(tl.summarize('superseded')).toBe('起核阶段耗时 total=12ms outcome=superseded');
  });
});

/**
 * 汇总行整行原文会被 push 进诊断报告且**不过脱敏**——「不含用户数据」是它免脱敏的唯一理由。
 * 该不变量原先只写在设计文档里、零判据（复审 Low）；此处把它落成门。
 */
describe('StartTimeline — label 形状约束（免脱敏的前提）', () => {
  it('越界字符被替成 ?：节点名/域名不会经 label 漏进诊断报告', () => {
    const tl = new StartTimeline({ now: fakeClock([0, 5]) });
    tl.mark('probe:香港节点 01.example.com');
    // 「香港节点」4 字 + 1 空格 = 5 个越界字符；ASCII 部分（含 `.` `:`）原样保留
    expect(tl.phases()[0].label).toBe('probe:?????01.example.com');
  });

  it('今天在用的 label 形态一律原样保留（约束不得误伤合法标签）', () => {
    const tl = new StartTimeline({ now: () => 0 });
    for (const l of ['killOrphans', 'coreReady:ready', 'tunAdapter:absent-timeout', 'startTail']) {
      tl.mark(l);
    }
    tl.beginLeg();
    tl.mark('adapterRelease');
    expect(tl.phases().map((p) => p.label)).toEqual([
      'killOrphans',
      'coreReady:ready',
      'tunAdapter:absent-timeout',
      'startTail',
      'L1.begin',
      'L1.adapterRelease',
    ]);
  });

  it('腿前缀在约束之外拼接：`L<n>.` 不被自身规则吃掉', () => {
    const tl = new StartTimeline({ now: () => 0 });
    tl.beginLeg();
    tl.mark('spawn');
    expect(tl.phases()[1].label).toBe('L1.spawn');
  });
});
