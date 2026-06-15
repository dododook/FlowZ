/**
 * parseSpeedTestUrl / resolveSpeedTestTarget 单测（纯函数，无网络/无 FS）：
 * 验证测速端点 URL → SpeedTestTarget 解析（http/https、host/port、path+query、非标准端口 Host 头、非法回落默认）。
 *
 * 这是「测速地址可设置」的后端核心：SpeedTestService.measureViaTunnel 据 target.https 决定 CONNECT 隧道上是否先
 * 做 TLS 握手，再发两次 GET 只计第二次（warm RTT）。FS/网络层（实际请求）属集成层、真机验证，不在此测。
 */
import { parseSpeedTestUrl, resolveSpeedTestTarget, DEFAULT_SPEED_TEST_URL } from '../speed-test';

describe('parseSpeedTestUrl（测速 URL 解析）', () => {
  it('默认 generate_204 (http) → host/path/port 正确', () => {
    const r = parseSpeedTestUrl(DEFAULT_SPEED_TEST_URL);
    expect(r).toEqual({
      https: false,
      host: 'www.gstatic.com',
      port: 80,
      path: '/generate_204',
      hostHeader: 'www.gstatic.com',
      absoluteUri: 'http://www.gstatic.com/generate_204',
    });
  });

  it('https 端点 → https=true、port=443、hostHeader 不带端口', () => {
    const r = parseSpeedTestUrl('https://cp.cloudflare.com/generate_204');
    expect(r).toMatchObject({
      https: true,
      host: 'cp.cloudflare.com',
      port: 443,
      path: '/generate_204',
      hostHeader: 'cp.cloudflare.com',
    });
  });

  it('带 query string → path 含 ?query', () => {
    const r = parseSpeedTestUrl('http://example.com/p?x=1&y=2');
    expect(r?.path).toBe('/p?x=1&y=2');
  });

  it('非标准端口 → port + hostHeader 带 host:port', () => {
    const r = parseSpeedTestUrl('http://example.com:8080/p');
    expect(r?.port).toBe(8080);
    expect(r?.hostHeader).toBe('example.com:8080');
    expect(r?.absoluteUri).toBe('http://example.com:8080/p');
  });

  it('https 非标准端口', () => {
    const r = parseSpeedTestUrl('https://example.com:8443/p');
    expect(r?.https).toBe(true);
    expect(r?.port).toBe(8443);
    expect(r?.hostHeader).toBe('example.com:8443');
  });

  it('两端空格容错（trim）', () => {
    expect(parseSpeedTestUrl('  http://example.com/p  ')?.host).toBe('example.com');
  });

  it('非法输入 → null', () => {
    expect(parseSpeedTestUrl(undefined)).toBeNull();
    expect(parseSpeedTestUrl(null)).toBeNull();
    expect(parseSpeedTestUrl('')).toBeNull();
    expect(parseSpeedTestUrl('not a url')).toBeNull();
    expect(parseSpeedTestUrl('ftp://example.com/p')).toBeNull(); // 非 http(s)
    expect(parseSpeedTestUrl('http://')).toBeNull(); // 无 host
  });

  it('非法端口 → null', () => {
    expect(parseSpeedTestUrl('http://example.com:0/p')).toBeNull();
    expect(parseSpeedTestUrl('http://example.com:99999/p')).toBeNull();
  });
});

describe('resolveSpeedTestTarget（非法回落默认）', () => {
  it('undefined → 默认 generate_204', () => {
    expect(resolveSpeedTestTarget(undefined).host).toBe('www.gstatic.com');
    expect(resolveSpeedTestTarget(undefined).path).toBe('/generate_204');
  });

  it('非法 → 默认', () => {
    expect(resolveSpeedTestTarget('garbage').host).toBe('www.gstatic.com');
    expect(resolveSpeedTestTarget('').https).toBe(false);
  });

  it('合法 https → 用该端点（不回落）', () => {
    expect(resolveSpeedTestTarget('https://cp.cloudflare.com/generate_204').https).toBe(true);
    expect(resolveSpeedTestTarget('https://cp.cloudflare.com/generate_204').host).toBe(
      'cp.cloudflare.com'
    );
  });
});
