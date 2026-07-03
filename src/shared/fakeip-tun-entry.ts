import type { UserConfig } from './types';

/**
 * 消费「FakeIP-TUN 待纠正」快照（纯函数，不可变）：仅当目标模式为 tun 且 dnsConfig.fakeIpTunAutoEnable===true
 * 时，把 systemProxy 迁移冻结的 enableFakeIp 回 true 并消费 flag（置 false，一次性）；其余一律不动。
 *
 * 触发只看**目标模式为 tun**（不限来源模式）：systemProxy→manual→tun 的绕行仍应纠正（manual 下 enableFakeIp:false
 * 无害、flag 存续到进入 tun 才消费）。flag 由迁移评估（ConfigManager.migrateFakeIpTunPending）一次性写入，只有
 * systemProxy+enableFakeIp:false+migrated 会被判 true；用户升级后任何一次手动改 FakeIP 会同写 false（意图即撤销），
 * 故不误伤「升级后在 TUN 下主动关 FakeIP」的用户。（升级前的 systemProxy 手动关历史无字节留痕、不可区分，属快照方案
 * 固有边界：可能误植后首次进 TUN 自动开回一次，toast 告知 + 再关即永久 false。）
 *
 * @returns config——corrected 时是**新对象**（renderer zustand store 禁原地改，dnsConfig 浅拷贝）；否则原样返回。
 *          corrected——是否真把 enableFakeIp 从 false 改成了 true（供调用方发提示；flag 已开着只消费时为 false）。
 */
export function applyFakeIpTunEntry(config: UserConfig): {
  config: UserConfig;
  corrected: boolean;
} {
  const modeType = (config.proxyModeType || 'systemProxy').toLowerCase();
  if (modeType !== 'tun' || config.dnsConfig?.fakeIpTunAutoEnable !== true) {
    return { config, corrected: false };
  }
  const corrected = config.dnsConfig.enableFakeIp === false;
  return {
    config: {
      ...config,
      dnsConfig: {
        ...config.dnsConfig,
        enableFakeIp: corrected ? true : config.dnsConfig.enableFakeIp,
        fakeIpTunAutoEnable: false,
      },
    },
    corrected,
  };
}
