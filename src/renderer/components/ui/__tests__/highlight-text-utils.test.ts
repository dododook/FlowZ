import { escapeRegExp, splitByQuery } from '../highlight-text-utils';

describe('escapeRegExp', () => {
  it('转义正则元字符', () => {
    expect(escapeRegExp('a.b*c+d?')).toBe('a\\.b\\*c\\+d\\?');
    expect(escapeRegExp('(g)[e]{o}|^$')).toBe('\\(g\\)\\[e\\]\\{o\\}\\|\\^\\$');
    expect(escapeRegExp('a\\b')).toBe('a\\\\b');
  });

  it('普通字符不变', () => {
    expect(escapeRegExp('youtube')).toBe('youtube');
  });
});

describe('splitByQuery', () => {
  it('空 query / 纯空白 query → 单个非命中段（原样）', () => {
    expect(splitByQuery('youtube', '')).toEqual([{ text: 'youtube', match: false }]);
    expect(splitByQuery('youtube', '   ')).toEqual([{ text: 'youtube', match: false }]);
  });

  it('无命中 → 单个非命中段', () => {
    expect(splitByQuery('youtube', 'zzz')).toEqual([{ text: 'youtube', match: false }]);
  });

  it('单处命中切成三段', () => {
    expect(splitByQuery('category-ads-all', 'ads')).toEqual([
      { text: 'category-', match: false },
      { text: 'ads', match: true },
      { text: '-all', match: false },
    ]);
  });

  it('大小写不敏感，且保留原文大小写', () => {
    expect(splitByQuery('YouTube', 'tube')).toEqual([
      { text: 'You', match: false },
      { text: 'Tube', match: true },
    ]);
  });

  it('多处命中全部标记', () => {
    expect(splitByQuery('cncn', 'cn')).toEqual([
      { text: 'cn', match: true },
      { text: 'cn', match: true },
    ]);
  });

  it('命中位于开头/结尾', () => {
    expect(splitByQuery('cn-list', 'cn')).toEqual([
      { text: 'cn', match: true },
      { text: '-list', match: false },
    ]);
    expect(splitByQuery('list-cn', 'cn')).toEqual([
      { text: 'list-', match: false },
      { text: 'cn', match: true },
    ]);
  });

  it('query 含正则元字符按字面量匹配（不当模式解释）', () => {
    // '.' 字面量：只命中真正的点，不命中任意字符
    expect(splitByQuery('geo.srs', '.')).toEqual([
      { text: 'geo', match: false },
      { text: '.', match: true },
      { text: 'srs', match: false },
    ]);
    // 含元字符的 query 无字面量命中 → 不报错、原样返回
    expect(splitByQuery('abc', 'a.c')).toEqual([{ text: 'abc', match: false }]);
    // 路径形态字面量命中
    expect(splitByQuery('geo/geosite/youtube.srs', 'geosite/you')).toEqual([
      { text: 'geo/', match: false },
      { text: 'geosite/you', match: true },
      { text: 'tube.srs', match: false },
    ]);
  });

  it('整串即命中', () => {
    expect(splitByQuery('cn', 'cn')).toEqual([{ text: 'cn', match: true }]);
  });
});
