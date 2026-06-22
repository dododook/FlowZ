import { dedupe, dedupeTrim } from '../collections';

describe('dedupe — 去重保序', () => {
  it('保留首次出现顺序、剔重复', () => {
    expect(dedupe([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
    expect(dedupe(['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
  });
  it('空 / 无重复原样', () => {
    expect(dedupe([])).toEqual([]);
    expect(dedupe([1, 2, 3])).toEqual([1, 2, 3]);
  });
  it('接受任意 Iterable（如 Set）', () => {
    expect(dedupe(new Set([1, 2, 2, 3]))).toEqual([1, 2, 3]);
  });
});

describe('dedupeTrim — 去重 + trim + 去空', () => {
  it('修剪空白后去重、丢空串、保序', () => {
    expect(dedupeTrim([' a ', 'a', 'b', '', '  ', 'b'])).toEqual(['a', 'b']);
  });
  it('全空 → []', () => {
    expect(dedupeTrim(['', '   ', '\t'])).toEqual([]);
  });
});
