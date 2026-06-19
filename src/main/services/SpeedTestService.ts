/**
 * 速度测试服务（真实测速）：**所有协议**统一经临时 sing-box 的各自 HTTP 代理出口、CONNECT 隧道上发两次 GET 测
 * urltest TTFB，验证完整链路（连接+鉴权+中继+响应）。计时对齐 mihomo `unified-delay`：在同一条已建立的隧道上**只计
 * 第二次**请求往返——即不含建连/握手的「实际请求时间」，跨协议可比（旧实现每次新建连接、把到代理的握手 RTT
 * 计进延迟，数值虚高且协议越重越偏，等价 mihomo `unified-delay:false`）。
 * 关键:端口通≠代理可用——裸 TCP ping 只测到入口的 RTT、测不出鉴权/协议/中继失败,故不再用于真实测速。
 *
 * 出站由 index.ts 注入 ProxyManager.buildSpeedTestOutbound 构造（全协议）。未注入（单测/兜底）时退回旧的 TCP ping + UDP 代理拆分。
 */

import * as net from 'net';
import * as http from 'http';
import * as tls from 'tls';
import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn, ChildProcess } from 'child_process';
import type { ServerConfig } from '../../shared/types';
import type { LogManager } from './LogManager';
import { resourceManager } from './ResourceManager';
import { getUserDataPath } from '../utils/paths';
import { resolveSpeedTestTarget, type SpeedTestTarget } from '../../shared/speed-test';
import { isEndpointProtocol } from '../../shared/endpoint-routes';
import { normalizeDuration } from '../../shared/duration';

/** 基于 UDP/QUIC 的协议，需要走真实代理测速 */
const UDP_PROTOCOLS = new Set(['hysteria2', 'tuic']);

export interface SpeedTestResult {
  serverId: string;
  latency: number | null; // null 表示超时或失败
  error?: string;
}

export class SpeedTestService {
  private logManager: LogManager;
  private readonly MAX_CONCURRENT = 5; // TCP 并发数（仅兜底裸 ping 路径）
  /** 经代理 urltest 的测速并发上限：大订阅时分波，避免 N 路握手同时打出→请求风暴假超时。
   *  小订阅(≤此值)等价全并行、零额外延迟。取 16=并发与稳健的折中（warm 计量已把握手挪出上报值，并发主要影响
   *  总测速时长与争用、非延迟数值）；调大更快、调小更稳。 */
  private static readonly PROXY_TEST_CONCURRENCY = 16;
  /** 单节点测速总超时（ms）：覆盖冷建连(CONNECT+到代理/目标握手)+两次 GET；上报值只取第二次 warm RTT，与此无关。
   *  取 8s 给大订阅并发冷启动留足头寸，超时即判该节点不可达(null)。 */
  private static readonly MEASURE_TIMEOUT_MS = 8000;
  /**
   * 出站构造器（由 index.ts 注入 ProxyManager.buildSpeedTestOutbound）：注入后**所有协议**统一走「临时 sing-box
   * 经代理 urltest」真实测速（端口通≠代理可用，裸 TCP ping 测不出鉴权/中继失败）；返回 null=该节点不可用（如 naive
   * 缺 libcronet）→ 跳过。未注入（兜底/单测）时退回旧的 TCP ping + UDP 代理拆分。
   */
  private buildOutboundFn?: (server: ServerConfig, tag: string) => Record<string, unknown> | null;

  /** 进行中的测速 Promise：双入口（UI/托盘）并发时复用同一次测速，避免起两个临时 sing-box（端口/资源冲突）。
   *  第二个调用方等待同一份最终结果（不收流式 onResult，末尾 results 同步覆盖即可）。 */
  private currentTest: Promise<Map<string, number | null>> | null = null;

  constructor(
    logManager: LogManager,
    buildOutboundFn?: (server: ServerConfig, tag: string) => Record<string, unknown> | null
  ) {
    this.logManager = logManager;
    this.buildOutboundFn = buildOutboundFn;
  }

  /**
   * 测试所有服务器（混合策略）。
   * @param onResult 可选逐节点回调：每测完一个节点即回传（serverId, latency），供 UI 流式增量显示
   *   （惰性、谁有结果谁先显示，等价 mihomo）。不传则仅在末尾用返回的 Map 一次性更新。
   */
  async testAllServers(
    servers: ServerConfig[],
    onResult?: (serverId: string, latency: number | null) => void,
    onProgress?: (tested: number, ok: number, total: number) => void,
    testUrl?: string
  ): Promise<Map<string, number | null>> {
    if (servers.length === 0) {
      return new Map();
    }
    // 双入口（UI/托盘）并发复用同一次测速，避免起两个临时 sing-box（端口/资源冲突）。
    // second caller 拿同一份 final results，但其 onResult/onProgress 不触发（流式只由 first caller 驱动）；
    // 可接受：数据最终正确，且 EVENT_SPEED_TEST_RESULT/PROGRESS 是 IPC broadcast，second caller 的 renderer
    // 订阅仍能收到 first caller 推的事件（latencyMap/进度照常更新）。
    if (this.currentTest) return this.currentTest;
    this.currentTest = this.doTestAllServers(servers, onResult, onProgress, testUrl).finally(() => {
      this.currentTest = null;
    });
    return this.currentTest;
  }

  private async doTestAllServers(
    servers: ServerConfig[],
    onResult?: (serverId: string, latency: number | null) => void,
    onProgress?: (tested: number, ok: number, total: number) => void,
    testUrl?: string
  ): Promise<Map<string, number | null>> {
    // 生产路径（注入了出站构造器）：**所有协议**统一走临时 sing-box 经代理 urltest，真实测速。
    if (this.buildOutboundFn) {
      this.logManager.addLog(
        'info',
        `开始测速: ${servers.length} 个节点（经代理 urltest）`,
        'SpeedTest'
      );
      const results = await this.testServersViaProxy(servers, onResult, onProgress, testUrl);
      const ok = [...results.values()].filter((v) => v !== null).length;
      // 仅汇总，不逐节点列明（结果由 UI 节点延迟徽标承载）。
      this.logManager.addLog('info', `测速完成：成功 ${ok}/${servers.length}`, 'SpeedTest');
      return results;
    }

    // 兜底路径（未注入构造器，如单测）：旧的 TCP 裸 ping + UDP 代理拆分。
    const tcpServers = servers.filter((s) => !UDP_PROTOCOLS.has(s.protocol.toLowerCase()));
    const udpServers = servers.filter((s) => UDP_PROTOCOLS.has(s.protocol.toLowerCase()));
    const results = new Map<string, number | null>();
    const [tcpResults, udpResults] = await Promise.all([
      this.testTcpServers(tcpServers, onResult),
      udpServers.length > 0
        ? this.testServersViaProxy(udpServers, onResult, undefined, testUrl)
        : new Map<string, number | null>(),
    ]);
    for (const [id, latency] of tcpResults) results.set(id, latency);
    for (const [id, latency] of udpResults) results.set(id, latency);
    this.logManager.addLog('info', '测速完成', 'SpeedTest');
    return results;
  }

  // ═══════════════════════════════════════════════════════════════
  //  TCP Ping（原有逻辑，保持不变）
  // ═══════════════════════════════════════════════════════════════

  private async testTcpServers(
    servers: ServerConfig[],
    onResult?: (serverId: string, latency: number | null) => void
  ): Promise<Map<string, number | null>> {
    const results = new Map<string, number | null>();
    if (servers.length === 0) return results;

    for (let i = 0; i < servers.length; i += this.MAX_CONCURRENT) {
      const batch = servers.slice(i, i + this.MAX_CONCURRENT);
      const batchResults = await Promise.all(batch.map((server) => this.testTcpServer(server)));

      batchResults.forEach((result) => {
        results.set(result.serverId, result.latency);
        onResult?.(result.serverId, result.latency);
        if (result.error) {
          this.logManager.addLog(
            'warn',
            `测速失败 ${result.serverId}: ${result.error}`,
            'SpeedTest'
          );
        }
      });
    }

    return results;
  }

  /**
   * 测试单个服务器 (TCP Ping)
   */
  private async testTcpServer(server: ServerConfig): Promise<SpeedTestResult> {
    const start = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new net.Socket();
        const timeout = 5000; // 5秒超时

        socket.setTimeout(timeout);

        socket.on('connect', () => {
          socket.destroy();
          resolve();
        });

        socket.on('timeout', () => {
          socket.destroy();
          reject(new Error('Timeout'));
        });

        socket.on('error', (err) => {
          socket.destroy();
          reject(err);
        });

        // 如果是 IPv6 且带有中括号，去除中括号以供 net.Socket 使用
        const isIpv6 = server.address.includes(':');
        const connectAddress =
          isIpv6 && server.address.startsWith('[') && server.address.endsWith(']')
            ? server.address.slice(1, -1)
            : server.address;

        socket.connect({
          port: server.port,
          host: connectAddress,
          family: isIpv6 ? 6 : 0,
        });
      });

      const latency = Date.now() - start;
      return {
        serverId: server.id,
        latency,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        serverId: server.id,
        latency: null,
        error: errorMessage,
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  UDP/QUIC 测速：通过临时 sing-box HTTP 代理
  // ═══════════════════════════════════════════════════════════════

  /**
   * 经临时 sing-box 真实测速（全协议）：每个可用节点起独立 HTTP 入站 → 该节点出站，经 CONNECT 隧道发两次 GET 测速端点
   * （默认 generate_204，可经 testUrl 自配，兼容 http/https）量 warm TTFB（详见 measureViaTunnel）。不可用节点（naive
   * 缺 libcronet 等）预先剔除为 null、不进临时核。
   * @param onResult 可选逐节点回调：每测完一个节点即回传（serverId, latency），供 UI 流式增量显示。
   * @param testUrl 可选测速端点 URL（非法回落默认 generate_204）。
   */
  private async testServersViaProxy(
    servers: ServerConfig[],
    onResult?: (serverId: string, latency: number | null) => void,
    onProgress?: (tested: number, ok: number, total: number) => void,
    testUrl?: string
  ): Promise<Map<string, number | null>> {
    const results = new Map<string, number | null>();
    // 进度计数：每个节点得出结果（含 null/不可用/失败）即 tested++，成功 ok++；total 含不可用节点。
    let tested = 0;
    let ok = 0;
    const total = servers.length;
    const report = (id: string, latency: number | null) => {
      onResult?.(id, latency);
      tested++;
      if (latency !== null) ok++;
      onProgress?.(tested, ok, total);
    };
    let singboxProcess: ChildProcess | null = null;
    let configFilePath: string | null = null;

    // 构造各节点出站；不可用（naive 缺 libcronet / 异常）→ 直接 null，不进临时核（避免预初始化 FATAL 拖垮整批）。
    const getOutbound =
      this.buildOutboundFn ?? ((s: ServerConfig, t: string) => this.buildOutbound(s, t));
    const usable: { server: ServerConfig; tag: string; outbound: Record<string, unknown> }[] = [];
    for (const s of servers) {
      const tag = `out-${s.id.slice(0, 8)}`;
      const ob = getOutbound(s, tag);
      if (ob) usable.push({ server: s, tag, outbound: ob });
      else {
        results.set(s.id, null);
        report(s.id, null);
      }
    }
    if (usable.length === 0) return results;

    // 解析测速端点（一次，预热+正式共用）；非法 testUrl 经 resolveSpeedTestTarget 回落默认 generate_204。
    const target = resolveSpeedTestTarget(testUrl);

    try {
      // 1. 为可用节点分配 HTTP 代理端口
      const ports = await this.findFreePorts(usable.length);
      const serverPortMap = new Map<string, number>(); // serverId → HTTP proxy port
      usable.forEach((u, idx) => serverPortMap.set(u.server.id, ports[idx]));

      // 2. 生成临时 sing-box 配置（每节点独立 HTTP 入站 → 该节点出站）
      const config = this.generateProxyTestConfig(usable, serverPortMap);

      // 3. 写入临时配置文件
      const userDataPath = getUserDataPath();
      configFilePath = path.join(userDataPath, `speedtest_${Date.now()}.json`);
      await fs.writeFile(configFilePath, JSON.stringify(config, null, 2));

      // 4. 启动临时 sing-box 进程
      const singboxPath = resourceManager.getSingBoxPath();
      singboxProcess = spawn(singboxPath, ['run', '-c', configFilePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // 收集 stderr 用于调试
      let stderrOutput = '';
      singboxProcess.stderr?.on('data', (data: Buffer) => {
        stderrOutput += data.toString();
      });

      // 监听进程异常退出
      let processExited = false;
      singboxProcess.on('exit', (code) => {
        processExited = true;
        if (code !== null && code !== 0) {
          this.logManager.addLog(
            'warn',
            `临时 sing-box 进程退出 (code=${code}): ${stderrOutput.slice(0, 500)}`,
            'SpeedTest'
          );
        }
      });

      // 5. 等待 sing-box 就绪（连第一个 HTTP 代理端口）。应用分流规则集下载可能耗时，给 10s。
      const ready = await this.waitForPortReady(ports[0], 10000);
      if (!ready || processExited) {
        this.logManager.addLog(
          'warn',
          `sing-box 测速进程未就绪: ${stderrOutput.slice(0, 500)}`,
          'SpeedTest'
        );
        for (const u of usable) {
          results.set(u.server.id, null);
          report(u.server.id, null);
        }
        return results;
      }

      // 6. 测速：每节点经各自 HTTP 代理建一条 CONNECT 隧道，在同一条隧道上发两次 GET、只计第二次（warm RTT）——
      //    对齐 mihomo unified-delay：第一次承担建连+握手暖身（丢弃计时），第二次是不含握手的纯请求延迟＝「实际请求
      //    时间」。冷握手挪到被丢弃的第一次，故 32 并发的争用也不污染上报值；measureViaTunnel 内部已暖身，无需独立
      //    预热轮。并发上限避免大订阅 N 路握手同时打出→请求风暴假超时；小订阅(≤上限)等价全并行。
      //    每测完一个节点立即回调 onResult（UI 流式显示），不等队列。
      await this.runWithLimit(usable, SpeedTestService.PROXY_TEST_CONCURRENCY, async (u) => {
        const port = serverPortMap.get(u.server.id)!;
        const latency = await this.measureViaTunnel(
          port,
          SpeedTestService.MEASURE_TIMEOUT_MS,
          target
        );
        results.set(u.server.id, latency);
        report(u.server.id, latency);
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logManager.addLog('error', `测速异常: ${msg}`, 'SpeedTest');
      for (const u of usable) {
        if (!results.has(u.server.id)) {
          results.set(u.server.id, null);
          report(u.server.id, null);
        }
      }
    } finally {
      // 清理临时进程
      if (singboxProcess && !singboxProcess.killed) {
        singboxProcess.kill('SIGTERM');
        const forceKillTimer = setTimeout(() => {
          try {
            singboxProcess?.kill('SIGKILL');
          } catch {
            // 进程可能已退出
          }
        }, 2000);
        singboxProcess.on('exit', () => clearTimeout(forceKillTimer));
      }
      // 清理临时配置文件
      if (configFilePath) {
        try {
          await fs.unlink(configFilePath);
        } catch {
          // ignore
        }
      }
    }

    return results;
  }

  /**
   * 生成用于测速的 sing-box 配置：每个可用节点一个独立 HTTP 代理入站 → 该节点（预构造）出站/endpoint。
   * 由 ProxyManager.buildSpeedTestOutbound 预构造：普通协议→outbound，WireGuard→endpoint（进 endpoints[]）；
   * route 规则按 tag 指向，两者一致（endpoint tag 当 outbound 用，已实测兼容）。
   */
  private generateProxyTestConfig(
    usable: { server: ServerConfig; tag: string; outbound: Record<string, unknown> }[],
    serverPortMap: Map<string, number>
  ): Record<string, unknown> {
    const inbounds: Record<string, unknown>[] = [];
    const outbounds: Record<string, unknown>[] = [];
    const endpoints: Record<string, unknown>[] = [];
    const routeRules: Record<string, unknown>[] = [];

    for (const { server, tag, outbound } of usable) {
      const port = serverPortMap.get(server.id);
      if (!port) continue;
      const inboundTag = `http-in-${server.id.slice(0, 8)}`;
      inbounds.push({ type: 'http', tag: inboundTag, listen: '127.0.0.1', listen_port: port });
      // endpoint（WireGuard/Tailscale）进 endpoints[]，普通协议进 outbounds[]；route 规则均按 tag 指向（一致）。
      // 按单一真值 isEndpointProtocol 判 type（非硬编码 'wireguard'），未来新增 endpoint 类型自动归位、不误进 outbounds。
      if (isEndpointProtocol(outbound.type as string)) {
        endpoints.push(outbound);
      } else {
        outbounds.push(outbound); // 预构造的出站（tag 已为 out-<id8>）
      }
      routeRules.push({ inbound: [inboundTag], action: 'route', outbound: tag });
    }

    // 必须有 direct 出站（sing-box 启动要求）
    outbounds.push({ type: 'direct', tag: 'direct' });

    const config: Record<string, unknown> = {
      log: { level: 'warn' },
      dns: {
        // sing-box 1.13+ 要求显式 type；出站 domain_resolver 与 default_domain_resolver 均指向本 tag
        servers: [{ tag: 'dns-direct', type: 'udp', server: '223.5.5.5', server_port: 53 }],
      },
      inbounds,
      outbounds,
      route: {
        rules: routeRules,
        auto_detect_interface: true,
        default_domain_resolver: 'dns-direct',
      },
    };
    if (endpoints.length > 0) config.endpoints = endpoints; // WireGuard 测速：顶层 endpoints[]
    return config;
  }

  /**
   * 为单个 UDP 服务器生成 sing-box outbound 配置
   */
  private buildOutbound(server: ServerConfig, tag: string): Record<string, unknown> {
    const protocol = server.protocol.toLowerCase();

    const outbound: Record<string, unknown> = {
      type: protocol,
      tag,
      server: server.address,
      server_port: server.port,
    };

    // ── Hysteria2 ──
    if (protocol === 'hysteria2') {
      outbound.password = server.password;

      if (server.hysteria2Settings?.upMbps) {
        outbound.up_mbps = server.hysteria2Settings.upMbps;
      }
      if (server.hysteria2Settings?.downMbps) {
        outbound.down_mbps = server.hysteria2Settings.downMbps;
      }
      if (server.hysteria2Settings?.obfs?.type && server.hysteria2Settings?.obfs?.password) {
        outbound.obfs = {
          type: server.hysteria2Settings.obfs.type,
          password: server.hysteria2Settings.obfs.password,
        };
      }
      if (server.hysteria2Settings?.network) {
        outbound.network = server.hysteria2Settings.network;
      }
    }

    // ── TUIC ──
    if (protocol === 'tuic') {
      outbound.uuid = server.uuid;
      outbound.password = server.password;

      if (server.tuicSettings) {
        if (server.tuicSettings.congestionControl) {
          outbound.congestion_control = server.tuicSettings.congestionControl;
        }
        if (server.tuicSettings.udpRelayMode) {
          outbound.udp_relay_mode = server.tuicSettings.udpRelayMode;
        }
        if (server.tuicSettings.zeroRttHandshake !== undefined) {
          outbound.zero_rtt_handshake = server.tuicSettings.zeroRttHandshake;
        }
        // heartbeat 经 normalizeDuration 收敛：表单录入裸毫秒整数会致测速内核 ParseDuration FATAL；带单位幂等。
        const heartbeat = normalizeDuration(server.tuicSettings.heartbeat);
        if (heartbeat) {
          outbound.heartbeat = heartbeat;
        }
      }
    }

    // ── TLS（hysteria2 和 tuic 都强制开启）──
    const tls: Record<string, unknown> = {
      enabled: true,
      server_name: server.tlsSettings?.serverName || server.address,
      insecure: server.tlsSettings?.allowInsecure || false,
    };
    if (server.tlsSettings?.alpn) {
      tls.alpn = server.tlsSettings.alpn;
    }
    outbound.tls = tls;

    return outbound;
  }

  // ═══════════════════════════════════════════════════════════════
  //  工具方法
  // ═══════════════════════════════════════════════════════════════

  /**
   * 经本地 HTTP 代理（临时 sing-box 各节点入站）测单节点延迟，量「实际请求时间」（不含建连/握手）。
   *
   * 做法对齐 mihomo `unified-delay`：CONNECT 到测速目标建一条隧道（= 已建立的「代理+目标」连接，等价 mihomo dial
   * 出来的 instance），https 目标先在隧道上做一次 TLS 握手；随后在**同一条**连接上发两次 GET——第一次暖身（承担
   * 建连+握手+冷启动，丢弃计时），第二次只量请求往返（响应头收齐 = warm TTFB）。
   * HTTP/HTTPS 走同一隧道路径：第二次请求是否 warm 不依赖 sing-box 入站是否复用出站（隧道本身就是那条已建立的连接），
   * 避免赌核内部行为。返回 null = 不可达/超时/对端过早关闭；单一总超时 timeout 兜底。
   */
  private measureViaTunnel(
    proxyPort: number,
    timeout: number,
    target: SpeedTestTarget
  ): Promise<number | null> {
    return new Promise((resolve) => {
      // 持有所有已建立句柄，finish 时统一 destroy（防 fd/socket 泄漏：大订阅并发 32 时累积）。
      let connectReq: http.ClientRequest | null = null;
      let tunnel: net.Socket | null = null;
      let tlsSock: tls.TLSSocket | null = null;
      let done = false;
      const finish = (v: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        tlsSock?.destroy();
        tunnel?.destroy();
        connectReq?.destroy();
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), timeout);

      // CONNECT 始终显式 host:port（标准端口也带，避免非标端口拼接歧义）。
      const connectHost = `${target.host}:${target.port}`;
      connectReq = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        method: 'CONNECT',
        path: connectHost,
        headers: { Host: connectHost },
        timeout,
      });
      connectReq.on('error', () => finish(null));
      connectReq.on('timeout', () => finish(null));
      // CONNECT 非 2xx（如 502）实测仍走 'connect'（携带 statusCode），由下方 statusCode 判定兜 null；
      // 'response' 仅兜「代理把 CONNECT 降级成普通 HTTP 响应」的边缘情况，避免挂到总超时。
      connectReq.on('response', () => finish(null));
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          finish(null); // finish 内统一 destroy socket
          return;
        }
        tunnel = socket;
        socket.setNoDelay(true); // 关 Nagle：小请求 TTFB 不被 delayed-ACK/合包拖慢
        if (target.https) {
          // 隧道上做一次 TLS 握手（仅一次，归入第一次暖身）；测速仅量可达性+TTFB，不校验证书（与 HTTP 路径等价）。
          tlsSock = tls.connect(
            { socket, servername: target.host, rejectUnauthorized: false },
            () => this.measureWarmRtt(tlsSock!, target, finish)
          );
          tlsSock.on('error', () => finish(null));
        } else {
          this.measureWarmRtt(socket, target, finish);
        }
      });
      connectReq.end();
    });
  }

  /**
   * 在一条已建立的隧道（net.Socket 或隧道上的 tls.TLSSocket）上发两次 GET，只计第二次「响应头收齐」的耗时（warm RTT）。
   *
   * 按 HTTP 报文边界（`\r\n\r\n`）在**连续缓冲**上数两次响应，**不是**见字节就判定——否则第一次响应的跨 chunk 残余
   * （TLS record/TCP 分段/CDN 多次 write）会被误当第二次首字节，使上报值塌成 ≈0ms（比虚高更危险，会误选坏节点）。
   * 切到第二次前**整段清空 buf**（连第一次响应的 body 残余一并丢弃——第二次请求此刻才发出，残余绝不含第二次数据）；
   * 计到第二次响应头收齐，与 mihomo `client.Do`（收齐响应头即返回）同口径。用 GET 而非 HEAD：默认端点 generate_204
   * 为 GET 设计、204 规范无 body，连接可立即复用；HEAD 可能 405/行为不一。
   * 请求用 origin-form（隧道直连 origin，路径非代理绝对 URI）。
   */
  private measureWarmRtt(
    conn: net.Socket | tls.TLSSocket,
    target: SpeedTestTarget,
    finish: (v: number | null) => void
  ): void {
    const HEADER_END = '\r\n\r\n';
    const request =
      `GET ${target.path} HTTP/1.1\r\n` +
      `Host: ${target.hostHeader}\r\n` +
      `Connection: keep-alive\r\n\r\n`;
    let buf = '';
    let firstDone = false;
    let start = 0;

    conn.on('data', (chunk: Buffer) => {
      // latin1 单字节编码：逐 chunk 拼接不会把多字节字符跨 chunk 错位，ASCII 的响应头与 \r\n\r\n 边界检测安全。
      // 勿改 utf8（会引入跨 chunk 截断）。
      buf += chunk.toString('latin1');
      if (!firstDone) {
        if (buf.indexOf(HEADER_END) < 0) return; // 第一次响应头未收齐，继续累积（跨 chunk 安全）
        // 第一次（暖身）响应头收齐：整段清空 buf（含可能的 body 残余）。第二次请求此刻才发出（下行 write），
        // 故残余绝不含第二次响应数据——只 slice 到响应头会让自配「非 204 带 body」端点的 body（含空行）污染
        // 第二次判定、塌成 ≈0ms，故整段丢弃。计时发第二次。
        firstDone = true;
        buf = '';
        start = Date.now();
        conn.write(request);
      } else {
        // 第二次响应：从第二次状态行 `HTTP/` 锚定起判「响应头收齐」，跳过可能先于第二次响应到达的第一次 body 残余
        // （自配非 204 端点 + header/body 分段时，body 残余会先入清空后的 buf；不从 HTTP/ 起算会把它误当第二次）。
        const sl = buf.indexOf('HTTP/');
        if (sl < 0 || buf.indexOf(HEADER_END, sl) < 0) return; // 第二次状态行/响应头未到齐
        finish(Date.now() - start); // 收齐第二次响应头 = 不含握手的纯请求往返
      }
    });
    conn.on('error', () => finish(null));
    conn.on('end', () => finish(null)); // 对端在测完前关闭 → 失败
    conn.write(request); // 第一次（暖身，丢弃计时）
  }

  /**
   * 并发上限执行（固定大小 worker 池）：最多 `limit` 个任务同时进行，其余排队。
   * 用于预热/测速——小订阅(items≤limit)即全并行，大订阅分波，消除请求风暴假超时。
   */
  private async runWithLimit<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>
  ): Promise<void> {
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        await fn(items[i]);
      }
    });
    await Promise.all(workers);
  }

  /**
   * 找到多个系统可用的空闲端口
   */
  private async findFreePorts(count: number): Promise<number[]> {
    const servers: net.Server[] = [];
    const ports: number[] = [];

    try {
      // 同时绑定所有端口，确保不冲突
      for (let i = 0; i < count; i++) {
        const srv = net.createServer();
        await new Promise<void>((resolve, reject) => {
          srv.listen(0, '127.0.0.1', () => resolve());
          srv.on('error', reject);
        });
        ports.push((srv.address() as net.AddressInfo).port);
        servers.push(srv);
      }
    } finally {
      // 关闭所有临时服务器，释放端口给 sing-box 使用
      await Promise.all(
        servers.map((srv) => new Promise<void>((resolve) => srv.close(() => resolve())))
      );
    }

    return ports;
  }

  /**
   * 等待端口可连接（表示 sing-box 已就绪）
   */
  private async waitForPortReady(port: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(500);
        socket.on('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => {
          socket.destroy();
          resolve(false);
        });
        socket.on('timeout', () => {
          socket.destroy();
          resolve(false);
        });
        socket.connect(port, '127.0.0.1');
      });

      if (ok) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }
}
