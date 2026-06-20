/**
 * TLS spoof（抗审查，sing-box 1.14）的平台/arch 门控 + 方法枚举 —— 主进程构建与渲染层表单共用单一真值。
 *
 * 能力来自 sing-box 1.14 的 `tls.spoof`/`tls.spoof_method`（outbound）与 `tls_spoof`/`tls_spoof_method`
 * （route action rule）。真握手前先发一份伪造的 ClientHello（白名单 SNI），诱使 SNI 过滤中间盒放行，
 * 用于跨境抗 SNI 阻断。
 *
 * 硬限界（已用真实 1.14 内核 `sing-box check` 实证，见设计 [[singbox-1.14-features]] §F）：
 *   1. 需提权：Linux 需 CAP_NET_RAW + CAP_NET_ADMIN、macOS 需 root、Windows 需管理员
 *      （spoof 直接操作裸 TCP 套接字注入伪造包）。
 *   2. **ARM64 不支持**：内核该能力仅在 amd64 实现 → ARM64 上不可用。
 *   3. **拒 IP-literal SNI**：内核 init 时报 `spoof requires TLS ClientHello with SNI`，
 *      故 server_name 为 IP 字面量时绝不下发 spoof（否则整代理 FATAL）。
 *
 * 因此门控分两层：
 *   · 平台/arch 门控（本文件 isTlsSpoofSupportedArch）—— ARM64 直接不可用；表单据此置灰带 tooltip。
 *   · SNI 门控（构建期）—— server_name 为 IP 字面量则不 emit（见 singbox-outbound-builder applyAntiCensorshipOptions）。
 */

/** TLS spoof 伪造方法枚举（sing-box 1.14 实证：仅这三个合法，其它值 → `tls_spoof: unknown method`）。 */
export const TLS_SPOOF_METHODS = ['wrong-ack', 'wrong-md5', 'wrong-timestamp'] as const;
export type TlsSpoofMethod = (typeof TLS_SPOOF_METHODS)[number];

/** 给定方法值是否为合法枚举（容错旁路写/旧配置）。 */
export function isValidTlsSpoofMethod(m: string | undefined): m is TlsSpoofMethod {
  return !!m && (TLS_SPOOF_METHODS as readonly string[]).includes(m);
}

/**
 * 当前 arch 是否支持 TLS spoof。**唯一判据是非 ARM64**（内核仅 amd64 实现）。
 * 接受 Node 的 process.arch 取值（'x64'/'arm64'/'arm'/'ia32'/...）。
 * arm/arm64 视为不支持；其余（x64/ia32 等 amd64 系/x86）视为支持。
 */
export function isTlsSpoofSupportedArch(arch: string | undefined): boolean {
  if (!arch) return false; // 拿不到 arch 时保守置不可用（宁缺毋滥，避免误下发致 FATAL）
  const a = arch.toLowerCase();
  return a !== 'arm64' && a !== 'arm' && a !== 'aarch64';
}

/**
 * 协议是否适用 TLS spoof（仅「标准 sing-box TCP-TLS 栈」有意义）。排除：
 *   · hysteria2 / tuic：TLS 在 QUIC 内、无 TCP ClientHello（spoof 是 TCP 套接字层伪造，对 QUIC 无效）。
 *   · naive：TLS 由 Cronet 自管，sing-box naive 出站不接受这类 TLS 注入字段。
 * 与 fragment 的排除集一致（applyAntiCensorshipOptions fragmentUnsupported）。
 */
export function isTlsSpoofSupportedProtocol(protocol: string | undefined): boolean {
  const p = (protocol || '').toLowerCase();
  return p !== 'hysteria2' && p !== 'tuic' && p !== 'naive';
}

/**
 * TLS spoof 是否应下发（构建期统一门控）—— outbound（singbox-outbound-builder）与 route action rule
 * （singbox-custom-rules）共用单一真值，杜绝两处门控漂移。任一不满足即返回 false（不 emit，否则内核 FATAL/无效）：
 *   1. 方法合法（wrong-ack/wrong-md5/wrong-timestamp）；
 *   2. arch 支持（ARM64 不支持，内核仅 amd64 实现）；
 *   3. 诱饵 SNI 非空；
 *   4. 诱饵 SNI 非 IP 字面量（内核拒 `spoof requires TLS ClientHello with SNI`）；
 *   5.（仅 outbound：传入 protocol 时）协议为标准 TCP-TLS 栈（排除 hy2/tuic/naive）；
 *   6.（仅 outbound：传入 serverSni 时）诱饵 SNI 不同于真 server_name（内核 FATAL `spoof must differ from server_name`）。
 * 提权是运行期生效条件，不影响配置合法性 → 不在此门控（UI 已提示）。
 *
 * @param isIpLiteral 注入的 IP 字面量判定（shared/dns.isIpLiteral）；保持 shared/tls-spoof 零跨模块依赖。
 */
export function validateTlsSpoof(
  spoofSni: string | undefined,
  method: string | undefined,
  arch: string | undefined,
  isIpLiteral: (host: string) => boolean,
  opts?: { protocol?: string; serverSni?: string }
): boolean {
  const sni = spoofSni?.trim();
  if (!isValidTlsSpoofMethod(method)) return false;
  if (!isTlsSpoofSupportedArch(arch)) return false;
  if (!sni) return false;
  if (isIpLiteral(sni)) return false;
  if (opts?.protocol !== undefined && !isTlsSpoofSupportedProtocol(opts.protocol)) return false;
  if (opts?.serverSni !== undefined && sni === opts.serverSni) return false;
  return true;
}
