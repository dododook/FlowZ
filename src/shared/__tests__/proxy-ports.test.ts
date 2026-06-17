import { localProxyPort, DEFAULT_MIXED_PORT } from '../proxy-ports';

describe('localProxyPort (mixed-only 单一真值)', () => {
  it('mixedPort 已设(>0) → 用 mixedPort', () => {
    expect(localProxyPort({ mixedPort: 7890 })).toBe(7890);
    expect(localProxyPort({ mixedPort: 1080, httpPort: 2080 })).toBe(1080); // mixedPort 优先于 httpPort
  });
  it('mixedPort 未设 → 回退旧 httpPort（迁移前/旧配置存量沿用）', () => {
    expect(localProxyPort({ httpPort: 2080 })).toBe(2080);
    expect(localProxyPort({ mixedPort: 0, httpPort: 2080 })).toBe(2080);
  });
  it('两者皆无 → 新装默认 7890', () => {
    expect(localProxyPort({})).toBe(DEFAULT_MIXED_PORT);
    expect(localProxyPort({ mixedPort: 0 })).toBe(7890);
  });
  it('DEFAULT_MIXED_PORT 对齐业内 7890', () => {
    expect(DEFAULT_MIXED_PORT).toBe(7890);
  });
});
