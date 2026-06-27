/**
 * iconProxySrc 纯逻辑单测（Phase 1b §8 图标代理协议）：验 https/http 包装、空与非网络 URL 原样、
 * 真实 URL 经 encodeURIComponent 嵌入可被 main handler 无损还原。
 */
import { ICON_PROXY_SCHEME, iconProxySrc } from '../icon-proxy';

describe('iconProxySrc', () => {
  it('https URL 包成 flowz-icon:// 代理 URL', () => {
    const out = iconProxySrc('https://cdn.jsdelivr.net/gh/Koolson/Qure/x.png');
    expect(out).toBe(
      `${ICON_PROXY_SCHEME}://i/${encodeURIComponent('https://cdn.jsdelivr.net/gh/Koolson/Qure/x.png')}`
    );
  });

  it('http URL 也代理', () => {
    expect(iconProxySrc('http://example.com/a.png')).toBe(
      `${ICON_PROXY_SCHEME}://i/${encodeURIComponent('http://example.com/a.png')}`
    );
  });

  it('空 / undefined / null 返回空串', () => {
    expect(iconProxySrc('')).toBe('');
    expect(iconProxySrc(undefined)).toBe('');
    expect(iconProxySrc(null)).toBe('');
  });

  it('非网络 URL（data: / 本地）原样返回，不代理', () => {
    expect(iconProxySrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(iconProxySrc('/local/icon.png')).toBe('/local/icon.png');
  });

  it('编码后的真实 URL 可被 decodeURIComponent 无损还原', () => {
    const real = 'https://raw.githubusercontent.com/a/b/c.json?x=1&y=2';
    const proxied = iconProxySrc(real);
    const enc = proxied.replace(`${ICON_PROXY_SCHEME}://i/`, '');
    expect(decodeURIComponent(enc)).toBe(real);
  });
});
