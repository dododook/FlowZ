/**
 * 时长字段规整成 sing-box 接受的 Go duration（`time.ParseDuration`）。
 * mihomo / 分享链常把时长字段写成毫秒整数（如 10000），裸传给 sing-box 会报 "missing unit"
 * 启动失败。规则：纯数字（含数字字符串）→ 视为毫秒补 `ms`；已带单位字符串透传。
 *
 * 单一真值：Clash 订阅解析（heartbeat / anytls idle）与 ProtocolParser 的 anytls idle URL 导入
 * 共用本函数，避免两条导入路径产出不一致的 duration 串（收敛面对齐）。
 */
export function normalizeDuration(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') {
    return Number.isFinite(v) ? `${v}ms` : undefined;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return undefined;
    // 纯数字（可含小数）→ 毫秒补单位；否则视为已带单位（10s/500ms/1m 等）透传。
    return /^[0-9]+(\.[0-9]+)?$/.test(t) ? `${t}ms` : t;
  }
  return undefined;
}
