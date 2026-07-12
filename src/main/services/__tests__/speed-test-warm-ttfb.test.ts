/**
 * SpeedTestService.measureViaTunnel 集成单测（本地 mock CONNECT 代理 + 明文/TLS origin，无 sing-box）。
 *
 * 核心断言：计时对齐 mihomo `unified-delay`——同一条隧道发两次 GET，**只计第二次**的请求往返。
 * 故意把 connectDelay（建连）/ firstDelay（第一次/含 TLS 握手）放大、secondDelay 放小，验证上报值≈secondDelay，
 * 远小于 connectDelay+firstDelay（证明握手/建连/第一次均不计入 = 不再虚高）。另覆盖：第一次响应跨 chunk 残余不污染
 * 第二次计时（防塌成 ≈0ms 的相位机缺陷）、CONNECT 失败 / 对端早关 / 超时三类失败返回 null。
 */
import * as net from 'net';
import * as tls from 'tls';
import { SpeedTestService } from '../SpeedTestService';
import { resolveSpeedTestTarget } from '../../../shared/speed-test';

// 测试专用自签证书（仅本进程 mock origin 用；客户端测速 rejectUnauthorized=false 不校验）。
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCoDRoduamuz7oo
JDqvXZbOAmrSm74Qd6uj8zpfrrIlp4lUg+pVU4STww4pZAQQb88FSfzXjjEjKyWV
q70Wv0nXeo2wvr+/mAZA3YDeAQFCb9aSq+HKzJhY9P3CmjOEJqgLjJ9OBos8QkR2
aSWQyUa7xR7N72MggqePfbRzG9qHRBolzfZQrtdVNB0V/gR+Hmcj/ZwB3M7Tdg7F
pMZrltVvncVUghWjIpcS8JgSc4t2WxDCJc3JYgtzt9CJqWWmTQFQNmgLfHNsm727
Y0tSE2c7EqvAYU7cQ59mpisbJc/P9Xcm+S3+9fe781wvZqlJTvdXGa1R0qpANYKz
KI/BwQ67AgMBAAECggEAGu/mtMcS7ON9Onv8MCn3R1RZ3SJ7x9X23FPbkoTFJ4YA
XFy8ziqSAMFuXrIaeKwDahye+8peE/4Rizk5GRFWe8S4O5GH2OU8c19ODcfpdMXK
hj4o9kHvVasHlg7znQY5P4it7GreHK2encBi9h9dSDHjqyzpHcfzpeuHZkAbujys
eF3QkNL6x1BmNUCro4TG0ulnTTQeyTgo3tr/gXDGW8dorYvEyykBf9MMpsuEfypO
nYOMcpHRxCa/jJ1TcTagkH/T1OTuemdfIjV5qWDOwzkmIx58RXG7Qxf5mfn3omKQ
i/bp5Ly98HXaUwbD6RvwdlhJe0M8O3mT96+di+RLsQKBgQDmzw+H2VkWK5mL6xXw
WqjWRaIsrqLFkb/0iBEwPwKXTg5UVwH1WNdM4ifrWIZbZilu+1ru/mtC9833FTik
7i+xli7qYk571QqmZ+R4/e7OIl003UlgmXcFIfhIiuOWlrymeh32R7wE/XK4gegt
dBNr2ZYzQM3v2s99Y5VWZF8VswKBgQC6ZI3p7hkPZ8QBsHpYnJ0PbRt1yuTwS1Bu
b67fGdULsooLa34rFmqpVSdpQFf90kaxQWQCGePKjl92lF4JJ/fWN9B08YN4Wf00
bvHfWHHk6KeW5uFCwE0iOqhcUF9tcD46D0wZlFBgOw8uUWAxtFZvSbwdjAq1/gdD
DmvvXfiu2QKBgF6Yhpj675Qykl/SHc/AmGoZZ/pAKN4oei/ShJjtejZg+2Z9soPH
wZX1Kr8+LPLQ0DJ4OjCxfWyY+4VE4U5XgJycHOZbHCeMjSzeb7lW+cTqOKEuAKDi
xPEJlyTEJ7rUVMU2T4lcpSa2aYpNU8ctR7hwGSswaDbhyyBs7AvYX1AZAoGANnBJ
9ong7dvrpmapxRmw0aGXRJcGuJv2mNqro2ODEtCJev5hMipw6pYBVb9CM9LnbLvh
fq+bFTzx6ss4j8oJm5pfmtgzAsKdrmO85vOJCEdfMzapkfpiTN3+8D9VL7x5oDF5
k3r64rA9JdUEmF/IYuaRN7wAINlZu58JrTav/DkCgYAtUdo8N6Zusw3Y23t8gLl6
EO1yYEncTo6hmlmsqEWGCi+Unrjja5tCU7qBl4tqn85qMGzynnSJhFiW5ZcPw0Nl
1oVy9i6fO4pqv/B/aqQqBED0c9kUoe+VkQAwXBu8AFrwgtUNL0lZW2BUUbVlKBS7
3QMAV0J/K1v4W5tNjSTb5g==
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDFzCCAf+gAwIBAgIUKsb6U3Icqun55FUl7UlKZ74eFFowDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPc3BlZWR0ZXN0LmxvY2FsMCAXDTI2MDYxNTExNDcwOVoY
DzIxMjYwNTIyMTE0NzA5WjAaMRgwFgYDVQQDDA9zcGVlZHRlc3QubG9jYWwwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCoDRoduamuz7ooJDqvXZbOAmrS
m74Qd6uj8zpfrrIlp4lUg+pVU4STww4pZAQQb88FSfzXjjEjKyWVq70Wv0nXeo2w
vr+/mAZA3YDeAQFCb9aSq+HKzJhY9P3CmjOEJqgLjJ9OBos8QkR2aSWQyUa7xR7N
72MggqePfbRzG9qHRBolzfZQrtdVNB0V/gR+Hmcj/ZwB3M7Tdg7FpMZrltVvncVU
ghWjIpcS8JgSc4t2WxDCJc3JYgtzt9CJqWWmTQFQNmgLfHNsm727Y0tSE2c7EqvA
YU7cQ59mpisbJc/P9Xcm+S3+9fe781wvZqlJTvdXGa1R0qpANYKzKI/BwQ67AgMB
AAGjUzBRMB0GA1UdDgQWBBSpVbrUvl6+TJr44KuK2RWu22A5rDAfBgNVHSMEGDAW
gBSpVbrUvl6+TJr44KuK2RWu22A5rDAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3
DQEBCwUAA4IBAQAHGAmoH954ZahWSUO0Zb1OelTZkmnPft8dY5W+HTj0WlksrDHE
LNszGo5AxlWVAHt55yJ0UcDnab+qAQKnt8KXpBLhAgrOrtgiwLcZ9u0nrjWXPCQE
2MksJxq4CnQxXVcgKzvTFtSrfkGCHL6Re1J0onAdPXbG/Bqur1WhW8bRbo59/ZnQ
uqqhVlXDQ53pa81ApTi+kbgra12ExUcXlrbmhPB2qxqKfAJ68H0a4sXdQS7n9Mwd
8IZ4nh5nFrD/IU54o6+QXqOFICQhqcWgykXL5gGf9oxAhCjMeXxUkUcxqGXTZYRk
xiWQ81eyG2tDO/dC57ooE2BY/n8AYwY19rHS
-----END CERTIFICATE-----`;

const mockLog = { addLog: () => {} } as unknown as ConstructorParameters<
  typeof SpeedTestService
>[0];

interface MockOpts {
  /** CONNECT 收齐后延迟多久才回 200（模拟建连慢）。 */
  connectDelay?: number;
  /** 第一次 GET 延迟多久回响应（模拟首请求/暖身慢）。 */
  firstDelay?: number;
  /** 第二次 GET 延迟多久回响应（= 期望被计入的 warm RTT）。 */
  secondDelay?: number;
  /** 第一次响应改为 200 + 该 body（自配非 204 端点；body 含空行时不应污染第二次计时）。 */
  firstBody?: string;
  /** 与 firstBody 配合：第一次响应的 header 与 body 分两段发送（body 后到，模拟 TCP 分段/TLS record）。 */
  splitFirstHeaderBody?: boolean;
  /** CONNECT 后是否升 TLS（模拟 https 目标）。 */
  tls?: boolean;
  /** 对 CONNECT 回非 200（不可达代理）。 */
  failConnect?: boolean;
  /** 第一次响应后立即关闭连接（不支持 keep-alive，第二次无连接可用）。 */
  closeAfterFirst?: boolean;
  /** 第一次响应头之后再补发的残余字节（独立 chunk，模拟分片/CDN 多次 write）；不应被当作第二次首字节计时。 */
  firstTrailer?: string;
  /** 无 body 时的响应状态码（默认 204）；用于 ③ 校验响应码用例（如 403 模拟目标拒绝）。两次响应同此码。 */
  status?: number;
}

interface MockProxy {
  port: number;
  close: () => Promise<void>;
}

/** 在已建立的流（明文隧道或 TLS）上扮演 origin：按到达的 GET 计次，按 first/second 时延回响应。 */
function serveOrigin(stream: net.Socket | tls.TLSSocket, opts: MockOpts): void {
  let reqBuf = '';
  let count = 0;
  stream.on('error', () => {});
  stream.on('data', (d: Buffer) => {
    reqBuf += d.toString('latin1');
    while (reqBuf.includes('\r\n\r\n')) {
      reqBuf = reqBuf.slice(reqBuf.indexOf('\r\n\r\n') + 4);
      count++;
      const isFirst = count === 1;
      const delay = isFirst ? (opts.firstDelay ?? 0) : (opts.secondDelay ?? 0);
      const closeNow = isFirst && opts.closeAfterFirst;
      setTimeout(() => {
        try {
          const body = isFirst ? opts.firstBody : undefined;
          if (body && opts.splitFirstHeaderBody) {
            // header 先发、body 后发（独立 chunk）：body 残余会先于第二次响应进入清空后的 buf。
            stream.write(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`);
            setTimeout(() => {
              try {
                stream.write(body);
              } catch {
                /* 连接可能已被客户端 destroy */
              }
            }, 10).unref();
          } else {
            stream.write(
              body
                ? `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
                : `HTTP/1.1 ${opts.status ?? 204} X\r\nContent-Length: 0\r\n\r\n`
            );
          }
          if (isFirst && opts.firstTrailer) {
            // 第一次响应头之后再发一段残余 chunk（模拟分片/CDN 多次 write）。
            setTimeout(() => {
              try {
                stream.write(opts.firstTrailer!);
              } catch {
                /* 连接可能已被客户端 destroy */
              }
            }, 10).unref();
          }
          if (closeNow) stream.end();
        } catch {
          /* 连接可能已被客户端 destroy */
        }
      }, delay).unref(); // unref：测试提前结束时不吊住事件循环（如 firstDelay=5000 的超时用例）
    }
  });
}

function startMockProxy(opts: MockOpts): Promise<MockProxy> {
  const live = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    live.add(sock);
    sock.on('close', () => live.delete(sock));
    sock.on('error', () => {});
    let buf = '';
    const onConnectData = (d: Buffer) => {
      buf += d.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      sock.removeListener('data', onConnectData); // 交棒：后续由 TLS server 或 origin 接管读取
      const reply = (): void => {
        if (opts.failConnect) {
          sock.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          return;
        }
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (opts.tls) {
          const tlsSock = new tls.TLSSocket(sock, {
            isServer: true,
            key: TEST_KEY,
            cert: TEST_CERT,
          });
          serveOrigin(tlsSock, opts);
        } else {
          serveOrigin(sock, opts);
        }
      };
      if (opts.connectDelay) setTimeout(reply, opts.connectDelay).unref();
      else reply();
    };
    sock.on('data', onConnectData);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            for (const s of live) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

type Measurable = {
  measureViaTunnel(
    proxyPort: number,
    timeout: number,
    target: ReturnType<typeof resolveSpeedTestTarget>
  ): Promise<{ latency: number | null; reason?: string }>;
};

const svc = new SpeedTestService(mockLog) as unknown as Measurable;

/** 计时用例只关心 latency：解包 .latency，保留既有断言不变。 */
const measureLatency = (
  port: number,
  timeout: number,
  target: ReturnType<typeof resolveSpeedTestTarget>
) => svc.measureViaTunnel(port, timeout, target).then((r) => r.latency);

const HTTP_TARGET = resolveSpeedTestTarget('http://speedtest.local/generate_204');
const HTTPS_TARGET = resolveSpeedTestTarget('https://speedtest.local/generate_204');

describe('SpeedTestService.measureViaTunnel（warm RTT，对齐 mihomo unified-delay）', () => {
  it('HTTP：只计第二次请求，排除建连+第一次（warm≈secondDelay，远小于 connect+first）', async () => {
    // connect 100 + first 250 → 若误计冷启动会是 ~350+；只计第二次应 ≈60。
    const proxy = await startMockProxy({ connectDelay: 100, firstDelay: 250, secondDelay: 60 });
    try {
      const latency = await measureLatency(proxy.port, 8000, HTTP_TARGET);
      expect(latency).not.toBeNull();
      expect(latency!).toBeGreaterThanOrEqual(40); // 确在量第二次（secondDelay=60）
      expect(latency!).toBeLessThan(200); // 远低于 connect(100)+first(250)，证明握手/暖身不计入
    } finally {
      await proxy.close();
    }
  });

  it('HTTPS：TLS 握手归入暖身、不计入；仍只计第二次请求', async () => {
    const proxy = await startMockProxy({
      connectDelay: 100,
      firstDelay: 250,
      secondDelay: 60,
      tls: true,
    });
    try {
      const latency = await measureLatency(proxy.port, 8000, HTTPS_TARGET);
      expect(latency).not.toBeNull();
      expect(latency!).toBeGreaterThanOrEqual(40);
      expect(latency!).toBeLessThan(200); // TLS 握手 + connect + first 均排除
    } finally {
      await proxy.close();
    }
  });

  it('第一次响应跨 chunk 残余不污染第二次计时（防塌成 ≈0ms）', async () => {
    // 第一次响应头后 10ms 再发一段无 \r\n\r\n 的残余 chunk；旧相位机会把它当第二次首字节 → latency≈10；
    // 正确实现应忽略残余、计到真正的第二次响应（secondDelay=100）。
    const proxy = await startMockProxy({
      firstDelay: 20,
      secondDelay: 100,
      firstTrailer: 'X-Leftover: stray-bytes-without-header-end\r\n',
    });
    try {
      const latency = await measureLatency(proxy.port, 8000, HTTP_TARGET);
      expect(latency).not.toBeNull();
      expect(latency!).toBeGreaterThanOrEqual(50); // ≈secondDelay(100)，证明残余未被计为第二次
      expect(latency!).toBeLessThan(260);
    } finally {
      await proxy.close();
    }
  });

  it('自配非 204 端点（200 + body 含空行）不污染第二次计时（防 body 残余塌 0）', async () => {
    // 第一次响应是 200 + body，且 body 内含 \r\n\r\n（HTML/JSON pretty-print 常见）。若把 body 残余当第二次响应头
    // 会塌成 ≈firstDelay；正确实现整段清空 buf、只计真正的第二次（secondDelay=100）。
    const proxy = await startMockProxy({
      firstDelay: 20,
      secondDelay: 100,
      firstBody: 'part-a\r\n\r\npart-b',
    });
    try {
      const latency = await measureLatency(proxy.port, 8000, HTTP_TARGET);
      expect(latency).not.toBeNull();
      expect(latency!).toBeGreaterThanOrEqual(50); // ≈secondDelay(100)，证明第一次 body 残余未被计入
      expect(latency!).toBeLessThan(260);
    } finally {
      await proxy.close();
    }
  });

  it('非 204 端点 header/body 分段、body 后到含空行：从 HTTP/ 锚定，仍只计第二次', async () => {
    // 第一次 200 响应的 header 先到（触发清空 buf）、body（含 \r\n\r\n）10ms 后到，先于第二次响应入 buf。
    // 若第二次不从状态行 HTTP/ 起算，会把该 body 残余误当第二次响应头 → 塌成 ≈firstDelay。
    const proxy = await startMockProxy({
      firstDelay: 20,
      secondDelay: 100,
      firstBody: 'part-a\r\n\r\npart-b',
      splitFirstHeaderBody: true,
    });
    try {
      const latency = await measureLatency(proxy.port, 8000, HTTP_TARGET);
      expect(latency).not.toBeNull();
      expect(latency!).toBeGreaterThanOrEqual(50); // ≈secondDelay(100)，证明后到的 body 残余未被计为第二次
      expect(latency!).toBeLessThan(260);
    } finally {
      await proxy.close();
    }
  });

  it('CONNECT 非 200（代理不可达）→ null + reason connect-*（③）', async () => {
    const proxy = await startMockProxy({ failConnect: true });
    try {
      const { latency, reason } = await svc.measureViaTunnel(proxy.port, 500, HTTP_TARGET);
      expect(latency).toBeNull();
      // Node 对 CONNECT 非 2xx 视版本走 'connect'(带 statusCode→connect-502) 或 'response'(→connect-downgraded)
      expect(reason).toMatch(/^connect-/);
    } finally {
      await proxy.close();
    }
  });

  it('对端在第二次前关闭（不支持 keep-alive）→ null + reason early-close（③）', async () => {
    const proxy = await startMockProxy({ firstDelay: 10, closeAfterFirst: true });
    try {
      const { latency, reason } = await svc.measureViaTunnel(proxy.port, 500, HTTP_TARGET);
      expect(latency).toBeNull();
      expect(reason).toBe('early-close');
    } finally {
      await proxy.close();
    }
  });

  it('整体超时（请求迟迟不响应）→ null + reason timeout（③）', async () => {
    const proxy = await startMockProxy({ firstDelay: 5000 }); // 远超下方 timeout
    try {
      const start = Date.now();
      const { latency, reason } = await svc.measureViaTunnel(proxy.port, 200, HTTP_TARGET);
      expect(latency).toBeNull();
      expect(reason).toBe('timeout');
      expect(Date.now() - start).toBeLessThan(1500); // 在总超时附近返回，不等 5s
    } finally {
      await proxy.close();
    }
  });

  it('目标返回非 2xx（如 CF-Workers 撞 cp.cloudflare 的 403）→ null + reason http-403（③ 校验响应码）', async () => {
    // 隧道建立、两次响应均收齐，但状态码 403 → 不再当成功记 TTFB，判失败并带 http-403。
    const proxy = await startMockProxy({ firstDelay: 5, secondDelay: 5, status: 403 });
    try {
      const { latency, reason } = await svc.measureViaTunnel(proxy.port, 2000, HTTP_TARGET);
      expect(latency).toBeNull();
      expect(reason).toBe('http-403');
    } finally {
      await proxy.close();
    }
  });
});

describe('SpeedTestService.measureWarmRttViaHttpProxy（出口伴测薄包装：resolveSpeedTestTarget + 8000 超时 + 透传 latency）', () => {
  it('默认 URL → 解析默认端点、超时 8000、透传 latency', async () => {
    const s = new SpeedTestService(mockLog);
    const spy = jest
      .spyOn(s as unknown as Measurable, 'measureViaTunnel')
      .mockResolvedValue({ latency: 55 });
    const rtt = await s.measureWarmRttViaHttpProxy(6001);
    expect(rtt).toBe(55);
    expect(spy).toHaveBeenCalledWith(6001, 8000, resolveSpeedTestTarget(undefined));
  });

  it('自配 URL → 解析该端点；隧道失败 null 透传（调用方据此放弃写入、不写 -1）', async () => {
    const s = new SpeedTestService(mockLog);
    const spy = jest
      .spyOn(s as unknown as Measurable, 'measureViaTunnel')
      .mockResolvedValue({ latency: null });
    const rtt = await s.measureWarmRttViaHttpProxy(6002, 'https://x.example/y');
    expect(rtt).toBeNull();
    expect(spy).toHaveBeenCalledWith(6002, 8000, resolveSpeedTestTarget('https://x.example/y'));
  });
});
