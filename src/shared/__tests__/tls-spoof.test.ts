/**
 * TLS spoof（P3a 抗审查）门控/枚举单一真值的单测。
 * 锁死：方法枚举（与 sing-box check 实证一致）+ arch 门控（ARM64 不支持）+ 协议门控（QUIC/naive 排除）。
 */
import {
  TLS_SPOOF_METHODS,
  isValidTlsSpoofMethod,
  isTlsSpoofSupportedArch,
  isTlsSpoofSupportedProtocol,
  validateTlsSpoof,
} from '../tls-spoof';
import { isIpLiteral } from '../dns';

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

describe('validateTlsSpoof — 真 server_name 为 IP 字面量拦截（第 7 门控）', () => {
  const ARCH = 'x64'; // 支持 arch，隔离本项判定
  it('传入的真 server_name 是 IPv4 字面量 → false（不下发，防内核 init FATAL）', () => {
    expect(
      validateTlsSpoof('decoy.microsoft.com', 'wrong-ack', ARCH, isIpLiteral, {
        protocol: 'trojan',
        serverSni: '198.51.100.7',
      })
    ).toBe(false);
  });

  it('传入的真 server_name 是 IPv6 字面量 → false', () => {
    expect(
      validateTlsSpoof('decoy.microsoft.com', 'wrong-ack', ARCH, isIpLiteral, {
        protocol: 'trojan',
        serverSni: '2001:db8::1',
      })
    ).toBe(false);
  });

  it('真 server_name 是域名 → true（其余门控满足）', () => {
    expect(
      validateTlsSpoof('decoy.microsoft.com', 'wrong-ack', ARCH, isIpLiteral, {
        protocol: 'trojan',
        serverSni: 'real.example.com',
      })
    ).toBe(true);
  });

  it('route action 场景：不传 serverSni → 天然跳过第 7 门控（IP 上下文不适用）', () => {
    expect(validateTlsSpoof('decoy.microsoft.com', 'wrong-ack', ARCH, isIpLiteral)).toBe(true);
  });
});
