/**
 * 自定义规则（Rule）的共享逻辑：类型常量、分组、逐类型值校验、端口解析、旧数据迁移。
 * 主进程（ConfigManager 迁移/校验、ProxyManager 生成）与渲染端（rule-dialog 校验）共用，
 * 保证两侧规则语义完全一致（仿 shared/version.ts 的共享惯例）。
 */
import type { Rule, RuleType, RuleCondition, LegacyDomainRule, RuleAction } from './types';
import { isValidMacAddress, isValidSourceHostname } from './neighbor';

export const RULE_TYPE_IDS: RuleType[] = [
  'domain',
  'domainSuffix',
  'domainKeyword',
  'domainRegex',
  'ipCidr',
  'sourceIpCidr',
  'port',
  'sourcePort',
  'sourceMac',
  'sourceHostname',
  'processName',
  'processPath',
  'geosite',
  'geoip',
  'ruleSet',
];

// device = 按源设备识别（MAC / 主机名，sing-box 1.14 局域网网关场景，仅 Linux/macOS）。
export type RuleCategory = 'domain' | 'network' | 'device' | 'process' | 'ruleset';

export const RULE_TYPE_CATEGORY: Record<RuleType, RuleCategory> = {
  domain: 'domain',
  domainSuffix: 'domain',
  domainKeyword: 'domain',
  domainRegex: 'domain',
  ipCidr: 'network',
  sourceIpCidr: 'network',
  port: 'network',
  sourcePort: 'network',
  sourceMac: 'device',
  sourceHostname: 'device',
  processName: 'process',
  processPath: 'process',
  geosite: 'ruleset',
  geoip: 'ruleset',
  ruleSet: 'ruleset',
};

/** 仅这三类域名规则支持 bypassFakeIP。 */
export const BYPASS_FAKEIP_TYPES: RuleType[] = ['domain', 'domainSuffix', 'domainKeyword'];

// 域名：标签 1-63 字符、可含通配 *. 前缀（domainSuffix 容忍）；不强校验 TLD（geosite 标签另有规则）
const DOMAIN_RE =
  /^(\*\.)?([a-zA-Z0-9_](?:[a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?\.)*[a-zA-Z0-9_-]{1,63}$/;
// geo 标签：小写字母数字 + ! - _（如 geolocation-!cn、category-ads-all）
// geo 标签大小写不敏感（用户输 CN 也接受）；生成期统一 lowercase（远程 .srs 文件名为小写）
const GEO_TAG_RE = /^[a-z0-9!_-]+$/i;
const PORT_RE = /^\d{1,5}(-\d{1,5})?$/;

/** 严格 IPv4：恰 4 段、每段 0-255、禁前导零（sing-box netip 拒 `010.0.0.1`）。 */
function isStrictIpv4(addr: string): boolean {
  const octets = addr.split('.');
  return (
    octets.length === 4 && octets.every((o) => /^(0|[1-9]\d{0,2})$/.test(o) && Number(o) <= 255)
  );
}

/**
 * 结构化 IPv6 校验：处理 `::` 压缩（至多一次）、每段 1-4 hex、末段可为内嵌 IPv4。匹配 sing-box netip.ParsePrefix——
 * 拒 `12345::1`（段>4 位）、`1:2:3:4:5:6:7:8:9`（>8 段）、`::::`/`dead::beef::1`（多个 ::）、`fe80:`、`:` 等会 FATAL 的形态。
 */
function isStrictIpv6(addr: string): boolean {
  const parts = addr.split('::');
  if (parts.length > 2) return false; // 多于一个 ::
  const hasCompression = parts.length === 2;
  const left = parts[0] === '' ? [] : parts[0].split(':');
  const right = hasCompression ? (parts[1] === '' ? [] : parts[1].split(':')) : [];
  const groups = [...left, ...right];
  let ipv4Suffix = false;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (i === groups.length - 1 && g.includes('.')) {
      if (!isStrictIpv4(g)) return false; // 末段内嵌 IPv4（如 ::ffff:192.168.1.1）
      ipv4Suffix = true;
    } else if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
      return false;
    }
  }
  const count = groups.length + (ipv4Suffix ? 1 : 0); // 内嵌 IPv4 占 2 个 16-bit 段
  // 无 :: 须恰 8 段；有 :: 时它代表 ≥1 个零段，故显式段须 ≤7。
  return hasCompression ? count <= 7 : count === 8;
}

/**
 * IPv4/IPv6（可选 CIDR 掩码）严格校验。**含范围+结构检查**：八位组 ≤255、禁前导零、掩码 v4≤32 / v6≤128、
 * IPv6 结构合法。旧的纯形状正则会放过 `10.0.0.0/40`、`300.300.300.300`、`abc`、`12345::1`、`010.0.0.1` 等，
 * 这些值会让 sing-box 启动 FATAL（且落在 endpoints[]/route.rules[] 时启动前 gate 无法按 outbounds 索引剪除→整体启动失败）。
 * ConfigManager 对 endpoint allowedIPs/routes/localAddress 用本函数 sanitize（丢弃非法项防 FATAL），customRules
 * 校验亦共用——单一真值，杜绝「校验通过却启动炸」。
 */
export function isValidIpCidr(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  const slash = v.indexOf('/');
  const addr = slash === -1 ? v : v.slice(0, slash);
  const maskStr = slash === -1 ? undefined : v.slice(slash + 1);
  const isV6 = addr.includes(':');
  if (maskStr !== undefined) {
    if (!/^\d{1,3}$/.test(maskStr)) return false;
    if (Number(maskStr) > (isV6 ? 128 : 32)) return false;
  }
  return isV6 ? isStrictIpv6(addr) : isStrictIpv4(addr);
}

function validPortToken(v: string): boolean {
  if (!PORT_RE.test(v)) return false;
  const parts = v.split('-').map((n) => parseInt(n, 10));
  return parts.every((n) => n >= 1 && n <= 65535) && (parts.length === 1 || parts[0] <= parts[1]);
}

/** 单条规则值是否合法（按类型）。空串一律非法。 */
export function validateRuleValue(type: RuleType, value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  switch (type) {
    case 'domain':
    case 'domainSuffix':
    case 'domainKeyword':
      // keyword 允许任意非空子串；domain/suffix 走域名形状
      return type === 'domainKeyword' ? v.length > 0 : DOMAIN_RE.test(v);
    case 'domainRegex':
      // sing-box 用 Golang RE2：拒绝 RE2 不支持的 lookahead/lookbehind/反向引用（过 JS 校验却启动 FATAL）
      if (/\(\?[=!<]|\\[1-9]/.test(v)) return false;
      try {
        new RegExp(v);
        return true;
      } catch {
        return false;
      }
    case 'ipCidr':
    case 'sourceIpCidr':
      return isValidIpCidr(v);
    case 'port':
    case 'sourcePort':
      return validPortToken(v);
    case 'sourceMac':
      // EUI-48 MAC（冒号/连字符/Cisco 点分）；脏 MAC 会让 TUN 侧 check / 启动 FATAL。
      return isValidMacAddress(v);
    case 'sourceHostname':
      // DHCP 租约主机名形状（字母数字 + 连字符）。
      return isValidSourceHostname(v);
    case 'processName':
      return !v.includes('/') && !v.includes('\\');
    case 'processPath':
      return v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v);
    case 'geosite':
    case 'geoip':
      return GEO_TAG_RE.test(v);
    case 'ruleSet':
      // 本地资源引用 res:<id> 或 http(s) URL
      if (v.startsWith('res:')) return v.length > 4;
      return /^https?:\/\/.+/i.test(v);
    default:
      return false;
  }
}

/** 规则的条件列表（**唯一遍历入口**）：多条件取 conditions，否则退化为单条件 [{type,values}]。 */
export function ruleConditions(
  rule: Pick<Rule, 'type' | 'values' | 'conditions'>
): RuleCondition[] {
  return rule.conditions && rule.conditions.length > 0
    ? rule.conditions
    : [{ type: rule.type, values: rule.values }];
}

/** 一条规则里的全部 ipCidr 值（trim/去空，扫所有条件）。供「与组网 mesh 段重叠」提醒共用。 */
export function ruleIpCidrs(rule: Pick<Rule, 'type' | 'values' | 'conditions'>): string[] {
  return ruleConditions(rule)
    .filter((c) => c.type === 'ipCidr')
    .flatMap((c) => (Array.isArray(c.values) ? c.values : []))
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
}

/** 聚合校验一条规则：每个条件类型合法 + 至少一个合法值；combineMode 合法；镜像 type 合法（旁路写防御）。 */
export function validateRule(
  rule: Pick<Rule, 'type' | 'values' | 'conditions' | 'combineMode'>
): boolean {
  if (rule.combineMode !== undefined && rule.combineMode !== 'and' && rule.combineMode !== 'or') {
    return false;
  }
  // 镜像 type 必须合法：消费点/回滚兼容读 rule.type，非法镜像会让 ConfigManager 整条丢弃
  if (!RULE_TYPE_IDS.includes(rule.type)) return false;
  const conds = ruleConditions(rule);
  if (conds.length === 0) return false;
  return conds.every((c) => {
    if (!c || !RULE_TYPE_IDS.includes(c.type)) return false;
    // 非数组/非字符串值防御：旁路 config:save 可注入，避免 v.trim() 抛 TypeError 冒泡成内部错误
    if (!Array.isArray(c.values)) return false;
    const vals = c.values.filter((v) => typeof v === 'string' && v.trim());
    return vals.length > 0 && vals.every((v) => validateRuleValue(c.type, v));
  });
}

/** 端口值数组 → sing-box 的 port(单端口) 与 port_range("start:end") 两组。 */
export function parsePortValues(values: string[]): { ports: number[]; ranges: string[] } {
  const ports: number[] = [];
  const ranges: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (!validPortToken(v)) continue;
    if (v.includes('-')) {
      const [a, b] = v.split('-');
      ranges.push(`${parseInt(a, 10)}:${parseInt(b, 10)}`);
    } else {
      ports.push(parseInt(v, 10));
    }
  }
  return { ports, ranges };
}

/** 是否旧版 DomainRule（无 type 字段且 domains 为数组）。要求 domains 为数组，防字符串被按字符迭代。 */
export function isLegacyDomainRule(r: unknown): r is LegacyDomainRule {
  return (
    !!r &&
    typeof r === 'object' &&
    !('type' in (r as Record<string, unknown>)) &&
    Array.isArray((r as Record<string, unknown>).domains)
  );
}

/**
 * 旧 DomainRule → 新 Rule[]（幂等、无损）。拆分输出与 generateCustomRules 旧行为一一对应，路由结果不变：
 *   ① 纯域名（剥 *.）→ domainSuffix（沿用原 id，带 bypassFakeIP）
 *   ② domains 中的 geosite:xxx → geosite（id = old.id + '_geosite'）
 *   ③ ipCidr → ipCidr（id = old.id + '_ip'，remarks 追加 ' (IP)'）
 * action/enabled/targetServerId/remarks 全量继承。
 */
export function migrateLegacyDomainRule(old: LegacyDomainRule): Rule[] {
  const out: Rule[] = [];
  // action 非法时回退 proxy；enabled 仅 false 才禁用（缺字段视为启用）——无损迁移
  const action: RuleAction = (['proxy', 'direct', 'block'] as const).includes(old.action)
    ? old.action
    : 'proxy';
  const enabled = old.enabled !== false;
  const domains: string[] = [];
  const geositeTags: string[] = [];

  for (const d of Array.isArray(old.domains) ? old.domains : []) {
    const v = (d || '').trim();
    if (!v) continue;
    if (v.toLowerCase().startsWith('geosite:')) {
      const tag = v.slice('geosite:'.length).trim();
      if (tag) geositeTags.push(tag);
    } else {
      domains.push(v.replace(/^\*\./, ''));
    }
  }

  if (domains.length > 0) {
    out.push({
      id: old.id,
      type: 'domainSuffix',
      values: domains,
      action,
      enabled,
      bypassFakeIP: old.bypassFakeIP,
      targetServerId: old.targetServerId,
      remarks: old.remarks,
    });
  }

  if (geositeTags.length > 0) {
    out.push({
      id: `${old.id}_geosite`,
      type: 'geosite',
      values: geositeTags,
      action,
      enabled,
      targetServerId: old.targetServerId,
      remarks: old.remarks,
    });
  }

  if (Array.isArray(old.ipCidr) && old.ipCidr.length > 0) {
    out.push({
      id: `${old.id}_ip`,
      type: 'ipCidr',
      values: old.ipCidr.filter((x) => (x || '').trim()),
      action,
      enabled,
      targetServerId: old.targetServerId,
      remarks: old.remarks ? `${old.remarks} (IP)` : undefined,
    });
  }

  // 极端兜底：旧规则既无域名也无 ipCidr → 产出一条空 domainSuffix 占位，避免规则凭空消失
  if (out.length === 0) {
    out.push({
      id: old.id,
      type: 'domainSuffix',
      values: [],
      action,
      enabled,
      bypassFakeIP: old.bypassFakeIP,
      targetServerId: old.targetServerId,
      remarks: old.remarks,
    });
  }

  return out;
}

/**
 * 迁移整个 customRules 数组（混合新旧）：旧规则展开为多条新规则，新规则原样保留。幂等。
 */
export function migrateCustomRules(rules: unknown[]): Rule[] {
  const out: Rule[] = [];
  for (const r of Array.isArray(rules) ? rules : []) {
    if (isLegacyDomainRule(r)) {
      out.push(...migrateLegacyDomainRule(r));
    } else if (r && typeof r === 'object' && 'type' in (r as Record<string, unknown>)) {
      out.push(r as Rule);
    }
    // 其它脏数据丢弃
  }
  return out;
}

/** customRules 是否包含任何旧版规则（决定是否需要迁移 + 备份）。 */
export function customRulesNeedMigration(rules: unknown[]): boolean {
  return Array.isArray(rules) && rules.some((r) => isLegacyDomainRule(r));
}
