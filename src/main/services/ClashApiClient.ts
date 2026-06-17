import * as http from 'http';

/**
 * clash_api（127.0.0.1:9090）专属 HTTP 客户端。单一 keep-alive http.Agent，供 ProxyManager（reassert/hotSwitch/
 * closeConnection）与 StatsService（流量/连接轮询）共用——消除两处独立 agent + Bearer + request plumbing 的重复。
 *
 * 不变量（P0）：杀核前须调 destroyAgent() RST 掉所有到 9090 的 keep-alive 连接，让 client 主动关 → 9090 不进 root
 * TIME_WAIT → 下次用户态 sing-box 免撞 TIME_WAIT 等 30s。原 ProxyManager 与 StatsService 各持一个 agent、各自 destroy，
 * 现合并为单一 agent，一次 destroy 全收（由 ProxyManager.setQuiesceClashClients 注入的回调统一调）。
 *
 * secret 经 getSecret 回调注入（与 StatsService 既有注入同形）：reload 配置后 secret 变也读最新，无需 setSecret 通知。
 * secret 仅主进程内存（client 不持久化），渲染端只收脱敏快照——安全边界不变。
 */
export interface ClashApiResult {
  ok: boolean;
  status: number;
}

export class ClashApiClient {
  private agent: http.Agent;

  // getPort：clash_api 控制端口取值回调（默认 9090）。与 getSecret 同形——每次请求读最新值，
  // reload 配置改 controlPort 后无需通知。缺省 9090 保持旧调用方/单测（仅传 getSecret）不破。
  constructor(
    private readonly getSecret: () => string,
    private readonly getPort: () => number = () => 9090
  ) {
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
  }

  /**
   * 通用 clash_api 请求（任意 method/body/timeout），丢弃响应体，仅关心成败。
   * 用 'close' 收口（'end' 后必 close；响应中途断时只有 close 无 end）→ 防 Promise 悬挂。resolve 幂等。
   * 供 ProxyManager.reassertSelectorSelection / hotSwitchNode / closeConnection 用。
   */
  request(
    pathName: string,
    method: string,
    body?: unknown,
    timeoutMs = 2000
  ): Promise<ClashApiResult> {
    return new Promise((resolve) => {
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const secret = this.getSecret();
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.getPort(),
          path: pathName,
          method,
          agent: this.agent,
          timeout: timeoutMs,
          headers: {
            ...(payload !== undefined
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
              : {}),
            ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
          },
        },
        (res) => {
          const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
          const code = res.statusCode ?? 0;
          res.on('error', () => resolve({ ok: false, status: 0 }));
          // 用 'close' 收口（'end' 后必 close；响应中途断时只有 close 无 end）→ 防 Promise 悬挂。resolve 幂等。
          res.on('close', () => resolve({ ok, status: code }));
          res.resume(); // 丢弃响应体（reassert/hotSwitch 只关心成败）
        }
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve({ ok: false, status: 0 }));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  /**
   * GET clash_api 并解析 JSON 响应体。供 StatsService.poll 用（原 StatsService.getJson）。
   * 900ms 默认（轮询用，对齐原值）。失败/非 200/解析失败 → null（轮询静默：核心刚停/鉴权未就绪）。
   */
  getJson<T = unknown>(path: string, timeoutMs = 900): Promise<T | null> {
    return new Promise((resolve) => {
      const secret = this.getSecret();
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.getPort(),
          path,
          method: 'GET',
          agent: this.agent,
          timeout: timeoutMs,
          headers: secret ? { Authorization: `Bearer ${secret}` } : {},
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            resolve(null);
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body) as T);
            } catch {
              resolve(null);
            }
          });
        }
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  /**
   * RST 掉所有到 9090 的 keep-alive socket + 重建新 Agent（为下次启动准备）。
   * 杀核前调（P0-2 治本，防 9090 TIME_WAIT）。合并自原 ProxyManager.destroyClashApiAgent + StatsService.closeConnections。
   */
  destroyAgent(): void {
    try {
      this.agent.destroy();
    } catch {
      /* 忽略 */
    }
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
  }
}
