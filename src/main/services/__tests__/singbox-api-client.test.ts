/**
 * singbox-api-client 单测：纯逻辑——Bearer metadata 注入 + clash 等价方法包装 + 订阅 stop 句柄。
 *
 * 不连真 gRPC 服务端：mock @grpc/grpc-js，捕获
 *  - 传给 service 构造器的 target + channel credentials（验恒 insecure，不再 combineChannelCredentials）；
 *  - 每次 unary 调用收到的 per-call metadata（验 authorization: Bearer <secret> / 空 secret 无头）；
 *  - 每个 RPC 方法收到的请求体（验 selectOutbound/closeConnection/closeAllConnections 字段）；
 *  - 订阅流的开/停（验 subscribeStatus/subscribeConnections 调对方法 + stop 句柄 cancel）。
 * proto-loader 也 mock 成返回一个把所有 RPC 方法挂到 client 上的 ctor，避免真写临时 proto 文件。
 */

// ---- grpc mock 状态（模块级，便于断言）----
interface FakeStream {
  on: jest.Mock;
  cancel: jest.Mock;
  handlers: Record<string, (arg?: unknown) => void>;
}

const mockState: {
  lastTarget: string;
  lastChannelCreds: unknown;
  lastMetadata: FakeMetadata | null;
  lastUnaryOptions: { deadline?: unknown } | null;
  insecureCreds: { __kind: 'insecure' };
  sslCalls: Array<{ rootCerts: unknown; verifyOptions: unknown }>;
  unaryCalls: Array<{ method: string; req: unknown }>;
  streams: FakeStream[];
  closedClients: number;
  // B-1：true 时 unary cb 永不触发（模拟核启动中/wedged：TCP accept 但方法不 serve）。
  hangUnary: boolean;
} = {
  lastTarget: '',
  lastChannelCreds: null,
  lastMetadata: null,
  lastUnaryOptions: null,
  insecureCreds: { __kind: 'insecure' },
  sslCalls: [],
  unaryCalls: [],
  streams: [],
  closedClients: 0,
  hangUnary: false,
};

class FakeMetadata {
  store: Record<string, string> = {};
  set(k: string, v: string): void {
    this.store[k.toLowerCase()] = v;
  }
}

function makeFakeStream(): FakeStream {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  return {
    handlers,
    on: jest.fn((evt: string, cb: (arg?: unknown) => void) => {
      handlers[evt] = cb;
    }),
    cancel: jest.fn(),
  };
}

// fake service client：把 7 个 RPC 方法挂上去。unary 用 cb 回调、stream 返回 FakeStream。
function makeFakeClientCtor() {
  return jest.fn().mockImplementation((target: string, creds: unknown) => {
    mockState.lastTarget = target;
    mockState.lastChannelCreds = creds;
    // unary 签名 4 参 (req, md, options, cb)——options 携带 gRPC CallOptions（含 deadline，B-1）。
    const unary =
      (method: string) =>
      (req: unknown, md: unknown, options: { deadline?: unknown }, cb: (err: unknown) => void) => {
        mockState.unaryCalls.push({ method, req });
        mockState.lastMetadata = md as FakeMetadata;
        mockState.lastUnaryOptions = options;
        if (mockState.hangUnary) {
          // 模拟 gRPC deadline 语义：服务端不响应，但带了 deadline → 到期 gRPC 用 DEADLINE_EXCEEDED 回调（必 settle）。
          // 无 deadline（旧行为）则永不回调（promise 永挂）。用真定时器在 deadline 时刻触发。
          const dl = options?.deadline;
          if (dl instanceof Date) {
            const ms = Math.max(0, dl.getTime() - Date.now());
            setTimeout(() => cb({ code: 4, details: 'Deadline exceeded' }), ms);
          }
          return; // 无 deadline：不回调（hang）
        }
        cb(null);
      };
    const stream = () => {
      const s = makeFakeStream();
      mockState.streams.push(s);
      return s;
    };
    return {
      SubscribeTailscaleStatus: stream,
      TailscaleLogout: unary('TailscaleLogout'),
      SubscribeStatus: stream,
      SubscribeConnections: stream,
      SelectOutbound: unary('SelectOutbound'),
      CloseConnection: unary('CloseConnection'),
      CloseAllConnections: unary('CloseAllConnections'),
      close: jest.fn(() => {
        mockState.closedClients++;
      }),
    };
  });
}

jest.mock('@grpc/grpc-js', () => {
  const Metadata = FakeMetadata;
  return {
    Metadata,
    credentials: {
      createInsecure: () => mockState.insecureCreds,
      // createSsl(rootCerts?, privateKey?, certChain?, verifyOptions?)：捕获 rootCerts + verifyOptions 供断言。
      createSsl: (rootCerts: unknown, _pk: unknown, _cc: unknown, verifyOptions: unknown) => {
        const creds = { __kind: 'ssl' as const, rootCerts, verifyOptions };
        mockState.sslCalls.push({ rootCerts, verifyOptions });
        return creds;
      },
    },
    loadPackageDefinition: () => ({
      daemon: { StartedService: makeFakeClientCtor() },
    }),
  };
});

jest.mock('@grpc/proto-loader', () => ({
  loadSync: () => ({}),
}));

// 临时 proto 写盘也 stub 掉（不实际写文件）。existsSync 返 false → 走写盘分支（getServiceCtor 已存在即跳过写盘）。
jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  writeFileSync: jest.fn(),
}));

import { SingBoxApiClient } from '../singbox-api-client';

const ENDPOINT = { host: '127.0.0.1', port: 9091 };

beforeEach(() => {
  mockState.lastTarget = '';
  mockState.lastChannelCreds = null;
  mockState.lastMetadata = null;
  mockState.lastUnaryOptions = null;
  mockState.sslCalls = [];
  mockState.unaryCalls = [];
  mockState.streams = [];
  mockState.closedClients = 0;
  mockState.hangUnary = false;
});

describe('Bearer metadata 注入', () => {
  it('secret 非空 → 每调用 metadata 带 authorization: Bearer <secret>（per-call，非 channel creds）', async () => {
    const client = new SingBoxApiClient(ENDPOINT, 'topsecret');
    // 触发一次 unary（每调用 attach authMetadata）
    await client.closeAllConnections();

    // 通道恒 insecure（不再 combineChannelCredentials——h2c 下实测抛）；认证走 per-call metadata
    expect(mockState.lastChannelCreds).toBe(mockState.insecureCreds);
    expect(mockState.lastMetadata?.store['authorization']).toBe('Bearer topsecret');
  });

  it('secret 为空 → metadata 无 authorization（免认证退化），通道恒 insecure', async () => {
    const client = new SingBoxApiClient(ENDPOINT, '');
    await client.closeAllConnections();

    expect(mockState.lastChannelCreds).toBe(mockState.insecureCreds);
    expect(mockState.lastMetadata?.store['authorization']).toBeUndefined();
  });

  it('target = <host>:<port>（host 参数化，Phase 2 远程预留）', async () => {
    const client = new SingBoxApiClient({ host: '10.0.0.5', port: 1234 }, 's');
    await client.closeAllConnections();
    expect(mockState.lastTarget).toBe('10.0.0.5:1234');
  });

  // F4：裸 IPv6 字面量须方括号包裹，否则 '::1:9090' 是非法 gRPC target。
  it('裸 IPv6 字面量 → 方括号包裹的 target（[::1]:9090）', async () => {
    const client = new SingBoxApiClient({ host: '::1', port: 9090 }, 's');
    await client.closeAllConnections();
    expect(mockState.lastTarget).toBe('[::1]:9090');
  });

  it('已带方括号的 IPv6 → 不重复加括号', async () => {
    const client = new SingBoxApiClient({ host: '[2001:db8::1]', port: 443 }, 's');
    await client.closeAllConnections();
    expect(mockState.lastTarget).toBe('[2001:db8::1]:443');
  });

  // R3-1：IPv4-mapped IPv6（'::ffff:1.2.3.4'）含 '.'，isIpv6Literal 误判 false；改按是否含 ':' 判定后须包裹。
  it('IPv4-mapped IPv6 字面量 → 方括号包裹（[::ffff:1.2.3.4]:port）', async () => {
    const client = new SingBoxApiClient({ host: '::ffff:1.2.3.4', port: 9090 }, 's');
    await client.closeAllConnections();
    expect(mockState.lastTarget).toBe('[::ffff:1.2.3.4]:9090');
  });

  it('IPv4 / 域名 → target 不变（不误包裹）', async () => {
    const v4 = new SingBoxApiClient({ host: '127.0.0.1', port: 9091 }, 's');
    await v4.closeAllConnections();
    expect(mockState.lastTarget).toBe('127.0.0.1:9091');

    const dn = new SingBoxApiClient({ host: 'remote.example', port: 8443 }, 's');
    await dn.closeAllConnections();
    expect(mockState.lastTarget).toBe('remote.example:8443');
  });
});

describe('clash 等价方法包装', () => {
  it('selectOutbound(group, out) → SelectOutbound{groupTag, outboundTag}', async () => {
    const client = new SingBoxApiClient(ENDPOINT, 's');
    await client.selectOutbound('PROXY', 'hk-01');
    expect(mockState.unaryCalls).toContainEqual({
      method: 'SelectOutbound',
      req: { groupTag: 'PROXY', outboundTag: 'hk-01' },
    });
  });

  it('closeConnection(id) → CloseConnection{id}', async () => {
    const client = new SingBoxApiClient(ENDPOINT, 's');
    await client.closeConnection('conn-42');
    expect(mockState.unaryCalls).toContainEqual({
      method: 'CloseConnection',
      req: { id: 'conn-42' },
    });
  });

  it('closeAllConnections() → CloseAllConnections{}', async () => {
    const client = new SingBoxApiClient(ENDPOINT, 's');
    await client.closeAllConnections();
    expect(mockState.unaryCalls).toContainEqual({ method: 'CloseAllConnections', req: {} });
  });

  it('unary 调用后关闭独立连接（client.close）', async () => {
    const client = new SingBoxApiClient(ENDPOINT, 's');
    await client.selectOutbound('g', 'o');
    expect(mockState.closedClients).toBe(1);
  });
});

describe('订阅流（subscribeStatus / subscribeConnections）', () => {
  it('subscribeStatus 推送经回调透传 Status，stop 句柄 cancel 流', () => {
    const client = new SingBoxApiClient(ENDPOINT, 's');
    const seen: unknown[] = [];
    const stop = client.subscribeStatus(1_000_000, (st) => seen.push(st));

    expect(mockState.streams).toHaveLength(1);
    const stream = mockState.streams[0];
    // 模拟一帧 Status
    stream.handlers['data']?.({ memory: '1024', goroutines: 12 });
    expect(seen).toEqual([{ memory: '1024', goroutines: 12 }]);

    stop();
    expect(stream.cancel).toHaveBeenCalled();
  });

  it('subscribeConnections 透传 ConnectionEvents，stop 后 data 不再透传', () => {
    const client = new SingBoxApiClient(ENDPOINT, 's');
    const seen: unknown[] = [];
    const stop = client.subscribeConnections(2_000_000, (ev) => seen.push(ev));

    const stream = mockState.streams[0];
    stream.handlers['data']?.({ events: [{ type: 'NEW', id: 'c1' }], reset: false });
    expect(seen).toHaveLength(1);

    stop();
    // stop 后再来一帧（best-effort 在途帧）不应透传
    stream.handlers['data']?.({ events: [], reset: true });
    expect(seen).toHaveLength(1);
  });
});

describe('远程 TLS 通道凭据（Phase 2）', () => {
  it('无 tls（本地）→ createInsecure（h2c），不走 createSsl', async () => {
    const client = new SingBoxApiClient({ host: '127.0.0.1', port: 9090 }, 's');
    await client.closeAllConnections();
    expect(mockState.lastChannelCreds).toBe(mockState.insecureCreds);
    expect(mockState.sslCalls).toHaveLength(0);
  });

  it('tls={}（无 CA、不跳过）→ createSsl(rootCerts=undefined)：用系统默认 CA 链验证', async () => {
    const client = new SingBoxApiClient({ host: 'remote.example', port: 443, tls: {} }, 's');
    await client.closeAllConnections();
    expect(mockState.sslCalls).toHaveLength(1);
    expect(mockState.sslCalls[0].rootCerts).toBeUndefined();
    expect(mockState.sslCalls[0].verifyOptions).toBeUndefined();
  });

  it('tls.ca → createSsl(rootCerts=该 CA 的 Buffer)（自签证书校验）', async () => {
    const ca = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';
    const client = new SingBoxApiClient({ host: 'remote.example', port: 443, tls: { ca } }, 's');
    await client.closeAllConnections();
    expect(mockState.sslCalls).toHaveLength(1);
    const root = mockState.sslCalls[0].rootCerts as Buffer;
    expect(Buffer.isBuffer(root)).toBe(true);
    expect(root.toString('utf-8')).toBe(ca);
    expect(mockState.sslCalls[0].verifyOptions).toBeUndefined();
  });

  it('tls.skipVerify → createSsl 带 checkServerIdentity no-op（放过 SAN/hostname）+ rootCerts 兜底空 Buffer', async () => {
    const client = new SingBoxApiClient(
      { host: 'self-signed.example', port: 443, tls: { skipVerify: true } },
      's'
    );
    await client.closeAllConnections();
    expect(mockState.sslCalls).toHaveLength(1);
    const vo = mockState.sslCalls[0].verifyOptions as { checkServerIdentity?: () => unknown };
    expect(typeof vo?.checkServerIdentity).toBe('function');
    // no-op 返回 undefined（不抛 = 接受）
    expect(vo.checkServerIdentity!()).toBeUndefined();
    const root = mockState.sslCalls[0].rootCerts as Buffer;
    expect(Buffer.isBuffer(root)).toBe(true);
    expect(root.length).toBe(0);
  });

  it('远程 TLS + Bearer：target 用远端 host:port，per-call metadata 仍带 Bearer', async () => {
    const client = new SingBoxApiClient(
      { host: 'remote.example', port: 8443, tls: {} },
      'remote-secret'
    );
    await client.closeAllConnections();
    expect(mockState.lastTarget).toBe('remote.example:8443');
    expect(mockState.lastMetadata?.store['authorization']).toBe('Bearer remote-secret');
  });
});

describe('probe 连通探活（Phase 2 连通测试）', () => {
  it('首帧 → resolve（开 SubscribeStatus 流，收 data 即通），并 cancel 流', async () => {
    const client = new SingBoxApiClient({ host: 'r', port: 1, tls: {} }, 's');
    const p = client.probe(1000);
    const stream = mockState.streams[0];
    expect(stream).toBeDefined();
    stream.handlers['data']?.({ memory: '1' });
    await expect(p).resolves.toBeUndefined();
    expect(stream.cancel).toHaveBeenCalled();
  });

  it('流 error → reject（鉴权失败/TLS 握手失败/拒连）', async () => {
    const client = new SingBoxApiClient({ host: 'r', port: 1, tls: {} }, 's');
    const p = client.probe(1000);
    const stream = mockState.streams[0];
    stream.handlers['error']?.(new Error('16 UNAUTHENTICATED'));
    await expect(p).rejects.toThrow('UNAUTHENTICATED');
  });
});

// B-1：unary（CloseConnection/CloseAllConnections/SelectOutbound/logout）必须带 gRPC deadline，
// 否则核启动中/wedged 时 server 不回调 → promise 永挂 → 连接页 Close 按钮永久 spinner。
describe('unary deadline 保证 promise 必 settle（B-1）', () => {
  it('unary 调用携带 deadline（绝对时间 Date，~2s 后）', async () => {
    const client = new SingBoxApiClient(ENDPOINT, 's');
    const before = Date.now();
    await client.closeAllConnections();
    const dl = mockState.lastUnaryOptions?.deadline;
    expect(dl instanceof Date).toBe(true);
    const ms = (dl as Date).getTime() - before;
    // 对齐旧 ClashApiClient 的 2000ms；留宽容窗口（执行抖动）。
    expect(ms).toBeGreaterThanOrEqual(1500);
    expect(ms).toBeLessThanOrEqual(2500);
  });

  it('server 不响应（核启动中/wedged）：带 deadline → 到期 reject（必 settle，不永挂）', async () => {
    jest.useFakeTimers();
    try {
      mockState.hangUnary = true;
      const client = new SingBoxApiClient(ENDPOINT, 's');
      const p = client.closeConnection('conn-x');
      // promise 挂起一个断言（rejects），推进时间越过 deadline → gRPC DEADLINE_EXCEEDED 回调触发 reject。
      const assertion = expect(p).rejects.toMatchObject({ code: 4 });
      await jest.advanceTimersByTimeAsync(2100);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('logout 同带 deadline，server 不响应时亦 settle（不永挂）', async () => {
    jest.useFakeTimers();
    try {
      mockState.hangUnary = true;
      const client = new SingBoxApiClient(ENDPOINT, 's');
      const p = client.logout('node-tag');
      const assertion = expect(p).rejects.toMatchObject({ code: 4 });
      await jest.advanceTimersByTimeAsync(2100);
      await assertion;
      // logout 也传了 deadline（Date）
      expect(mockState.lastUnaryOptions?.deadline instanceof Date).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('正常响应路径不受影响（cb(null) → resolve）', async () => {
    const client = new SingBoxApiClient(ENDPOINT, 's');
    await expect(client.selectOutbound('g', 'o')).resolves.toBeUndefined();
  });
});
