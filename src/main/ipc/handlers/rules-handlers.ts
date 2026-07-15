import { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { Rule } from '../../../shared/types';
import { validateRule } from '../../../shared/rules';
import { registerIpcHandler } from '../ipc-handler';
import { ConfigManager } from '../../services/ConfigManager';
import { ipcEventEmitter } from '../ipc-events';
import { mainEventEmitter, MAIN_EVENTS } from '../main-events';

/** 服务端兜底校验：类型合法 + 至少一个合法值（防旁路写入非法规则）。 */
function assertValidRule(rule: Rule): void {
  // 聚合校验：单/多条件统一经 validateRule（遍历 conditions：类型合法 + 至少一合法值 + combineMode 合法）
  if (!rule || !validateRule(rule)) {
    throw new Error('规则非法：类型 / 匹配值 / 组合模式不合法');
  }
}

export function registerRulesHandlers(configManager: ConfigManager): void {
  registerIpcHandler<void, Rule[]>(
    IPC_CHANNELS.RULES_GET_ALL,
    async (_event: IpcMainInvokeEvent) => {
      const config = await configManager.loadConfig();
      return config.customRules || [];
    }
  );

  registerIpcHandler<Rule, Rule>(
    IPC_CHANNELS.RULES_ADD,
    async (_event: IpcMainInvokeEvent, rule: Rule) => {
      assertValidRule(rule);
      const config = await configManager.loadConfig();
      const newRule: Rule = {
        ...rule,
        id: rule.id || `rule_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      };

      if (!config.customRules) {
        config.customRules = [];
      }
      config.customRules.push(newRule);
      await configManager.saveConfig(config);

      ipcEventEmitter.sendToAll('event:configChanged', { newValue: config });
      mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, config);

      return newRule;
    }
  );

  registerIpcHandler<Rule, void>(
    IPC_CHANNELS.RULES_UPDATE,
    async (_event: IpcMainInvokeEvent, rule: Rule) => {
      assertValidRule(rule);
      const config = await configManager.loadConfig();

      if (!config.customRules) {
        throw new Error('No rules found');
      }

      const index = config.customRules.findIndex((r) => r.id === rule.id);
      if (index === -1) {
        throw new Error(`Rule not found: ${rule.id}`);
      }

      config.customRules[index] = rule;
      await configManager.saveConfig(config);

      ipcEventEmitter.sendToAll('event:configChanged', { newValue: config });
      mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, config);
    }
  );

  registerIpcHandler<{ ruleId: string }, void>(
    IPC_CHANNELS.RULES_DELETE,
    async (_event: IpcMainInvokeEvent, args: { ruleId: string }) => {
      const config = await configManager.loadConfig();

      if (!config.customRules) {
        throw new Error('No rules found');
      }

      const index = config.customRules.findIndex((r) => r.id === args.ruleId);
      if (index === -1) {
        throw new Error(`Rule not found: ${args.ruleId}`);
      }

      config.customRules.splice(index, 1);
      await configManager.saveConfig(config);

      ipcEventEmitter.sendToAll('event:configChanged', { newValue: config });
      mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, config);
    }
  );

  // 重排规则（上下移/拖动）：orderedIds 必须是现有规则 id 的严格排列（长度相等 + 集合一致），否则拒绝（防旁路丢/增规则）
  registerIpcHandler<{ orderedIds: string[] }, void>(
    IPC_CHANNELS.RULES_REORDER,
    async (_event: IpcMainInvokeEvent, args: { orderedIds: string[] }) => {
      const config = await configManager.loadConfig();
      const rules = config.customRules || [];
      const ids = args?.orderedIds || [];
      if (ids.length !== rules.length || new Set(ids).size !== ids.length) {
        throw new Error('orderedIds must be a permutation of existing rule ids');
      }
      const byId = new Map(rules.map((r) => [r.id, r]));
      if (!ids.every((id) => byId.has(id))) {
        throw new Error('orderedIds contains unknown rule id');
      }
      // 净零变更（debounce 窗口内下移又上移=原序）→ 跳过 save+广播+重启，避免无意义断流
      if (rules.every((r, i) => r.id === ids[i])) {
        return;
      }
      config.customRules = ids.map((id) => byId.get(id)!);
      await configManager.saveConfig(config);

      ipcEventEmitter.sendToAll('event:configChanged', { newValue: config });
      mainEventEmitter.emit(MAIN_EVENTS.CONFIG_CHANGED, config);
    }
  );
}
