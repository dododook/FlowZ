/**
 * 本地代理端口单一真值（mixed-only 架构）。
 * FlowZ 用单个 sing-box `mixed` inbound 同口服务 HTTP + SOCKS（对齐 Stash/Clash 业内做法）；
 * 独立 http/socks 端口与 mixed 开关已移除。`httpPort`/`socksPort` 仅为旧配置兼容/迁移保留（@deprecated）。
 */

/** mixed-only 新装默认本地端口。对齐业内（Stash/Clash 7890）。注：存量用户经迁移沿用其原 httpPort，不受此影响。 */
export const DEFAULT_MIXED_PORT = 7890;

/** clash_api 外部控制端口默认值（对齐业内 9090）。可经 config.controlPort 改（解决另一 clash 系应用/任意进程占 9090 致 clash_api 无法 bind 的死局）。 */
export const DEFAULT_CONTROL_PORT = 9090;

/**
 * 当前生效的 clash_api 外部控制端口（StatsService / external_controller / 端口冲突清理 / 高级设置展示与复制 统一调用）。
 * controlPort 已设(>0)用之；否则默认 9090。与 localProxyPort 同形，杜绝散落硬编码 9090。
 */
export function controlApiPort(config: { controlPort?: number }): number {
  if (config.controlPort && config.controlPort > 0) return config.controlPort;
  return DEFAULT_CONTROL_PORT;
}

/**
 * 当前生效的本地混合代理端口。mixedPort 已设(>0)用之；否则回退旧 httpPort（迁移前/旧配置，存量沿用 2080 类）；
 * 再否则新装默认 7890。所有消费方（inbound / 系统代理 / 经代理拉取 / 连通性检测 / 探针排除）统一调用，杜绝散落硬编码。
 */
export function localProxyPort(config: { mixedPort?: number; httpPort?: number }): number {
  if (config.mixedPort && config.mixedPort > 0) return config.mixedPort;
  if (config.httpPort && config.httpPort > 0) return config.httpPort;
  return DEFAULT_MIXED_PORT;
}
