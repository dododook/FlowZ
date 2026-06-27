/**
 * 图标代理协议（Phase 1b §8）：renderer 的外部图标 <img> 不直接走 default session（删 default session
 * pin 后 manual 接管模式会破图），改用自定义 protocol flowz-icon:// 由 main 经 update-in 统一会话拉取，
 * 全模式经核。本模块零运行时依赖，scheme 名 + URL 构造在 main/renderer 间单一真值共享。
 */
export const ICON_PROXY_SCHEME = 'flowz-icon';

/**
 * 把外部图标 URL 包成 flowz-icon:// 代理 URL（renderer 端 <img src>）。空 / 非 http(s) URL 原样返回
 * （emoji 占位、data:、本地资源不代理）。host 段固定 'i'，真实 URL 经 encodeURIComponent 放 pathname，
 * 由 main protocol handler decode 后经 update-in 拉取。
 */
export function iconProxySrc(url: string | undefined | null): string {
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) return url; // 非网络 URL（data:/本地）不代理
  return `${ICON_PROXY_SCHEME}://i/${encodeURIComponent(url)}`;
}
