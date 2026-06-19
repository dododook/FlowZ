/**
 * 诊断报告脱敏 + Markdown 构建 —— 纯函数，主进程 DiagnosticService 与单测共用，不经网络/FS。
 *
 * 红线（[[issue-diagnostics-and-support]] 不变量）：诊断报告会被贴到公开 issue，**绝不含明文密钥**。
 * 脱敏走「单一真值」：UserConfig 与生成的 sing-box 配置都过同一个 redactDeep，避免某处漏掉。
 *
 * 策略 = 键名黑名单（命中即整值打码）+ url 仅留 origin + custom 协议 secretKeys 叠加；未命中键原样保留（诊断需看形态）。
 * 注意：**无值层启发式**（不按 base64/熵猜密钥）。custom 协议（raw-JSON 透传）的自定义密钥键若既不在黑名单、用户又
 * 未在表单声明 secretKeys，则不会被打码——故 custom 节点务必声明 secretKeys（snell psk 等常见键已黑名单兜底）。
 */

import { isIpv4 } from './ip';

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
  };
  redactedUserConfig: unknown;
  redactedSingboxConfig: unknown;
  appLogTail: string;
  singboxLogTail: string;
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
  lines.push('');

  lines.push('## 生成的 sing-box 配置（脱敏）');
  lines.push('');
  lines.push(fence('json', JSON.stringify(input.redactedSingboxConfig, null, 2)));
  lines.push('');

  lines.push('## 用户配置（脱敏）');
  lines.push('');
  lines.push(fence('json', JSON.stringify(input.redactedUserConfig, null, 2)));
  lines.push('');

  lines.push('## app.log（近期）');
  lines.push('');
  lines.push(fence('text', input.appLogTail));
  lines.push('');

  lines.push('## singbox.log（近期）');
  lines.push('');
  lines.push(fence('text', input.singboxLogTail));
  lines.push('');

  // P0.6：末尾在全报告（配置块 + 日志 + 运行态）统一打码节点标识符，跨段占位一致便于关联诊断。
  return redactIdentifiers(lines.join('\n'), input.nodeIdentifiers ?? []);
}
