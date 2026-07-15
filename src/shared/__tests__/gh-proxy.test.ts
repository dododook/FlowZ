import {
  ghMirrorUrl,
  applyGhProxy,
  isGithubHost,
  normalizeGhProxyPrefix,
  GH_PROXY_PRESETS,
} from '../gh-proxy';

const GH = 'https://github.com/a/b/releases/download/v1/x.zip';

// 域名表是「加速」与「镜像兜底」共用的单一真值。曾有消费方各持一份副本（RuleResourceManager 的 2 域
// GITHUB_HOSTS vs 本表 5 域）→ 同一 URL 在第1级算 GitHub、第3级不算，三级兜底自相矛盾。
// 本组断言逐个钉死 5 域 + 刻意排除项，任何漂移即红。
describe('isGithubHost（域名表单一真值）', () => {
  it.each([
    'https://github.com/a/b',
    'https://raw.githubusercontent.com/a/b/main/x.srs',
    'https://objects.githubusercontent.com/gh-release-assets/1/2',
    'https://gist.githubusercontent.com/u/id/raw/x',
    'https://codeload.github.com/a/b/tar.gz/refs/heads/main',
  ])('GitHub 家族域命中：%s', (url) => {
    expect(isGithubHost(url)).toBe(true);
  });

  it('api.github.com 刻意不在表内（Trees API 刷新不走加速）', () => {
    expect(isGithubHost('https://api.github.com/repos/a/b/git/trees/main')).toBe(false);
  });

  it('非 GitHub 域 → false', () => {
    expect(isGithubHost('https://example.com/x.zip')).toBe(false);
    expect(isGithubHost('https://notgithub.com/a')).toBe(false);
  });

  it('非法 URL → false（不抛）', () => {
    expect(isGithubHost('not a url')).toBe(false);
    expect(isGithubHost('')).toBe(false);
  });
});

describe('ghMirrorUrl', () => {
  it('无 ghPrefix → 回落内置 preset[0]+url', () => {
    expect(ghMirrorUrl(GH)).toBe(GH_PROXY_PRESETS[0] + GH);
  });

  it('有 ghPrefix 且命中 GitHub 域 → 用前缀拼接', () => {
    expect(ghMirrorUrl(GH, 'https://my.mirror/')).toBe('https://my.mirror/' + GH);
  });

  it('有 ghPrefix 但非 GitHub 域(applyGhProxy 不改) → 回落 preset[0]', () => {
    const nonGh = 'https://example.com/x.zip';
    expect(ghMirrorUrl(nonGh, 'https://my.mirror/')).toBe(GH_PROXY_PRESETS[0] + nonGh);
  });
});

describe('applyGhProxy', () => {
  it('GitHub 域加前缀；非 GitHub 域原样', () => {
    expect(applyGhProxy('https://m/', GH)).toBe('https://m/' + GH);
    expect(applyGhProxy('https://m/', 'https://example.com/x')).toBe('https://example.com/x');
    expect(applyGhProxy(undefined, GH)).toBe(GH);
  });
});

describe('normalizeGhProxyPrefix', () => {
  it('裸域名 → https://host/；空/非法 → null', () => {
    expect(normalizeGhProxyPrefix('gh-proxy.org')).toBe('https://gh-proxy.org/');
    expect(normalizeGhProxyPrefix('https://gh-proxy.org')).toBe('https://gh-proxy.org/');
    expect(normalizeGhProxyPrefix('')).toBeNull();
    expect(normalizeGhProxyPrefix('http://x.com')).toBeNull(); // 非 https
  });
});
