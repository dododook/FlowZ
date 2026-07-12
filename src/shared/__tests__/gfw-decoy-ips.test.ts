/**
 * GFW decoy IP 集匹配单测（R3，§14.4）：v4/v6 decoy 段命中 + 真实 IP 放行 + 非法字节不误杀。纯字节、零 I/O。
 */
import { isDecoyIp } from '../gfw-decoy-ips';

const v4 = (s: string): Uint8Array => Uint8Array.from(s.split('.').map((n) => parseInt(n, 10)));
const v6 = (...groups: number[]): Uint8Array => {
  const b = new Uint8Array(16);
  groups.forEach((g, i) => {
    b[i * 2] = (g >> 8) & 0xff;
    b[i * 2 + 1] = g & 0xff;
  });
  return b;
};

describe('isDecoyIp', () => {
  it('Facebook 31.13.0.0/16 decoy → true', () => expect(isDecoyIp(v4('31.13.95.169'))).toBe(true));
  it('Dropbox 162.125.0.0/16 → true', () => expect(isDecoyIp(v4('162.125.32.7'))).toBe(true));
  it('Twitter 199.59.148.0/22 → true', () => expect(isDecoyIp(v4('199.59.150.40'))).toBe(true));
  it('实测 202.160.128.0/22 → true', () => expect(isDecoyIp(v4('202.160.128.16'))).toBe(true));
  it('实测 185.45.7.0/24 → true', () => expect(isDecoyIp(v4('185.45.7.185'))).toBe(true));
  it('实测 45.114.11.0/24 → true', () => expect(isDecoyIp(v4('45.114.11.25'))).toBe(true));
  it('历史单点 8.7.198.45/32 → true', () => expect(isDecoyIp(v4('8.7.198.45'))).toBe(true));
  it('157.240.0.0/16 (实测 157.240.17.35) → true', () =>
    expect(isDecoyIp(v4('157.240.17.35'))).toBe(true));

  it('真 Google 142.251.x → false', () => expect(isDecoyIp(v4('142.251.155.2'))).toBe(false));
  it('真 Cloudflare 104.18.x → false', () => expect(isDecoyIp(v4('104.18.37.228'))).toBe(false));
  it('/32 单点邻居不误杀（8.7.198.46 ≠ .45）→ false', () =>
    expect(isDecoyIp(v4('8.7.198.46'))).toBe(false));
  it('/22 段外（202.160.132.1 越过 /22）→ false', () =>
    expect(isDecoyIp(v4('202.160.132.1'))).toBe(false));

  it('Facebook v6 2a03:2880::/29 (face:b00c) → true', () =>
    expect(isDecoyIp(v6(0x2a03, 0x2880, 0xf134, 0x0183, 0xface, 0xb00c, 0x0000, 0x25de))).toBe(
      true
    ));
  it('真 Google v6 2001:4860 → false', () =>
    expect(isDecoyIp(v6(0x2001, 0x4860, 0x4826, 0x0200, 0, 0, 0, 0))).toBe(false));
  it('v6 /29 段外（2a03:2888 越过 /29）→ false', () =>
    expect(isDecoyIp(v6(0x2a03, 0x2888, 0, 0, 0, 0, 0, 0))).toBe(false));

  it('非 4/16 字节（畸形 rdata）→ false（不误杀）', () =>
    expect(isDecoyIp(new Uint8Array(3))).toBe(false));
});
