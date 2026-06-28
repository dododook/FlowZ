/**
 * TUN 网络栈（stack）解析单一真值 —— 主进程构建（singbox-inbounds-builder）与渲染层表单（network-settings）共用。
 *
 * sing-box TUN inbound 的 `stack` 决定 TUN 裸 IP 包到 L4 连接的 TCP/IP 实现：
 *   · system  —— 用宿主系统（内核）网络栈做 L3→L4，性能最优、强平台相关；
 *   · gvisor  —— 用 gVisor 全用户态虚拟栈，最稳、跨平台一致、开销略高；
 *   · mixed   —— TCP 走 system 栈、UDP 走 gvisor 栈的【固定组合】（非自动择优）。
 * 三者默认均为 endpoint-independent NAT（gvisor 才可配该项）。来源：sing-box TUN inbound 文档。
 *
 * FlowZ 额外引入 `auto` 默认档（仅活在存储/UI 层）：经 resolveTunStack 解析成【具体】栈下发给核——
 * FlowZ 始终显式 pin，绝不吃 sing-box 的 build-tag 默认（编进 gvisor→默认漂成 mixed，否则只有 system；
 * 默认是编译期决定、会漂，产品语义不能随之漂）。完整依据/置信度见 docs/design/tun-stack-option.md。
 */
import type { TunStack } from './types';

/** 下发给核的【具体】栈值（永不含 'auto'）。 */
export type ConcreteTunStack = 'system' | 'gvisor' | 'mixed';

/**
 * `Auto` 档的平台映射（单一真值）：
 *   · macOS（darwin）→ gvisor —— Apple 严格接管场景强制 gvisor / system·mixed 不可用（sing-box TunnelVision 文档）
 *     + FlowZ 历史实证（3.3.18 稳定组合）+ DNS/NetworkExtension 约束；
 *   · Windows（win32）/ Linux → system —— 内核栈性能 + Win 热切换 guard 实测零环路（仅 system 放行）。
 */
export const PLATFORM_DEFAULT_STACK: Record<string, ConcreteTunStack> = {
  darwin: 'gvisor',
  win32: 'system',
  linux: 'system',
};

/** stack 字段全部合法值（含 Auto），供 ConfigManager 校验 + UI 选项单一真值。 */
export const TUN_STACK_VALUES: readonly TunStack[] = ['auto', 'system', 'gvisor', 'mixed'];

/** 三档具体栈（不含 Auto），供 UI 渲染兜底选项。 */
export const CONCRETE_TUN_STACKS: readonly ConcreteTunStack[] = ['system', 'gvisor', 'mixed'];

/**
 * 解析用户选择的 TUN stack → 下发给核的【具体】栈（恒 system|gvisor|mixed，永不返回 'auto'/省略）。
 * - `auto` / 缺省（undefined/null）→ 平台默认（PLATFORM_DEFAULT_STACK；mac→gvisor / Win·Linux→system；未知平台兜底 system）；
 * - 显式 `system`/`gvisor`/`mixed` → **原样下发（全平台 honor，含 mac，零强制回退）**。
 *   mac 选 system/mixed 是用户知情的实验选择（UI 默认 gvisor + 未验证提示），由真机判定其可用性，不在此静默改写。
 */
export function resolveTunStack(
  userStack: TunStack | undefined | null,
  platform: NodeJS.Platform | string
): ConcreteTunStack {
  if (!userStack || userStack === 'auto') {
    return PLATFORM_DEFAULT_STACK[platform] ?? 'system';
  }
  return userStack;
}

/**
 * TUN stack 一次性迁移【纯逻辑】（无 fs/副作用，供 ConfigManager 薄壳 + 单测复用，对齐已测的 resolveTunStack 模式）。
 * 存量 stack 多为旧强制默认（mac=gvisor / Win·Linux=system，旧 UI 不暴露 stack → 非用户真实选择）→ 一律归 'auto'
 * （'auto' 经 resolveTunStack 解析回各平台原默认 → 行为零变化）。就地修改 config，返回是否变更（true→调用方落盘）。
 * 幂等：tunStackMigrated===true 即不动（护用户迁移后在 UI 的显式选择不被回灌）。
 */
export function migrateTunStackConfig(config: {
  tunStackMigrated?: boolean;
  tunConfig?: { stack: TunStack } | null;
}): boolean {
  if (config.tunStackMigrated === true) return false;
  if (config.tunConfig) config.tunConfig.stack = 'auto';
  config.tunStackMigrated = true;
  return true;
}
