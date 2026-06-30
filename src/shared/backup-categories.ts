/**
 * 选择性备份/恢复的类别模型 + 纯函数（主/渲染/单测共用，零副作用、零 IO）。
 *
 * 6 类（前 5 类对应「数据备份与恢复」卡的统计维度，第 6 类是通用设置）：
 *   manualNodes    手动节点      —— servers（无 subscriptionId、非 endpoint 协议）
 *   meshNodes      组网节点      —— servers（无 subscriptionId、endpoint 协议，如 Tailscale）
 *   subscriptions  订阅源        —— subscriptions[] + 其展开节点（servers 有 subscriptionId）；两者一体进出（离线也能恢复）
 *   customRules    自定义规则    —— customRules[] + customRuleSets[]
 *   appRules       应用分流      —— appRules[] (+ appRulesSeeded)
 *   generalSettings 通用设置     —— 其余所有 config 字段（代理模式/DNS/端口/TUN/外观/语言…），用排除法（自动涵盖未来新增设置）
 *
 * 导出 pickCategories：只抽选中类的字段。
 * 导入 mergeCategories：选中类**整类替换** current，未选类保留；**空跳过**（选了但备份该类为空 → 不用空覆盖、保留 current、记 skipped），防误删。
 */
import type { UserConfig, ServerConfig } from './types';
import { isEndpointProtocol } from './endpoint-routes';
import { isDirectSelection } from './direct-selection';

export type BackupCategory =
  | 'manualNodes'
  | 'meshNodes'
  | 'subscriptions'
  | 'customRules'
  | 'appRules'
  | 'generalSettings';

/** 有序类别清单（UI 展示顺序 + 全选基准）。 */
export const BACKUP_CATEGORIES: readonly BackupCategory[] = [
  'manualNodes',
  'meshNodes',
  'subscriptions',
  'customRules',
  'appRules',
  'generalSettings',
];

type NodeCategory = 'manualNodes' | 'meshNodes' | 'subscriptions';

/** 单个 server 归到哪个节点类（订阅节点 > 组网节点 > 手动节点）。 */
function classifyServer(s: ServerConfig): NodeCategory {
  if (s.subscriptionId) return 'subscriptions';
  if (isEndpointProtocol(s.protocol)) return 'meshNodes';
  return 'manualNodes';
}

/**
 * 不属于 generalSettings 的「数据字段」（随各自类别走，不进通用设置）。generalSettings = config 其余键。
 * - ruleResources 随自定义规则类（ruleSet 规则按 res:<id> 引用它）；customAppPresets 随应用分流类（appRule.appId 引用它）。
 * - selectedServerId 跟节点走、不随通用设置导入；导入节点后若失效，mergeCategories 末尾主动归零
 *   （ConfigManager.validateConfig 对失效 selectedServerId 是 **throw、非归零**，不兜底会令整份导入失败）。
 */
const DATA_FIELDS: readonly string[] = [
  'servers',
  'subscriptions',
  'customRules',
  'customRuleSets',
  'ruleResources',
  'appRules',
  'appRulesSeeded',
  'customAppPresets',
  'selectedServerId',
];

/** 敏感/临时态字段：既不进任何类别、也不进通用设置（绝不写入备份文件）。 */
const EXCLUDED_FROM_BACKUP: readonly string[] = [
  'clashApiSecret', // clash_api 明文密钥，不跨机
  'privacyPassword', // 隐私解锁密码（loadConfig 已清明文为空串，此处纵深防御兜底，绝不入备份）
  'diagnosticCapture', // 临时诊断态（提级日志）
  'builtinGeoMeta', // 内置 geo 元数据（随包，无需备份）
];

function isGeneralKey(key: string): boolean {
  return !DATA_FIELDS.includes(key) && !EXCLUDED_FROM_BACKUP.includes(key);
}

/** 某 config 是否含通用设置字段（排除法：存在任一非数据键）。 */
function hasGeneralSettings(config: Partial<UserConfig>): boolean {
  return Object.keys(config).some(isGeneralKey);
}

/** 某类在 config 中的数量（generalSettings 恒计 1=整组；订阅源计订阅源数，节点随源不单列）。 */
export function countCategory(config: Partial<UserConfig>, cat: BackupCategory): number {
  const servers = config.servers ?? [];
  switch (cat) {
    case 'manualNodes':
      return servers.filter((s) => classifyServer(s) === 'manualNodes').length;
    case 'meshNodes':
      return servers.filter((s) => classifyServer(s) === 'meshNodes').length;
    case 'subscriptions':
      return config.subscriptions?.length ?? 0;
    case 'customRules':
      return (config.customRules?.length ?? 0) + (config.customRuleSets?.length ?? 0);
    case 'appRules':
      return config.appRules?.length ?? 0;
    case 'generalSettings':
      return hasGeneralSettings(config) ? 1 : 0;
  }
}

/** config/备份里「有数据」的类（导入时只列这些供勾选）。 */
export function detectCategories(config: Partial<UserConfig>): BackupCategory[] {
  return BACKUP_CATEGORIES.filter((cat) => {
    if (cat === 'subscriptions') {
      const servers = config.servers ?? [];
      return (
        (config.subscriptions?.length ?? 0) > 0 ||
        servers.some((s) => classifyServer(s) === 'subscriptions')
      );
    }
    return countCategory(config, cat) > 0;
  });
}

/** 导出：从完整 config 抽出选中类的字段（其余字段不进备份）。 */
export function pickCategories(
  config: UserConfig,
  selected: BackupCategory[]
): Partial<UserConfig> {
  const sel = new Set(selected);
  const out: Partial<UserConfig> = {};

  const pickedNodeCats: NodeCategory[] = (
    ['manualNodes', 'meshNodes', 'subscriptions'] as NodeCategory[]
  ).filter((c) => sel.has(c));
  if (pickedNodeCats.length) {
    out.servers = (config.servers ?? []).filter((s) => pickedNodeCats.includes(classifyServer(s)));
  }
  if (sel.has('subscriptions') && config.subscriptions) {
    out.subscriptions = config.subscriptions;
  }
  if (sel.has('customRules')) {
    out.customRules = config.customRules;
    out.customRuleSets = config.customRuleSets ?? [];
    if (config.ruleResources) out.ruleResources = config.ruleResources;
  }
  if (sel.has('appRules')) {
    if (config.appRules) out.appRules = config.appRules;
    if (config.appRulesSeeded !== undefined) out.appRulesSeeded = config.appRulesSeeded;
    if (config.customAppPresets) out.customAppPresets = config.customAppPresets;
  }
  if (sel.has('generalSettings')) {
    for (const [k, v] of Object.entries(config)) {
      if (isGeneralKey(k)) (out as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/**
 * 导入：把 backup 的选中类合并进 current（整类替换 + 空跳过），未选类保留 current。
 * 返回新 config + skipped（选了但备份为空、被跳过的类，供 UI 提示）。
 */
export function mergeCategories(
  current: UserConfig,
  backup: Partial<UserConfig>,
  selected: BackupCategory[]
): { config: UserConfig; skipped: BackupCategory[] } {
  const sel = new Set(selected);
  const skipped: BackupCategory[] = [];
  const result: UserConfig = { ...current };

  const curServers = current.servers ?? [];
  const bakServers = backup.servers ?? [];
  let newServers: ServerConfig[] = [];

  // manualNodes / meshNodes：各自整类替换 / 空跳过 / 未选保留
  for (const cat of ['manualNodes', 'meshNodes'] as NodeCategory[]) {
    const curNodes = curServers.filter((s) => classifyServer(s) === cat);
    const bakNodes = bakServers.filter((s) => classifyServer(s) === cat);
    if (!sel.has(cat)) {
      newServers = newServers.concat(curNodes); // 未选：保留
    } else if (bakNodes.length) {
      newServers = newServers.concat(bakNodes); // 替换
    } else {
      newServers = newServers.concat(curNodes); // 空跳过：保留 current
      skipped.push(cat);
    }
  }

  // subscriptions：订阅源字段 + 订阅节点一体处理
  const curSubNodes = curServers.filter((s) => classifyServer(s) === 'subscriptions');
  const bakSubNodes = bakServers.filter((s) => classifyServer(s) === 'subscriptions');
  if (!sel.has('subscriptions')) {
    newServers = newServers.concat(curSubNodes); // 未选：保留订阅节点 + result.subscriptions 已 = current
  } else {
    const hasData = (backup.subscriptions?.length ?? 0) > 0 || bakSubNodes.length > 0;
    if (hasData) {
      newServers = newServers.concat(bakSubNodes);
      result.subscriptions = backup.subscriptions ?? [];
    } else {
      newServers = newServers.concat(curSubNodes); // 空跳过：保留
      skipped.push('subscriptions');
    }
  }
  result.servers = newServers;

  // customRules（+ customRuleSets 同族）
  if (sel.has('customRules')) {
    const hasData =
      (backup.customRules?.length ?? 0) > 0 || (backup.customRuleSets?.length ?? 0) > 0;
    if (hasData) {
      // 整类替换：rules + ruleSets + ruleResources（被 ruleSet 规则按 res:<id> 引用）同进同出。
      result.customRules = backup.customRules ?? [];
      result.customRuleSets = backup.customRuleSets ?? [];
      result.ruleResources = backup.ruleResources ?? [];
    } else {
      skipped.push('customRules');
    }
  }

  // appRules（+ appRulesSeeded）
  if (sel.has('appRules')) {
    if (backup.appRules?.length) {
      // 整类替换：appRules + appRulesSeeded + customAppPresets（appRule.appId 可引用自定义预设）同进同出。
      result.appRules = backup.appRules;
      if (backup.appRulesSeeded !== undefined) result.appRulesSeeded = backup.appRulesSeeded;
      result.customAppPresets = backup.customAppPresets ?? [];
    } else {
      skipped.push('appRules');
    }
  }

  // generalSettings：排除法覆盖所有非数据键
  if (sel.has('generalSettings')) {
    let applied = false;
    for (const [k, v] of Object.entries(backup)) {
      if (isGeneralKey(k)) {
        (result as unknown as Record<string, unknown>)[k] = v;
        applied = true;
      }
    }
    if (!applied) skipped.push('generalSettings');
  }

  // 导入节点类后选中节点可能已不在新 servers → 主动归零（validateConfig 对失效 selectedServerId 是 throw、
  // 非归零，不兜底会令整份导入失败）。null 与 direct 哨兵不动。
  if (
    result.selectedServerId &&
    !isDirectSelection(result.selectedServerId) &&
    !result.servers.some((s) => s.id === result.selectedServerId)
  ) {
    result.selectedServerId = null;
  }

  return { config: result, skipped };
}
