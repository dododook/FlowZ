/**
 * 远程实例（P5 Phase2）安全纯逻辑：环回主机判定 + 「非环回明文（h2c）泄漏 Bearer」防护（E-2）。
 *
 * 背景：SingBoxApiClient 端点无 tls → channelCredentials() 走 createInsecure() = h2c 明文，Bearer secret 经
 * per-call metadata 明文上线。本地实例（SSH 隧道 host=localhost/127.0.0.1）明文走环回是合法的；但**非环回主机**
 * （公网/LAN）无 tls 时明文发 Bearer = 凭据网络泄漏。
 *
 * 与 shared/ssrf-guard.isPrivateIp 语义正交：那个判「内网/回环/link-local/CGNAT」整体（含 192.168/10.x LAN），
 * 用于 SSRF 防护、范围更宽；本判定仅识别**严格环回**（localhost / 127.0.0.0/8 / ::1），LAN IP 视为「非环回」
 * （局域网亦可被嗅探，无 tls 同样泄漏 Bearer，故归不安全侧）。零依赖、零 I/O，便于独立单测。
 */

/**
 * 是否严格环回主机：localhost（大小写不敏感）/ 127.0.0.0/8（IPv4 回环段）/ ::1（IPv6 回环，含 [::1] 方括号写法）。
 * 仅这三类的 h2c 明文 Bearer 被视为安全（本机/SSH 隧道，不上物理链路）。其余（公网域名、LAN IP、0.0.0.0 等）= 非环回。
 */
export function isLoopbackHost(host: string): boolean {
  if (typeof host !== 'string') return false;
  const h = host
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (h === '') return false;
  if (h === 'localhost') return true;
  if (h === '::1') return true;
  // 127.0.0.0/8：首字节 127 即环回（127.0.0.1 / 127.1 等点分写法保守只认完整四段 127.x.x.x）。
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    if (a === 127 && [m[1], m[2], m[3], m[4]].every((o) => Number(o) >= 0 && Number(o) <= 255)) {
      return true;
    }
  }
  return false;
}

/**
 * 「非环回明文泄漏 Bearer」判定（E-2 核心）：host 非环回、无 tls、且带 secret → secret 会明文上链路 = 不安全。
 * @returns true = 该实例配置会明文泄漏 Bearer secret，调用方应据此剥离 secret（或拒绝）。
 */
export function leaksBearerOverPlaintext(inst: {
  host: string;
  tls?: unknown;
  secret?: string;
}): boolean {
  if (isLoopbackHost(inst.host)) return false; // 环回 h2c 合法（SSH 隧道 / 本机）
  if (inst.tls) return false; // 带 tls 走 TLS，Bearer 不明文
  return typeof inst.secret === 'string' && inst.secret !== ''; // 无 tls + 非环回 + 有 secret = 泄漏
}
