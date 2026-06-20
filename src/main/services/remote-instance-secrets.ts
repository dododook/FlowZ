/**
 * 远程实例 secret 的「写时合并 / 读时剥离」纯逻辑（P5 Phase2）。
 *
 * 背景：远端 api service 的 secret 须以 Bearer 原值发出（不可哈希），存于 config.json（0o600，与 clashApiSecret 同级），
 * 但**绝不回读给渲染端**——CONFIG_GET 经 stripRemoteSecrets 剥明文（仿 config-handlers 对 privacyPassword 的处理）。
 *
 * 由此引出「写时合并」：渲染端拿到的是被剥过 secret 的 config，保存时会原样回写（secret 字段为空/缺失）。若直接落盘
 * 会把已存的 secret 清零。故 CONFIG_SAVE 前用 mergeRemoteSecrets：incoming 实例 secret 为空/缺失 → 沿用 existing 同 id
 * 的已存 secret（写时保留）；incoming 给了非空 secret → 用新值（更新）。删除实例随整条移除（existing 无对应 id 即丢）。
 *
 * 清空 secret（已设置 → 改为免认证）当前 UI 不暴露；如需，约定渲染端发 secret:null 显式清空（本批未做，标 TODO）。
 */
import type { UserConfig, RemoteInstance } from '../../shared/types';

/** CONFIG_GET：剥掉 remoteInstances 的 secret 明文（渲染端只需「已设置/未设置」由 hasSecret 占位表达）。 */
export function stripRemoteSecrets(config: UserConfig): UserConfig {
  if (!Array.isArray(config.remoteInstances) || config.remoteInstances.length === 0) {
    return config;
  }
  return {
    ...config,
    remoteInstances: config.remoteInstances.map((inst) => {
      const { secret, ...rest } = inst;
      // 保留「是否已设置」语义，secret 明文不下发（渲染端据 hasSecret 显示占位/「已设置」）。
      return {
        ...rest,
        hasSecret: typeof secret === 'string' && secret !== '',
      } as RemoteInstance & {
        hasSecret: boolean;
      };
    }),
  } as UserConfig;
}

/**
 * CONFIG_SAVE：把 incoming（来自渲染端、secret 多为空）与 existing（磁盘已存、带 secret）按 id 合并 secret。
 * 规则：incoming.secret 非空 → 用新值；incoming.secret 空/缺失 → 沿用 existing 同 id 的 secret（写时保留，防被清零）。
 * existing 无对应 id（新增实例）→ 用 incoming.secret（可能为空 = 免认证）。incoming 删掉的实例随数组自然移除。
 */
export function mergeRemoteSecrets(
  incoming: UserConfig,
  existing: UserConfig | undefined
): UserConfig {
  if (!Array.isArray(incoming.remoteInstances) || incoming.remoteInstances.length === 0) {
    return incoming;
  }
  const existingById = new Map<string, RemoteInstance>();
  for (const inst of existing?.remoteInstances || []) {
    if (inst && typeof inst.id === 'string') existingById.set(inst.id, inst);
  }
  return {
    ...incoming,
    remoteInstances: incoming.remoteInstances.map((inst) => {
      // 渲染端可能带上 stripRemoteSecrets 注入的 hasSecret——回写时剔除（非 RemoteInstance 字段）。
      const { secret, ...rest } = inst as RemoteInstance & { hasSecret?: boolean };
      delete (rest as { hasSecret?: boolean }).hasSecret;
      const incomingSecret = typeof secret === 'string' && secret !== '' ? secret : undefined;
      if (incomingSecret !== undefined) {
        return { ...rest, secret: incomingSecret };
      }
      const prior = existingById.get(rest.id)?.secret;
      return prior ? { ...rest, secret: prior } : { ...rest };
    }),
  };
}
