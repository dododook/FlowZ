/**
 * sing-box 1.14 管理 API（daemon.StartedService）gRPC 客户端 —— Tailscale 状态订阅 + 原生登出。
 * 取代 1.13.x 的「state 目录存在性 + stdout 日志解析」启发式（见 docs/design/tailscale-1.14-management-api.md）。
 *
 * proto 内嵌（避免打包路径依赖）；用本地 `Empty`——空消息 wire 编码为 0 字节，与服务端 google.protobuf.Empty
 * 完全兼容（gRPC 只按 service/method 名 + 字段号对齐，消息类型名不参与 wire）。字段号对齐 sing-box
 * 1.14.0-alpha.32 grpcurl 反射；升级核时若变以反射为准重核。
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
 * 连本地 api service（127.0.0.1:<port>，不加密 h2c），订阅 Tailscale 状态流（断线自动重连）。
 * 随主核起停：主核起→start()，主核停→stop()。
 */
export class TailscaleApiClient {
  private client: grpc.Client | null = null;
  private call: grpc.ClientReadableStream<{ endpoints?: TailscaleEndpointStatus[] }> | null = null;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly port: number,
    private readonly onUpdate: (endpoints: TailscaleEndpointStatus[]) => void
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    try {
      const Ctor = getServiceCtor();
      this.client = new Ctor(`127.0.0.1:${this.port}`, grpc.credentials.createInsecure());
      this.call = (
        this.client as unknown as {
          SubscribeTailscaleStatus: (
            req: Record<string, never>
          ) => grpc.ClientReadableStream<{ endpoints?: TailscaleEndpointStatus[] }>;
        }
      ).SubscribeTailscaleStatus({});
      this.call.on('data', (msg) => this.onUpdate(msg?.endpoints || []));
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
        const Ctor = getServiceCtor();
        const c = new Ctor(`127.0.0.1:${this.port}`, grpc.credentials.createInsecure());
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

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.cleanupCall();
  }
}
