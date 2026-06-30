/**
 * xray-import 单测（node env，零 electron）。覆盖 vmess/vless/trojan/shadowsocks 映射 +
 * streamSettings(tls/reality/ws/grpc) + 不支持协议跳过 + 内部协议忽略 + 缺字段失败。
 */
import { parseXrayOutbounds } from '../xray-import';

const NOW = '2026-06-30T00:00:00.000Z';

describe('parseXrayOutbounds', () => {
  it('vmess + ws + tls → ServerConfig', () => {
    const r = parseXrayOutbounds(
      [
        {
          protocol: 'vmess',
          tag: 'vm1',
          settings: {
            vnext: [
              {
                address: '1.2.3.4',
                port: 443,
                users: [{ id: 'uuid-1', alterId: 2, security: 'auto' }],
              },
            ],
          },
          streamSettings: {
            network: 'ws',
            security: 'tls',
            wsSettings: { path: '/p', headers: { Host: 'h.com' } },
            tlsSettings: { serverName: 'h.com', fingerprint: 'chrome' },
          },
        },
      ],
      NOW
    );
    expect(r.servers).toHaveLength(1);
    const s = r.servers[0];
    expect(s.protocol).toBe('vmess');
    expect(s.address).toBe('1.2.3.4');
    expect(s.port).toBe(443);
    expect(s.uuid).toBe('uuid-1');
    expect(s.alterId).toBe(2);
    expect(s.network).toBe('ws');
    expect(s.security).toBe('tls');
    expect(s.wsSettings?.path).toBe('/p');
    expect(s.wsSettings?.headers?.Host).toBe('h.com');
    expect(s.tlsSettings?.serverName).toBe('h.com');
  });

  it('vless + reality + grpc → flow + realitySettings + grpc', () => {
    const r = parseXrayOutbounds(
      [
        {
          protocol: 'vless',
          tag: 'vl1',
          settings: {
            vnext: [
              {
                address: '5.6.7.8',
                port: 8443,
                users: [{ id: 'uuid-2', flow: 'xtls-rprx-vision' }],
              },
            ],
          },
          streamSettings: {
            network: 'grpc',
            security: 'reality',
            grpcSettings: { serviceName: 'grpc-svc' },
            realitySettings: { publicKey: 'pk', shortId: 'sid', serverName: 'sni.com' },
          },
        },
      ],
      NOW
    );
    expect(r.servers).toHaveLength(1);
    const s = r.servers[0];
    expect(s.protocol).toBe('vless');
    expect(s.uuid).toBe('uuid-2');
    expect(s.flow).toBe('xtls-rprx-vision');
    expect(s.network).toBe('grpc');
    expect(s.grpcSettings?.serviceName).toBe('grpc-svc');
    expect(s.security).toBe('reality');
    expect(s.realitySettings?.publicKey).toBe('pk');
    expect(s.realitySettings?.shortId).toBe('sid');
  });

  it('trojan + shadowsocks 映射凭据', () => {
    const r = parseXrayOutbounds(
      [
        {
          protocol: 'trojan',
          tag: 't1',
          settings: { servers: [{ address: 'a.com', port: 443, password: 'pw' }] },
        },
        {
          protocol: 'shadowsocks',
          tag: 'ss1',
          settings: {
            servers: [{ address: 'b.com', port: 8388, method: 'aes-256-gcm', password: 'sspw' }],
          },
        },
      ],
      NOW
    );
    expect(r.servers).toHaveLength(2);
    const trojan = r.servers.find((s) => s.protocol === 'trojan')!;
    expect(trojan.password).toBe('pw');
    const ss = r.servers.find((s) => s.protocol === 'shadowsocks')!;
    expect(ss.shadowsocksSettings?.method).toBe('aes-256-gcm');
    expect(ss.shadowsocksSettings?.password).toBe('sspw');
  });

  it('不支持协议计 skipped；内部协议(freedom) 忽略不计', () => {
    const r = parseXrayOutbounds(
      [
        { protocol: 'socks', tag: 's', settings: { servers: [{ address: 'x', port: 1 }] } },
        { protocol: 'freedom', tag: 'direct' },
        { protocol: 'blackhole', tag: 'block' },
      ],
      NOW
    );
    expect(r.servers).toHaveLength(0);
    expect(r.skipped).toBe(1); // 仅 socks，freedom/blackhole 不计
  });

  it('缺必填字段 → failed，不产出节点', () => {
    const r = parseXrayOutbounds(
      [
        {
          protocol: 'vmess',
          tag: 'bad',
          settings: { vnext: [{ address: '1.1.1.1', port: 443, users: [{}] }] },
        },
      ],
      NOW
    );
    expect(r.servers).toHaveLength(0);
    expect(r.failed).toBe(1);
  });

  it('非数组 → 空结果', () => {
    const r = parseXrayOutbounds(undefined, NOW);
    expect(r.servers).toHaveLength(0);
    expect(r.skipped).toBe(0);
    expect(r.failed).toBe(0);
  });
});
