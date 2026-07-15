export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.max(Math.floor(Math.log(bytes) / Math.log(k)), 0), units.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${units[i]}`;
}

/** ISO 时间 → 相对时间的 i18n key + 数值（渲染端用 t() 本地化）。非法/空 → null。 */
export function formatTimeAgo(
  iso?: string
): { key: 'justNow' | 'minutesAgo' | 'hoursAgo' | 'daysAgo'; n: number } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return { key: 'justNow', n: 0 };
  if (sec < 3600) return { key: 'minutesAgo', n: Math.floor(sec / 60) };
  if (sec < 86400) return { key: 'hoursAgo', n: Math.floor(sec / 3600) };
  return { key: 'daysAgo', n: Math.floor(sec / 86400) };
}
