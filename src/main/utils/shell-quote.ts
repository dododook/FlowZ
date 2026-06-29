/**
 * shell 单引号转义（防注入）：把字符串包进单引号，内部单引号用 '\'' 序列闭合-转义-重开。
 * POSIX sh / bash 通用。
 *
 * shell 脚本生成的单一真值——原先 ProxyManager / PlatformPrivilegeService / HelperManager /
 * update-install-script 各持一份字节级同形副本，收敛至此，杜绝「改一处忘同步另一处」的转义漂移。
 */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
