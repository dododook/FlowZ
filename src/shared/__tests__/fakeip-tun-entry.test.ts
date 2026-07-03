/**
 * applyFakeIpTunEntry 纯函数单测（F 组）：消费「FakeIP-TUN 待纠正」快照。
 * 核心不变量：只在 tun + flag===true 时动 enableFakeIp；用户主动关（flag=false）绝不误伤；不变异输入。
 */
import { applyFakeIpTunEntry } from '../fakeip-tun-entry';
import type { UserConfig } from '../types';

function cfg(
  proxyModeType: string,
  enableFakeIp: boolean | undefined,
  fakeIpTunAutoEnable: boolean | undefined
): UserConfig {
  return {
    proxyModeType,
    dnsConfig: {
      domesticDns: 'https://doh.pub/dns-query',
      foreignDns: 'https://dns.google/dns-query',
      enableFakeIp,
      fakeIpTunAutoEnable,
    },
  } as unknown as UserConfig;
}

describe('applyFakeIpTunEntry', () => {
  it('tun + flag true + enableFakeIp false → 回 true + 消费 flag + corrected', () => {
    const r = applyFakeIpTunEntry(cfg('tun', false, true));
    expect(r.corrected).toBe(true);
    expect(r.config.dnsConfig!.enableFakeIp).toBe(true);
    expect(r.config.dnsConfig!.fakeIpTunAutoEnable).toBe(false);
  });

  it('tun + flag true + enableFakeIp true → 仅消费 flag，corrected false', () => {
    const r = applyFakeIpTunEntry(cfg('tun', true, true));
    expect(r.corrected).toBe(false);
    expect(r.config.dnsConfig!.enableFakeIp).toBe(true);
    expect(r.config.dnsConfig!.fakeIpTunAutoEnable).toBe(false);
  });

  it('systemProxy + flag true → no-op，flag 保留（未进 tun 不消费）', () => {
    const r = applyFakeIpTunEntry(cfg('systemProxy', false, true));
    expect(r.corrected).toBe(false);
    expect(r.config.dnsConfig!.enableFakeIp).toBe(false);
    expect(r.config.dnsConfig!.fakeIpTunAutoEnable).toBe(true);
  });

  it('manual + flag true → no-op，flag 保留（systemProxy→manual→tun 绕行场景）', () => {
    const r = applyFakeIpTunEntry(cfg('manual', false, true));
    expect(r.corrected).toBe(false);
    expect(r.config.dnsConfig!.fakeIpTunAutoEnable).toBe(true);
  });

  it('tun + flag false → no-op（用户主动关 / 已消费，绝不动 enableFakeIp）', () => {
    const r = applyFakeIpTunEntry(cfg('tun', false, false));
    expect(r.corrected).toBe(false);
    expect(r.config.dnsConfig!.enableFakeIp).toBe(false);
  });

  it('tun + flag undefined → no-op', () => {
    const r = applyFakeIpTunEntry(cfg('tun', false, undefined));
    expect(r.corrected).toBe(false);
    expect(r.config.dnsConfig!.enableFakeIp).toBe(false);
  });

  it('不变异输入对象（corrected 时返回新对象，dnsConfig 浅拷贝）', () => {
    const input = cfg('tun', false, true);
    const r = applyFakeIpTunEntry(input);
    expect(input.dnsConfig!.enableFakeIp).toBe(false); // 原对象未被改
    expect(input.dnsConfig!.fakeIpTunAutoEnable).toBe(true);
    expect(r.config).not.toBe(input);
    expect(r.config.dnsConfig).not.toBe(input.dnsConfig);
  });

  it('缺 dnsConfig → no-op 不崩', () => {
    const r = applyFakeIpTunEntry({ proxyModeType: 'tun' } as UserConfig);
    expect(r.corrected).toBe(false);
    expect(r.config).toBeDefined();
  });
});
