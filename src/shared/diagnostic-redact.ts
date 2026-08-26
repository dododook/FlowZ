/**
 * 诊断报告脱敏 + Markdown 构建 —— 纯函数，主进程 DiagnosticService 与单测共用，不经网络/FS。
 *
 * 红线（不变量）：诊断报告会被贴到公开 issue，**绝不含明文密钥**。
 * 脱敏走「单一真值」：UserConfig 与生成的 sing-box 配置都过同一个 redactDeep，避免某处漏掉。
 *
 * 策略 = 键名黑名单（命中即整值打码）+ url 仅留 origin + custom 协议 secretKeys 叠加；未命中键原样保留（诊断需看形态）。
 * 注意：**无值层启发式**（不按 base64/熵猜密钥）。custom 协议（raw-JSON 透传）的自定义密钥键若既不在黑名单、用户又
 * 未在表单声明 secretKeys，则不会被打码——故 custom 节点务必声明 secretKeys（snell psk 等常见键已黑名单兜底）。
 */

import { isIpv4 } from './ip';
import type { ProcessMetricsSummary } from './process-metrics';

/** 打码占位符（定长，不泄露原值长度信息）。 */
export const REDACTED = '<redacted>';

/**
 * 密钥键名黑名单（小写、去分隔符后比较，故 camelCase 与 snake_case 同时命中：
 * privateKey / private_key 都归一为 "privatekey"）。命中即整值打码。
 *
 * 仅收「凭据/密钥」类。刻意排除可公开的结构字段：reality public_key（公钥本就公开）、short_id、
 * server_name/sni、method（SS 加密算法名非密钥）、fingerprint、alpn —— 这些保留以判形态。
 * username 保留（naive 用户名单独不可用，且有助定位），仅 password 类打码（对齐设计稿枚举）。
 */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  'password',
  'uuid',
  'privatekey',
  'privatekeypassphrase',
  'presharedkey',
  'authkey',
  'secret',
  'clashapisecret',
  'token',
  'pluginopts', // ss plugin_opts 常含 host;password
  'pluginoptions',
  'privacypassword',
  'psk', // snell 等第三方协议主密钥（无 customSettings.secretKeys 时的兜底）
  'userkey', // snell 多用户服务器鉴权 key（一等公民 snellSettings.userkey / 自定义 JSON 兜底）
]);

/** url 类键名（值按 url 处理：仅保留 origin，path/query 都打码——订阅 token 可能在 path 或 query）。 */
export const URL_KEYS: ReadonlySet<string> = new Set(['url']);

/** 归一键名：小写 + 去 _/-，使 privateKey / private_key / private-key 等价比较。导出供调用方构造叠加密钥集。 */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

/**
 * url 脱敏：仅保留 origin（scheme+host[:port]），path/query 一律打码。
 * 机场订阅 token 既可能在 query(?token=) 也可能嵌在 path 段（如 /abcTOKEN/clash）→ 宁过勿漏（红线）；
 * origin 已足够判「订阅源主机是否可达」。非法 url 退化为截断到 ? 前。
 */
export function redactUrlValue(raw: string): string {
  try {
    const u = new URL(raw);
    const hasPathOrQuery = (u.pathname && u.pathname !== '/') || !!u.search;
    return hasPathOrQuery ? `${u.origin}/${REDACTED}` : u.origin;
  } catch {
    const q = raw.indexOf('?');
    return q >= 0 ? `${raw.slice(0, q)}?${REDACTED}` : raw;
  }
}

/**
 * 递归脱敏任意 JSON 值。
 * @param value 待脱敏对象（不就地修改，返回新副本）
 * @param extraSecretKeys 额外打码的「归一化」键名（custom 协议 secretKeys 叠加用）
 */
export function redactDeep(value: unknown, extraSecretKeys?: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, extraSecretKeys));
  }
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    // custom 协议：outbound 内按该节点声明的 secretKeys 额外打码（归一化后并入黑名单传给子层）。
    let childExtra = extraSecretKeys;
    const cs = src.customSettings as { secretKeys?: unknown } | undefined;
    if (cs && Array.isArray(cs.secretKeys)) {
      const merged = new Set(extraSecretKeys ?? []);
      for (const k of cs.secretKeys) if (typeof k === 'string') merged.add(normalizeKey(k));
      childExtra = merged;
    }

    for (const [k, v] of Object.entries(src)) {
      const nk = normalizeKey(k);
      if (v == null) {
        out[k] = v;
      } else if (SECRET_KEYS.has(nk) || extraSecretKeys?.has(nk)) {
        // 命中密钥：标量打码；对象/数组整体打码（不向下递归，杜绝嵌套泄漏）。
        out[k] = REDACTED;
      } else if (URL_KEYS.has(nk) && typeof v === 'string') {
        out[k] = redactUrlValue(v);
      } else if (typeof v === 'object') {
        out[k] = redactDeep(v, childExtra);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return value;
}

/**
 * P0.6 节点标识符脱敏：键名黑名单（redactDeep）只打码"密钥键"，但节点的 server/SNI/Host/节点名 是**值**、
 * 刻意保留以判形态——它们泄漏"用哪个机场/后端域名/优选 IP"；且日志 tail 原文（redactDeep 管不到）含这些 +
 * 访问活动。本组：把节点标识符在 配置块 + 日志 统一替换为稳定占位（保留"域名/IP"形态与跨段相关性，
 * 例如 `lookup <domain-1> SERVFAIL` 仍可对上配置里的 `<domain-1>`），但不暴露具体值。
 * 访问活动（非节点的目标域名/IP）暂不打码（#57 诊断需要，报告头声明可自删）。
 */
export interface NodeIdentifier {
  value: string;
  placeholder: string;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// IPv4 判定收敛到 shared/ip.isIpv4（严格每段 0-255，杜绝 999.x 被旧宽松正则误判为 IP）；
// IPv6 仅作脱敏形态粗判（含 ':' 即归 IP），无需精确。
const looksLikeIp = (s: string): boolean => isIpv4(s) || s.includes(':');

type ServerLike = {
  address?: unknown;
  name?: unknown;
  tlsSettings?: { serverName?: unknown } | null;
  wsSettings?: { headers?: Record<string, unknown> | null } | null;
  shadowTlsSettings?: { sni?: unknown } | null;
  tailscaleSettings?: { hostname?: unknown; exitNode?: unknown } | null;
  httpSettings?: { host?: unknown; headers?: Record<string, unknown> | null } | null;
  customSettings?: { outbound?: Record<string, unknown> | null } | null;
};

/** 主机类键名（归一：小写去 _）：custom 透传 outbound 里这些键的字符串值是节点身份。 */
const HOST_KEY_SET: ReadonlySet<string> = new Set([
  'server',
  'servername',
  'sni',
  'host',
  'hostname',
]);

/**
 * 递归收集对象里主机类键的字符串值。custom 协议（raw-JSON 透传）的 outbound 原样下发到生成 config，
 * 身份字段可能嵌套（如 `tls.server_name` 伪装 SNI、`transport.headers.Host`），只扫顶层会漏 → 全深度遍历。
 */
function collectHostsDeep(obj: unknown, add: (v: unknown) => void): void {
  if (Array.isArray(obj)) {
    for (const x of obj) collectHostsDeep(x, add);
    return;
  }
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      if (HOST_KEY_SET.has(k.toLowerCase().replace(/_/g, ''))) add(v);
    } else if (v && typeof v === 'object') {
      collectHostsDeep(v, add);
    }
  }
}

/**
 * 收集 transport headers 里的 Host 值（节点伪装域名）。大小写不敏感匹配 `host` 键；值兼容
 * string（WebSocketSettings.headers）与 string[]（HttpSettings.headers）。ws/http 共用，避免两处各写一份。
 */
function addHostHeaders(headers: unknown, add: (v: unknown) => void): void {
  if (!headers || typeof headers !== 'object') return;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'host') continue;
    if (Array.isArray(v)) for (const x of v) add(x);
    else add(v);
  }
}

/**
 * 从 config.servers 收集本用户节点标识符 + 稳定占位符。涵盖一切会进生成 config / 日志的节点身份字段：
 * 地址/SNI/WS-Host/ShadowTLS-sni/Tailscale-hostname·exitNode/HTTP-host[]·headers.Host/custom outbound 的 server·sni·host。
 * 地址类：域名→`<domain-N>`、IP→`<ip-N>`（保留"域名 vs IP"诊断信号）；节点名→`<node-N>`。去重（同值一占位）。
 * 节点名 <4 字符跳过（防误伤日志普通词）；地址类不设长度阈值（靠 redactIdentifiers 的主机边界锚定防误替）。
 */
export function collectNodeIdentifiers(
  config: { servers?: ReadonlyArray<ServerLike> } | null | undefined,
  // #57 resolve-ahead：节点域名被预解析成 IP 写进生成 config 的 outbound.server，这些 IP 不在 config.servers 里、
  // 否则会以明文漏进诊断报告 → 调用方（DiagnosticService）把它们传入，一并按节点 IP 身份打码为 <ip-N>。
  extraAddresses?: Iterable<string>
): NodeIdentifier[] {
  const out: NodeIdentifier[] = [];
  const seen = new Set<string>();
  let domainN = 0;
  let ipN = 0;
  let nameN = 0;
  const add = (raw: unknown, kind: 'addr' | 'name'): void => {
    if (typeof raw !== 'string') return;
    const v = raw.trim();
    if (!v) return;
    if (kind === 'name' && v.length < 4) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    let placeholder: string;
    if (kind === 'name') {
      placeholder = `<node-${++nameN}>`;
    } else if (looksLikeIp(v)) {
      placeholder = `<ip-${++ipN}>`;
    } else {
      placeholder = `<domain-${++domainN}>`;
    }
    out.push({ value: v, placeholder });
  };
  for (const s of config?.servers || []) {
    add(s?.address, 'addr');
    add(s?.tlsSettings?.serverName, 'addr');
    // ws/http transport 的 Host 头（伪装域名）：大小写不敏感、值兼容 string(ws)|string[](http)，共用 addHostHeaders。
    // 仅匹配精确 `host` 键（刻意不走 collectHostsDeep 的 HOST_KEY_SET）：transport headers 只有 Host 头承载身份，
    // 用全集会把恰好叫 server/sni 的自定义 HTTP 头误收为节点身份；collectHostsDeep 仅用于 custom raw-JSON
    // outbound（键名不可控、需广撒网）。
    addHostHeaders(s?.wsSettings?.headers, (v) => add(v, 'addr'));
    addHostHeaders(s?.httpSettings?.headers, (v) => add(v, 'addr'));
    add(s?.shadowTlsSettings?.sni, 'addr');
    add(s?.tailscaleSettings?.hostname, 'addr');
    add(s?.tailscaleSettings?.exitNode, 'addr');
    const httpHost = s?.httpSettings?.host;
    if (Array.isArray(httpHost)) for (const h of httpHost) add(h, 'addr');
    // custom 透传 outbound 原样下发 → 递归收主机类键（含嵌套 tls.server_name / transport.headers.Host）
    collectHostsDeep(s?.customSettings?.outbound, (v) => add(v, 'addr'));
    add(s?.name, 'name');
  }
  // resolve-ahead 预解析得到的节点 IP（在 config.servers 之外）：按 IP 身份打码，杜绝真实节点 IP 漏进报告。
  for (const ip of extraAddresses ?? []) add(ip, 'addr');
  return out;
}

/**
 * 在任意文本（日志 tail / 序列化后的配置）里把节点标识符替换为占位符。
 * 长值优先（防短值先替坏长值）、大小写不敏感（日志域名常小写）、正则转义。
 * **主机边界锚定**（前后非 `[字母数字._-]`）：防节点标识符作为子串误替无关串
 * （节点 `a.com` 不碰 `cdn.a.com`；节点 IP `104.18.8.8` 不把 `104.18.8.83` 切成 `<ip-1>3`）。
 * 占位符为 `<...>` 不含原值，不会自我再匹配。
 */
export function redactIdentifiers(text: string, ids: readonly NodeIdentifier[]): string {
  if (!text || ids.length === 0) return text;
  const sorted = [...ids].sort((a, b) => b.value.length - a.value.length);
  let out = text;
  for (const { value, placeholder } of sorted) {
    out = out.replace(
      new RegExp(`(?<![\\w.-])${escapeRegExp(value)}(?![\\w.-])`, 'gi'),
      placeholder
    );
  }
  return out;
}

/**
 * 渲染进程堆分层（issue #242 §6.2）：main 经 executeJavaScript 向 renderer 取一次，映射到 MB。取不到/超时/无窗口
 * → unavailable 置原因串，其余字段缺省。全 optional 使构建器逐字段渲染。
 */
export interface RendererHeapReport {
  unavailable?: string; // 存在即视为不可用（超时/无窗口/失败），其余字段无意义
  usedHeapMb?: number;
  totalHeapMb?: number;
  heapLimitMb?: number;
  residentSetMb?: number;
  blinkResourceMb?: number; // webFrame 资源缓存 liveSize 汇总
}

/** sing-box 核进程采样（issue #242 §6.3）：核不在 Electron 进程树，单独采 RSS/CPU。取不到 → unavailable。 */
export interface CoreProcessReport {
  unavailable?: string;
  pid?: number;
  rssMb?: number;
  cpuPercent?: number;
}

/** 诊断报告输入（全部已脱敏 / 已 tail；构建器只拼装，不做任何 IO 或脱敏）。 */
export interface DiagnosticReportInput {
  generatedAt: string; // ISO
  app: {
    flowzVersion: string;
    coreVersion: string;
    os: string; // e.g. "win32 x64 10.0.22631"
    electron?: string;
  };
  runtime: {
    proxyMode: string;
    proxyModeType: string;
    proxyRunning: boolean;
    startedViaHelper?: boolean;
    helperStatus?: string;
    systemProxy?: string; // 实际生效的系统代理（脱敏无关，IP:port）
    effectiveDns?: string; // 生效系统解析器
    nodeDomainResolver?: string; // #57 节点域名解析档位
    logLevel: string;
    captureActive: boolean;
    cronetLibStatus?: string; // libcronet 可用性：available / copy-failed（损坏/拷贝失败）/ no-lib（无内置库）
    cronetHealTriggered?: number; // 本会话 libcronet 自愈触发次数
    cronetHealFailed?: number; // 本会话 libcronet 自愈失败次数（连续失败疑库被反复删/杀软）
    lastStartReadyRetries?: number; // issue #176：最近一次启动经几次就绪重试（>0=起核慢，多因 Win 重启争用，非核崩）
    // issue #367：最近一次 OS DNS 缓存刷新的结果。缺省=本会话从未触发过刷新（本身即信息，如核从未成功起过）。
    // 只带相对时长（ageSec）不带绝对时间戳——绝对时刻对判读无增益，却把使用时间带进报告。
    lastDnsFlush?: {
      ok: boolean;
      reason?: string; // command-missing | permission-denied | timeout | unknown
      detail: string;
      skipped?: boolean; // 平台无刷新机制的 no-op（**不是**刷新成功）
      partial?: string; // darwin：dscacheutil 成功但 HUP mDNSResponder 失败（负缓存很可能没清掉）
      context: string; // start | stop | link-change
      ageSec: number;
    };
    lastStartTimeline?: string; // B0：最近一次起核的分阶段耗时汇总行（`起核阶段耗时 total=… | 阶段=ms …`）
  };
  redactedUserConfig: unknown;
  redactedSingboxConfig: unknown;
  /** 最近一次测速诊断：临时测速 sing-box 配置 + 逐节点失败 reason。配置必须由调用方先脱敏。 */
  speedTestDiagnostics?: {
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
    failures: ReadonlyArray<{
      serverId: string;
      serverName?: string;
      tag?: string;
      reason: string;
    }>;
    resolvedIpProbes?: ReadonlyArray<{
      serverId: string;
      serverName?: string;
      tag?: string;
      targetHost: string;
      resolverPath: string;
      resolvedIps: readonly string[];
      error?: string;
    }>;
    redactedTempConfig?: unknown;
  };
  /** 逐进程内存/CPU 快照（issue #242）：一眼看出是哪个子进程内存偏高；type/pid/内存/CPU 非敏感，无需脱敏。 */
  processMetrics?: ProcessMetricsSummary;
  /** 渲染进程堆分层（issue #242 §6.2）：V8 堆 + 进程 RSS + Blink 资源缓存；取不到为 unavailable。 */
  rendererHeap?: RendererHeapReport;
  /** sing-box 核进程 RSS/CPU（issue #242 §6.3）：核不在 Electron 进程树，单独采样。 */
  coreProcess?: CoreProcessReport;
  /** 内存时间线（issue #242 §6.4）：每 5min 一帧（Electron 全进程 + 核 RSS）的紧凑 CSV，斜率判泄漏/高水位。 */
  memoryTimelineCsv?: string;
  /** 渲染进程内存 watchdog（issue #242 §4）：本会话隐藏态回收(discard)/可见态告警(warn)次数 + 触发阈值，纯数字。 */
  rendererWatchdog?: { discardCount: number; warnCount: number; thresholdMb: number };
  appLogTail: string;
  singboxLogTail: string;
  /**
   * 提权/看护路径下的核启动日志（singbox_startup.log）尾部。核在 logger 建起前失败、panic、被环境拦下，
   * 错误只走 stderr——singbox.log 里一个字都没有。issue #324 两轮诊断都定不了位正因该段缺失。
   * **内容按写侧而异**（见 main/utils/paths.ts getSingBoxStartupLogPath 的平台表）：mac wrapper / Windows
   * helper 服务含核的 stdout+stderr；Windows UAC 看护脚本未重定向 → 只有看护脚本自述行。故本段标题不写死
   * 「核 stdout/stderr」，由 startupLogSource 如实标注本机走的哪条写侧路径。
   * 可选：未提供则不出该段（老调用点/单测不受影响）。
   */
  startupLogTail?: string;
  /** 本段内容的来源与元信息（写侧路径描述 + 文件大小/最后写入时刻）；缺省则段标题只写文件名。 */
  startupLogSource?: string;
  /**
   * Windows UAC 看护脚本自身的日志（`flowz-win-watchdog.log`）尾部。与核 stderr 分文件（Start-Process 的
   * 重定向独占目标文件）。它记的是「谁停的核」——`sing-box exited by itself` / `Stopflag detected` /
   * `Parent process gone`，是区分「核自杀」与「被外部杀」的判据，和 FATAL 文本互补。
   * 仅 Windows UAC 路径有内容；其它平台/路径不提供，不出该段。
   */
  watchdogLogTail?: string;
  /** 节点标识符 → 占位符（P0.6）：构建末尾在全报告统一替换，打码节点身份（域名/IP/SNI/节点名），保留形态与跨段相关性。 */
  nodeIdentifiers?: readonly NodeIdentifier[];
  /** 当前级别不含连接明细（>info）且日志疑似有连接/DNS 错误 → 提示开启诊断采集复现。 */
  hint?: string;
}

/**
 * 动态围栏（CommonMark）：扫描 body 内最长连续反引号串，用 max(3, n+1) 个反引号作围栏。
 * 防内容（日志/节点名/订阅名，机场可控）含 ``` 提前闭合代码块、破坏报告结构。
 */
function fence(lang: string, body: string): string {
  const safe = body.length ? body : '(空)';
  let maxRun = 0;
  let cur = 0;
  for (let i = 0; i < safe.length; i++) {
    if (safe[i] === '`') {
      cur++;
      if (cur > maxRun) maxRun = cur;
    } else {
      cur = 0;
    }
  }
  const ticks = '`'.repeat(Math.max(3, maxRun + 1));
  return `${ticks}${lang}\n${safe}\n${ticks}`;
}

function tableCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

function formatSpeedTestTargetForReport(
  target: NonNullable<DiagnosticReportInput['speedTestDiagnostics']>['target']
): string {
  const scheme = target.https ? 'https' : 'http';
  const raw = `${scheme}://${target.hostHeader}${target.path}`;
  return target.host === 'www.gstatic.com' && target.path === '/generate_204'
    ? raw
    : redactUrlValue(raw);
}

/** 构建诊断报告 Markdown（纯字符串拼装，可单测）。 */
export function buildDiagnosticReport(input: DiagnosticReportInput): string {
  const { app, runtime } = input;
  const lines: string[] = [];

  lines.push('# FlowZ 诊断报告');
  lines.push('');
  lines.push(
    '> 本报告用于排障，可附到 GitHub issue。**密钥与节点身份已脱敏**（uuid/密码/私钥/订阅 token 已打码；' +
      '节点域名/IP/SNI/节点名已替换为 `<domain-N>`/`<ip-N>`/`<node-N>` 占位符）。日志明细可能仍含访问过的**其它**域名/IP——介意可自行删减后再上传。'
  );
  lines.push('');
  if (input.hint) {
    lines.push(`> 提示：${input.hint}`);
    lines.push('');
  }

  lines.push('## 环境');
  lines.push('');
  lines.push(`- 生成时间：${input.generatedAt}`);
  lines.push(`- FlowZ 版本：${app.flowzVersion}`);
  lines.push(`- 内核版本：${app.coreVersion}`);
  lines.push(`- 系统：${app.os}`);
  if (app.electron) lines.push(`- Electron：${app.electron}`);
  lines.push('');

  lines.push('## 运行态');
  lines.push('');
  lines.push(`- 代理模式：${runtime.proxyMode} / ${runtime.proxyModeType}`);
  lines.push(`- 代理运行中：${runtime.proxyRunning ? '是' : '否'}`);
  if (runtime.startedViaHelper !== undefined)
    lines.push(`- 经提权 helper 启动：${runtime.startedViaHelper ? '是' : '否'}`);
  if (runtime.helperStatus) lines.push(`- Helper 状态：${runtime.helperStatus}`);
  if (runtime.systemProxy) lines.push(`- 系统代理实际值：${runtime.systemProxy}`);
  if (runtime.effectiveDns) lines.push(`- 生效系统 DNS：${runtime.effectiveDns}`);
  if (runtime.nodeDomainResolver) lines.push(`- 节点域名解析档位：${runtime.nodeDomainResolver}`);
  lines.push(`- 日志级别：${runtime.logLevel}`);
  lines.push(`- 诊断采集中：${runtime.captureActive ? '是' : '否'}`);
  if (runtime.cronetLibStatus) lines.push(`- libcronet 状态：${runtime.cronetLibStatus}`);
  if (runtime.cronetHealTriggered || runtime.cronetHealFailed) {
    lines.push(
      `- libcronet 自愈：触发 ${runtime.cronetHealTriggered ?? 0} 次 / 失败 ${runtime.cronetHealFailed ?? 0} 次`
    );
  }
  if (runtime.lastStartReadyRetries) {
    lines.push(
      `- 最近一次起核经 ${runtime.lastStartReadyRetries} 次就绪重试才成功（起核慢，多因 Windows 重启争用下 wintun 适配器未及时释放；非核崩溃）`
    );
  }
  // issue #367：刷新是否真的发生过必须在报告里可读——它守着「系统解析器缓存了错误记录」这类故障的唯一出口
  // （issue #363：内核侧全程正常，症状全部来自系统缓存的否定记录）。失败时连同可操作提示一并带出。
  if (runtime.lastDnsFlush) {
    const f = runtime.lastDnsFlush;
    if (!f.ok) {
      lines.push(
        `- 系统 DNS 缓存刷新：**失败**（${f.reason ?? 'unknown'}，${f.context}，${f.ageSec}s 前）：${f.detail}`
      );
    } else if (f.skipped) {
      lines.push(`- 系统 DNS 缓存刷新：本平台无对应机制，已跳过（${f.detail}）`);
    } else if (f.partial) {
      // macOS unicast DNS 缓存主体在 mDNSResponder：HUP 没打成意味着 issue #363 那类负缓存很可能**没被清掉**。
      // 与真成功共用「成功」headline 会让开发者扫报告时无法区分，正是本批要消灭的那类误读。
      lines.push(
        `- 系统 DNS 缓存刷新：**部分成功**（${f.context}，${f.ageSec}s 前，${f.detail}）：${f.partial}`
      );
    } else {
      lines.push(`- 系统 DNS 缓存刷新：成功（${f.context}，${f.ageSec}s 前，${f.detail}）`);
    }
  } else {
    lines.push('- 系统 DNS 缓存刷新：本会话从未触发');
  }
  if (runtime.lastStartTimeline) {
    lines.push(`- ${runtime.lastStartTimeline}`);
  }
  lines.push('');

  lines.push('## 生成的 sing-box 配置（脱敏）');
  lines.push('');
  lines.push(fence('json', JSON.stringify(input.redactedSingboxConfig, null, 2)));
  lines.push('');

  lines.push('## 用户配置（脱敏）');
  lines.push('');
  lines.push(fence('json', JSON.stringify(input.redactedUserConfig, null, 2)));
  lines.push('');

  if (input.speedTestDiagnostics) {
    const d = input.speedTestDiagnostics;
    lines.push('## 最近一次测速诊断');
    lines.push('');
    lines.push(`- 生成时间：${d.generatedAt}`);
    lines.push(`- 测速目标：${formatSpeedTestTargetForReport(d.target)}`);
    lines.push(`- 节点数：total=${d.total} / usable=${d.usable} / failed=${d.failures.length}`);
    lines.push('');
    if (d.failures.length > 0) {
      lines.push('| 节点 ID | 节点名 | 出站 tag | reason |');
      lines.push('|---|---|---|---|');
      for (const f of d.failures) {
        lines.push(
          `| ${tableCell(f.serverId)} | ${tableCell(f.serverName)} | ${tableCell(f.tag)} | ${tableCell(f.reason)} |`
        );
      }
      lines.push('');
    }
    if (d.resolvedIpProbes && d.resolvedIpProbes.length > 0) {
      lines.push('### 失败 endpoint 目标解析探测');
      lines.push('');
      lines.push(
        '| 节点 ID | 节点名 | 出站 tag | 目标域名 | resolver path | resolved IPs | error |'
      );
      lines.push('|---|---|---|---|---|---|---|');
      for (const p of d.resolvedIpProbes) {
        lines.push(
          `| ${tableCell(p.serverId)} | ${tableCell(p.serverName)} | ${tableCell(p.tag)} | ${tableCell(p.targetHost)} | ${tableCell(p.resolverPath)} | ${tableCell(p.resolvedIps.join(', '))} | ${tableCell(p.error)} |`
        );
      }
      lines.push('');
    }
    if (d.redactedTempConfig !== undefined) {
      lines.push('### 临时测速 sing-box 配置（脱敏）');
      lines.push('');
      lines.push(fence('json', JSON.stringify(d.redactedTempConfig, null, 2)));
      lines.push('');
    }
  }

  lines.push('## app.log（近期）');
  lines.push('');
  lines.push(fence('text', input.appLogTail));
  lines.push('');

  lines.push('## singbox.log（近期）');
  lines.push('');
  lines.push(fence('text', input.singboxLogTail));
  lines.push('');

  // 核启动日志：与 singbox.log 互补（见 startupLogTail 字段注释）。放在其后，同样进 redactIdentifiers。
  // 标题带来源描述 + 文件元信息：Windows helper 侧 O_APPEND 永不截断，仅凭 64KB tail 无法判断内容属于哪次
  // 会话（sing-box 的 FATAL[0000] 是启动相对秒、非墙钟时间），故必须让读报告的人看见文件多大、何时最后写入。
  if (input.startupLogTail !== undefined) {
    const src = input.startupLogSource ? ` · ${input.startupLogSource}` : '';
    lines.push(`## singbox_startup.log（近期${src}）`);
    lines.push('');
    lines.push(fence('text', input.startupLogTail));
    lines.push('');
  }

  // Windows UAC 看护脚本自述日志：回答「谁停的核」，与上面的 FATAL 文本互补（见 watchdogLogTail 注释）。
  if (input.watchdogLogTail !== undefined) {
    lines.push('## flowz-win-watchdog.log（近期 · Windows UAC 看护脚本自述）');
    lines.push('');
    lines.push(fence('text', input.watchdogLogTail));
    lines.push('');
  }

  // P0.6：末尾在全报告（配置块 + 日志 + 运行态）统一打码节点标识符，跨段占位一致便于关联诊断。
  const redacted = redactIdentifiers(lines.join('\n'), input.nodeIdentifiers ?? []);

  // 技术观测段（进程内存表 + 渲染堆分层 + 核进程 + 内存时间线 CSV，issue #242）刻意放在 redactIdentifiers
  // **之后**拼接：段内只有进程 type/pid/内存/CPU/进程名/时刻等数字，无节点标识符、无需脱敏；若纳入打码 pass，
  // 机场把节点命名成纯数字（如 "2048"）会撞上其中的内存/PID 数字被误替成占位符，反而毁掉定位价值。故与打码隔离。
  const tail: string[] = [];

  if (input.processMetrics) {
    const pm = input.processMetrics;
    tail.push('', '## 进程内存', '');
    tail.push(`- 合计：${pm.totalMemoryMb} MB（${pm.rows.length} 个进程，按内存降序）`, '');
    tail.push(
      '| 类型 | PID | 内存(MB) | 峰值(MB) | CPU(%) | 标识 | 创建时刻 |',
      '|---|---|---|---|---|---|---|'
    );
    for (const r of pm.rows) {
      const created =
        typeof r.creationTime === 'number' ? new Date(r.creationTime).toISOString() : '';
      tail.push(
        `| ${r.type} | ${r.pid} | ${r.memoryMb} | ${r.peakMemoryMb ?? ''} | ${r.cpuPercent} | ${r.label ?? ''} | ${created} |`
      );
    }
  }

  if (input.rendererHeap) {
    const rh = input.rendererHeap;
    tail.push('', '## 渲染进程堆分层', '');
    if (rh.unavailable) {
      tail.push(`- ${rh.unavailable}`);
    } else {
      if (rh.usedHeapMb !== undefined) tail.push(`- V8 usedHeap：${rh.usedHeapMb} MB`);
      if (rh.totalHeapMb !== undefined) tail.push(`- V8 totalHeap：${rh.totalHeapMb} MB`);
      if (rh.heapLimitMb !== undefined) tail.push(`- V8 heapLimit：${rh.heapLimitMb} MB`);
      if (rh.residentSetMb !== undefined) tail.push(`- 进程 residentSet：${rh.residentSetMb} MB`);
      if (rh.blinkResourceMb !== undefined)
        tail.push(`- Blink 资源缓存(live)：${rh.blinkResourceMb} MB`);
    }
  }

  if (input.coreProcess) {
    const cp = input.coreProcess;
    tail.push('', '## sing-box 核进程', '');
    if (cp.unavailable) tail.push(`- ${cp.unavailable}`);
    else tail.push(`- PID ${cp.pid ?? ''}：RSS ${cp.rssMb ?? ''} MB，CPU ${cp.cpuPercent ?? ''}%`);
  }

  if (input.memoryTimelineCsv) {
    tail.push('', '## 内存时间线（每 5min 一帧，最多 24h）', '');
    tail.push(fence('csv', input.memoryTimelineCsv));
  }

  if (input.rendererWatchdog) {
    const rw = input.rendererWatchdog;
    tail.push('', '## 渲染进程内存看护', '');
    tail.push(`- 阈值：${rw.thresholdMb} MB`);
    tail.push(`- 隐藏态回收（discard）：${rw.discardCount} 次`);
    tail.push(`- 可见态告警（warn）：${rw.warnCount} 次`);
  }

  if (tail.length === 0) return redacted;
  return redacted + '\n' + tail.join('\n') + '\n';
}
