/**
 * stats-worker 单测（batch2 §3.6）：worker 数据面核心——change-driven aggregate、rate-cap、detail 需求门控、
 * connectionsStream 开关订阅、connect 复位。worker 是 utilityProcess 入口模块（顶层即读 process.parentPort、
 * new StatsService、post('ready')），故：mock process.parentPort（捕获 message handler + postMessage）+ StatsService
 * （捕获 onConnections 回调 + resubscribe/stop/setConnectionsStreamEnabled 替身）+ SingBoxApiClient（空壳），并经
 * jest.resetModules + doMock + require 每 test 重载 worker 隔离其 module-level 状态。aggregateConnections/Signature 用
 * 真实实现（要真签名比对）。Date.now 打桩以精确控 rate-cap 窗口。
 */
import type { ConnectionEntry } from '../../../shared/types';

type Posted = { type: string; payload?: unknown; [k: string]: unknown };
type ConnSnap = { connections: ConnectionEntry[]; at: number };

describe('stats-worker (batch2 数据面核心)', () => {
  let posted: Posted[];
  let messageHandler: ((e: { data: unknown }) => void) | null;
  let onConnections: ((snap: ConnSnap) => void) | null;
  let statsMethods: {
    resubscribe: jest.Mock;
    stop: jest.Mock;
    setConnectionsStreamEnabled: jest.Mock;
  };
  let nowVal: number;

  const ENDPOINT = { host: '127.0.0.1', port: 9090, secret: 's', tls: undefined };
  const CONNECT = { type: 'connect', endpoint: ENDPOINT };

  // 造一条假连接：host 决定聚合 host 名，chain 决定 outbound（喂真实 aggregateConnections）。
  const conn = (host: string, chain: string): ConnectionEntry =>
    ({
      id: `${host}-${chain}`,
      chains: [chain],
      rule: '',
      rulePayload: '',
      metadata: { host },
    }) as ConnectionEntry;

  const send = (m: unknown): void => {
    if (!messageHandler) throw new Error('messageHandler 未注册');
    messageHandler({ data: m });
  };
  const fireConn = (connections: ConnectionEntry[]): void => {
    if (!onConnections) throw new Error('onConnections 未捕获');
    onConnections({ connections, at: nowVal });
  };
  const postsOf = (type: string): Posted[] => posted.filter((p) => p.type === type);

  beforeEach(() => {
    posted = [];
    messageHandler = null;
    onConnections = null;
    nowVal = 10_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => nowVal);
    statsMethods = {
      resubscribe: jest.fn(),
      stop: jest.fn(),
      setConnectionsStreamEnabled: jest.fn(),
    };

    // worker 顶层读 process.parentPort → 须在 require 前装替身。
    (process as unknown as { parentPort: unknown }).parentPort = {
      postMessage: (m: Posted) => posted.push(m),
      on: (_ev: string, h: (e: { data: unknown }) => void) => {
        messageHandler = h;
      },
    };

    jest.resetModules();
    jest.doMock('../../services/StatsService', () => ({
      StatsService: jest.fn(
        (_onStats: unknown, _getClient: unknown, onConn: (s: ConnSnap) => void) => {
          onConnections = onConn;
          return statsMethods;
        }
      ),
    }));
    jest.doMock('../../services/singbox-api-client', () => ({
      SingBoxApiClient: jest.fn(() => ({})),
    }));
    require('../stats-worker');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('加载即 post ready + 构造 StatsService（捕获 onConnections）', () => {
    expect(postsOf('ready')).toHaveLength(1);
    expect(typeof onConnections).toBe('function');
  });

  it('connect：复位连接流开关 true + resubscribe + 强制首帧 aggregate 必发', () => {
    send(CONNECT);
    expect(statsMethods.setConnectionsStreamEnabled).toHaveBeenCalledWith(true);
    expect(statsMethods.resubscribe).toHaveBeenCalled();
    // 首帧：lastSentSig=null（!=签名）且 rate-cap（now-0>=2000）→ post aggregate。
    fireConn([conn('a.com', 'P')]);
    expect(postsOf('aggregate')).toHaveLength(1);
  });

  it('change-driven：同签名不 post（仅 at 变的零信息增量被吞）', () => {
    send(CONNECT);
    fireConn([conn('a.com', 'P')]); // 首帧 post
    expect(postsOf('aggregate')).toHaveLength(1);
    nowVal += 5000; // 远超 rate-cap，排除 cap 干扰
    fireConn([conn('a.com', 'P')]); // 同内容 → 签名不变 → 不 post
    expect(postsOf('aggregate')).toHaveLength(1);
  });

  it('rate-cap：内容变但未过 AGG_MIN_INTERVAL_MS(1000) 不 post，过后才 post', () => {
    send(CONNECT);
    fireConn([conn('a.com', 'P')]); // t0 首帧 post，lastSentAt=t0
    expect(postsOf('aggregate')).toHaveLength(1);

    nowVal += 500; // < 1000
    fireConn([conn('a.com', 'P'), conn('b.com', 'Q')]); // 内容变，但未过 cap → 不 post
    expect(postsOf('aggregate')).toHaveLength(1);

    nowVal += 600; // 累计 1100 ≥ 1000
    fireConn([conn('a.com', 'P'), conn('b.com', 'Q')]); // 仍与 lastSentSig 不同 → post
    expect(postsOf('aggregate')).toHaveLength(2);
  });

  it('detail 需求门控：detailDemand=false 不 post detail；setDemand.detail=true 后每帧 post', () => {
    send(CONNECT); // detailDemand 复位 false
    fireConn([conn('a.com', 'P')]);
    expect(postsOf('detail')).toHaveLength(0); // 无需求 → 不跨进程传明细

    send({ type: 'setDemand', connectionsStream: true, detail: true });
    fireConn([conn('a.com', 'P')]); // 即便同内容（aggregate 不 post），detail 仍每帧 post
    expect(postsOf('detail')).toHaveLength(1);
    const payload = postsOf('detail')[0].payload as ConnSnap;
    expect(payload.connections).toHaveLength(1);
    expect(payload.at).toBe(nowVal);
  });

  it('connectionsStream 开关：变化才调 setConnectionsStreamEnabled，未变不调', () => {
    send(CONNECT); // 复位调一次 true
    statsMethods.setConnectionsStreamEnabled.mockClear();

    send({ type: 'setDemand', connectionsStream: false, detail: false }); // true→false
    expect(statsMethods.setConnectionsStreamEnabled).toHaveBeenLastCalledWith(false);

    send({ type: 'setDemand', connectionsStream: false, detail: false }); // 未变 → 不调
    expect(statsMethods.setConnectionsStreamEnabled).toHaveBeenCalledTimes(1);

    send({ type: 'setDemand', connectionsStream: true, detail: false }); // false→true
    expect(statsMethods.setConnectionsStreamEnabled).toHaveBeenLastCalledWith(true);
    expect(statsMethods.setConnectionsStreamEnabled).toHaveBeenCalledTimes(2);
  });

  it('stop：调 stats.stop（不 post 数据帧）', () => {
    send(CONNECT);
    send({ type: 'stop' });
    expect(statsMethods.stop).toHaveBeenCalled();
    expect(postsOf('aggregate')).toHaveLength(0);
    expect(postsOf('detail')).toHaveLength(0);
  });
});
