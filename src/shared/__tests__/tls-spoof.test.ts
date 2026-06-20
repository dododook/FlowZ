/**
 * TLS spoof（P3a 抗审查）门控/枚举单一真值的单测。
 * 锁死：方法枚举（与 sing-box check 实证一致）+ arch 门控（ARM64 不支持）+ 协议门控（QUIC/naive 排除）。
 */
import {
  TLS_SPOOF_METHODS,
  isValidTlsSpoofMethod,
  isTlsSpoofSupportedArch,
  isTlsSpoofSupportedProtocol,
} from '../tls-spoof';

describe('TLS spoof 方法枚举', () => {
  it('恰为 sing-box 1.14 实证的三个合法方法（wrong- 前缀）', () => {
    expect([...TLS_SPOOF_METHODS]).toEqual(['wrong-ack', 'wrong-md5', 'wrong-timestamp']);
  });

  it('isValidTlsSpoofMethod 仅认这三个；裸 md5/timestamp 与空值不认', () => {
    expect(isValidTlsSpoofMethod('wrong-ack')).toBe(true);
    expect(isValidTlsSpoofMethod('wrong-md5')).toBe(true);
    expect(isValidTlsSpoofMethod('wrong-timestamp')).toBe(true);
    // 设计文档简写 md5/timestamp 实测非法，必须带 wrong- 前缀
    expect(isValidTlsSpoofMethod('md5')).toBe(false);
    expect(isValidTlsSpoofMethod('timestamp')).toBe(false);
    expect(isValidTlsSpoofMethod('ack')).toBe(false);
    expect(isValidTlsSpoofMethod(undefined)).toBe(false);
    expect(isValidTlsSpoofMethod('')).toBe(false);
  });
});

describe('isTlsSpoofSupportedArch（ARM64 不支持）', () => {
  it('amd64 系（x64/ia32/x86）支持', () => {
    expect(isTlsSpoofSupportedArch('x64')).toBe(true);
    expect(isTlsSpoofSupportedArch('ia32')).toBe(true);
    expect(isTlsSpoofSupportedArch('X64')).toBe(true); // 大小写不敏感
  });

  it('arm / arm64 / aarch64 不支持', () => {
    expect(isTlsSpoofSupportedArch('arm64')).toBe(false);
    expect(isTlsSpoofSupportedArch('arm')).toBe(false);
    expect(isTlsSpoofSupportedArch('aarch64')).toBe(false);
    expect(isTlsSpoofSupportedArch('ARM64')).toBe(false);
  });

  it('arch 缺失（空/undefined）保守置不支持', () => {
    expect(isTlsSpoofSupportedArch(undefined)).toBe(false);
    expect(isTlsSpoofSupportedArch('')).toBe(false);
  });
});

describe('isTlsSpoofSupportedProtocol（仅标准 TCP-TLS 栈）', () => {
  it('TCP-TLS 协议支持', () => {
    for (const p of ['vless', 'vmess', 'trojan', 'http', 'anytls', 'shadowsocks']) {
      expect(isTlsSpoofSupportedProtocol(p)).toBe(true);
    }
  });

  it('QUIC 内 TLS（hy2/tuic）与 Cronet 自管（naive）排除', () => {
    expect(isTlsSpoofSupportedProtocol('hysteria2')).toBe(false);
    expect(isTlsSpoofSupportedProtocol('tuic')).toBe(false);
    expect(isTlsSpoofSupportedProtocol('naive')).toBe(false);
    expect(isTlsSpoofSupportedProtocol('Hysteria2')).toBe(false); // 大小写不敏感
  });
});
