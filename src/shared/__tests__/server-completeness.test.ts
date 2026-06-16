import { ALL_PROTOCOLS, protocolRequirementError, isServerComplete } from '../server-completeness';
import type { ServerConfig, Protocol } from '../types';

/** 每协议「配置齐备」的最小协议必填字段（与 protocolRequirementError 判据对齐）。 */
const requiredByProtocol: Record<Protocol, Partial<ServerConfig>> = {
  vless: { uuid: 'u' },
  vmess: { uuid: 'u' },
  trojan: { password: 'p' },
  hysteria2: { password: 'p' },
  anytls: { password: 'p' },
  tuic: { uuid: 'u', password: 'p' },
  shadowsocks: { shadowsocksSettings: { method: 'aes-256-gcm', password: 'p' } as any },
  naive: { username: 'u', password: 'p' },
  socks: {},
  http: {},
  ssh: {},
  wireguard: {
    wireguardSettings: {
      privateKey: 'k',
      peerPublicKey: 'pk',
      localAddress: ['10.0.0.2/32'],
    } as any,
  },
};

const node = (protocol: Protocol, extra: Partial<ServerConfig> = {}): ServerConfig =>
  ({ id: 'id-1', name: 'n', protocol, address: '1.2.3.4', port: 443, ...extra }) as ServerConfig;

describe('server-completeness（主/渲染共用单一真值）', () => {
  // drift 护栏：ALL_PROTOCOLS 每个协议，配齐必填后 protocolRequirementError 必须返回 null、
  // isServerComplete 必须 true——漏列协议会在此变红（修 WireGuard/anytls 漂移类 bug 的护栏）。
  it.each(ALL_PROTOCOLS as Protocol[])('完整 %s 节点 → 齐备', (protocol) => {
    expect(protocolRequirementError(node(protocol, requiredByProtocol[protocol]))).toBeNull();
    expect(isServerComplete(node(protocol, requiredByProtocol[protocol]))).toBe(true);
  });

  it('未选/未找到 → 不可启动', () => {
    expect(isServerComplete(undefined)).toBe(false);
    expect(isServerComplete(null)).toBe(false);
  });

  it('缺地址/端口 → 不可启动', () => {
    expect(isServerComplete(node('socks', { address: '' }))).toBe(false);
    expect(isServerComplete(node('socks', { port: 0 }))).toBe(false);
  });

  it('缺协议必填 → 报错信息（抽样）', () => {
    expect(protocolRequirementError(node('vless'))).toMatch(/uuid/i);
    expect(protocolRequirementError(node('trojan'))).toMatch(/password/i);
    expect(protocolRequirementError(node('anytls'))).toMatch(/password/i); // 曾在 validateConfig 漏校验
    expect(protocolRequirementError(node('tuic', { uuid: 'u' }))).toMatch(/password/i);
    expect(
      protocolRequirementError(
        node('wireguard', {
          wireguardSettings: { privateKey: 'k', localAddress: ['10.0.0.2/32'] } as any,
        })
      )
    ).toMatch(/peerPublicKey/i);
  });

  it('未知协议 → 报错 + 不可启动', () => {
    expect(protocolRequirementError(node('mystery' as Protocol))).toMatch(/unsupported/i);
    expect(isServerComplete(node('mystery' as Protocol))).toBe(false);
  });
});
