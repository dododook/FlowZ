/**
 * 把「运行态系统里已有的诊断事实」汇成单个脱敏 Markdown：环境快照 + 运行态 + 脱敏 UserConfig +
 * 脱敏「实际下发给内核的 sing-box 配置」（#57 类一眼可见 DNS/route 根因）+ app.log / singbox.log /
 * singbox_startup.log（提权路径下的核启动日志，#324 盲区；内容按写侧而异，见 describeStartupLog）近期 tail。
 *
 * 设计取舍：单 Markdown 文件（非 zip）—— 一个文件更易上传、人可读、零新依赖（package.json 无 zip 库）。
 * 脱敏走单一真值 shared/diagnostic-redact，绝不漏密钥（公开 issue 附件零明文密钥，红线）。
 * 纯拼装/脱敏逻辑在 shared 模块且有单测；本服务只做 IO 与服务取数。
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import { app } from 'electron';
import type { UserConfig } from '../../shared/types';
import {
  buildDiagnosticReport,
  redactDeep,
  normalizeKey,
  collectNodeIdentifiers,
  type DiagnosticReportInput,
  type CoreProcessReport,
} from '../../shared/diagnostic-redact';
import { effectiveLogLevel } from '../../shared/log-level';
import { summarizeProcessMetrics, type RendererHeapSample } from '../../shared/process-metrics';
import {
  collectRendererHeap,
  sampleCoreProcess,
  serializeMemoryTimelineCsv,
} from './process-sampler';
import {
  getLogsPath,
  getSingBoxLogPath,
  getSingBoxStartupLogPath,
  getSingBoxConfigPath,
  getWindowsWatchdogLogPath,
} from '../utils/paths';
import path from 'path';
import type { LogManager } from './LogManager';
import type { ProxyManager } from './ProxyManager';
import type { SpeedTestDiagnosticSnapshot } from './SpeedTestService';
import type { IConfigManager } from './ConfigManager';
import type { ISystemProxyManager } from './SystemProxyManager';
import { resourceManager } from './ResourceManager';

/** 每个日志文件最多纳入报告的尾部字节数（足够排障，又不让报告爆大）。 */
const LOG_TAIL_BYTES = 64 * 1024;

/** 连接/DNS 类错误标记（命中且非 debug 级 → 提示开启诊断采集复现）。 */
const TROUBLE_RE =
  /servfail|dns|connection refused|timeout|timed out|handshake|authentication failed|no such host/i;

export class DiagnosticService {
  constructor(
    private readonly configManager: IConfigManager,
    private readonly logManager: LogManager,
    private readonly proxyManager: ProxyManager,
    private readonly systemProxyManager: ISystemProxyManager,
    private readonly privacyProvider: () => boolean = () => false,
    /** 渲染进程堆内省取数（index.ts 注入 executeJavaScript；缺省=不采）。issue #242 §6.2。 */
    private readonly rendererIntrospect?: () => Promise<RendererHeapSample | null>,
    /** 渲染进程内存 watchdog 计数取数（index.ts 注入本会话 discard/warn 次数 + 阈值；缺省=不纳入）。issue #242 §4。 */
    private readonly rendererWatchdogStats?: () => {
      discardCount: number;
      warnCount: number;
      thresholdMb: number;
    },
    /** 最近一次测速诊断快照（临时测速 config + 逐节点失败 reason）；缺省=无测速诊断段。 */
    private readonly speedTestDiagnosticsProvider?: () => SpeedTestDiagnosticSnapshot | null
  ) {}

  /** 读文件尾部最多 maxBytes 字节；不存在/失败返回占位串（绝不抛）。 */
  private async readTail(filePath: string, maxBytes: number): Promise<string> {
    try {
      const stat = await fs.stat(filePath);
      const start = Math.max(0, stat.size - maxBytes);
      const fd = await fs.open(filePath, 'r');
      try {
        const len = stat.size - start;
        const buf = Buffer.alloc(len);
        await fd.read(buf, 0, len, start);
        const text = buf.toString('utf-8');
        // 截断导致首行半截 → 丢弃首个不完整行，保持可读
        return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
      } finally {
        await fd.close();
      }
    } catch (e: any) {
      // 只回错误码，不回 e.message：Node 的 EACCES/EPERM message 内嵌完整路径（含 OS 用户名），而本报告是
      // 给公开 issue 当附件用的，redactIdentifiers 只打码节点标识符、不碰路径。singbox_startup.log 在
      // Windows helper 路径下由 SYSTEM 创建、fixFilePermissions 又只修 darwin，是三个 tail 里最可能踩到
      // 非 ENOENT 失败的那个。
      return e?.code === 'ENOENT' ? '(无日志文件)' : `(读取失败: ${e?.code ?? '未知错误'})`;
    }
  }

  /**
   * 描述 startup log 的**写侧**与文件元信息，供报告段标题如实标注。
   *
   * 为什么必须标：三个写侧写进去的东西根本不同（见 main/utils/paths.ts getSingBoxStartupLogPath），其中
   * Windows UAC 看护脚本压根不重定向核的输出——若段标题一律写「核 stdout/stderr」，读报告的人会把「只有
   * 看护脚本自述行、没有 FATAL」误读成「核什么都没打印」，与 issue #324 里那条假的「UAC 授权失败」是同一
   * 类误导。另外 Windows helper 侧 O_APPEND 永不截断，必须给出文件大小与最后写入时刻，否则无法判断这
   * 64KB tail 属于哪次会话（sing-box 的 FATAL[0000] 是启动相对秒，非墙钟时间）。
   */
  private async describeStartupLog(): Promise<string> {
    // isStartedViaHelper 反映最近一次启动走的路径（代理已停时即上一次），是此处能拿到的最准信息。
    const viaHelper = this.proxyManager.isStartedViaHelper();
    const writer = viaHelper
      ? '写侧 helper 服务：核 stdout+stderr，只追加不截断'
      : process.platform === 'darwin'
        ? '写侧 osascript wrapper：核 stdout+stderr，每次启动截断'
        : process.platform === 'win32'
          ? '写侧 UAC 看护脚本：核 stderr（-RedirectStandardError），每次起核截断；看护脚本自述行见下一段'
          : '非 helper 路径（直起）：核输出走 app.log 管道，本文件不被写入';
    try {
      const st = await fs.stat(getSingBoxStartupLogPath());
      const mb = (st.size / (1024 * 1024)).toFixed(2);
      return `${writer} · ${mb} MB · 最后写入 ${st.mtime.toISOString()}`;
    } catch {
      return writer; // 文件缺失/不可读：tail 那边已给占位，此处不重复报错
    }
  }

  async buildReport(): Promise<string> {
    const config: UserConfig = await this.configManager.loadConfig();

    // 落盘待写日志先 flush，确保 tail 含最新行
    await this.logManager.flush().catch(() => {});

    // startupLogTail = 提权/看护路径下的核启动日志。核在 logger 建起前挂掉或 panic 时，singbox.log 里什么
    // 都没有、失败原因只走 stderr（issue #324：两轮诊断报告都因缺这段而定不了位）。恒纳入报告——文件不存在
    // 时 readTail 给「(无日志文件)」占位，这本身也是信息（该机从未走过提权启动路径）。
    const [appLogTail, singboxLogTail, startupLogTail, startupLogSource, watchdogLogTail] =
      await Promise.all([
        this.readTail(path.join(getLogsPath(), 'app.log'), LOG_TAIL_BYTES),
        this.readTail(getSingBoxLogPath(), LOG_TAIL_BYTES),
        this.readTail(getSingBoxStartupLogPath(), LOG_TAIL_BYTES),
        this.describeStartupLog(),
        // 看护脚本自述日志只有 Windows UAC 路径会写；其它平台不出该段（避免恒定的「(无日志文件)」噪声）。
        process.platform === 'win32'
          ? this.readTail(getWindowsWatchdogLogPath(), LOG_TAIL_BYTES)
          : Promise.resolve(undefined),
      ]);

    const coreVersion = await this.proxyManager.getCoreVersion().catch(() => 'unknown');
    const status = this.proxyManager.getStatus();
    const sysProxy = await this.systemProxyManager.getProxyStatus().catch(() => null);

    // 生成「实际下发给内核」的 sing-box 配置并脱敏（#57：直接看 DNS/route 形态）。
    // custom 协议在生成时已把 customSettings.outbound 展平进 outbound 顶层、剥离 customSettings 包装，
    // → redactDeep 无法在生成配置里就地读到 secretKeys。故先汇总所有 custom 节点声明的 secretKeys（归一化）
    //   作为 extraSecretKeys 传入，确保第三方协议自定义密钥键在生成配置段也被打码（红线：零明文密钥）。
    const customSecretKeys = new Set<string>();
    for (const s of config.servers || []) {
      const sk = s.customSettings?.secretKeys;
      if (Array.isArray(sk))
        for (const k of sk) if (typeof k === 'string') customSecretKeys.add(normalizeKey(k));
    }
    let redactedSingbox: unknown;
    try {
      redactedSingbox = redactDeep(
        this.proxyManager.generateSingBoxConfig(config),
        customSecretKeys
      );
    } catch (e: any) {
      redactedSingbox = { error: `生成失败: ${e?.message ?? e}` };
    }

    // 纵深防御：脱敏 UserConfig 也兜底（理论上 config 为 JSON 可序列化、redactDeep 无环不会抛，
    // 但任何未来非 JSON 字段引入都不应让整份报告导出失败）。
    let redactedUserConfig: unknown;
    try {
      redactedUserConfig = redactDeep(config);
    } catch (e: any) {
      redactedUserConfig = { error: `脱敏失败: ${e?.message ?? e}` };
    }

    let speedTestDiagnostics: DiagnosticReportInput['speedTestDiagnostics'];
    const rawSpeedTestDiagnostics = this.speedTestDiagnosticsProvider?.();
    if (rawSpeedTestDiagnostics) {
      let redactedTempConfig: unknown;
      if (rawSpeedTestDiagnostics.tempConfig !== undefined) {
        try {
          redactedTempConfig = redactDeep(rawSpeedTestDiagnostics.tempConfig, customSecretKeys);
        } catch (e: any) {
          redactedTempConfig = { error: `脱敏失败: ${e?.message ?? e}` };
        }
      }
      speedTestDiagnostics = {
        generatedAt: rawSpeedTestDiagnostics.generatedAt,
        target: rawSpeedTestDiagnostics.target,
        total: rawSpeedTestDiagnostics.total,
        usable: rawSpeedTestDiagnostics.usable,
        failures: rawSpeedTestDiagnostics.failures,
        resolvedIpProbes: rawSpeedTestDiagnostics.resolvedIpProbes,
        redactedTempConfig,
      };
    }

    // 逐进程内存/CPU 快照（issue #242）：一次导出即可定位是哪个子进程内存偏高，取代靠用户截系统监视器猜。
    // best-effort：getAppMetrics 极端异常不阻断报告。
    let processMetrics;
    try {
      processMetrics = summarizeProcessMetrics(app.getAppMetrics());
    } catch {
      processMetrics = undefined;
    }

    // 渲染进程堆分层（issue #242 §6.2）：向 renderer 取一次 V8 堆 + RSS + Blink 资源缓存。**2s 超时兜底**——
    // renderer 卡死正是 #242 场景，collectRendererHeap 超时/无窗口/失败均返回 unavailable，绝不挂住导出。
    const rendererHeap = await collectRendererHeap(this.rendererIntrospect);

    // sing-box 核进程 RSS/CPU（issue #242 §6.3）：核不在 Electron 进程树（processMetrics 覆盖不到）。核 PID 取
    // getStatus().pid（wrapper 模式=真实 singboxPid，直启=spawn pid）；helper 托管路径无 pid → unavailable。
    let coreProcess: CoreProcessReport;
    if (status.running && status.pid) {
      const s = await sampleCoreProcess(status.pid).catch(() => null);
      coreProcess = s
        ? { pid: s.pid, rssMb: s.rssMb, cpuPercent: s.cpuPercent }
        : { unavailable: 'unavailable（核进程采样失败/平台不支持，如 Windows 本批未采）' };
    } else {
      coreProcess = {
        unavailable: 'unavailable（代理未运行，或核 PID 不可得，如 Linux helper 托管路径）',
      };
    }

    // 内存时间线（issue #242 §6.4）：ProxyManager 周期采样维护的 5min/帧 ring → 紧凑 CSV（斜率判泄漏/高水位）。
    let memoryTimelineCsv: string | undefined;
    try {
      memoryTimelineCsv = serializeMemoryTimelineCsv(this.proxyManager.getMemoryTimelineFrames());
    } catch {
      memoryTimelineCsv = undefined;
    }

    // 渲染进程内存 watchdog 计数（issue #242 §4）：本会话隐藏态回收/可见态告警次数 + 阈值；best-effort 不阻断报告。
    let rendererWatchdog;
    try {
      rendererWatchdog = this.rendererWatchdogStats?.();
    } catch {
      rendererWatchdog = undefined;
    }

    const effLevel = effectiveLogLevel(config.logLevel || 'info', this.privacyProvider());
    // #347：effLevel 是「按导出时的 config 重算」的值，而核加载的是**启动那一刻**写到磁盘的那份配置，两者可能
    // 不同（报告者首份诊断包头部显示 info、日志实为 debug，首轮判断因此被误导，差点把可用的 debug 证据当成
    // 「级别不够、证据缺失」丢掉）。真值在磁盘上核实际加载的那份 config：优先读它的 log.level，读不到（核未运行 /
    // 文件缺失 / JSON 损坏）才回落 effLevel，并**在字段值里标注来源**——不让两个不同来源共用一个无标注字段。
    let runningLevel: string | undefined;
    try {
      const onDisk = JSON.parse(await fs.readFile(getSingBoxConfigPath(), 'utf-8'));
      const lv = onDisk?.log?.level;
      if (typeof lv === 'string' && lv) runningLevel = lv;
    } catch {
      runningLevel = undefined;
    }
    const levelForHint = runningLevel ?? effLevel;
    const logLevelField =
      runningLevel !== undefined
        ? `${runningLevel}（运行中核实例）`
        : `${effLevel}（配置值，核未运行或配置文件不可读）`;
    const captureActive = !!config.diagnosticCapture;
    const wantDeeper =
      levelForHint !== 'debug' &&
      !captureActive &&
      TROUBLE_RE.test(appLogTail) &&
      !config.disableLogFile;

    const input: DiagnosticReportInput = {
      generatedAt: new Date().toISOString(),
      app: {
        flowzVersion: app.getVersion(),
        coreVersion,
        os: `${process.platform} ${process.arch} ${os.release()}`,
        electron: process.versions.electron,
      },
      runtime: {
        proxyMode: config.proxyMode,
        proxyModeType: config.proxyModeType,
        proxyRunning: status.running,
        startedViaHelper: this.proxyManager.isStartedViaHelper(),
        systemProxy: sysProxy?.enabled
          ? sysProxy.httpProxy || sysProxy.httpsProxy || sysProxy.socksProxy || '(已启用)'
          : '(未启用)',
        nodeDomainResolver: config.dnsConfig?.nodeDomainResolver || 'auto',
        logLevel: logLevelField,
        captureActive,
        // libcronet 现状 + 本会话自愈计数：naive 缺/坏库根因 + 「库被反复删（疑杀软）」可观测（取数 best-effort，绝不阻断报告）。
        cronetLibStatus: (() => {
          try {
            return resourceManager.getCronetLibStatus();
          } catch {
            return undefined;
          }
        })(),
        cronetHealTriggered: this.proxyManager.getCronetHealStats().triggered,
        cronetHealFailed: this.proxyManager.getCronetHealStats().failed,
        // issue #176：最近一次启动经几次就绪重试才成功。>0 = 起核慢（Windows 重启争用下 wintun 适配器未及时释放），
        // 区别于「核崩溃自动重启」——便于在报告里把「争用慢起但已自愈」与真崩溃分开。
        lastStartReadyRetries: this.proxyManager.getLastStartReadyRetries(),
        // issue #367：最近一次 OS DNS 缓存刷新结果。缺省=本会话从未触发（渲染侧据此打印「从未触发」）。
        lastDnsFlush: (() => {
          const f = this.proxyManager.getLastDnsFlush();
          if (!f) return undefined;
          return {
            ok: f.ok,
            reason: f.reason,
            detail: f.detail,
            skipped: f.skipped,
            // partial 必须透传：它是「dscacheutil 成功但 HUP mDNSResponder 失败」这一档的唯一判据，
            // 漏抄不报类型错（optional），只会让渲染侧退到 else 分支把部分成功印成「成功」。
            partial: f.partial,
            context: f.context,
            ageSec: Math.max(0, Math.round((Date.now() - f.at) / 1000)),
          };
        })(),
        // B0：最近一次起核的分阶段耗时。「启动慢」类报告的第一手依据——没有它只能对着总时长猜。
        lastStartTimeline: this.proxyManager.getLastStartTimeline() ?? undefined,
      },
      redactedUserConfig,
      redactedSingboxConfig: redactedSingbox,
      speedTestDiagnostics,
      processMetrics,
      rendererHeap,
      coreProcess,
      memoryTimelineCsv,
      rendererWatchdog,
      appLogTail,
      singboxLogTail,
      startupLogTail,
      startupLogSource,
      watchdogLogTail,
      // issue #147：节点 outbound.server 已恒为域名（不再烧 IP），无额外预解析 IP 需补脱敏 → 仅扫 config.servers。
      nodeIdentifiers: collectNodeIdentifiers(config),
      hint: wantDeeper
        ? `当前日志级别为 ${levelForHint}，未含 DNS 解析等连接详情，但日志中已出现连接/DNS 类错误。建议到 主页 → 日志 → 诊断 开启「诊断采集」，复现问题后再次导出可获得更完整的根因数据。`
        : undefined,
    };

    return buildDiagnosticReport(input);
  }
}
