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
    '> 本报告用于排障，可附到 GitHub issue。**密钥已脱敏**（uuid/密码/私钥/订阅 token 等已打码），' +
      '但仍可能含访问过的域名/IP/SNI（日志明细）——介意可自行删减后再上传。'
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

  return lines.join('\n');
}
