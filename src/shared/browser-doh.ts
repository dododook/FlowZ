/**
 * 浏览器 DoH 泄漏拦截清单（单一真值）。
 *
 * **为什么需要拦**：浏览器自带 DoH 时，域名解析直接以 HTTPS 打向 DoH 提供商，**不经系统 UDP 53**，
 * 于是绕开 sing-box 的 `hijack-dns` → 绕开 FakeIP 与 DNS 分流。后果是域名级分流（geosite）退化成
 * IP 级、国内外判别失准，且查询内容不再受隧道约束。拦掉它们（发 RST 而非静默丢包）能让浏览器
 * 立即回退到系统 UDP 53，重新进入 FlowZ 的 DNS 体系。
 *
 * **为什么必须可编辑，而不是内置固定表**：这本质是**黑名单，做不到完备**。Chrome/Firefox 可选的
 * DoH 提供商远不止下面五个（NextDNS / AdGuard / Mullvad / DNS.SB / ControlD…），Firefox 还允许
 * 填任意自定义 URL —— 换一个不在表里的提供商即绕过。故内置项只作**默认值**，用户可增可删；
 * 与「绕过局域网」清单（`effectiveBypassLan`）同一套「开关 + 可编辑清单」形态，不引新概念。
 *
 * 匹配方式是 `domain_keyword`（子串），故 `dns.google` 同时覆盖 `dns.google.com`。
 */

/** 默认拦截的 DoH 域名关键词：浏览器内置/默认提供商里最常见的几个。 */
export const DEFAULT_BROWSER_DOH_KEYWORDS: readonly string[] = [
  'dns.google',
  'cloudflare-dns.com',
  'doh.opendns.com',
  'dns.quad9.net',
  'one.one.one.one',
];

/**
 * 本次生效的 DoH 拦截关键词。开关关（`blockBrowserDoh === false`）→ 空数组，调用方据此**不发射**规则。
 * 清单未设置 → 用内置默认值；已设置 → 完全以用户清单为准（含用户删光内置项 = 只留他自己那批）。
 * 逐项 trim 去空，避免空串关键词匹配到一切。
 */
export function effectiveBrowserDohKeywords(config: {
  blockBrowserDoh?: boolean;
  browserDohList?: string[];
}): string[] {
  if (config.blockBrowserDoh === false) return [];
  const list = config.browserDohList ?? [...DEFAULT_BROWSER_DOH_KEYWORDS];
  return list.map((s) => s.trim()).filter(Boolean);
}
