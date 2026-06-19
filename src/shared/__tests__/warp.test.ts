import {
  reservedFromClientId,
  splitEndpoint,
  buildRegisterBody,
  parseRegisterResponse,
  buildUnregisterRequest,
  classifyDeregisterResult,
  enqueuePendingDeregister,
  planDeregisterDrain,
  WARP_API_BASE,
  WARP_USER_AGENT,
  WARP_CLIENT_VERSION,
  WARP_DEREGISTER_MAX_AGE_MS,
  WARP_DEREGISTER_MAX_QUEUE,
  WARP_DEREGISTER_MAX_PER_DRAIN,
  WARP_DEFAULT_ENDPOINT_HOST,
  WARP_DEFAULT_ENDPOINT_PORT,
  type PendingDeregisterEntry,
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

// ── 设备注销 / 待注销队列 ──────────────────────────────────────────────

describe('buildUnregisterRequest', () => {
  it('裸 DELETE /{version}/reg/{deviceId} + Bearer + UA/CF-Client-Version', () => {
    const { url, headers } = buildUnregisterRequest('v0a2158', 'dev-123', 'tok-abc');
    expect(url).toBe(`${WARP_API_BASE}/v0a2158/reg/dev-123`);
    expect(headers.Authorization).toBe('Bearer tok-abc');
    expect(headers['User-Agent']).toBe(WARP_USER_AGENT);
    expect(headers['CF-Client-Version']).toBe(WARP_CLIENT_VERSION);
  });
  it('版本段随入参（应对 CF 版本滚动）', () => {
    expect(buildUnregisterRequest('v9x9', 'd', 't').url).toBe(`${WARP_API_BASE}/v9x9/reg/d`);
  });
});

describe('classifyDeregisterResult（全矩阵）', () => {
  it('204 / 404 → done（已注销 / 别处已销）', () => {
    expect(classifyDeregisterResult(204)).toBe('done');
    expect(classifyDeregisterResult(404)).toBe('done');
  });
  it('401 / 403 → drop（token 死，重试浪费）', () => {
    expect(classifyDeregisterResult(401)).toBe('drop');
    expect(classifyDeregisterResult(403)).toBe('drop');
  });
  it('网络失败/超时(null) → retry', () => {
    expect(classifyDeregisterResult(null)).toBe('retry');
    expect(classifyDeregisterResult(null, new Error('ETIMEDOUT'))).toBe('retry');
  });
  it('5xx / 400 → retry（暂时不可达 / 待版本升级）', () => {
    expect(classifyDeregisterResult(500)).toBe('retry');
    expect(classifyDeregisterResult(502)).toBe('retry');
    expect(classifyDeregisterResult(503)).toBe('retry');
    expect(classifyDeregisterResult(400)).toBe('retry');
  });
  it('含 1020（WAF/版本失效）→ retry', () => {
    expect(classifyDeregisterResult(403, new Error('WARP API 403: error 1020'))).toBe('retry');
    // err 文本里带 1020，即便状态码非典型也 retry
    expect(classifyDeregisterResult(429, { message: 'code 1020' })).toBe('retry');
  });
  it('其它未知 4xx（非 1020）→ drop（非暂时性，不无限占预算）', () => {
    expect(classifyDeregisterResult(429)).toBe('drop');
    expect(classifyDeregisterResult(410)).toBe('drop');
  });
});

describe('enqueuePendingDeregister（MAX_QUEUE 丢最旧）', () => {
  const mk = (id: string, at = 0): PendingDeregisterEntry => ({
    deviceId: id,
    token: `t-${id}`,
    enqueuedAt: at,
  });

  it('未满 → 追加，无丢弃', () => {
    const { queue, dropped } = enqueuePendingDeregister([mk('a'), mk('b')], mk('c'));
    expect(queue.map((e) => e.deviceId)).toEqual(['a', 'b', 'c']);
    expect(dropped).toEqual([]);
  });
  it('超 MAX_QUEUE → 丢最旧（FIFO），长度封顶', () => {
    const full = Array.from({ length: WARP_DEREGISTER_MAX_QUEUE }, (_, i) => mk(`d${i}`));
    const { queue, dropped } = enqueuePendingDeregister(full, mk('new'));
    expect(queue.length).toBe(WARP_DEREGISTER_MAX_QUEUE);
    expect(dropped.map((e) => e.deviceId)).toEqual(['d0']); // 最旧被挤掉
    expect(queue[queue.length - 1].deviceId).toBe('new'); // 新条目在队尾
    expect(queue[0].deviceId).toBe('d1');
  });
});

describe('planDeregisterDrain（年龄 + MAX_PER_DRAIN 截断）', () => {
  const NOW = 10_000_000_000;
  const mk = (id: string, ageMs: number): PendingDeregisterEntry => ({
    deviceId: id,
    token: `t-${id}`,
    enqueuedAt: NOW - ageMs,
  });

  it('超 7 天 → expire（不调网络）；在龄 → eligible', () => {
    const queue = [
      mk('old', WARP_DEREGISTER_MAX_AGE_MS + 1),
      mk('fresh', WARP_DEREGISTER_MAX_AGE_MS - 1),
    ];
    const { plan, deferred } = planDeregisterDrain(queue, NOW);
    expect(plan.find((p) => p.entry.deviceId === 'old')?.action).toBe('expire');
    expect(plan.find((p) => p.entry.deviceId === 'fresh')?.action).toBe('eligible');
    expect(deferred).toEqual([]);
  });

  it('恰好 7 天（边界）不算超龄 → eligible（> 才超）', () => {
    const { plan } = planDeregisterDrain([mk('edge', WARP_DEREGISTER_MAX_AGE_MS)], NOW);
    expect(plan[0].action).toBe('eligible');
  });

  it('eligible 至多 MAX_PER_DRAIN 条，余下 deferred（留队，不动）', () => {
    const queue = Array.from({ length: WARP_DEREGISTER_MAX_PER_DRAIN + 3 }, (_, i) =>
      mk(`e${i}`, 1000)
    );
    const { plan, deferred } = planDeregisterDrain(queue, NOW);
    expect(plan.filter((p) => p.action === 'eligible').length).toBe(WARP_DEREGISTER_MAX_PER_DRAIN);
    expect(deferred.length).toBe(3);
  });

  it('expire 不占 MAX_PER_DRAIN 预算（超龄直接计划 expire，不挤掉在龄的处理名额）', () => {
    // 前置一批超龄 + 后置 MAX_PER_DRAIN 条在龄 → 在龄全应 eligible，超龄全 expire，无 deferred。
    const expired = Array.from({ length: 5 }, (_, i) =>
      mk(`x${i}`, WARP_DEREGISTER_MAX_AGE_MS + 1000)
    );
    const fresh = Array.from({ length: WARP_DEREGISTER_MAX_PER_DRAIN }, (_, i) =>
      mk(`f${i}`, 1000)
    );
    const { plan, deferred } = planDeregisterDrain([...expired, ...fresh], NOW);
    expect(plan.filter((p) => p.action === 'expire').length).toBe(5);
    expect(plan.filter((p) => p.action === 'eligible').length).toBe(WARP_DEREGISTER_MAX_PER_DRAIN);
    expect(deferred.length).toBe(0);
  });
});
