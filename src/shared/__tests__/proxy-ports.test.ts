import {
  localProxyPort,
  DEFAULT_MIXED_PORT,
  controlApiPort,
  DEFAULT_CONTROL_PORT,
} from '../proxy-ports';

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

describe('controlApiPort (clash_api 控制端口单一真值)', () => {
  it('controlPort 已设(>0) → 用 controlPort', () => {
    expect(controlApiPort({ controlPort: 9091 })).toBe(9091);
    expect(controlApiPort({ controlPort: 12345 })).toBe(12345);
  });
  it('controlPort 未设/无效 → 默认 9090', () => {
    expect(controlApiPort({})).toBe(DEFAULT_CONTROL_PORT);
    expect(controlApiPort({ controlPort: 0 })).toBe(9090);
    expect(controlApiPort({ controlPort: -1 })).toBe(9090);
  });
  it('DEFAULT_CONTROL_PORT 对齐业内 9090', () => {
    expect(DEFAULT_CONTROL_PORT).toBe(9090);
  });
});
