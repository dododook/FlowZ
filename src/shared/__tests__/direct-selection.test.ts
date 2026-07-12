import { pickFallbackExit, isDirectSelection, DIRECT_SERVER_ID } from '../direct-selection';

describe('pickFallbackExit（删选中节点兜底出口，D4）', () => {
  it('有测速值 → 选最快（latencyMap 最低正值）', () => {
    expect(pickFallbackExit(['a', 'b', 'c'], { a: 200, b: 80, c: 150 })).toBe('b');
  });

  it('无任何正测速值 → 回退列表第一个候选', () => {
    expect(pickFallbackExit(['a', 'b', 'c'], {})).toBe('a');
  });

  it('latency<=0（超时 -1 / 0）不参与最快比较，仅靠首个兜底', () => {
    // a=-1(超时) b=无 c=-1 → 全无正值 → 回退第一个 a
    expect(pickFallbackExit(['a', 'b', 'c'], { a: -1, c: -1 })).toBe('a');
    // 仅 c 有正值 → 选 c（即便 c 不是第一个）
    expect(pickFallbackExit(['a', 'b', 'c'], { a: -1, c: 120 })).toBe('c');
  });

  it('部分节点有测速值 → 在有值者里选最快', () => {
    expect(pickFallbackExit(['a', 'b', 'c'], { b: 90 })).toBe('b');
  });

  it('空候选 → null（调用方置 selectedServerId=null → direct）', () => {
    expect(pickFallbackExit([], { a: 50 })).toBeNull();
  });

  it('候选顺序影响「无值回退第一个」（按用户列表序传入）', () => {
    expect(pickFallbackExit(['x', 'y'], {})).toBe('x');
    expect(pickFallbackExit(['y', 'x'], {})).toBe('y');
  });
});

describe('isDirectSelection', () => {
  it('哨兵 __direct__ → true；null/普通 id → false', () => {
    expect(isDirectSelection(DIRECT_SERVER_ID)).toBe(true);
    expect(isDirectSelection(null)).toBe(false);
    expect(isDirectSelection('some-id')).toBe(false);
    expect(isDirectSelection(undefined)).toBe(false);
  });
});
