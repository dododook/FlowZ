/**
 * TUN 默认值解析单一真值（stack + mtu）—— 主进程构建（singbox-inbounds-builder）与渲染层表单
 * （network-settings）共用。
 *
 * sing-box TUN inbound 的 `stack` 决定 TUN 裸 IP 包到 L4 连接的 TCP/IP 实现：
 *   · system  —— 用宿主系统（内核）网络栈做 L3→L4，性能最优、强平台相关；
 *   · gvisor  —— 用 gVisor 全用户态虚拟栈，最稳、跨平台一致、开销略高；
 *   · mixed   —— TCP 走 system 栈、UDP 走 gvisor 栈的【固定组合】（非自动择优）。
 * 三者默认均为 endpoint-independent NAT（gvisor 才可配该项）。来源：sing-box TUN inbound 文档。
 *
 * FlowZ 对 stack 与 mtu **都**引入 `auto` 默认档（仅活在存储/UI 层）：经 resolveTunStack / resolveTunMtu
 * 解析成【具体】值下发给核——FlowZ 始终显式 pin，绝不吃 sing-box 的编译期/平台默认（stack：编进 gvisor
 * 则默认漂成 mixed，否则只有 system；mtu：桌面 65535 / Android 9000 / Apple NE 4064）。默认由编译期与
 * 平台决定、会漂，产品语义不能随之漂。完整依据见 docs/design/tun-stack-option.md。
 *
 * **为什么 mtu 也要走 `auto`**：把具体数值写进存储会派生一串问题——需要哨兵去猜「这个数是用户设的还是
 * 历史默认」（旧实现用 `mtu === 9000` 当哨兵）、UI 因此不敢暴露该项、平台默认散落多处、且改了默认也惠及
 * 不到存量用户（他们存储里是死数字）。改用 `auto` 后这些一并消失：存储存**意图**，解析期落**平台值**。
 */
import type { TunStack, TunMtu } from './types';

/** 下发给核的【具体】栈值（永不含 'auto'）。 */
export type ConcreteTunStack = 'system' | 'gvisor' | 'mixed';

/**
 * `Auto` 档的平台映射（单一真值）：
 *   · macOS（darwin）→ gvisor —— Apple 严格接管场景强制 gvisor / system·mixed 不可用（sing-box TunnelVision 文档）
 *     + FlowZ 历史实证（3.3.18 稳定组合）+ DNS/NetworkExtension 约束；
 *   · Windows（win32）→ gvisor —— 207 实测（wintun）：新默认组合（gvisor/65535）相对旧默认（system/1350）
 *     **+133% 吞吐、CPU 减半**；热切换环路三栈补测均 21/21 零失败（**裸 sing-box 最小配置**，FlowZ 本体
 *     回归见 benchmark 0.5），据此同批删除原「仅 system 放行」的 guard（见 ProxyManager.planHotSwitch）。
 *     注：1400B UDP 丢包的根因是 **MTU 1350**（1400+28 > 1350 需分片、system 栈不处理），不是栈本身——
 *     选 system 亦落 MTU 4064，实测 5/5 不丢；勿把它当成 gvisor 相对 system 的优势记；
 *   · Linux → system —— 内核栈性能，实测无需改。
 */
export const PLATFORM_DEFAULT_STACK: Record<string, ConcreteTunStack> = {
  darwin: 'gvisor',
  win32: 'gvisor',
  linux: 'system',
};

/**
 * `Auto` 档 MTU 的 **(平台 × 具体栈)** 映射（单一真值）。
 *
 * **必须按栈分档、不能只看平台**：同一个 MTU 在不同栈下差异可达数量级——真机实测 Windows + gvisor 下
 * 65535 为最优档，而同机 system 栈下 65535 直接塌陷（两者相差约 80 倍）。另有两处上游按 MTU 门控的平台
 * 优化：Linux 的 GSO 要求 gvisor 且 `mtu < 49152`，macOS 的 multiPendingPackets 要求 gvisor `< 32768` /
 * system·mixed `<= 9000`——取值越界会静默关掉这些优化。
 *
 * 每格取值的独立依据（均非拍脑袋，实测机器见 docs/design/networking/flowz-win-tun-mtu-benchmark.md）：
 *   · **Windows gvisor 65535** —— 三平台中唯一没有 MTU 门槛型上游优化的平台（GSO 仅 Linux、
 *     multiPendingPackets 仅 Darwin），207 实测 65535 + gvisor = 845–919 Mbps 为最优档；
 *   · **macOS gvisor 9000** —— multiPendingPackets 要求 gvisor `< 32768`，9000 同时满足非 gvisor 的
 *     `<= 9000` → 唯一「三栈通吃」取值，用户切栈不掉坑；
 *   · **Linux gvisor 9000** —— GSO 要求 gvisor 且 `mtu < 49152`（65535 会静默关掉 GSO）；
 *   · **三平台 system/mixed 一律 4064** —— 修 1400B UDP 数据报丢包的最小档（三平台复现），同时规避
 *     Windows `system + 65535` 塌到 ~11 Mbps 的组合。
 *
 * 旧值（mac 1400 / Win·Linux 1350，且不分栈）是历史强制默认，与实测最优档差 70%~数倍。
 */
export const PLATFORM_DEFAULT_MTU: Record<string, Record<ConcreteTunStack, number>> = {
  darwin: { system: 4064, gvisor: 9000, mixed: 4064 },
  win32: { system: 4064, gvisor: 65535, mixed: 4064 },
  linux: { system: 4064, gvisor: 9000, mixed: 4064 },
};

/** stack 字段全部合法值（含 Auto），供 ConfigManager 校验 + UI 选项单一真值。 */
export const TUN_STACK_VALUES: readonly TunStack[] = ['auto', 'system', 'gvisor', 'mixed'];

/** 三档具体栈（不含 Auto），供 UI 渲染兜底选项。 */
export const CONCRETE_TUN_STACKS: readonly ConcreteTunStack[] = ['system', 'gvisor', 'mixed'];

/** MTU 显式数值的合法区间（'auto' 另行放行）。下界=IPv6 最小 MTU；上界=sing-box 可接受上限。 */
export const TUN_MTU_MIN = 1280;
export const TUN_MTU_MAX = 65535;

/**
 * system/mixed 栈下仍属「安全」的 MTU 上界。超过即进入实测劣化区：Windows `system + 65535` 吞吐塌到
 * ~11 Mbps（同机 gvisor + 65535 为 845–919 Mbps）；且上游 macOS 的 multiPendingPackets 对非 gvisor 栈
 * 就是 `mtu <= 9000` 门槛（`protocol/tun/inbound.go:191`），越界静默关掉该优化。
 */
export const TUN_MTU_SAFE_MAX_NON_GVISOR = 9000;

/**
 * 解析用户选择的 TUN stack → 下发给核的【具体】栈（恒 system|gvisor|mixed，永不返回 'auto'/省略）。
 * - `auto` / 缺省（undefined/null）→ 平台默认（PLATFORM_DEFAULT_STACK；mac·Win→gvisor / Linux→system；未知平台兜底 system）；
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
 * 解析用户选择的 TUN MTU → 下发给核的【具体】数值（恒 number，永不返回 'auto'/省略）。
 *
 * @param stack **必须传已解析的具体栈**（resolveTunStack 的返回值）；传用户原始值会让 'auto' 落不进表。
 * - 显式正整数 → **原样下发**（honor 用户选择，含已知劣化组合——坏组合由 UI 非阻断提示，不静默改写，
 *   与 mac 选 system/mixed 的既有原则一致）；
 * - `auto` / 缺省 / 非正数 → (平台 × 栈) 映射，未知平台兜底 linux 档。
 *   非正数并入 auto 是防御：旧配置可能存 0，旧实现亦按 falsy 回落平台值，此处保持一致。
 */
export function resolveTunMtu(
  userMtu: TunMtu | undefined | null,
  platform: NodeJS.Platform | string,
  stack: ConcreteTunStack
): number {
  if (typeof userMtu === 'number' && userMtu > 0) {
    return userMtu;
  }
  const perPlatform = PLATFORM_DEFAULT_MTU[platform] ?? PLATFORM_DEFAULT_MTU.linux;
  return perPlatform[stack];
}

/**
 * 解析 UI 的 MTU 文本输入 → 存储值；非法返回 `null`（与本仓 parseDnsServerSpec / parseSpeedTestUrl /
 * parseCustomUpstream 等既有解析器同款 `T | null` 约定，不另造 `{ok,value}` 判别式联合）。
 * - 空串/纯空白 → `'auto'`（复位。存的是**意图**，不把当前平台值固化成数字——固化会让后续平台默认演进对该用户失效）；
 * - 合法整数（TUN_MTU_MIN..TUN_MTU_MAX）→ 该数值；
 * - 其余 → `null`，由调用方回滚显示并提示。**不静默钳制**：钳制会让用户以为设成了自己填的值。
 *   （`'auto'` 是合法返回值且非 null，故 null 能无歧义地表示「非法」。）
 */
export function parseTunMtuInput(raw: string): TunMtu | null {
  const s = raw.trim();
  if (!s) return 'auto';
  // 先要求纯十进制数字：`Number()` 还认 '1e4'/'0x500'/'+1400'，当前 UI 已把输入过滤成纯数字所以到不了，
  // 但本函数是 shared 导出，未来若有调用方直接喂原始文本，那些形式会被静默接受成一个用户没打算填的值。
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < TUN_MTU_MIN || n > TUN_MTU_MAX) return null;
  return n;
}

/**
 * 已知劣化组合判定（供 UI 出**非阻断** warning；不禁止——与 mac 允许显式选 system/mixed 的 honor 原则一致）。
 *
 * **按平台分**，因为「非 gvisor + 大 MTU」的代价三平台并不相同：
 *   · win32  —— 实测灾难：`system + 65535` 吞吐塌到 ~11 Mbps（同机 gvisor + 65535 为 845–919 Mbps）；
 *   · darwin —— 静默关掉 multiPendingPackets（上游对非 gvisor 的门槛就是 `mtu <= 9000`）；
 *   · linux  —— **不报**：`system + 65535` 两轮实测均正常（935 / 465 Mbps，无塌陷），对它弹警告是虚警。
 *
 * @param stack **必须是已解析的具体栈**：Auto 在 Windows 落 gvisor 时该组合并不成立，传用户原始值会误报。
 */
export function isDegradedMtuCombo(
  stack: ConcreteTunStack,
  mtu: TunMtu | undefined | null,
  platform: NodeJS.Platform | string
): boolean {
  if (stack === 'gvisor' || (platform !== 'win32' && platform !== 'darwin')) return false;
  return typeof mtu === 'number' && mtu > TUN_MTU_SAFE_MAX_NON_GVISOR;
}

/**
 * 存量配置里属于「旧强制默认」的 MTU：这些不是用户选择，而是旧版本写死后持久化的结果
 * （9000 = 更早期 createDefaultConfig 的值，1350/1400 = 后来的平台调优值）。迁移时一律归 'auto'。
 * 用户经 UI 显式设成同值者由 tunMtuMigrated 守卫保护（迁移只跑一次），不会被回灌。
 */
const LEGACY_FORCED_MTU: readonly number[] = [9000, 1350, 1400];

/**
 * TUN 默认值一次性迁移【纯逻辑】（无 fs/副作用，供 ConfigManager 薄壳 + 单测复用）。就地修改 config，
 * 返回是否变更（true→调用方落盘）。stack 与 mtu **各自独立幂等守卫**：
 *
 * - stack（tunStackMigrated）：存量多为旧强制默认（mac=gvisor / Win·Linux=system，旧 UI 不暴露 stack →
 *   非用户真实选择）→ 一律归 'auto'（解析回各平台原默认，行为零变化）。
 * - mtu（tunMtuMigrated）：存量落在 LEGACY_FORCED_MTU 的归 'auto'；其余（用户手改过 config.json）保留。
 *
 * **两个标记不可合并**：tunStackMigrated 对存量用户早已置 true，复用它会让这批人的 mtu 永不迁移。
 */
export function migrateTunDefaults(config: {
  tunStackMigrated?: boolean;
  tunMtuMigrated?: boolean;
  // mtu 标可选：迁移要容忍残缺存量配置（缺键的旧 config.json / 部分恢复的备份），缺失即按「无 legacy 值可迁」
  // 处理、只置标记。内部另有 typeof 守卫，故此处放宽不削弱正确性。
  tunConfig?: { stack: TunStack; mtu?: TunMtu } | null;
}): boolean {
  let changed = false;
  if (config.tunStackMigrated !== true) {
    if (config.tunConfig) config.tunConfig.stack = 'auto';
    config.tunStackMigrated = true;
    changed = true;
  }
  if (config.tunMtuMigrated !== true) {
    const mtu = config.tunConfig?.mtu;
    if (config.tunConfig && typeof mtu === 'number' && LEGACY_FORCED_MTU.includes(mtu)) {
      config.tunConfig.mtu = 'auto';
    }
    config.tunMtuMigrated = true;
    changed = true;
  }
  return changed;
}
