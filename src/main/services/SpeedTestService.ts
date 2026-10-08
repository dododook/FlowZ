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
import {
  resolveSpeedTestTarget,
  parseHttpStatusCode,
  isAcceptableSpeedTestStatus,
  type SpeedTestTarget,
  type MainCoreProbe,
  type SpeedTestOutcome,
  type SpeedTestSkipped,
  type SpeedTestRunResult,
} from '../../shared/speed-test';

/** 一次测速运行的可变上下文（各路径就地填充 outcome/skipped，doTestAllServers 收口读取 §16.2）：
 *  - outcome 缺省 completed；任一 superseded()/gen-change abort 点置 interrupted（含崩溃：superseded 含 !isRunning）。
 *  - skipped=起测即知「本核不可测」的波前缺席节点（不入 outcome、notInPool 供徽标 tooltip 信号）。 */
interface SpeedTestRunContext {
  outcome: SpeedTestOutcome;
  skipped: SpeedTestSkipped;
}
import { isEndpointProtocol, isSpeedTestable } from '../../shared/endpoint-routes';
import { normalizeDuration } from '../../shared/duration';

/** 基于 UDP/QUIC 的协议，需要走真实代理测速 */
const UDP_PROTOCOLS = new Set(['hysteria2', 'tuic']);

export interface SpeedTestResult {
  serverId: string;
  latency: number | null; // null 表示超时或失败
  error?: string;
}

export interface SpeedTestFailureDiagnostic {
  serverId: string;
  serverName?: string;
  tag?: string;
  reason: string;
}

export interface SpeedTestResolvedIpDiagnostic {
  serverId: string;
  serverName?: string;
  tag?: string;
  targetHost: string;
  resolverPath: string;
  resolvedIps: string[];
  error?: string;
}

export interface SpeedTestDiagnosticSnapshot {
  generatedAt: string;
  target: {
    host: string;
    port: number;
    path: string;
    https: boolean;
    hostHeader: string;
  };
  total: number;
  usable: number;
  failures: SpeedTestFailureDiagnostic[];
  resolvedIpProbes: SpeedTestResolvedIpDiagnostic[];
  tempConfig?: Record<string, unknown>;
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
  /** endpoint 失败后的结构化 DNS 探测超时。只走失败 endpoint，避免影响正常测速值。 */
  private static readonly DNS_PROBE_TIMEOUT_MS = 1500;
  /**
   * 出站构造器（由 index.ts 注入 ProxyManager.buildSpeedTestOutbound）：注入后**所有协议**统一走「临时 sing-box
   * 经代理 urltest」真实测速（端口通≠代理可用，裸 TCP ping 测不出鉴权/中继失败）；返回 null=该节点不可用（如 naive
   * 缺 libcronet）→ 跳过。未注入（兜底/单测）时退回旧的 TCP ping + UDP 代理拆分。
   */
  private buildOutboundFn?: (server: ServerConfig, tag: string) => Record<string, unknown> | null;

  /**
   * §15 主核测速探测池句柄取值器（由 index.ts 注入，call-time 懒引用 ProxyManager.getSpeedTestMainCoreProbe）：
   * 主核运行 + 池就绪 → 测速走主核（testServersViaMainCore，同核单会话消除 WG/WARP 双会话超时）；否则回退临时核。
   * 未注入（单测/兜底）→ 恒回退临时核路径，行为不变。
   */
  private getMainCoreProbe?: () => MainCoreProbe | null;

  /**
   * §15.11 核生命周期世代取值器（由 index.ts 注入，call-time 拉 ProxyManager.getLifecycleGeneration）：测速起测时
   * 快照 gen0，逐波/每 report 前比对——超代（核 start/stop/restart 中途跃迁）即 abort，保留已测、绝不给未测节点写假
   * -1。缺省 `() => 0`（未注入=单测/兜底）→ 恒不超代，行为与今日一致（回归保护）。
   */
  private getCoreGeneration: () => number;

  /** 进行中的测速 Promise + 其覆盖的节点 id 集：多入口并发（首页/托盘/页级全部/本组/单节点，各传不同 serverIds
   *  子集）时按「覆盖」编排——新请求 ⊆ 在飞集 → 复用同一次（零重跑、避免双临时 sing-box 端口冲突）；未覆盖 → 串行链
   *  在其后（不同分组/单节点/子集先-全量后 各自被完整测到，永不并发双 sing-box、无静默漏测）。 */
  private currentTest: Promise<SpeedTestRunResult> | null = null;
  private currentTestIds: Set<string> | null = null;
  private lastDiagnostics: SpeedTestDiagnosticSnapshot | null = null;

  constructor(
    logManager: LogManager,
    buildOutboundFn?: (server: ServerConfig, tag: string) => Record<string, unknown> | null,
    getMainCoreProbe?: () => MainCoreProbe | null,
    getCoreGeneration?: () => number
  ) {
    this.logManager = logManager;
    this.buildOutboundFn = buildOutboundFn;
    this.getMainCoreProbe = getMainCoreProbe;
    // 缺省恒返 0 → getCoreGeneration()!==gen0 恒 false → 永不超代（回归安全）。
    this.getCoreGeneration = getCoreGeneration ?? (() => 0);
  }

  getLastSpeedTestDiagnostics(): SpeedTestDiagnosticSnapshot | null {
    return this.lastDiagnostics;
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
  ): Promise<SpeedTestRunResult> {
    // 单一真值闸（下沉于此，UI/托盘两入口共用）：此处仅剔「**永久**不可测」节点（自定义 endpoint / reverseMesh system
    // 内核接口 / mesh-only 无出口）——它们对任何路径都返 null→-1「超时」，与 UI 角标「不适用」口径冲突。
    // §16.1 path-aware 的 TS-exit（仅主核池可用时可测）是**瞬态**判定，**不在此按入队瞬刻的 caps 冻结**：本次请求可能
    // 串在在飞测速之后，doTestAllServers 数十秒后才真正执行——入队时核停冻结掉 TS 会致「排队期间核起来了却仍被剔、既不
    // 测也不进 skipped 静默漏测」。故用恒真 caps（mainCorePool:true）只筛掉永久不可测，把 TS-exit 的真实取舍下沉到
    // doTestAllServers 执行侧按 runtime caps 决定（主核路径测之 / 临时核路径按 mainCorePool:false 剔入 tsNotReady 出信号）。
    const testable = servers.filter((s) => isSpeedTestable(s, { mainCorePool: true }));
    if (testable.length === 0) {
      return {
        results: new Map(),
        outcome: 'completed',
        skipped: { notInPool: [], tsNotReady: [] },
      };
    }
    // 并发编排（多入口各传不同子集）：按「在飞测速是否覆盖本次请求」决定复用 or 串行。
    const inFlight = this.currentTest;
    const inFlightIds = this.currentTestIds;
    const requestIds = new Set(testable.map((s) => s.id));
    if (inFlight && inFlightIds && [...requestIds].every((id) => inFlightIds.has(id))) {
      // 覆盖态（在飞集 ⊇ 本次请求）：复用同一次测速，零重跑。second caller 拿同一份 final results，其 onResult/
      // onProgress 不驱动（流式只由 first caller），但 EVENT_SPEED_TEST_RESULT/PROGRESS 是 IPC broadcast，
      // 本 caller 的 renderer 仍收得到（latencyMap/进度照常更新）。
      return inFlight;
    }
    // 未覆盖（不同分组 / 单节点先-全量后 / 子集先-全量后）：串行链在在飞测速之后跑——永不并发双临时 sing-box
    // （端口/资源冲突），且本次请求的节点集用**自身** set 完整测到（杜绝旧「无条件复用」导致的静默漏测/错测）。
    const run = inFlight
      ? inFlight
          .catch(() => {}) // 吞前一次异常，仅为串行不断链（本次独立、不受前次成败影响）
          .then(() => this.doTestAllServers(testable, onResult, onProgress, testUrl))
      : this.doTestAllServers(testable, onResult, onProgress, testUrl);
    this.currentTest = run;
    this.currentTestIds = requestIds;
    void run.finally(() => {
      // 仅当仍是最新一次（其后无更晚的串行链接）才清空，避免清掉排队中的下一次。
      if (this.currentTest === run) {
        this.currentTest = null;
        this.currentTestIds = null;
      }
    });
    return run;
  }

  private async doTestAllServers(
    servers: ServerConfig[],
    onResult?: (serverId: string, latency: number | null) => void,
    onProgress?: (tested: number, ok: number, total: number) => void,
    testUrl?: string
  ): Promise<SpeedTestRunResult> {
    // §15.11：起测时快照核生命周期世代——本次测速 = 绑定于 gen0 的作业，任一核 start/stop/restart/config-regen
    // 中途跃迁 → getCoreGeneration()!==gen0 → 超代 abort（保留已测、未测节点缺席 map、绝不写假 -1）。缺省 ()=>0 恒不超代。
    const gen0 = this.getCoreGeneration();
    // §16.2 一次运行的可变上下文：各路径就地填 outcome（abort 点置 interrupted）+ skipped（波前缺席）。
    const runCtx: SpeedTestRunContext = {
      outcome: 'completed',
      skipped: { notInPool: [], tsNotReady: [] },
    };

    // §15 主核路径（主核运行 + 池就绪）：经**已运行的主核** probe 池测全部节点——同 endpoint tag=同 WG 会话，
    // 结构性消除临时核双会话超时（G1）。复用现成 measureViaTunnel（warm-TTFB 保真），selectOutbound 热切 probe 槽。
    const mainCoreProbe = this.getMainCoreProbe?.();
    if (mainCoreProbe?.available() && mainCoreProbe.isRunning()) {
      this.logManager.addLog(
        'info',
        `开始测速: ${servers.length} 个节点（经主核探测池，${mainCoreProbe.poolPorts.length} 槽）`,
        'SpeedTest'
      );
      const results = await this.testServersViaMainCore(
        mainCoreProbe,
        servers,
        gen0,
        runCtx,
        onResult,
        onProgress,
        testUrl
      );
      const ok = [...results.values()].filter((v) => v !== null).length;
      this.logManager.addLog(
        'info',
        runCtx.outcome === 'interrupted'
          ? `测速中断：已测 ${ok}/${servers.length}（核生命周期跃迁，未测节点保留原值）`
          : `测速完成：成功 ${ok}/${servers.length}`,
        'SpeedTest'
      );
      return { results, outcome: runCtx.outcome, skipped: runCtx.skipped };
    }

    // 生产路径（注入了出站构造器）：**所有协议**统一走临时 sing-box 经代理 urltest，真实测速。
    // 此路径 = 主核未运行/未就绪时的临时核兜底（R-b：测一半用户开代理 → 主核 start → gen++ → abort，见 §15.11）。
    if (this.buildOutboundFn) {
      // §16.1 漂移防护：TS-exit 只有主核路径可测（临时核建不出第二 tsnet 实例）。上游 caps 快照若在主核运行时纳入了
      // TS-exit，而此刻主核已挂落到临时核路径（序列链竞态）→ 按临时核口径再剔 TS，防临时核对其 buildOutbound=null→假 -1。
      const tempServers = servers.filter((s) => isSpeedTestable(s, { mainCorePool: false }));
      // L-2：漂移剔除的 TS-exit 计入 skipped（可见性——toast 副行计数、不误算 outcome=interrupted；徽标由 renderer 派生
      // ts-needs-core）；否则「测速完成」但被请求的 TS 既无值也无任何提示（静默无下文）。
      for (const s of servers) {
        if (!tempServers.some((t) => t.id === s.id)) runCtx.skipped.tsNotReady.push(s.id);
      }
      this.logManager.addLog(
        'info',
        `开始测速: ${tempServers.length} 个节点（经代理 urltest）`,
        'SpeedTest'
      );
      const results = await this.testServersViaProxy(
        tempServers,
        gen0,
        runCtx,
        onResult,
        onProgress,
        testUrl
      );
      const ok = [...results.values()].filter((v) => v !== null).length;
      // 仅汇总，不逐节点列明（结果由 UI 节点延迟徽标承载）。
      this.logManager.addLog(
        'info',
        runCtx.outcome === 'interrupted'
          ? `测速中断：已测 ${ok}/${tempServers.length}`
          : `测速完成：成功 ${ok}/${tempServers.length}`,
        'SpeedTest'
      );
      return { results, outcome: runCtx.outcome, skipped: runCtx.skipped };
    }

    // 兜底路径（未注入构造器，如单测）：旧的 TCP 裸 ping + UDP 代理拆分。无 gen 语义 → 恒 completed。
    const tcpServers = servers.filter((s) => !UDP_PROTOCOLS.has(s.protocol.toLowerCase()));
    const udpServers = servers.filter((s) => UDP_PROTOCOLS.has(s.protocol.toLowerCase()));
    const results = new Map<string, number | null>();
    const [tcpResults, udpResults] = await Promise.all([
      this.testTcpServers(tcpServers, onResult),
      udpServers.length > 0
        ? this.testServersViaProxy(udpServers, gen0, runCtx, onResult, undefined, testUrl)
        : new Map<string, number | null>(),
    ]);
    for (const [id, latency] of tcpResults) results.set(id, latency);
    for (const [id, latency] of udpResults) results.set(id, latency);
    this.logManager.addLog('info', '测速完成', 'SpeedTest');
    return { results, outcome: runCtx.outcome, skipped: runCtx.skipped };
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

  private async testTcpServer(server: ServerConfig): Promise<SpeedTestResult> {
    const start = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new net.Socket();
        const timeout = 5000;

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
   * @param gen0 §15.11 起测时核生命周期世代快照：runWithLimit 内每 measure 前后比对，超代（核中途 START，R-b 瞬态
   *   双会话）即丢弃在飞结果、不 report、不写假 -1；临时核由 finally 照常杀。缺省 0（未注入=恒不超代，回归安全）。
   * @param onResult 可选逐节点回调：每测完一个节点即回传（serverId, latency），供 UI 流式增量显示。
   * @param testUrl 可选测速端点 URL（非法回落默认 generate_204）。
   */
  private async testServersViaProxy(
    servers: ServerConfig[],
    gen0 = 0,
    runCtx?: SpeedTestRunContext,
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
    // issue #154 ③：失败原因计数（reason→次数）+ 末尾分布日志，把「为何全超时」从玄学变可定位
    //（http-403=目标拒绝/查测速地址、connect-timeout=连不上、unusable=naive 缺库、core-not-ready=临时核没起）。
    const failReasons = new Map<string, number>();
    const failures: SpeedTestFailureDiagnostic[] = [];
    const resolvedIpProbes: SpeedTestResolvedIpDiagnostic[] = [];
    const resolvedIpProbePromises: Promise<SpeedTestResolvedIpDiagnostic>[] = [];
    const noteFail = (reason: string) =>
      failReasons.set(reason, (failReasons.get(reason) ?? 0) + 1);
    const noteNodeFail = (reason: string, server: ServerConfig, tag?: string): void => {
      noteFail(reason);
      failures.push({
        serverId: server.id,
        serverName: server.name,
        tag,
        reason,
      });
    };
    const logFailDist = () => {
      if (failReasons.size === 0) return;
      const dist = [...failReasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${r}×${n}`)
        .join('，');
      this.logManager.addLog('info', `测速失败原因分布：${dist}`, 'SpeedTest');
    };
    let singboxProcess: ChildProcess | null = null;
    let configFilePath: string | null = null;
    let tempConfig: Record<string, unknown> | undefined;
    let stderrOutput = '';
    let stdoutOutput = '';

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
        noteNodeFail('unusable', s, tag); // naive 缺 libcronet / 构造异常 → 不可测节点
        report(s.id, null);
      }
    }
    // 解析测速端点（一次，预热+正式共用）；非法 testUrl 经 resolveSpeedTestTarget 回落默认 generate_204。
    const target = resolveSpeedTestTarget(testUrl);
    if (usable.length === 0) {
      this.lastDiagnostics = {
        generatedAt: new Date().toISOString(),
        target,
        total,
        usable: 0,
        failures: [...failures],
        resolvedIpProbes: [],
      };
      logFailDist();
      return results;
    }

    try {
      // 1. 为可用节点分配 HTTP 代理端口
      const ports = await this.findFreePorts(usable.length);
      const serverPortMap = new Map<string, number>(); // serverId → HTTP proxy port
      usable.forEach((u, idx) => serverPortMap.set(u.server.id, ports[idx]));

      // 2. 生成临时 sing-box 配置（每节点独立 HTTP 入站 → 该节点出站；端点目标解析走穿隧道 223.5.5.5，geo 正确）
      const config = this.generateProxyTestConfig(usable, serverPortMap);
      tempConfig = config;

      // 3. 写入临时配置文件
      const userDataPath = getUserDataPath();
      configFilePath = path.join(userDataPath, `speedtest_${Date.now()}.json`);
      await fs.writeFile(configFilePath, JSON.stringify(config, null, 2));

      // 4. 启动临时 sing-box 进程
      const singboxPath = resourceManager.getSingBoxPath();
      singboxProcess = spawn(singboxPath, ['run', '-c', configFilePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // 收集临时核输出用于调试。正常退出也在 finally 以 debug 写 app.log；日志级别非 debug 时自动被 LogManager 过滤。
      singboxProcess.stdout?.on('data', (data: Buffer) => {
        stdoutOutput += data.toString();
      });
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
          noteNodeFail('core-not-ready', u.server, u.tag); // 临时 sing-box 未就绪：整批不可测
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
        // §15.11 R-b：核中途 START（临时核 + 新主核瞬态双会话）→ gen 变 → 丢弃、不 report（未测节点不写假 -1）。
        if (this.getCoreGeneration() !== gen0) {
          if (runCtx) runCtx.outcome = 'interrupted';
          return;
        }
        const port = serverPortMap.get(u.server.id)!;
        const { latency, reason } = await this.measureViaTunnel(
          port,
          SpeedTestService.MEASURE_TIMEOUT_MS,
          target
        );
        // 超代再检（measure 期间核可能刚 START）：绝不写假 -1——超代的未测 vs measureViaTunnel 真实失败(-1) 由此分流。
        if (this.getCoreGeneration() !== gen0) {
          if (runCtx) runCtx.outcome = 'interrupted';
          return;
        }
        results.set(u.server.id, latency);
        if (latency === null) {
          noteNodeFail(reason ?? 'unknown', u.server, u.tag); // ③ 记失败模式
          report(u.server.id, latency);
          if (isEndpointProtocol(u.outbound.type as string)) {
            resolvedIpProbePromises.push(
              this.probeEndpointTargetResolvedIps(
                port,
                u.server,
                u.tag,
                target.host,
                SpeedTestService.DNS_PROBE_TIMEOUT_MS
              )
            );
          }
          return;
        }
        report(u.server.id, latency);
      });
      resolvedIpProbes.push(...(await Promise.all(resolvedIpProbePromises)));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logManager.addLog('error', `测速异常: ${msg}`, 'SpeedTest');
      for (const u of usable) {
        if (!results.has(u.server.id)) {
          results.set(u.server.id, null);
          noteNodeFail('exception', u.server, u.tag);
          report(u.server.id, null);
        }
      }
    } finally {
      this.lastDiagnostics = {
        generatedAt: new Date().toISOString(),
        target,
        total,
        usable: usable.length,
        failures: [...failures],
        resolvedIpProbes: [...resolvedIpProbes],
        tempConfig,
      };
      logFailDist(); // ③ 末尾打失败原因分布（normal/not-ready/catch 路径都经 finally）
      const coreOutput = [stderrOutput, stdoutOutput].filter(Boolean).join('\n').trim();
      if (coreOutput) {
        this.logManager.addLog(
          'debug',
          `临时 sing-box 测速输出：${coreOutput.slice(-4000)}`,
          'SpeedTest'
        );
      }
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
  /**
   * §15 主核测速（方案 A）：经**已运行的主核**探测池测全部节点，结构性消除临时核 WG/WARP 双会话超时（G1）。
   * 编排（§15.5）：把 usable 按 K（池槽数）分波；每波先 gRPC selectOutbound 把 K 槽热切到本波各节点（1:1，
   * 节点[k]→probe-selector-k），再经 probe-in-k 端口跑**现成 measureViaTunnel**（warm-TTFB 逐字复用，唯一变量=
   * CONNECT 目标端口 poolPort[k]）。波间串行——同槽跨波复用，先测完（finish 已 destroy 隧道）再 selectOutbound
   * 重定向，interrupt_exist_connections 清残留、无跨节点串味。report/失败分布/onResult/onProgress 与临时核路径同款。
   * 池测结果权威（同 endpoint tag=同 WG 会话，成功真值），如实上报（含 null=真不通）；不再被临时核 null 覆盖。
   * §15.11：绑定起测世代 gen0——逐波前 + 每 report 前比对 getCoreGeneration()，超代（核 stop/restart/regen 中途跃迁，
   * R-a/R-c）即停发新波、丢在飞结果、return 已测部分 map（未测节点缺席 → 合并语义保留旧值，绝不写假 -1）。
   */
  private async testServersViaMainCore(
    probe: MainCoreProbe,
    servers: ServerConfig[],
    gen0: number,
    runCtx: SpeedTestRunContext,
    onResult?: (serverId: string, latency: number | null) => void,
    onProgress?: (tested: number, ok: number, total: number) => void,
    testUrl?: string
  ): Promise<Map<string, number | null>> {
    const results = new Map<string, number | null>();
    const poolPorts = probe.poolPorts;
    const K = poolPorts.length;
    // 进度/失败分布机制与 testServersViaProxy 同款（单一口径，UI/诊断零差异）。
    let tested = 0;
    let ok = 0;
    // 进度分母=实际会被 report 的节点数（波前缺席的 not-in-pool/ts-not-ready 不 report → 剔出分母，避免进度停在 <100%）；
    // 波前 gate 后重置为 poolTestable.length。
    let total = servers.length;
    const report = (id: string, latency: number | null) => {
      onResult?.(id, latency);
      tested++;
      if (latency !== null) ok++;
      onProgress?.(tested, ok, total);
    };
    const failReasons = new Map<string, number>();
    const failures: SpeedTestFailureDiagnostic[] = [];
    const resolvedIpProbes: SpeedTestResolvedIpDiagnostic[] = [];
    const noteNodeFail = (reason: string, server: ServerConfig, tag?: string): void => {
      failReasons.set(reason, (failReasons.get(reason) ?? 0) + 1);
      failures.push({ serverId: server.id, serverName: server.name, tag, reason });
    };
    const logFailDist = () => {
      if (failReasons.size === 0) return;
      const dist = [...failReasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${r}×${n}`)
        .join('，');
      this.logManager.addLog('info', `测速失败原因分布：${dist}`, 'SpeedTest');
    };

    // 上游 testAllServers 已按 isSpeedTestable(caps) 过滤（含 TS-exit）；此处再波前预筛「本核不可测」→ 缺席（不
    // select/measure/report、绝不写假 -1）：①非池成员（§16.3.3：订阅新增/改址未重启入池，tagOf 会回退裸 id →
    // selectOutbound throw → 旧代码假 -1）；②TS 节点未登录就绪（§16.1.3 层3）。缺席节点入 runCtx.skipped，不进 outcome
    // 分母（起测即知不可测≠中断），notInPool 另供徽标 tooltip 信号。
    const poolTestable: ServerConfig[] = [];
    for (const s of servers) {
      if (!probe.hasTag(s.id)) {
        runCtx.skipped.notInPool.push(s.id);
        noteNodeFail('not-in-pool', s);
        continue;
      }
      // §2：已编辑未生效（dirty）节点——运行核仍跑旧参数，测它得旧参数出口 latency 却挂新参数名下失真。波前剔除
      // 免测（徽标经 pendingChanges.modified 显「待生效」，非 notInPool 的「待入池」，故不入 skipped.notInPool）。
      // 传完整节点 s（本列表来自 ConfigManager 最新 config）→ 直接比其指纹 vs 快照，避 currentConfig 滞后漏判（F-B）。
      if (probe.isDirty(s)) {
        noteNodeFail('dirty-pending', s);
        continue;
      }
      if (s.protocol?.toLowerCase() === 'tailscale' && !probe.tsNodeReady(s.id)) {
        runCtx.skipped.tsNotReady.push(s.id);
        noteNodeFail('ts-not-ready', s, probe.tagOf(s.id));
        continue;
      }
      poolTestable.push(s);
    }
    total = poolTestable.length; // 进度分母=实际测量节点数（缺席节点已剔）
    const target = resolveSpeedTestTarget(testUrl);

    // §15.11 F1：超代 = 核生成号跃迁（start/stop/restart/regen）**或**核已不在运行（`!probe.isRunning()`）。后者覆盖
    // 「自发崩溃」——handleProcessExit 崩溃分支不 bump lifecycleGeneration（gen 检查漏判），但崩溃后 probe.isRunning()
    // 立即为 false，故经此把崩溃窗口的在飞 measure 失败判为「未测」而非真实失败 → 绝不写假 -1（诚实性根基）。
    // 反之：gen 不变且核仍运行时的 measureViaTunnel null 是**真实节点超时**，照常记 -1。
    const superseded = () => this.getCoreGeneration() !== gen0 || !probe.isRunning();

    try {
      for (let base = 0; base < poolTestable.length; base += K) {
        // §15.11 超代①：核跃迁/崩溃 → 停发新波，return 已测部分 map（未测节点缺席，不写假 -1）。§16.2 标 interrupted。
        if (superseded()) {
          runCtx.outcome = 'interrupted';
          return results;
        }
        const wave = poolTestable.slice(base, base + K);
        // 1. 本波各节点按槽热切 selector（node[k] → probe-selector-k，gRPC live 生效 15.3）。逐槽记成败：
        //    naive 缺库等被主核跳过的节点其 tag 非 selector 成员 → selectOutbound 抛错 → 记 select-failed（如实不可测）。
        const selected = await Promise.all(
          wave.map(async (node, k) => {
            try {
              await probe.selectSlot(k, probe.tagOf(node.id));
              return true;
            } catch {
              return false;
            }
          })
        );
        // 2. 本波并发测量，槽 k 严格用 poolPort[k]（1:1 绑定，不经 runWithLimit worker 池——那会丢失 k↔端口对应）。
        await Promise.all(
          wave.map(async (node, k) => {
            const tag = probe.tagOf(node.id);
            // §15.11 超代（selectSlot 期间核可能已跃迁/崩溃，stale-tag selectOutbound throw → selected[k]=false）：
            //   诚实性根基——超代导致的「未测/select 失败」绝不 report(-1)；仅 gen0 期核仍在的真实 select 失败才记 select-failed。
            if (superseded()) {
              runCtx.outcome = 'interrupted';
              return;
            }
            if (!selected[k]) {
              results.set(node.id, null);
              noteNodeFail('select-failed', node, tag); // 该节点非 probe-selector 成员（被主核跳过/不可用）
              report(node.id, null);
              return;
            }
            const port = poolPorts[k];
            const { latency, reason } = await this.measureViaTunnel(
              port,
              SpeedTestService.MEASURE_TIMEOUT_MS,
              target
            );
            // §15.11 超代②：measure 期间核跃迁/崩溃 → 丢在飞结果、不 report、不写假 -1（超代未测 vs 真实失败 -1 分流处）。
            if (superseded()) {
              runCtx.outcome = 'interrupted';
              return;
            }
            results.set(node.id, latency);
            if (latency === null) {
              noteNodeFail(reason ?? 'unknown', node, tag);
              report(node.id, null);
              // 端点失败结构化 DNS 探测：必须在本波内 await 完（下一波会把该槽 selector 重定向到别的节点）。
              if (isEndpointProtocol(node.protocol)) {
                resolvedIpProbes.push(
                  await this.probeEndpointTargetResolvedIps(
                    port,
                    node,
                    tag,
                    target.host,
                    SpeedTestService.DNS_PROBE_TIMEOUT_MS
                  )
                );
              }
              return;
            }
            report(node.id, latency);
          })
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logManager.addLog('error', `主核测速异常: ${msg}`, 'SpeedTest');
      // §15.11：仅非超代（核未跃迁/未崩溃）时把未测节点记 exception(-1)（真实异常）；超代下绝不写假 -1（缺席、保留旧值）。
      if (!superseded()) {
        for (const s of poolTestable) {
          if (!results.has(s.id)) {
            results.set(s.id, null);
            noteNodeFail('exception', s, probe.tagOf(s.id));
            report(s.id, null);
          }
        }
      } else {
        // §16.2：超代下异常 → 标 interrupted（未测节点缺席、绝不写假 -1）。
        runCtx.outcome = 'interrupted';
      }
    } finally {
      this.lastDiagnostics = {
        generatedAt: new Date().toISOString(),
        target,
        total,
        usable: poolTestable.length,
        failures: [...failures],
        resolvedIpProbes: [...resolvedIpProbes],
      };
      logFailDist();
    }

    return results;
  }

  private generateProxyTestConfig(
    usable: { server: ServerConfig; tag: string; outbound: Record<string, unknown> }[],
    serverPortMap: Map<string, number>
  ): Record<string, unknown> {
    const inbounds: Record<string, unknown>[] = [];
    const outbounds: Record<string, unknown>[] = [];
    const endpoints: Record<string, unknown>[] = [];
    const routeRules: Record<string, unknown>[] = [];
    // 解析节点 server 地址的国内 DNS（见下「两类解析不变量」）；端点另加穿隧道 DNS（dns-exit-<id8>）。
    const dnsServers: Record<string, unknown>[] = [
      { tag: 'dns-direct', type: 'udp', server: '223.5.5.5', server_port: 53 },
    ];
    const dnsRules: Record<string, unknown>[] = [];

    for (const { server, tag, outbound } of usable) {
      const port = serverPortMap.get(server.id);
      if (!port) continue;
      const id8 = server.id.slice(0, 8);
      const inboundTag = `http-in-${id8}`;
      inbounds.push({ type: 'http', tag: inboundTag, listen: '127.0.0.1', listen_port: port });
      routeRules.push({ inbound: [inboundTag], action: 'route', outbound: tag });
      // endpoint（WireGuard/WARP/未来 TS）进 endpoints[]，普通协议进 outbounds[]；route 均按 tag 指向。
      // 按单一真值 isEndpointProtocol 判 type（非硬编码 'wireguard'），未来端点类型自动归位。
      if (isEndpointProtocol(outbound.type as string)) {
        endpoints.push(outbound);
        // 端点是 L3（运 IP 包、不认域名）→ sing-box 强制**本地解析**目标域名（wireguard/endpoint.go 空 QueryOptions，
        // 过 dns.rules + default）。默认 dns-direct(223.5.5.5) 从**本机**解析 → 本机 geo 的 IP；但端点出口可能在别处
        // （境外 WARP / 国内自建 WG），本机 geo IP 出口够不着 → 超时/失真。故把目标解析经 inbound 键控 dns.rule 定向到
        // 「穿本节点隧道」的 223.5.5.5：查询从**出口**发出，AliDNS（有大陆节点 + ECS）按**出口地理**返 IP（境外出口→境外 IP、
        // 国内出口→国内 IP），出口恒够得着。真机双证：WARP→142.251.x(境外)/204、国内 WG→58.63.x(国内)/204；1.1.1.1 因
        // anycast 无大陆 PoP、在国内出口反挂（74.125.x 境外 IP 墙内不可达），故用 223.5.5.5 单形态覆盖境内外。
        // endpoint 级 domain_resolver 只管 peer 地址、禁指向隧道 DNS（peer 解析死锁 FATAL，实测）。
        const exitDnsTag = `dns-exit-${id8}`;
        dnsServers.push({
          tag: exitDnsTag,
          type: 'udp',
          server: '223.5.5.5',
          server_port: 53,
          detour: tag, // 查询穿本端点隧道 → AliDNS 按出口地理(ECS)返 IP
        });
        // 族别偏好（语义不变，写法迁移）：WG localAddress 含 v6 → v4 优先但保留 v6（避免 v6 优先落不可达）；
        // 纯 v4 → 只取 A（消 v6 解析噪声）。
        //
        // 迁移背景（sing-box 1.14.0，随包核 1.14.0-beta.2 本机 loopback 实测）：rule-action 上的 legacy
        // `strategy` 已废弃、run 时 WARN、1.16.0 移除；更要命的是它与**同一份 dns 配置内**任何带
        // `query_type`/`ip_version` 的规则（含引用带 query_type 的 rule-set）**互斥**——共存则 `sing-box run`
        // 与 `check` 双双硬拒（`initialize dns router: Legacy strategy ... is deprecated` FATAL）。主配置
        // （singbox-dns-builder）大量用 query_type，测速配置用 rule-action strategy，此前只是**恰好错开**。
        // 新写法改用 query_type 规则项表达，两侧不再有 legacy strategy，该雷结构性拆除。
        //
        //  · 旧 `prefer_ipv4` → **不下发任何东西**：本配置无顶层 `dns.strategy`（见下方 `dns` 组装），内核默认
        //    并发 A/AAAA 且把 v4 排在 v6 前（sortAddresses 对 AsIS 与 prefer_ipv4 同一分支）。实测两形态返回
        //    的地址列表逐项同序。⚠️ 该等价性**依赖测速配置不带顶层 dns.strategy**，由 speed-test-endpoint-dns
        //    单测「全仓禁 legacy rule-action strategy」一例锁死。
        //  · 旧 `ipv4_only` → 给该 inbound 的 AAAA 查询前置一条 predefined 空 NOERROR：AAAA 就地返空、不出网，
        //    结果集只剩 A。实测与 legacy ipv4_only 的出网查询与解析结果逐字节一致。
        //
        // 顺序有牙：抑制规则必须排在本节点 route 规则**之前**——DNS 规则先匹配先命中，route 规则是该 inbound 的
        // catch-all，排它前面则 AAAA 先被 route 吃掉、抑制静默失效（实测反证）。
        const hasV6 = !!server.wireguardSettings?.localAddress?.some((a) => a.includes(':'));
        if (!hasV6) {
          dnsRules.push({
            inbound: [inboundTag],
            query_type: ['AAAA'],
            action: 'predefined',
            rcode: 'NOERROR', // 空答复：等价旧 ipv4_only 的「不要 v6」，且不触发拒绝日志噪声
          });
        }
        dnsRules.push({
          inbound: [inboundTag], // 端点入站的目标解析走穿隧道 DNS（按出口地理）
          action: 'route',
          server: exitDnsTag,
          disable_cache: true, // 多端点并测出口 geo 答案各异，禁缓存防互污染（cache 按 question 全局共享）
        });
      } else {
        outbounds.push(outbound); // 预构造的出站（tag 已为 out-<id8>）
      }
    }

    // 必须有 direct 出站（sing-box 启动要求）
    outbounds.push({ type: 'direct', tag: 'direct' });

    // 两类解析不变量（issue #154 + 2026-07 端点修正，真机 debug 确证）：
    //  · 代理出站（vless/vmess/trojan/hy2/tuic/ss/snell/anytls/naive/ssh…）：目标域名以 ATYP=domain **透传给出口远程
    //    解析**，不经本机 dns-direct（代理 dialer 只拨 server 地址、destination 进协议头）。各节点量到自身真实路径。
    //    ⚠️ 勿引入 sniff / outbound.domain_strategy / 针对目标的本地解析——会破坏此不变量。
    //  · 端点（WG/WARP…L3）：**必本地解析**目标（内核强制）。故上方用 inbound 键控 dns.rule 把端点的目标解析压到穿隧道
    //    223.5.5.5（AliDNS ECS 按出口地理返 IP、geo 正确、单形态覆盖境内外出口）；default_domain_resolver 仍解节点 server 地址。
    // ⚠️ 恒不下发顶层 `dns.strategy`：端点族别偏好靠上方的 query_type 规则项表达，而「无顶层 strategy」
    // 正是「省略 prefer_ipv4 == prefer_ipv4」这一等价性的前提（顶层若为 prefer_ipv6，端点解析会翻成 v6 优先，
    // 实测确证）。要加顶层 strategy 必须同时重新推导端点规则，别只加一半。单测锁死本不变量。
    const dns: Record<string, unknown> = { servers: dnsServers };
    if (dnsRules.length > 0) dns.rules = dnsRules; // 仅有端点节点时下发；纯代理配置零变化
    const config: Record<string, unknown> = {
      // 诊断采集会把 LogManager 提到 debug；临时测速核随之提级，复现时能把测速核自身的 DNS/dial 细节带进 app.log。
      // 非采集态保持 warn，避免普通测速输出膨胀。
      log: { level: this.logManager.getLogLevel?.() === 'debug' ? 'debug' : 'warn' },
      dns,
      inbounds,
      outbounds,
      route: {
        rules: routeRules,
        // 独立测速核没有 TUN inbound，不存在 outbound 回灌自身的问题。关闭接口自动绑定，让 OS
        // 正确遵循 OpenVPN/EasyConnect 等通过更具体路由（macOS 常见 0/1 + 128/1）选出的出口。
        auto_detect_interface: false,
        default_domain_resolver: 'dns-direct',
      },
    };
    if (endpoints.length > 0) config.endpoints = endpoints; // 端点测速：顶层 endpoints[]
    return config;
  }

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
  ): Promise<{ latency: number | null; reason?: string }> {
    return new Promise((resolve) => {
      // 持有所有已建立句柄，finish 时统一 destroy（防 fd/socket 泄漏：大订阅并发 32 时累积）。
      let connectReq: http.ClientRequest | null = null;
      let tunnel: net.Socket | null = null;
      let tlsSock: tls.TLSSocket | null = null;
      let done = false;
      // issue #154 ③：latency=null 时带 reason（connect-/http-/tunnel-/timeout 等），供 testServersViaProxy 汇总
      // 失败原因分布——把「玄学超时」变成可定位（如 http-403=目标拒绝、connect-timeout=连不上）。
      const finish = (latency: number | null, reason?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        tlsSock?.destroy();
        tunnel?.destroy();
        connectReq?.destroy();
        resolve({ latency, reason });
      };
      const timer = setTimeout(() => finish(null, 'timeout'), timeout);

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
      connectReq.on('error', () => finish(null, 'connect-error'));
      connectReq.on('timeout', () => finish(null, 'connect-timeout'));
      // CONNECT 非 2xx（如 502）实测仍走 'connect'（携带 statusCode），由下方 statusCode 判定兜 null；
      // 'response' 仅兜「代理把 CONNECT 降级成普通 HTTP 响应」的边缘情况，避免挂到总超时。
      connectReq.on('response', () => finish(null, 'connect-downgraded'));
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          finish(null, `connect-${res.statusCode}`); // finish 内统一 destroy socket
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
          tlsSock.on('error', () => finish(null, 'tls-error'));
        } else {
          this.measureWarmRtt(socket, target, finish);
        }
      });
      connectReq.end();
    });
  }

  /**
   * 出口伴测入口（IpInfoService 代理出口探测成功后调用）：经主核 probe-proxy-in 的 HTTP 代理端口，用与节点测速
   * 完全相同的 CONNECT 隧道 + 2×GET 量 warm TTFB —— 产出口径 == latencyMap 的测速值（同端点/同算法/同 warm 语义），
   * 故可合法写入节点延迟。返回 null = 隧道不可用/超时/非 2xx/对端过早关闭 → 调用方放弃写入（绝不写 -1）。
   */
  async measureWarmRttViaHttpProxy(proxyPort: number, testUrl?: string): Promise<number | null> {
    const target = resolveSpeedTestTarget(testUrl);
    const { latency, reason } = await this.measureViaTunnel(
      proxyPort,
      SpeedTestService.MEASURE_TIMEOUT_MS,
      target
    );
    // 失败记 reason（connect-502/timeout/early-close/http-403 等）至 debug——伴测 runner 侧仅拿到 null，
    // 排障（真机 V6 失败降级）须在此保留原因，否则失败静默无从区分。
    if (latency === null) {
      // Y1（§12.3.2）：带 target host——V37 判读 WARP 无延迟根因（early-close / http-4xx / MTU timeout）须知打的哪个目标。
      this.logManager.addLog(
        'debug',
        `出口伴测失败 (${reason ?? 'unknown'}) target=${target.host}:${target.port} port=${proxyPort}`,
        'SpeedTest'
      );
    }
    return latency;
  }

  private async probeEndpointTargetResolvedIps(
    proxyPort: number,
    server: ServerConfig,
    tag: string,
    targetHost: string,
    timeout: number
  ): Promise<SpeedTestResolvedIpDiagnostic> {
    const resolverPath = `dns-exit-${server.id.slice(0, 8)} tcp/53 probe`;
    if (net.isIP(targetHost)) {
      return {
        serverId: server.id,
        serverName: server.name,
        tag,
        targetHost,
        resolverPath,
        resolvedIps: [targetHost],
      };
    }
    try {
      const resolvedIps = await this.queryDnsAOverTcpViaProxy(proxyPort, targetHost, timeout);
      return {
        serverId: server.id,
        serverName: server.name,
        tag,
        targetHost,
        resolverPath,
        resolvedIps,
        error: resolvedIps.length === 0 ? 'no-a-record' : undefined,
      };
    } catch (e: any) {
      return {
        serverId: server.id,
        serverName: server.name,
        tag,
        targetHost,
        resolverPath,
        resolvedIps: [],
        error: e?.message ?? String(e),
      };
    }
  }

  private queryDnsAOverTcpViaProxy(
    proxyPort: number,
    hostname: string,
    timeout: number
  ): Promise<string[]> {
    return new Promise((resolve, reject) => {
      let connectReq: http.ClientRequest | null = null;
      let socket: net.Socket | null = null;
      let done = false;
      let buf = Buffer.alloc(0);
      const finish = (err: Error | null, ips?: string[]) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket?.destroy();
        connectReq?.destroy();
        if (err) reject(err);
        else resolve(ips ?? []);
      };
      const timer = setTimeout(() => finish(new Error('dns-probe-timeout')), timeout);
      connectReq = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        method: 'CONNECT',
        path: '223.5.5.5:53',
        headers: { Host: '223.5.5.5:53' },
        timeout,
      });
      connectReq.on('error', () => finish(new Error('dns-probe-connect-error')));
      connectReq.on('timeout', () => finish(new Error('dns-probe-connect-timeout')));
      connectReq.on('response', () => finish(new Error('dns-probe-connect-downgraded')));
      connectReq.on('connect', (res, s) => {
        socket = s;
        if (res.statusCode !== 200) {
          s.destroy();
          finish(new Error(`dns-probe-connect-${res.statusCode}`));
          return;
        }
        socket.setNoDelay(true);
        socket.on('error', () => finish(new Error('dns-probe-socket-error')));
        socket.on('end', () => finish(new Error('dns-probe-early-close')));
        socket.on('data', (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          if (buf.length < 2) return;
          const len = buf.readUInt16BE(0);
          if (buf.length < len + 2) return;
          try {
            finish(null, SpeedTestService.parseDnsAResponse(buf.subarray(2, len + 2)));
          } catch (e: any) {
            finish(new Error(e?.message ?? String(e)));
          }
        });
        try {
          socket.write(SpeedTestService.buildDnsTcpQuery(hostname, 1));
        } catch (e: any) {
          finish(new Error(e?.message ?? String(e)));
        }
      });
      connectReq.end();
    });
  }

  private static buildDnsTcpQuery(hostname: string, qtype: number): Buffer {
    const labels = hostname.split('.').filter(Boolean);
    const qnameParts: Buffer[] = [];
    for (const label of labels) {
      const b = Buffer.from(label, 'ascii');
      if (b.length === 0 || b.length > 63) throw new Error('invalid-dns-label');
      qnameParts.push(Buffer.from([b.length]), b);
    }
    qnameParts.push(Buffer.from([0]));
    const body = Buffer.alloc(12 + qnameParts.reduce((n, b) => n + b.length, 0) + 4);
    let off = 0;
    body.writeUInt16BE(Math.floor(Math.random() * 0xffff), off);
    off += 2;
    body.writeUInt16BE(0x0100, off); // RD
    off += 2;
    body.writeUInt16BE(1, off); // QDCOUNT
    off += 2;
    body.writeUInt16BE(0, off); // ANCOUNT
    off += 2;
    body.writeUInt16BE(0, off); // NSCOUNT
    off += 2;
    body.writeUInt16BE(0, off); // ARCOUNT
    off += 2;
    for (const part of qnameParts) {
      part.copy(body, off);
      off += part.length;
    }
    body.writeUInt16BE(qtype, off);
    off += 2;
    body.writeUInt16BE(1, off); // IN
    const frame = Buffer.alloc(body.length + 2);
    frame.writeUInt16BE(body.length, 0);
    body.copy(frame, 2);
    return frame;
  }

  private static parseDnsAResponse(buf: Buffer): string[] {
    if (buf.length < 12) throw new Error('dns-response-short');
    const qd = buf.readUInt16BE(4);
    const an = buf.readUInt16BE(6);
    let off = 12;
    for (let i = 0; i < qd; i++) {
      off = SpeedTestService.skipDnsName(buf, off) + 4; // qtype + qclass
      if (off > buf.length) throw new Error('dns-question-truncated');
    }
    const ips: string[] = [];
    for (let i = 0; i < an; i++) {
      off = SpeedTestService.skipDnsName(buf, off);
      if (off + 10 > buf.length) throw new Error('dns-answer-truncated');
      const type = buf.readUInt16BE(off);
      const klass = buf.readUInt16BE(off + 2);
      const rdlen = buf.readUInt16BE(off + 8);
      off += 10;
      if (off + rdlen > buf.length) throw new Error('dns-rdata-truncated');
      if (type === 1 && klass === 1 && rdlen === 4) {
        ips.push(`${buf[off]}.${buf[off + 1]}.${buf[off + 2]}.${buf[off + 3]}`);
      }
      off += rdlen;
    }
    return ips;
  }

  private static skipDnsName(buf: Buffer, offset: number): number {
    let off = offset;
    let jumps = 0;
    while (off < buf.length) {
      const len = buf[off];
      if ((len & 0xc0) === 0xc0) {
        if (off + 1 >= buf.length) throw new Error('dns-pointer-truncated');
        jumps++;
        if (jumps > 16) throw new Error('dns-pointer-loop');
        return off + 2;
      }
      if (len === 0) return off + 1;
      if ((len & 0xc0) !== 0) throw new Error('dns-label-invalid');
      off += 1 + len;
    }
    throw new Error('dns-name-truncated');
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
    finish: (latency: number | null, reason?: string) => void
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
        // issue #154 ③ 校验响应码：非 2xx（如 cp.cloudflare 经 CF-Workers 的 403）判失败，不再把错误页当成功记 TTFB。
        const code = parseHttpStatusCode(buf.slice(sl));
        // code===null：响应头收齐但状态行无法解析出 3 位码（畸形/非标准）——无法确认 2xx，判失败，
        // 否则畸形响应会被当成功记 TTFB，软重引入 #154 修复前「错误页当成功」的问题。
        if (code === null || !isAcceptableSpeedTestStatus(code)) {
          finish(null, code === null ? 'http-unparsable' : `http-${code}`);
          return;
        }
        finish(Date.now() - start); // 收齐第二次响应头且 2xx = 不含握手的纯请求往返
      }
    });
    conn.on('error', () => finish(null, 'tunnel-error'));
    conn.on('end', () => finish(null, 'early-close')); // 对端在测完前关闭 → 失败
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
