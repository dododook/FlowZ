import { getRuleActionStyle, ruleActionLabel } from '../rule-action-style';

// t 桩：原样回 key，便于断言映射目标
const t = ((k: string) => k) as any;

describe('ruleActionLabel', () => {
  it('direct → rules.direct', () => {
    expect(ruleActionLabel('direct', t)).toBe('rules.direct');
  });

  it('block 及别名 → rules.block', () => {
    expect(ruleActionLabel('block', t)).toBe('rules.block');
    expect(ruleActionLabel('reject', t)).toBe('rules.block');
    expect(ruleActionLabel('reject-drop', t)).toBe('rules.block');
    expect(ruleActionLabel('drop', t)).toBe('rules.block');
  });

  it('proxy → rules.proxy', () => {
    expect(ruleActionLabel('proxy', t)).toBe('rules.proxy');
  });

  it('大小写不敏感', () => {
    expect(ruleActionLabel('DIRECT', t)).toBe('rules.direct');
    expect(ruleActionLabel('Block', t)).toBe('rules.block');
  });

  it('未知值/空 容错回落 rules.proxy（锁默认分支语义）', () => {
    expect(ruleActionLabel('', t)).toBe('rules.proxy');
    expect(ruleActionLabel('whatever-node', t)).toBe('rules.proxy');
  });
});

describe('getRuleActionStyle 三值配色单一真值（badge 淡色调去眩光）', () => {
  it('direct → success（淡色底 + 同色字）', () => {
    expect(getRuleActionStyle('direct').badgeBg).toBe('bg-success/15');
    expect(getRuleActionStyle('direct').text).toBe('text-success');
    expect(getRuleActionStyle('direct').dot).toBe('bg-success'); // 拓扑点仍实色
  });

  it('block 及别名 → destructive（淡色底）', () => {
    expect(getRuleActionStyle('block').badgeBg).toBe('bg-destructive/15');
    expect(getRuleActionStyle('reject').badgeBg).toBe('bg-destructive/15');
  });

  it('proxy/未知 → primary（淡色底 + 同色字）', () => {
    expect(getRuleActionStyle('proxy').badgeBg).toBe('bg-primary/15');
    expect(getRuleActionStyle('proxy').text).toBe('text-primary');
    expect(getRuleActionStyle('node-x').badgeBg).toBe('bg-primary/15');
  });
});
