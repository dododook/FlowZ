/**
 * sing-box 启动失败 FATAL 行的解析与分类（issue #324）。
 *
 * 背景：sing-box 启动失败的 FATAL 只写 stderr，**永不进 config 里 `log.output` 指定的文件**（`log/export.go`
 * 的包级 std logger 在 init() 固定绑 os.Stderr，cmd_run.go 的 run() 出错走它）。FlowZ 把这条 stderr 重定向到
 * `singbox_startup.log`（helper 路径 / macOS wrapper / Windows UAC 看护三写侧，见 utils/paths.ts），但在
 * #324 之前只有诊断报告导出时才读它——启动失败路径完全不读，用户看到的永远是「TUN 初始化未完成」这类
 * 按适配器存在性反推的文案。#324 的真因（TUN 地址被占用）因此在文件里躺了三天，靠人肉传日志才定位。
 *
 * 本模块是纯函数（零 IO），供 ProxyManager 在起核失败时把真因捞出来上屏。
 *
 * **硬约束：解析结果绝不能拼进 `CoreStartRetryError.message`。** core-readiness.ts 的
 * NON_RETRYABLE_START_ERROR_PATTERNS 含 permission/eacces/enoent 等词，FATAL 原文极易命中（例如
 * `permission denied`），会把本可重试的起核失败静默判成终态。只走 logToManager + 结构化事件字段。
 */

/** sing-box CLI 默认 logger 即使重定向到文件也带 ANSI 色码（`\x1b[31mFATAL\x1b[0m[0000]`）。 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** 剥 ANSI 色码。匹配失败即原样返回（非 sing-box 写的行也安全）。 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * 从 startup log 文本里取**最后一条** FATAL 行（已剥色码、已 trim）。无则 null。
 *
 * 取最后一条而非第一条：helper 写侧是 `O_APPEND` 永不截断（helper-win/winproc.go），同一次 start 的多轮重试
 * 会追加多条同样的 FATAL，且调用方即便按 run 边界切过片段，片段内仍可能有多腿。最后一条最接近本次失败。
 */
export function extractLastFatal(text: string): string | null {
  const lines = stripAnsi(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    // sing-box 的格式是 `FATAL[0000] <msg>`。只宽松了 FATAL 之后的分隔符（`[` 或空白），行首锚点是刻意的：
    // 放宽成行内匹配会把「日志里提到 FATAL 的普通行」也认成 FATAL。若上游哪天在 FATAL 前加了墙钟时间戳前缀，
    // 这里会失配 —— 那属于必须随核升级复核的契约，不是这条正则该兜的。
    if (/^FATAL[[\s]/.test(line)) return line;
  }
  return null;
}

/**
 * FATAL 分类。`tun-*` 三档对应 sing-tun 在 `tun.New()` 里的不同失败点，用户可操作性差异很大；
 * `other` = 认得是 FATAL 但不在已知表内（照原文透传，永远好过编造）。
 */
export type SingBoxFatalKind =
  | 'tun-address-conflict'
  | 'tun-adapter-create'
  | 'tun-dns'
  | 'tun-other'
  | 'other';

export interface SingBoxFatalInfo {
  kind: SingBoxFatalKind;
  /** 原始 FATAL 行（已剥色码），供日志留证。 */
  raw: string;
  /** 面向用户的中文说明（可操作）。 */
  message: string;
}

/**
 * 把一条 FATAL 行分类成可操作的中文说明。
 *
 * @param line   FATAL 行（stripAnsi 后的原文）
 * @param ctx.tunAddress 本次实际下发的 TUN IPv4 地址（裸 IP 或 CIDR），用于地址冲突文案点名具体地址。
 */
export function classifySingBoxFatal(
  line: string,
  ctx?: { tunAddress?: string }
): SingBoxFatalInfo {
  const raw = stripAnsi(line).trim();
  const lower = raw.toLowerCase();
  const addr = ctx?.tunAddress ? ctx.tunAddress.split('/')[0] : '';

  // 地址冲突（#324 实证）：Windows `CreateUnicastIpAddressEntry` 撞 ERROR_OBJECT_ALREADY_EXISTS，
  // 消息是 "The object already exists."。占用方可能是一张 Disconnected/隐藏的适配器（本案是残留的
  // TAP-Windows V9），设备管理器默认看不到，故文案必须点出这一点，否则用户会回答「没有别的网卡」。
  if (lower.includes('set ipv4 address') || lower.includes('set ipv6 address')) {
    // v4/v6 必须分叉：macOS 默认给 TUN 配 IPv6，v6 撞车时点名 ctx.tunAddress（恒为 v4）会把用户引去找占用
    // 172.19.0.1 的网卡——方向全错。且 P0-2 的候选池只避让 v4，对 v6 冲突无避让，文案不能暗示已处理。
    const isV6 = lower.includes('set ipv6 address');
    const suffix =
      '无法配置到虚拟网卡。占用方可能是一张已断开或隐藏的适配器（设备管理器默认不显示），常见于其它 VPN/TUN 客户端的残留网卡。';
    return {
      kind: 'tun-address-conflict',
      raw,
      message: isV6
        ? `TUN 的 IPv6 地址已被本机其它网络接口占用，${suffix}`
        : addr
          ? `TUN 地址 ${addr} 已被本机其它网络接口占用，${suffix}`
          : `TUN 地址已被本机其它网络接口占用，${suffix}`,
    };
  }

  // 适配器创建失败（驱动层）：wintun 从内存反射加载（sing-tun/internal/wintun/memmod），是杀软启发式的
  // 高命中面；也可能是其它厂商的 wintun 驱动版本冲突或 HVCI 拒绝。
  if (lower.includes('create adapter') || lower.includes('open existing adapter')) {
    return {
      kind: 'tun-adapter-create',
      raw,
      message:
        '虚拟网卡（wintun）创建失败。常见原因：wintun 驱动被安全软件拦截或隔离、驱动版本与其它 VPN 客户端冲突。',
    };
  }

  if (lower.includes('set ipv4 dns') || lower.includes('set ipv6 dns')) {
    return { kind: 'tun-dns', raw, message: 'TUN 接口的 DNS 下发失败。' };
  }

  // 仍在 tun.New() 窗口内但不在已知表：透传原文，不编造原因。
  if (lower.includes('configure tun interface')) {
    return { kind: 'tun-other', raw, message: `TUN 接口配置失败：${raw}` };
  }

  return { kind: 'other', raw, message: `sing-box 启动失败：${raw}` };
}

/**
 * 按 run 边界切出「本次起核」写入的片段。
 *
 * 两个写侧的截断语义相反（见 utils/paths.ts）：Windows helper 侧 `O_APPEND` 永不截断，文件会跨会话无限
 * 追加；UAC 看护脚本的 `-RedirectStandardError` 与 macOS wrapper 则每次起核截断。而 sing-box 的
 * `FATAL[0000]` 只有启动相对秒、**没有墙钟时间戳**，光看内容无法判断某条 FATAL 属于哪次会话。
 * 故调用方在起核前记录文件大小作锚点，失败时按锚点切——不切就会读到几个月前的残留 FATAL 并当成本次原因，
 * 那比不报更糟。
 *
 * **适用边界（勿误用）**：本函数按「文件只增不减」推断 run 边界，只对**追加写侧**成立（当前三平台 helper 路径
 * 均为 `O_APPEND`）。对**截断写侧**（Windows UAC 的 `-RedirectStandardError`、macOS wrapper 的 `> "$LOG"`）
 * 不可用：重复失败腿写出逐字节相同的内容时 `sizeNow === offsetBytes`，会被判成「本腿零写入」而切成空串，
 * FATAL 系统性丢失。截断写侧的调用方应直接按「整文件即本次」处理（写侧类型可由 `startedViaWrapper` 判定）。
 *
 * @param text        起核后读到的文件全文（或 tail）
 * @param offsetBytes 起核前记录的文件字节大小
 * @param sizeNow     当前文件字节大小；小于 offsetBytes 说明文件被截断过 → 全文都是本次的
 */
export function sliceSinceRunStart(text: string, offsetBytes: number, sizeNow: number): string {
  if (offsetBytes <= 0) return text;
  // 截断过 → 现有内容全部属于本次起核。
  if (sizeNow < offsetBytes) return text;
  // 追加语义：text 可能只是 tail（起始被裁过），此时按「新增字节数」从尾部取。
  const appended = sizeNow - offsetBytes;
  if (appended <= 0) return '';
  const buf = Buffer.from(text, 'utf-8');
  if (appended >= buf.length) return text;
  const sliced = buf.subarray(buf.length - appended).toString('utf-8');
  // 切点可能落在多字节字符/行中间 → 丢弃首个不完整行，保持可读。
  const nl = sliced.indexOf('\n');
  return nl >= 0 ? sliced.slice(nl + 1) : sliced;
}
