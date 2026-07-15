/**
 * error-page 单测（GAP-1a/3 终局兜底静态错误页）。钉住：转义、重载动作（有/无 reloadUrl）、data: URL 往返。
 */
import { buildFatalErrorPageHtml, fatalErrorPageDataUrl } from '../error-page';

describe('buildFatalErrorPageHtml', () => {
  it('含标题/正文/按钮文案', () => {
    const html = buildFatalErrorPageHtml({
      title: '加载失败',
      message: '界面起不来',
      reloadLabel: '重新加载',
    });
    expect(html).toContain('加载失败');
    expect(html).toContain('界面起不来');
    expect(html).toContain('重新加载');
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('转义 HTML 特殊字符，防错误文本破坏结构 / 注入', () => {
    const html = buildFatalErrorPageHtml({
      title: 'T',
      message: '<img src=x onerror=alert(1)> & "q" \'s\'',
      reloadLabel: 'R',
    });
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
    expect(html).toContain('&#39;');
  });

  it('无 retryChannel → 按钮内联脚本走 location.reload()', () => {
    const html = buildFatalErrorPageHtml({ title: 'T', message: 'M', reloadLabel: 'R' });
    expect(html).toContain("getElementById('flowz-reload')");
    expect(html).toContain('location.reload()');
    expect(html).not.toContain('ipcRenderer.invoke');
  });

  it('有 retryChannel → 按钮经 preload invoke 该通道（真恢复），失败回退 location.reload()', () => {
    const html = buildFatalErrorPageHtml({
      title: 'T',
      message: 'M',
      reloadLabel: 'R',
      retryChannel: 'fatal:retry',
    });
    expect(html).toContain('window.electron.ipcRenderer.invoke("fatal:retry")');
    expect(html).toContain('location.reload()'); // catch 回退
  });
});

describe('fatalErrorPageDataUrl', () => {
  it('data: 前缀 + encodeURIComponent 往返得回原 HTML', () => {
    const text = { title: '标题 <x>', message: '正文 & 更多', reloadLabel: '重载' };
    const dataUrl = fatalErrorPageDataUrl(text);
    expect(dataUrl.startsWith('data:text/html;charset=utf-8,')).toBe(true);
    const decoded = decodeURIComponent(dataUrl.slice('data:text/html;charset=utf-8,'.length));
    expect(decoded).toBe(buildFatalErrorPageHtml(text));
  });
});
