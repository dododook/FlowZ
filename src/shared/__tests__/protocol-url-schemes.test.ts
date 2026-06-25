import { SUPPORTED_URL_SCHEMES, isSupportedShareUrl } from '../protocol-url-schemes';

describe('isSupportedShareUrl', () => {
  it.each(SUPPORTED_URL_SCHEMES.map((s) => `${s}://x`))('支持 %s', (u) =>
    expect(isSupportedShareUrl(u)).toBe(true)
  );

  // naive:// 曾仅后端支持、前端漏列，单独锁回归（issue #191）
  it('支持裸 naive://', () => expect(isSupportedShareUrl('naive://u:p@h:443#n')).toBe(true));

  it.each(['ftp://x', 'wireguard://x', 'tailscale://x', 'foobar', ''])('不支持 %s', (u) =>
    expect(isSupportedShareUrl(u)).toBe(false)
  );

  // http 前缀不得误命中 https（前缀精确匹配回归）
  it('http:// 与 https:// 各自精确匹配', () => {
    expect(isSupportedShareUrl('https://x')).toBe(true);
    expect(isSupportedShareUrl('http://x')).toBe(true);
  });
});
