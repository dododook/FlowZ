/**
 * trimConnection 单测：gRPC SingBoxConnection → ConnectionEntry（§3-B clash_api 轮询迁 gRPC 流后的字段映射）。
 * 验证连接信息页所需扩展字段（network/type/sourceIP/sourcePort/destinationPort/processPath + upload/download/start）
 * 由 gRPC 字段正确映射带出，且 topology 原有字段（id/chains/rule/metadata.host/destinationIP）保持。
 * 字段映射：chainList→chains, domain→host, source/destination 拆 ip:port, uplinkTotal/downlinkTotal→upload/download,
 * createdAt(ns)→start(RFC3339), processInfo.processPath→processPath, inboundType→type。
 */
import { trimConnection } from '../StatsService';
import type { SingBoxConnection } from '../singbox-api-client';

// 对照 sing-box 1.14 管理 API SubscribeConnections 单条 Connection（longs=String → int64 字段为 string）。
const RAW: SingBoxConnection = {
  id: 'conn-1',
  inbound: 'mixed-in',
  inboundType: 'Tun',
  network: 'tcp',
  source: '192.168.1.10:54321',
  destination: '93.184.216.34:443',
  domain: 'example.com',
  rule: 'rule_set=>proxy',
  chainList: ['proxy-selector', 'hk-node'],
  uplinkTotal: '12345',
  downlinkTotal: '67890',
  // 2026-06-13T10:00:00.000Z 的 unix 纳秒（毫秒 1781258400000 × 1e6）。
  createdAt: String(Date.parse('2026-06-13T10:00:00.000Z') * 1_000_000),
  processInfo: { processPath: '/usr/bin/curl' },
};

describe('trimConnection（gRPC SingBoxConnection → ConnectionEntry）', () => {
  it('带出连接信息页所需扩展字段（gRPC 映射）', () => {
    const e = trimConnection(RAW);
    expect(e.upload).toBe(12345); // ← uplinkTotal
    expect(e.download).toBe(67890); // ← downlinkTotal
    expect(e.start).toBe('2026-06-13T10:00:00.000Z'); // ← createdAt(ns) 转 RFC3339
    expect(e.metadata?.network).toBe('tcp');
    expect(e.metadata?.type).toBe('Tun'); // ← inboundType
    expect(e.metadata?.sourceIP).toBe('192.168.1.10'); // ← 拆 source
    expect(e.metadata?.sourcePort).toBe('54321'); // ← 拆 source
    expect(e.metadata?.destinationIP).toBe('93.184.216.34'); // ← 拆 destination
    expect(e.metadata?.destinationPort).toBe('443'); // ← 拆 destination
    expect(e.metadata?.processPath).toBe('/usr/bin/curl'); // ← processInfo.processPath
  });

  it('保持 topology 原有字段（向后兼容）', () => {
    const e = trimConnection(RAW);
    expect(e.id).toBe('conn-1');
    expect(e.chains).toEqual(['proxy-selector', 'hk-node']); // ← chainList
    expect(e.rule).toBe('rule_set=>proxy');
    expect(e.rulePayload).toBe(''); // gRPC 无 rulePayload，恒空串
    expect(e.metadata?.host).toBe('example.com'); // ← domain
  });

  it('IPv6 source/destination 带方括号正确拆 ip:port', () => {
    const e = trimConnection({
      id: 'v6',
      source: '[fe80::1]:54321',
      destination: '[2606:2800:220:1:248:1893:25c8:1946]:443',
    });
    expect(e.metadata?.sourceIP).toBe('fe80::1');
    expect(e.metadata?.sourcePort).toBe('54321');
    expect(e.metadata?.destinationIP).toBe('2606:2800:220:1:248:1893:25c8:1946');
    expect(e.metadata?.destinationPort).toBe('443');
  });

  it('裸 IPv6（无方括号、无端口）退化为整体当 ip，端口 undefined', () => {
    const e = trimConnection({ id: 'v6bare', destination: 'fe80::1' });
    expect(e.metadata?.destinationIP).toBe('fe80::1');
    expect(e.metadata?.destinationPort).toBeUndefined();
  });

  it('缺失/非法数值字段兜底为 undefined（不产生 NaN）', () => {
    const e = trimConnection({ id: 'x', chainList: [], rule: '' });
    expect(e.upload).toBeUndefined();
    expect(e.download).toBeUndefined();
    expect(e.start).toBeUndefined(); // createdAt 缺失
    // metadata 恒为对象（gRPC 映射不再 undefined），但各字段缺失 → undefined。
    expect(e.metadata?.host).toBeUndefined();
    expect(e.metadata?.sourceIP).toBeUndefined();

    const bad = trimConnection({ id: 'y', uplinkTotal: 'oops', downlinkTotal: undefined });
    expect(bad.upload).toBeUndefined();
    expect(bad.download).toBeUndefined();
  });
});
