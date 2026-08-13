/**
 * 自定义路由规则生成 —— 从 ProxyManager.generateCustomRules + applyRuleAction 抽出
 * （SingBoxConfigBuilder 抽取 Phase 2 step 6）。
 *
 * 纯函数：只读 customRules/资源 + 注入实例态依赖（log 回调 / onDegraded 副作用回调）。
 * 用户自定义分流规则 → sing-box route 规则 + rule_set 定义（含 L3 外化 headless、geosite/geoip、
 * res:<id> 本地资源、logical AND/OR、fail-closed 缺失跳过）。config 字节等价由 config-snapshot 网验证。
 */

import * as path from 'path';
import type { Rule, CustomRuleSet, RuleResource, RuleCondition } from '../../shared/types';
import { ruleConditions } from '../../shared/rules';
import { validateTlsSpoof } from '../../shared/tls-spoof';
import { isIpLiteral } from '../../shared/dns';
import {
  isValidMacAddress,
  isValidSourceHostname,
  isSourceDeviceMatchSupported,
} from '../../shared/neighbor';
import {
  EXT_TYPES,
  planCustomRule,
  customRuleFileBase,
  condMatcherFields,
} from './custom-rule-files';
import { getCustomRulesDir, getRuleResourcesPath } from '../utils/paths';
import {
  getRuleSetRuntimeDir as getRuntimeRulesDir,
  isValidSrsFile,
  resolveBuiltinRuleSetRefMeta,
} from './builtin-geo-rulesets';
import type { SingBoxRouteRule, SingBoxRuleSet } from './singbox-config-types';

/** 注入依赖：log = ProxyManager.logToManager（source 默认 'ProxyManager'）；onDegraded = 标记外化文件未落盘降级。 */
export interface CustomRulesDeps {
  log: (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', message: string) => void;
  onDegraded: () => void;
}

export function buildCustomRules(
  customRules: Rule[],
  customRuleSets: CustomRuleSet[] = [],
  selectedServerId: string | undefined,
  idToTagMap: Map<string, string> | undefined,
  selectedServerTag: string = 'proxy',
  ruleResources: RuleResource[] = [],
  registerDnsBypass: boolean = false, // FakeIP 启用时：为外化 bypassFakeIP 规则注册 <base>-dns rule_set 条目
  deps: CustomRulesDeps
): { rules: SingBoxRouteRule[]; ruleSets: SingBoxRuleSet[] } {
  const rules: SingBoxRouteRule[] = [];
  const ruleSets: SingBoxRuleSet[] = [];

  // 目的地 OR 组：这些 type 的字段在单条 default rule 内原生 OR（sing-box: domain||suffix||keyword||regex||ip_cidr）。
  const OR_GROUP = new Set(['domain', 'domainSuffix', 'domainKeyword', 'domainRegex', 'ipCidr']);
  const pushU = <T>(arr: T[] | undefined, items: T[]): T[] => [...(arr || []), ...items];

  // 把一个条件的 type→字段累积到 target（值并集；geosite/geoip→rule_set tag；ruleSet→注册定义+tag）。返回 hasMatcher。
  const applyConditionFields = (cond: RuleCondition, target: SingBoxRouteRule): boolean => {
    // EXT 类型（域名/IP/端口/进程 系）委托单一真值 condMatcherFields——与外化文件内容永不漂移。
    // geosite/geoip/ruleSet 与源设备类（sourceMac/sourceHostname）不可 headless 表达，留 inline（下方 switch）。
    if (EXT_TYPES.has(cond.type)) {
      const fields = condMatcherFields(cond);
      if (!fields) return false;
      const t = target as Record<string, unknown>;
      for (const k of Object.keys(fields)) {
        t[k] = pushU(t[k] as unknown[] | undefined, fields[k] as unknown[]);
      }
      return true;
    }
    const vals = (cond.values || []).map((v) => v.trim()).filter(Boolean);
    if (vals.length === 0) return false;
    switch (cond.type) {
      case 'sourceMac': {
        // P6：源设备 MAC（sing-box 1.14 source_mac_address）。**仅 Linux/macOS**——win32 上内核不支持，发射即 FATAL，
        // 故平台不支持时整条不产 matcher（fail-closed，与脏 MAC 过滤同口径）。脏 MAC 过滤（合法值才下发，杜绝脏值入 config）。
        if (!isSourceDeviceMatchSupported(process.platform)) return false;
        const macs = vals.filter(isValidMacAddress);
        if (macs.length === 0) return false; // 全脏 → 不产 matcher、不留空数组在 target
        target.source_mac_address = pushU(target.source_mac_address, macs);
        return true;
      }
      case 'sourceHostname': {
        // P6：源设备主机名（sing-box 1.14 source_hostname，DHCP 租约名）。仅 Linux/macOS（同上）。
        if (!isSourceDeviceMatchSupported(process.platform)) return false;
        const hosts = vals.filter(isValidSourceHostname);
        if (hosts.length === 0) return false;
        target.source_hostname = pushU(target.source_hostname, hosts);
        return true;
      }
      case 'geosite':
        // 裸标签 → geosite-<tag>（lowercase 对齐 getRequiredGeoCategories 与远程 .srs 文件名）
        target.rule_set = pushU(
          target.rule_set as string[] | undefined,
          vals.map((t) => `geosite-${t.toLowerCase()}`)
        );
        return true;
      case 'geoip':
        target.rule_set = pushU(
          target.rule_set as string[] | undefined,
          vals.map((t) => `geoip-${t.toLowerCase()}`)
        );
        return true;
      case 'ruleSet': {
        // 远程 URL → custom-ruleset-N（format 按扩展名）；本地 res:<id> → 本地 rule_set。tag 去重（重复 tag 会 FATAL）。
        const seen = new Set(
          Array.isArray(target.rule_set)
            ? target.rule_set
            : target.rule_set != null
              ? [target.rule_set]
              : []
        );
        for (const v of vals) {
          let tag: string;
          if (v.startsWith('res:')) {
            const resId = v.slice(4);
            // 内置随包资源（res:builtin:<tag>）：复用 b.tag（geosite-netflix 等），runtime 路径取自单一真值表。
            // proxy 模式下 getLocalGeoRuleSets 已注入同 tag 本地 rule_set；此处自注入 + route 装配末尾按 tag 去重
            // （keep-first，两者同路径同 format，行为一致），故 direct 模式或本地缺失也能自洽。文件缺失/损坏 → 跳过（不 FATAL）。
            const builtinMeta = resolveBuiltinRuleSetRefMeta(resId);
            if (builtinMeta) {
              const filePath = path.join(getRuntimeRulesDir(), builtinMeta.fileName);
              if (!isValidSrsFile(filePath)) {
                deps.log(
                  'warn',
                  `ruleSet 规则引用的内置资源文件缺失/损坏，已跳过: ${builtinMeta.fileName}`
                );
                continue;
              }
              tag = builtinMeta.tag;
              if (!ruleSets.some((rs) => rs.tag === tag)) {
                ruleSets.push({ tag, type: 'local', format: 'binary', path: filePath });
              }
            } else {
              const res = ruleResources.find((rr) => rr.id === resId);
              if (!res) {
                deps.log('warn', `ruleSet 规则引用的资源不存在，已跳过: ${v}`);
                continue;
              }
              const filePath = path.join(getRuleResourcesPath(), res.fileName);
              // 与 builtin 分支对齐：用 isValidSrsFile（验 SRS 魔数）而非裸 existsSync——
              // 损坏/半写文件存在但非法时注入 local rule_set 会让 sing-box 加载 FATAL，须 fail-closed 跳过。
              if (!isValidSrsFile(filePath)) {
                deps.log('warn', `ruleSet 规则引用的资源文件缺失/损坏，已跳过: ${res.fileName}`);
                continue;
              }
              tag = `local-rs-${res.id}`;
              if (!ruleSets.some((rs) => rs.tag === tag)) {
                ruleSets.push({ tag, type: 'local', format: res.format, path: filePath });
              }
            }
          } else {
            // fail-closed：远程 URL rule_set 能力已移除——所有 srs 统一由「规则资源」页管理（res:<id> 引用本地副本）。
            // 旧配置 / 旁路写入的裸 URL 值 → 跳过（不再生成运行期远程下载），日志告知改用规则资源。
            deps.log(
              'warn',
              `ruleSet 规则的远程 URL 已不再支持，请改用「规则资源」下载后引用，已跳过: ${v}`
            );
            continue;
          }
          seen.add(tag);
        }
        if (seen.size > 0) {
          target.rule_set = Array.from(seen);
          return true;
        }
        return false;
      }
    }
    return false;
  };

  // 每条 Rule → 单 default rule（目的地 OR 组合并：单条件 或 combineMode!=='and' 且全为 OR 组类型）
  // 或 logical rule（跨维度/含 rule_set 的 OR、或 AND）。绝不把「应 OR」的条件塞进单 default rule 当 AND。
  for (const rule of customRules) {
    if (!rule.enabled) continue;

    // ── L3 外化分流：全条件可 headless 表达 → 写独立 rule_set 文件，route 仅引用 tag（改值热重载零重启）。
    const plan = planCustomRule(rule);
    const extBase = customRuleFileBase(rule.id);
    // DNS 文件注册须在 ext-skip 跳过之前：route 侧 fail-closed 跳过的 bypass 规则，DNS 侧今日仍消费其域名值。
    if (registerDnsBypass && rule.bypassFakeIP && plan.kind !== 'inline' && plan.dnsRules) {
      const dnsPath = path.join(getCustomRulesDir(), `${extBase}.dns.json`);
      if (
        require('fs').existsSync(dnsPath) &&
        !ruleSets.some((rs) => rs.tag === `${extBase}-dns`)
      ) {
        ruleSets.push({ tag: `${extBase}-dns`, type: 'local', format: 'source', path: dnsPath });
      }
    }
    if (plan.kind === 'ext-skip') continue; // 全 EXT 但 fail-closed → 无 route 规则（DNS 已上方处理）
    if (plan.kind === 'ext') {
      const filePath = path.join(getCustomRulesDir(), `${extBase}.json`);
      if (require('fs').existsSync(filePath)) {
        if (!ruleSets.some((rs) => rs.tag === extBase)) {
          ruleSets.push({ tag: extBase, type: 'local', format: 'source', path: filePath });
        }
        const extRule: SingBoxRouteRule = { action: 'route', rule_set: [extBase] };
        applyRuleAction(
          extRule,
          rule.action,
          rule.targetServerId,
          selectedServerId,
          idToTagMap,
          selectedServerTag,
          rule.id,
          { spoof: rule.tlsSpoof, method: rule.tlsSpoofMethod }
        );
        rules.push(extRule);
        continue;
      }
      // 文件未落盘（预检/onRetry 重生成期）→ 标记降级，回落 inline 现状（值已知，功能不损）。
      deps.onDegraded();
    }

    const rawConds = ruleConditions(rule);
    const conds = rawConds
      .map((c) => ({
        type: c.type,
        values: (c.values || []).map((v) => v.trim()).filter(Boolean),
      }))
      .filter((c) => c.values.length > 0);
    if (conds.length === 0) continue;
    // AND 模式任一条件在预过滤被丢弃（值全空白/空数组）→ 整条跳过（fail-closed）：否则会以剩余条件的
    // 「超集」下发（含坍缩成单 default rule 绕过 logical 分支的 fail-closed）。UI 已拦空值，此为旁路写/手改兜底。
    if (rule.combineMode === 'and' && conds.length < rawConds.length) continue;

    const mergeable =
      conds.length === 1 ||
      (rule.combineMode !== 'and' && conds.every((c) => OR_GROUP.has(c.type)));

    let finalRule: SingBoxRouteRule | null = null;
    if (mergeable) {
      const singboxRule: SingBoxRouteRule = { action: 'route' };
      let hasMatcher = false;
      for (const c of conds) if (applyConditionFields(c, singboxRule)) hasMatcher = true;
      if (hasMatcher) finalRule = singboxRule;
    } else {
      // logical：每条件一个纯 matcher 子规则（无 action/outbound，action/outbound 在外层 logical 规则）
      const subRules: SingBoxRouteRule[] = [];
      let dropped = false;
      for (const c of conds) {
        const sub: SingBoxRouteRule = {};
        if (applyConditionFields(c, sub)) subRules.push(sub);
        else dropped = true; // 该条件无法产出 matcher（如 ruleSet 资源缺失、端口全非法）
      }
      // AND 模式任一子条件被丢弃 → 整条跳过（fail-closed）：否则剩余 AND 子集会匹配「超集」（比用户意图更宽），
      // 与最小权限/旧行为（整条 skip）相悖。OR 模式丢弃失败子条件无害（少一个候选项）。
      if (rule.combineMode === 'and' && dropped) {
        finalRule = null;
      } else if (subRules.length === 1) {
        finalRule = { ...subRules[0], action: 'route' };
      } else if (subRules.length > 1) {
        finalRule = {
          action: 'route',
          type: 'logical',
          mode: rule.combineMode || 'or',
          rules: subRules,
        };
      }
    }
    if (!finalRule) continue;

    applyRuleAction(
      finalRule,
      rule.action,
      rule.targetServerId,
      selectedServerId,
      idToTagMap,
      selectedServerTag,
      rule.id,
      { spoof: rule.tlsSpoof, method: rule.tlsSpoofMethod }
    );
    rules.push(finalRule);
  }

  // fail-closed：legacy customRuleSets（迁移后通常为空，ConfigManager 已转成 customRules）原走运行期远程下载，
  // 远程能力已移除 → 仅日志告知，不再生成 remote rule_set / 路由规则。
  for (const ruleSet of customRuleSets) {
    if (!ruleSet.enabled || !ruleSet.url) continue;
    deps.log('warn', `legacy 远程规则集已不再支持（请用「规则资源」），已跳过: ${ruleSet.url}`);
  }

  return { rules, ruleSets };
}

/**
 * 应用规则动作到 sing-box 规则对象（纯：只改传入 singboxRule，读 idToTagMap 参数）。
 */
function applyRuleAction(
  singboxRule: SingBoxRouteRule,
  action: string,
  targetServerId?: string,
  _selectedServerId?: string, // 3b 后不再用于条件判断（保留位参以不动调用方），下划线跳过未用检查
  idToTagMap?: Map<string, string>,
  selectedServerTag: string = 'proxy',
  ruleId?: string, // rule-sel selector 命名所需（customRule.id）；缺省则回落旧行为
  // P3a：route action TLS spoof（成对的 spoof SNI + 方法）。block 规则不挂（reject 无握手）。
  tlsSpoof?: { spoof?: string; method?: string }
): void {
  if (action === 'proxy') {
    // anti-drift（铁律）：指定了目标节点的规则 → 指向独立 rule-sel-<ruleId> selector，**绝不直绑节点、
    // 绝不经共享 proxy-selector**。直绑节点会让热切全局节点后这条固定规则漂走（复活旧 quirk）；经共享
    // proxy-selector 会让「固定规则」随全局节点漂移。rule-sel 独立 selector 使「改规则目标节点」可经
    // clash_api PUT /proxies/rule-sel-<id> 热切换、且互不干扰。selector 由 generateRuleSelectors 预建；
    // 极端情况（selector 未生成，如降级/onRetry 中间态）→ 死引用由 fixRouteDeadReferences 兜底改写为
    // proxy-selector，启动不 FATAL。
    // rule-sel 恒存在（generateRuleSelectors 为所有 proxy 规则生成）：outbound 恒指 rule-sel-<ruleId>，
    // 「默认/跟全局」= rule-sel default=proxy-selector（嵌套），「指定节点」= default=节点 tag。
    if (ruleId) {
      singboxRule.outbound = `rule-sel-${ruleId}`;
    } else if (targetServerId) {
      const targetTag = idToTagMap?.get(targetServerId);
      singboxRule.outbound = targetTag || `proxy-${targetServerId}`;
    } else {
      singboxRule.outbound = selectedServerTag;
    }
  } else if (action === 'direct') {
    singboxRule.outbound = 'direct';
  } else if (action === 'block') {
    // sing-box 1.14 路由动作：`reject` 就地终止，不经任何出站；与内置的 QUIC / DoH / STUN reject 同形。
    // 取代 legacy 的 `outbound: 'block'`（1.11 起 deprecated）。行为等价已实测（真内核 1.14.0-beta.14，
    // 同一份最小配置只差这一处：两者客户端侧都是立即关闭、502，差别仅在日志——block 出站每拦一条打一行
    // **ERROR** `operation not permitted`，reject 只在 DEBUG 打 `connection closed: rejected`）。
    // 故迁移买到的是「阻断规则不再刷 ERROR 日志淹没真错误」+ 去掉 legacy 依赖，不是失败形态的改变。
    singboxRule.action = 'reject';
    delete singboxRule.outbound;
  } else {
    singboxRule.outbound = selectedServerTag;
  }

  // P3a：route action TLS spoof（sing-box 1.14 tls_spoof/tls_spoof_method）。仅非 block 规则挂（block=reject 无握手）。
  // 门控（方法合法 / arch 支持 / SNI 非空且非 IP 字面量）经 validateTlsSpoof 单一真值，与 outbound spoof 共用。
  // route action 规则无固定协议 / 无单一 server_name 上下文 → 不传 protocol / serverSni（那两层仅 outbound 适用）。
  // 提权是运行期生效条件，不影响配置合法性 → 不门控（UI 已提示）。
  if (action !== 'block') {
    const spoofSni = (tlsSpoof?.spoof || '').trim();
    const method = tlsSpoof?.method;
    if (validateTlsSpoof(spoofSni, method, process.arch, isIpLiteral)) {
      singboxRule.tls_spoof = spoofSni;
      singboxRule.tls_spoof_method = method;
    }
  }
}
