/**
 * 远程实例安全纯逻辑单测（E-2）：isLoopbackHost 环回判定 + leaksBearerOverPlaintext 明文 Bearer 泄漏判定。
 * 零依赖、零 I/O。
 */
import { isLoopbackHost, leaksBearerOverPlaintext } from '../remote-instance-security';

describe('isLoopbackHost', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['  localhost  ', true],
    ['127.0.0.1', true],
    ['127.1.2.3', true], // 127/8 全段环回
    ['::1', true],
    ['[::1]', true], // 方括号写法
  ])('环回 %s → true', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });

  it.each([
    ['remote.example', false],
    ['192.168.1.1', false], // LAN 非环回
    ['10.0.0.1', false],
    ['0.0.0.0', false], // 通配非环回
    ['8.8.8.8', false],
    ['126.0.0.1', false], // 邻段非 127
    ['128.0.0.1', false],
    ['', false],
  ])('非环回 %s → false', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });

  it('非字符串入参 → false（防御）', () => {
    expect(isLoopbackHost(undefined as unknown as string)).toBe(false);
    expect(isLoopbackHost(null as unknown as string)).toBe(false);
  });
});

describe('leaksBearerOverPlaintext', () => {
  it('非环回 + 无 tls + 有 secret → 泄漏（true）', () => {
    expect(leaksBearerOverPlaintext({ host: 'remote.example', secret: 's' })).toBe(true);
    expect(leaksBearerOverPlaintext({ host: '192.168.1.5', secret: 's' })).toBe(true);
  });

  it('环回 + 无 tls + 有 secret → 不泄漏（h2c 本机合法）', () => {
    expect(leaksBearerOverPlaintext({ host: 'localhost', secret: 's' })).toBe(false);
    expect(leaksBearerOverPlaintext({ host: '127.0.0.1', secret: 's' })).toBe(false);
    expect(leaksBearerOverPlaintext({ host: '::1', secret: 's' })).toBe(false);
  });

  it('非环回 + 有 tls + 有 secret → 不泄漏（TLS 加密）', () => {
    expect(leaksBearerOverPlaintext({ host: 'remote.example', secret: 's', tls: {} })).toBe(false);
    expect(
      leaksBearerOverPlaintext({ host: 'remote.example', secret: 's', tls: { skipVerify: true } })
    ).toBe(false);
  });

  it('非环回 + 无 tls + 无 secret/空 secret → 不泄漏（无凭据）', () => {
    expect(leaksBearerOverPlaintext({ host: 'remote.example' })).toBe(false);
    expect(leaksBearerOverPlaintext({ host: 'remote.example', secret: '' })).toBe(false);
  });
});
