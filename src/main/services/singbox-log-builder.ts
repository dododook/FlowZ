/**
 * sing-box 日志配置生成 —— 从 ProxyManager.generateLogConfig 抽出（SingBoxConfigBuilder 抽取 Phase 2 step 8）。
 * 纯函数：只读 config + 注入 privacyMode（隐私模式经 effectiveLogLevel 抬到 ≥warn）。
 * config 字节等价由 config-snapshot 网验证（含 TUN-darwin/win32 的 output 文件路径分支）。
 */

import type { UserConfig } from '../../shared/types';
import { effectiveLogLevel } from '../../shared/log-level';
import { getSingBoxLogPath } from '../utils/paths';
import type { SingBoxLogConfig } from './singbox-config-types';

export function buildLogConfig(config: UserConfig, privacyMode: boolean): SingBoxLogConfig {
  // 日志级别由用户配置（默认 info）。level 影响是否记录访问域名/SNI（info/debug 会记，warn+ 不记）。
  // 隐私模式经 effectiveLogLevel 抬到 ≥warn，从源头不让 sing-box 记录连接明细到 singbox.log。
  const logConfig: SingBoxLogConfig = {
    level: effectiveLogLevel(config.logLevel || 'info', privacyMode),
    timestamp: true,
  };

  // 用户关闭日志写盘：整体禁用 sing-box 日志（隐私/省盘），不再写文件
  if (config.disableLogFile) {
    logConfig.disabled = true;
    return logConfig;
  }

  // sing-box 日志写文件（output）的场景 = TUN 模式（与 ProxyManager.needsRootPrivilege / isTunModeNow 同谓词）：
  //  - mac/win TUN：提权后台运行，stdout 无法被父进程捕获 → 必须写文件 + logFileWatcher 读取。
  //  - Linux TUN：issue #210 根因 #1——虽是直接子进程、stdout 可捕获，但日志全量直喂主进程
  //    （handleProcessOutput→addLog）在高频下会撑爆 LogManager.pendingWrites。写文件 + watcher 有
  //    MAX_LOG_FILE_SIZE 截断兜底，三平台 TUN 行为统一。
  // manual 模式（直接子进程、非 TUN 接管）日志量小，stdout 直喂可接受，不写文件（与 ProxyManager
  // logFileWatcher 启用条件严格一致——二者必须同谓词，否则会出现「写文件但无人读」或「读空文件」）。
  // 注意：此处用 config.proxyModeType（生成时的配置），非 this.currentConfig。
  const isTunMode = config.proxyModeType?.toLowerCase() === 'tun';
  const writesLogToFile =
    isTunMode &&
    (process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux');

  if (writesLogToFile) {
    logConfig.output = getSingBoxLogPath();
  }

  return logConfig;
}
