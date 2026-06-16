import {
  reservedFromClientId,
  splitEndpoint,
  buildRegisterBody,
  parseRegisterResponse,
  WARP_DEFAULT_ENDPOINT_HOST,
  WARP_DEFAULT_ENDPOINT_PORT,
} from '../warp';

describe('reservedFromClientId', () => {
  it('base64 → 前 3 字节十进制', () => {
    expect(reservedFromClientId(Buffer.from([1, 2, 3]).toString('base64'))).toEqual([1, 2, 3]);
    // 多于 3 字节取前 3
    expect(reservedFromClientId(Buffer.from([10, 20, 30, 40]).toString('base64'))).toEqual([
      10, 20, 30,
    ]);
  });
  it('空/不足 3 字节 → undefined', () => {
    expect(reservedFromClientId(undefined)).toBeUndefined();
    expect(reservedFromClientId('')).toBeUndefined();
    expect(reservedFromClientId(Buffer.from([1, 2]).toString('base64'))).toBeUndefined();
  });
});

describe('splitEndpoint', () => {
  it('host:port', () => {
    expect(splitEndpoint('engage.cloudflareclient.com:2408')).toEqual({
      host: 'engage.cloudflareclient.com',
      port: 2408,
    });
  });
  it('[v6]:port', () => {
    expect(splitEndpoint('[2606:4700:d0::a29f:c001]:2408')).toEqual({
      host: '2606:4700:d0::a29f:c001',
      port: 2408,
    });
  });
  it('无端口/空 → WARP 默认', () => {
    expect(splitEndpoint('engage.cloudflareclient.com')).toEqual({
      host: 'engage.cloudflareclient.com',
      port: WARP_DEFAULT_ENDPOINT_PORT,
    });
    expect(splitEndpoint('')).toEqual({
      host: WARP_DEFAULT_ENDPOINT_HOST,
      port: WARP_DEFAULT_ENDPOINT_PORT,
    });
  });
});

describe('buildRegisterBody', () => {
  it('含 key/tos + 固定字段', () => {
    const b = buildRegisterBody('PUBKEYB64', '2026-06-16T00:00:00.000Z');
    expect(b.key).toBe('PUBKEYB64');
    expect(b.tos).toBe('2026-06-16T00:00:00.000Z');
    expect(b.install_id).toBe('');
    expect(b.type).toBe('Android');
  });
});

describe('parseRegisterResponse', () => {
  const ok = {
    id: 'devid',
    token: 'secret-token',
    account: { id: 'acctid', license: 'lic', warp_plus: true },
    config: {
      client_id: Buffer.from([5, 6, 7]).toString('base64'),
      interface: { addresses: { v4: '172.16.0.2', v6: '2606:4700:110::1' } },
      peers: [{ public_key: 'PEERPUB', endpoint: { host: 'engage.cloudflareclient.com:2408' } }],
    },
  };

  it('完整响应 → 提取端点/地址/reserved/meta（不含 token）', () => {
    const r = parseRegisterResponse(ok);
    expect(r.address).toBe('engage.cloudflareclient.com');
    expect(r.port).toBe(2408);
    expect(r.peerPublicKey).toBe('PEERPUB');
    expect(r.localAddress).toEqual(['172.16.0.2/32', '2606:4700:110::1/128']);
    expect(r.reserved).toEqual([5, 6, 7]);
    expect(r.deviceId).toBe('devid');
    expect(r.accountId).toBe('acctid');
    expect(r.warpPlus).toBe(true);
    expect((r as any).token).toBeUndefined();
  });

  it('仅 v4', () => {
    const r = parseRegisterResponse({
      ...ok,
      config: { ...ok.config, interface: { addresses: { v4: '172.16.0.2' } } },
    });
    expect(r.localAddress).toEqual(['172.16.0.2/32']);
  });

  it('缺 peer 公钥 / 端点 / 地址 → 抛错', () => {
    expect(() => parseRegisterResponse({ config: { peers: [] } })).toThrow();
    expect(() =>
      parseRegisterResponse({ config: { peers: [{ endpoint: { host: 'h:1' } }] } })
    ).toThrow();
    expect(() =>
      parseRegisterResponse({
        config: { peers: [{ public_key: 'P', endpoint: { host: 'h:1' } }], interface: {} },
      })
    ).toThrow();
  });
});
