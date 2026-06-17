/**
 * DiagnosticService —— 一键诊断报告的汇集层（[[issue-diagnostics-and-support]] P0）。
 *
 * 把「运行态系统里已有的诊断事实」汇成单个脱敏 Markdown：环境快照 + 运行态 + 脱敏 UserConfig +
 * 脱敏「实际下发给内核的 sing-box 配置」（#57 类一眼可见 DNS/route 根因）+ app.log/singbox.log 近期 tail。
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
  type DiagnosticReportInput,
} from '../../shared/diagnostic-redact';
import { effectiveLogLevel } from '../../shared/log-level';
import { getLogsPath, getSingBoxLogPath } from '../utils/paths';
import path from 'path';
import type { LogManager } from './LogManager';
import type { ProxyManager } from './ProxyManager';
import type { IConfigManager } from './ConfigManager';
import type { ISystemProxyManager } from './SystemProxyManager';

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
    private readonly privacyProvider: () => boolean = () => false
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
      return e?.code === 'ENOENT' ? '(无日志文件)' : `(读取失败: ${e?.message ?? e})`;
    }
  }

  /** 生成完整诊断报告 Markdown 字符串。 */
  async buildReport(): Promise<string> {
    const config: UserConfig = await this.configManager.loadConfig();

    // 落盘待写日志先 flush，确保 tail 含最新行
    await this.logManager.flush().catch(() => {});

    const [appLogTail, singboxLogTail] = await Promise.all([
      this.readTail(path.join(getLogsPath(), 'app.log'), LOG_TAIL_BYTES),
      this.readTail(getSingBoxLogPath(), LOG_TAIL_BYTES),
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

    const effLevel = effectiveLogLevel(config.logLevel || 'info', this.privacyProvider());
    const captureActive = !!config.diagnosticCapture;
    const wantDeeper =
      effLevel !== 'debug' &&
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
        logLevel: effLevel,
        captureActive,
      },
      redactedUserConfig,
      redactedSingboxConfig: redactedSingbox,
      appLogTail,
      singboxLogTail,
      hint: wantDeeper
        ? `当前日志级别为 ${effLevel}，未含 DNS 解析等连接详情，但日志中已出现连接/DNS 类错误。建议到 设置 → 高级 → 诊断 开启「诊断采集」，复现问题后再次导出可获得更完整的根因数据。`
        : undefined,
    };

    return buildDiagnosticReport(input);
  }
}
