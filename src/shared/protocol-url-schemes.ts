/**
 * 分享链接支持的协议 scheme 单一真值。
 * 由 ProtocolParser.isSupported（分享链接解析 + 本地导入 links 分支共用）消费此列表，
 * 避免多处白名单各自维护导致漂移（naive:// 曾仅后端支持、前端漏列，撞 issue #191 导入语境）。
 */
export const SUPPORTED_URL_SCHEMES = [
  'vless',
  'vmess',
  'trojan',
  'hysteria2',
  'hy2',
  'ss',
  'anytls',
  // snell 无标准 scheme，此为 Surge 生态工具（sub-store 等）的事实形态：
  // snell://psk@host:port?version=4&obfs=http&obfs-host=bing.com#name
  'snell',
  'tuic',
  'naive',
  'http2',
  'naive+https',
  'socks5',
  'socks',
  's5',
  'http',
  'https',
] as const;

/**
 * 判断字符串是否为受支持的协议分享链接。
 * 前缀精确匹配 `<scheme>://`：'http' → 'http://' 不会误命中 'https://'
 * （后者不以 'http://' 开头），故列表顺序无关。
 */
export function isSupportedShareUrl(url: string): boolean {
  return SUPPORTED_URL_SCHEMES.some((scheme) => url.startsWith(`${scheme}://`));
}
