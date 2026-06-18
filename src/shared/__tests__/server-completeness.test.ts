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
  tailscale: {}, // 账号制：无硬必填项（auth_key 可选）；无 address/port
  custom: { customSettings: { outbound: { type: 'snell' } } as any }, // raw-JSON：须含 type 的 outbound 对象
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

  it('Tailscale 豁免 address/port（账号制）→ 无地址端口仍可启动', () => {
    expect(isServerComplete({ id: 't', name: 'ts', protocol: 'tailscale' } as ServerConfig)).toBe(
      true
    );
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

  it('custom：缺 outbound / 缺 type → 报错；有合法 outbound → 齐备且豁免 address/port', () => {
    expect(protocolRequirementError(node('custom'))).toMatch(/custom/i); // 无 customSettings
    expect(
      protocolRequirementError(node('custom', { customSettings: { outbound: {} } as any }))
    ).toMatch(/type/i); // 缺 type
    // 合法 outbound + 完全无 address/port → 仍可启动（自带 server/port 在 JSON 内）
    expect(
      isServerComplete({
        id: 'c',
        name: 'c',
        protocol: 'custom',
        customSettings: { outbound: { type: 'snell', server: '1.2.3.4', server_port: 8388 } },
      } as unknown as ServerConfig)
    ).toBe(true);
  });

  it('未知协议 → 报错 + 不可启动', () => {
    expect(protocolRequirementError(node('mystery' as Protocol))).toMatch(/unsupported/i);
    expect(isServerComplete(node('mystery' as Protocol))).toBe(false);
  });

  it('WG 关外网且无可路由网段 → 字段虽齐备仍不可启动（空 allowed_ips=FATAL，生成期跳过）', () => {
    const off = node('wireguard', {
      wireguardSettings: {
        privateKey: 'k',
        peerPublicKey: 'pk',
        localAddress: ['10.0.0.2/32'],
        allowedIPs: ['0.0.0.0/0', '::/0'],
        allowInternet: false,
      } as any,
    });
    // 协议必填项齐备（不报错），但 isServerComplete 因不可路由置为 false。
    expect(protocolRequirementError(off)).toBeNull();
    expect(isServerComplete(off)).toBe(false);
    // 补一个具体段 → 可路由、可启动。
    const withSubnet = node('wireguard', {
      wireguardSettings: {
        privateKey: 'k',
        peerPublicKey: 'pk',
        localAddress: ['10.0.0.2/32'],
        allowedIPs: ['10.8.0.0/24'],
        allowInternet: false,
      } as any,
    });
    expect(isServerComplete(withSubnet)).toBe(true);
  });
});
