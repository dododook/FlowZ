/**
 * 传输层 network 值标准化 —— 把导入/存量配置里大小写不一的 network（websocket/h2/http2 等别名）收敛到表单
 * Select 的规范值。vless/vmess 表单的 Select 用「大写」值（Tcp/Ws/Grpc/Http/HttpUpgrade）、trojan 表单用
 * 「小写」值（tcp/ws/grpc/http/httpupgrade）—— 两套大小写差异**显式**保留为两个导出，避免三表单各自重复内联同一段
 * 映射（行为与各表单原 normalizeNetwork 逐字节一致）。
 *
 * 别名归一：ws|websocket→ws；httpupgrade→httpupgrade；grpc→grpc；h2|http|http2→http；其余→tcp（默认）。
 */

/** 规范 network 类目（小写真值，与 trojan Select 选项一致）。 */
export type NetworkLower = 'tcp' | 'ws' | 'grpc' | 'http' | 'httpupgrade';
/** 规范 network 类目（大写表单值，与 vless/vmess Select 选项一致）。 */
export type NetworkUpper = 'Tcp' | 'Ws' | 'Grpc' | 'Http' | 'HttpUpgrade';

/** network 标准化（小写变体，trojan 表单用）。 */
export function normalizeNetworkLower(n: string | undefined): NetworkLower {
  const lower = (n || 'tcp').toLowerCase();
  if (lower === 'ws' || lower === 'websocket') return 'ws';
  if (lower === 'httpupgrade') return 'httpupgrade';
  if (lower === 'grpc') return 'grpc';
  if (lower === 'h2' || lower === 'http' || lower === 'http2') return 'http';
  return 'tcp';
}

/** network 标准化（大写变体，vless/vmess 表单用）。复用小写变体后映射，单一映射真值。 */
export function normalizeNetworkUpper(n: string | undefined): NetworkUpper {
  const UPPER: Record<NetworkLower, NetworkUpper> = {
    tcp: 'Tcp',
    ws: 'Ws',
    grpc: 'Grpc',
    http: 'Http',
    httpupgrade: 'HttpUpgrade',
  };
  return UPPER[normalizeNetworkLower(n)];
}
