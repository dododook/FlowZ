/**
 * 连接信息页纯逻辑（无 React 依赖）：抽到独立 .ts 便于 jest（node env / testMatch *.test.ts）单测。
 * 含 per-conn 速率差分 + 隐私屏蔽判定 + 各列展示派生。
 */
import type { ConnectionEntry } from '../../../shared/types';

/** 上一帧累计字节缓存（按连接 id）：用于跨两帧差分算 per-conn 速率。 */
export type RateState = Map<string, { up: number; down: number; at: number }>;

/** per-conn 速率（B/s）。 */
export interface ConnSpeed {
  up: number;
  down: number;
}

/**
 * per-conn 速率差分（纯函数，供单测）：对当前帧每条连接，用 prev 缓存里同 id 的 upload/download/at 求差分速率。
 * - 新连接（prev 无）→ 速率 0（首帧无基准）。
 * - 速率 = max(0, (cur-prev)/dt)：clamp≥0 防核重启累计回绕出负值；dt 下限 1ms 防除零爆炸。
 * - 返回 { speeds(id→ConnSpeed), next(下一轮 prev 缓存，仅含本帧仍在的连接 → 消失的连接自然清出) }。
 */
export function computeConnSpeeds(
  conns: ConnectionEntry[],
  prev: RateState,
  now: number
): { speeds: Map<string, ConnSpeed>; next: RateState } {
  const speeds = new Map<string, ConnSpeed>();
  const next: RateState = new Map();
  for (const c of conns) {
    const up = c.upload ?? 0;
    const down = c.download ?? 0;
    const p = prev.get(c.id);
    if (p) {
      const dt = Math.max((now - p.at) / 1000, 0.001);
      speeds.set(c.id, {
        up: Math.max(0, (up - p.up) / dt),
        down: Math.max(0, (down - p.down) / dt),
      });
    } else {
      speeds.set(c.id, { up: 0, down: 0 }); // 新连接首帧无基准 → 0
    }
    next.set(c.id, { up, down, at: now });
  }
  return { speeds, next };
}

/**
 * 隐私屏蔽判定（纯函数，供单测）：连接表含 sourceIP/processPath 敏感字段，隐私模式激活时不展示明细（决策）。
 * 返回 true = 应屏蔽（页面渲染「隐私模式下不可用」，不把敏感数据进 DOM）。
 */
export function shouldHideForPrivacy(isPrivacyMode: boolean): boolean {
  return isPrivacyMode === true;
}

/** 连接的目标展示：host 优先，回落 destinationIP，带目标端口。 */
export function destOf(c: ConnectionEntry): string {
  const m = c.metadata || {};
  const host = m.host || m.destinationIP || '';
  const port = m.destinationPort ? `:${m.destinationPort}` : '';
  return host ? `${host}${port}` : '-';
}

/** 源展示：sourceIP:sourcePort。 */
export function sourceOf(c: ConnectionEntry): string {
  const m = c.metadata || {};
  if (!m.sourceIP) return '-';
  return m.sourcePort ? `${m.sourceIP}:${m.sourcePort}` : m.sourceIP;
}

/** 类型展示：network/type（如 tcp/Tun）。 */
export function typeOf(c: ConnectionEntry): string {
  const m = c.metadata || {};
  const parts = [m.network, m.type].filter(Boolean);
  return parts.length ? parts.join('/') : '-';
}

/** 节点链展示。 */
export function chainOf(c: ConnectionEntry): string {
  return c.chains && c.chains.length ? c.chains.join(' / ') : '-';
}

/**
 * 规则去向是否为「阻断」类 action（block / reject / reject-drop / drop）。
 * 供 badge 配色（destructive）与行内弱化（blocked 行 recede）共用，避免两处各写一份判定漂移。
 */
export function isBlockedAction(action: string): boolean {
  const a = (action || '').toLowerCase();
  return a === 'block' || a === 'reject' || a === 'reject-drop' || a === 'drop';
}

/** 时长（now - start，秒）。start 缺/非法 → -1（排序垫底、展示 '-'）。 */
export function durationSec(c: ConnectionEntry, now: number): number {
  if (!c.start) return -1;
  const t = Date.parse(c.start);
  if (isNaN(t)) return -1;
  return Math.max(0, (now - t) / 1000);
}

/** 时长格式化（s / m s / h m）。负数（无 start）→ '-'。 */
export function fmtDuration(sec: number): string {
  if (sec < 0) return '-';
  if (sec < 60) return `${Math.floor(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${Math.floor(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

/** 规则展示视图：从连接的 rule/rulePayload 拆出「条件类型」「去向 action」「完整原文（hover）」。 */
export interface RuleView {
  /** 主条件字段名（process_name / domain / rule_set / ...）；复合规则取首个；识别不出为空。 */
  type: string;
  /** 去向 action（direct / block / 节点名 / proxy ...）；尾部 `=> route(X)` 提取；无则空。 */
  action: string;
  /** 完整原文，供 hover/title 展示。 */
  full: string;
}

/**
 * 解析连接匹配规则用于紧凑展示（方案 B：类型 + action badge，payload 收进 hover）。
 * sing-box 的 rule 是整条规则的字符串，可能复合且很长（如 `process_name=[Surge ... cloudd] => route(direct)`
 * 或 `(network=tcp && domain=x) => route(节点)`），原样塞进表格列会撑爆布局。此函数：
 *  - rule 含 `=>` → 视为完整规则串，提尾部去向 action + 首个条件字段类型；payload 列表由 UI 截断 + hover 兜底。
 *  - rule 不含 `=>` → 多为「rule=类型 / rulePayload=值」分离形态，组合成 `类型: 值` 展示。
 * 解析失败（格式非预期）→ type/action 空，UI 回退显示 full 截断（方案 A 兜底），永不丢信息。
 */
export function parseRule(rule: string, rulePayload?: string): RuleView {
  const r = (rule || '').trim();
  const p = (rulePayload || '').trim();
  if (r.includes('=>')) {
    // 解析尾部 action，支持 action 内部含括号（如 route(nested(inner)) / route(proxy,ss)）。
    // 旧正则 [^()=>]+? 把括号排除，遇到含括号 action 直接失配回退空，导致 badge 配色对但 action 显示丢。
    // 改两段式：route(...) 形式贪婪取末尾 ) 内整体 + 括号平衡校验；否则回退裸 action（不含括号）。
    let am = r.match(/=>\s*route\s*\(\s*(.*?)\s*\)\s*$/);
    let action = '';
    let condEnd = r.length;
    if (am) {
      // 校验 action 内部括号平衡：失衡（如 route(a(b)））视为格式异常，留空走兜底
      let depth = 0;
      let balanced = true;
      for (const ch of am[1]) {
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth < 0) {
            balanced = false;
            break;
          }
        }
      }
      if (balanced && depth === 0) {
        action = am[1].trim();
        condEnd = am.index ?? r.length;
      } else {
        am = null;
      }
    }
    if (!am) {
      // 回退：裸 action（无 route 包裹，如 '=> proxy'）；含括号视为格式异常留空
      const am2 = r.match(/=>\s*([^()\s]+?)\s*$/);
      if (am2) {
        action = am2[1].trim();
        condEnd = am2.index ?? r.length;
      }
    }
    const condPart = r.slice(0, condEnd);
    // 限长防 ReDoS：字段名本就短，condPart 截断 256 + 量词上界 63，避免超长无分隔串触发 [\w-]* 灾难性回溯
    // （rule 来自 sing-box clash API、无长度保证；type 字段名在 condPart 前部，截断不影响提取）。
    const tm = condPart.slice(0, 256).match(/([a-zA-Z_][\w-]{0,63})\s*[=:]/);
    return { type: tm ? tm[1] : '', action, full: r };
  }
  const full = r && p ? `${r}: ${p}` : r || p;
  return { type: r, action: '', full };
}
