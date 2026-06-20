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
  insecureCreds: { __kind: 'insecure' };
  unaryCalls: Array<{ method: string; req: unknown }>;
  streams: FakeStream[];
  closedClients: number;
} = {
  lastTarget: '',
  lastChannelCreds: null,
  lastMetadata: null,
  insecureCreds: { __kind: 'insecure' },
  unaryCalls: [],
  streams: [],
  closedClients: 0,
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
    const unary = (method: string) => (req: unknown, md: unknown, cb: (err: unknown) => void) => {
      mockState.unaryCalls.push({ method, req });
      mockState.lastMetadata = md as FakeMetadata;
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
    },
    loadPackageDefinition: () => ({
      daemon: { StartedService: makeFakeClientCtor() },
    }),
  };
});

jest.mock('@grpc/proto-loader', () => ({
  loadSync: () => ({}),
}));

// 临时 proto 写盘也 stub 掉（不实际写文件）。
jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
}));

import { SingBoxApiClient } from '../singbox-api-client';

const ENDPOINT = { host: '127.0.0.1', port: 9091 };

beforeEach(() => {
  mockState.lastTarget = '';
  mockState.lastChannelCreds = null;
  mockState.lastMetadata = null;
  mockState.unaryCalls = [];
  mockState.streams = [];
  mockState.closedClients = 0;
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
