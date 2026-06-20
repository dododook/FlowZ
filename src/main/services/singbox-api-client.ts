/**
 * sing-box 1.14 管理 API（daemon.StartedService）gRPC 客户端 —— 管理面统一入口（非仅 Tailscale）。
 * 含：Tailscale 状态订阅 + 原生登出，以及 clash 等价管理方法（选节点 / 关连接 / 订阅 Status / 订阅 Connections）。
 * 取代 1.13.x 的「state 目录存在性 + stdout 日志解析」启发式（见 docs/design/tailscale-1.14-management-api.md）。
 *
 * proto 内嵌（避免打包路径依赖）；用本地 `Empty`——空消息 wire 编码为 0 字节，与服务端 google.protobuf.Empty
 * 完全兼容（gRPC 只按 service/method 名 + 字段号对齐，消息类型名不参与 wire）。字段号对齐 sing-box
 * 1.14.0-alpha.32 grpcurl 反射；升级核时若变以反射为准重核。
 *
 * 认证（P0 修复）：api service 注入了 secret（= config.clashApiSecret）时，daemon/server.go 会对每个 RPC 校验
 * metadata `authorization: "Bearer <secret>"`（缺失/不符 → Unauthenticated）。本客户端经 call credentials 把 Bearer
 * 注入到所有 unary + stream 调用；secret 为空时退化为不带 metadata（免认证，本地调试/旧核）。
 *
 * 端点（Phase 2 预留）：构造参数 endpoint = { host, port }，本任务只做本地 h2c（createInsecure）。远程 TLS
 * （channel credentials 换 createSsl + Bearer 仍走 call credentials）留 Phase 2，此处只把 host 参数化、不引入 TLS。
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PROTO_SRC = `
syntax = "proto3";
package daemon;
message Empty {}
service StartedService {
  rpc SubscribeTailscaleStatus(Empty) returns (stream TailscaleStatusUpdate);
  rpc TailscaleLogout(TailscaleLogoutRequest) returns (Empty);
  rpc SubscribeStatus(SubscribeStatusRequest) returns (stream Status);
  rpc SubscribeConnections(SubscribeConnectionsRequest) returns (stream ConnectionEvents);
  rpc SelectOutbound(SelectOutboundRequest) returns (Empty);
  rpc CloseConnection(CloseConnectionRequest) returns (Empty);
  rpc CloseAllConnections(Empty) returns (Empty);
}
message TailscaleStatusUpdate { repeated TailscaleEndpointStatus endpoints = 1; }
message TailscaleEndpointStatus {
  string endpointTag = 1;
  string backendState = 2;
  string authURL = 3;
  TailscalePeer self = 6;
}
message TailscalePeer {
  string hostName = 1;
  repeated string tailscaleIPs = 4;
  bool online = 5;
  int64 keyExpiry = 11;
  string stableID = 12;
  bool expired = 13;
}
message TailscaleLogoutRequest { string endpointTag = 1; }

message SubscribeStatusRequest { int64 interval = 1; }
message Status {
  int64 memory = 1;
  int32 goroutines = 2;
  int32 connectionsIn = 3;
  int32 connectionsOut = 4;
  int64 trafficAvailable = 5;
  int64 uplink = 6;
  int64 downlink = 7;
  int64 uplinkTotal = 8;
  int64 downlinkTotal = 9;
}

message SubscribeConnectionsRequest { int64 interval = 1; }
message ConnectionEvents {
  repeated ConnectionEvent events = 1;
  bool reset = 2;
}
message ConnectionEvent {
  ConnectionEventType type = 1;
  string id = 2;
  Connection connection = 3;
  int64 uplinkDelta = 4;
  int64 downlinkDelta = 5;
  int64 closedAt = 6;
}
enum ConnectionEventType {
  NEW = 0;
  UPDATE = 1;
  CLOSED = 2;
}
message Connection {
  string id = 1;
  string inbound = 2;
  string inboundType = 3;
  int32 ipVersion = 4;
  string network = 5;
  string source = 6;
  string destination = 7;
  string domain = 8;
  string protocol = 9;
  string user = 10;
  string fromOutbound = 11;
  int64 createdAt = 12;
  int64 closedAt = 13;
  int64 uplink = 14;
  int64 downlink = 15;
  int64 uplinkTotal = 16;
  int64 downlinkTotal = 17;
  string rule = 18;
  string outbound = 19;
  string outboundType = 20;
  repeated string chainList = 21;
  ProcessInfo processInfo = 22;
}
message ProcessInfo {
  uint32 processId = 1;
  uint32 userId = 2;
  string userName = 3;
  string processPath = 4;
  repeated string packageNames = 5;
}
message SelectOutboundRequest {
  string groupTag = 1;
  string outboundTag = 2;
}
message CloseConnectionRequest { string id = 1; }
`;

export interface TailscaleSelf {
  hostName?: string;
  tailscaleIPs?: string[];
  online?: boolean;
  keyExpiry?: string; // longs=String：unix 秒
  stableID?: string;
  expired?: boolean;
}

export interface TailscaleEndpointStatus {
  endpointTag: string; // = FlowZ 节点 tag（server.name）
  backendState: string; // NoState | NeedsLogin | Starting | Running | ...
  authURL: string;
  self?: TailscaleSelf;
}

// clash 等价方法消息（longs=String → int64/uint64 字段均为 string；enums=String → type 为 'NEW'|'UPDATE'|'CLOSED'）。
export interface SingBoxStatus {
  memory?: string;
  goroutines?: number;
  connectionsIn?: number;
  connectionsOut?: number;
  trafficAvailable?: string;
  uplink?: string;
  downlink?: string;
  uplinkTotal?: string;
  downlinkTotal?: string;
}

export interface SingBoxProcessInfo {
  processId?: number;
  userId?: number;
  userName?: string;
  processPath?: string;
  packageNames?: string[];
}

export interface SingBoxConnection {
  id?: string;
  inbound?: string;
  inboundType?: string;
  ipVersion?: number;
  network?: string;
  source?: string;
  destination?: string;
  domain?: string;
  protocol?: string;
  user?: string;
  fromOutbound?: string;
  createdAt?: string;
  closedAt?: string;
  uplink?: string;
  downlink?: string;
  uplinkTotal?: string;
  downlinkTotal?: string;
  rule?: string;
  outbound?: string;
  outboundType?: string;
  chainList?: string[];
  processInfo?: SingBoxProcessInfo;
}

export interface SingBoxConnectionEvent {
  type?: string; // 'NEW' | 'UPDATE' | 'CLOSED'（enums=String）
  id?: string;
  connection?: SingBoxConnection;
  uplinkDelta?: string;
  downlinkDelta?: string;
  closedAt?: string;
}

export interface SingBoxConnectionEvents {
  events?: SingBoxConnectionEvent[];
  reset?: boolean;
}

/** 管理 API 端点（Phase 2 预留 host 参数化；本任务恒 127.0.0.1 本地 h2c）。 */
export interface SingBoxApiEndpoint {
  host: string;
  port: number;
}

// service 构造器只解析一次（proto 内嵌→写临时文件→loadSync）。
let serviceCtor: grpc.ServiceClientConstructor | null = null;
function getServiceCtor(): grpc.ServiceClientConstructor {
  if (serviceCtor) return serviceCtor;
  const protoPath = path.join(os.tmpdir(), 'flowz-started-service.proto');
  fs.writeFileSync(protoPath, PROTO_SRC);
  const def = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
  });
  const pkg = grpc.loadPackageDefinition(def) as unknown as {
    daemon: { StartedService: grpc.ServiceClientConstructor };
  };
  serviceCtor = pkg.daemon.StartedService;
  return serviceCtor;
}

/**
 * Bearer call credentials：secret 非空时为每个 RPC 注入 metadata `authorization: Bearer <secret>`；空则免认证。
 * 经 grpc.credentials.combineChannelCredentials 与 h2c（insecure）通道合并——call credentials 不要求 TLS 通道
 * （@grpc/grpc-js 在 insecure 通道上仍会附带 call metadata，与官方 ClashApiClient 的 Authorization 头同义）。
 */
function buildCallCredentials(secret: string): grpc.CallCredentials | null {
  if (!secret) return null;
  return grpc.credentials.createFromMetadataGenerator((_params, callback) => {
    const md = new grpc.Metadata();
    md.set('authorization', `Bearer ${secret}`);
    callback(null, md);
  });
}

/**
 * 连本地 api service（127.0.0.1:<port>，不加密 h2c），订阅 Tailscale 状态流（断线自动重连）+ clash 等价管理方法。
 * 随主核起停：主核起→start()，主核停→stop()。
 *
 * 兼容：旧构造签名 (port:number, onUpdate) 已迁移为 (endpoint, secret, onUpdate?)；调用方 ProxyManager 已同步。
 */
export class SingBoxApiClient {
  private readonly host: string;
  private readonly port: number;
  private readonly callCreds: grpc.CallCredentials | null;
  private readonly onUpdate?: (endpoints: TailscaleEndpointStatus[]) => void;

  private client: grpc.Client | null = null;
  private call: grpc.ClientReadableStream<{ endpoints?: TailscaleEndpointStatus[] }> | null = null;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;

  /**
   * @param endpoint 管理 API 端点（{host, port}）。本任务恒本地 h2c。
   * @param secret   Bearer 鉴权 secret（= config.clashApiSecret）；空串 → 免认证。
   * @param onUpdate Tailscale 状态订阅回调（可选——纯做 clash 管理调用时可不传，不自动 start 订阅）。
   */
  constructor(
    endpoint: SingBoxApiEndpoint,
    secret: string,
    onUpdate?: (endpoints: TailscaleEndpointStatus[]) => void
  ) {
    this.host = endpoint.host;
    this.port = endpoint.port;
    this.callCreds = buildCallCredentials(secret);
    this.onUpdate = onUpdate;
  }

  private target(): string {
    return `${this.host}:${this.port}`;
  }

  /** 建通道凭据：本地 h2c insecure + （secret 非空时）Bearer call credentials。Phase 2 远程换 createSsl。 */
  private channelCredentials(): grpc.ChannelCredentials {
    const base = grpc.credentials.createInsecure();
    return this.callCreds ? grpc.credentials.combineChannelCredentials(base, this.callCreds) : base;
  }

  private newClient(): grpc.Client {
    const Ctor = getServiceCtor();
    return new Ctor(this.target(), this.channelCredentials());
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    if (!this.onUpdate) return; // 无订阅回调：纯管理调用客户端，不开 Tailscale 状态流
    try {
      this.client = this.newClient();
      this.call = (
        this.client as unknown as {
          SubscribeTailscaleStatus: (
            req: Record<string, never>
          ) => grpc.ClientReadableStream<{ endpoints?: TailscaleEndpointStatus[] }>;
        }
      ).SubscribeTailscaleStatus({});
      this.call.on('data', (msg) => {
        // stop 后守卫：gRPC cancel() 是 best-effort，已派发进事件循环的在途 data 帧仍可能触发——
        // 不加守卫会在 stop（换节点/切模式后旧 client 已弃用、ProxyManager 已置 client=null）后
        // 用陈旧 endpoint 状态推一条跨代 EVENT_TAILSCALE_STATUS，误点亮/熄灭错节点登录态。
        if (this.stopped) return;
        this.onUpdate?.(msg?.endpoints || []);
      });
      this.call.on('error', () => this.scheduleReconnect());
      this.call.on('end', () => this.scheduleReconnect());
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    this.cleanupCall();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, 2000);
  }

  private cleanupCall(): void {
    try {
      this.call?.cancel();
    } catch {
      /* ignore */
    }
    this.call = null;
    try {
      this.client?.close();
    } catch {
      /* ignore */
    }
    this.client = null;
  }

  /** 原生登出指定 endpoint（不清 state 目录）。一次性 unary call，独立连接。 */
  logout(endpointTag: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const c = this.newClient();
        (
          c as unknown as {
            TailscaleLogout: (
              req: { endpointTag: string },
              cb: (err: grpc.ServiceError | null) => void
            ) => void;
          }
        ).TailscaleLogout({ endpointTag }, (err) => {
          try {
            c.close();
          } catch {
            /* ignore */
          }
          if (err) reject(err);
          else resolve();
        });
      } catch (e) {
        reject(e as Error);
      }
    });
  }

  /** 通用一次性 unary 调用（独立连接，调用后即关）。供 clash 等价方法复用。 */
  private unary<TReq>(method: string, req: TReq): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const c = this.newClient();
        (
          c as unknown as Record<
            string,
            (r: TReq, cb: (err: grpc.ServiceError | null) => void) => void
          >
        )[method](req, (err) => {
          try {
            c.close();
          } catch {
            /* ignore */
          }
          if (err) reject(err);
          else resolve();
        });
      } catch (e) {
        reject(e as Error);
      }
    });
  }

  /** clash 等价：在 selector/urltest group 内选定出站。 */
  selectOutbound(groupTag: string, outboundTag: string): Promise<void> {
    return this.unary('SelectOutbound', { groupTag, outboundTag });
  }

  /** clash 等价：按 id 关闭单条连接。 */
  closeConnection(id: string): Promise<void> {
    return this.unary('CloseConnection', { id });
  }

  /** clash 等价：关闭全部连接（Empty 请求）。 */
  closeAllConnections(): Promise<void> {
    return this.unary('CloseAllConnections', {});
  }

  /**
   * clash 等价：订阅 Status 流（内存/goroutine/流量速率/累计）。intervalNs = 推送间隔（纳秒，int64）。
   * 复用 SubscribeTailscaleStatus 的断线重连模式，返回一个 stop 句柄供调用方停订阅。
   */
  subscribeStatus(intervalNs: number, onStatus: (status: SingBoxStatus) => void): () => void {
    return this.subscribeStream<{ interval: number }, SingBoxStatus>(
      'SubscribeStatus',
      { interval: intervalNs },
      onStatus
    );
  }

  /**
   * clash 等价：订阅 Connections 事件流（NEW/UPDATE/CLOSED 增量 + reset 全量重置）。intervalNs = 推送间隔（纳秒）。
   * 复用断线重连模式，返回 stop 句柄。
   */
  subscribeConnections(
    intervalNs: number,
    onEvents: (events: SingBoxConnectionEvents) => void
  ): () => void {
    return this.subscribeStream<{ interval: number }, SingBoxConnectionEvents>(
      'SubscribeConnections',
      { interval: intervalNs },
      onEvents
    );
  }

  /**
   * 通用 server-streaming 订阅（独立连接 + 2s 断线重连），返回 stop 句柄。
   * 与 Tailscale 订阅流（this.call）相互独立——各持各的 client/retryTimer，互不干扰生命周期。
   */
  private subscribeStream<TReq, TMsg>(
    method: string,
    req: TReq,
    onMsg: (msg: TMsg) => void
  ): () => void {
    let stopped = false;
    let client: grpc.Client | null = null;
    let stream: grpc.ClientReadableStream<TMsg> | null = null;
    let retry: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      try {
        stream?.cancel();
      } catch {
        /* ignore */
      }
      stream = null;
      try {
        client?.close();
      } catch {
        /* ignore */
      }
      client = null;
    };

    const schedule = (): void => {
      if (stopped || retry) return;
      cleanup();
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, 2000);
    };

    const connect = (): void => {
      if (stopped) return;
      try {
        client = this.newClient();
        stream = (
          client as unknown as Record<string, (r: TReq) => grpc.ClientReadableStream<TMsg>>
        )[method](req);
        stream.on('data', (msg: TMsg) => {
          if (stopped) return;
          onMsg(msg);
        });
        stream.on('error', () => schedule());
        stream.on('end', () => schedule());
      } catch {
        schedule();
      }
    };

    connect();

    return () => {
      stopped = true;
      if (retry) {
        clearTimeout(retry);
        retry = null;
      }
      cleanup();
    };
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.cleanupCall();
  }
}
