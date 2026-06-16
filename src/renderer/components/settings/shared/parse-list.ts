/**
 * 把用户在单/多行输入框里填的 CIDR / 地址列表拆成数组：按逗号、空白、换行任意组合分隔，trim 去空。
 * WireGuard（localAddress/allowedIPs/reserved）与 Tailscale（routes/advertiseRoutes）共用——
 * 同一份分隔语义，杜绝两表单各自 split 漂移（reserved 的纯数字解析在 wireguard-form 自行二次过滤）。
 */
export const splitTextList = (v: string | undefined): string[] =>
  (v || '')
    .split(/[\n,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
