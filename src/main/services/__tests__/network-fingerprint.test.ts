/**
 * computeNetworkFingerprint 单测（issue #368）。
 * 判据核心：**同一网络状态恒等、真实变化必变、噪音不变**——指纹是「要不要刷 DNS 缓存」的唯一判据，
 * 它误判成「变了」就是稳态下周期性清缓存，误判成「没变」就是换网后漏刷。
 */
import {
  computeNetworkFingerprint,
  nextFingerprintBaseline,
  readLinuxResolverFingerprint,
} from '../network-fingerprint';
import type { NetworkInterfaceInfo } from 'os';

const v4 = (address: string, internal = false): NetworkInterfaceInfo =>
  ({
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:11:22:33:44:55',
    internal,
    cidr: `${address}/24`,
  }) as NetworkInterfaceInfo;

const v6 = (address: string, internal = false): NetworkInterfaceInfo =>
  ({
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:11:22:33:44:55',
    internal,
    cidr: `${address}/64`,
    scopeid: 0,
  }) as NetworkInterfaceInfo;

describe('computeNetworkFingerprint', () => {
  it('同一状态恒等（幂等）', () => {
    const ifaces = { wlan0: [v4('192.168.1.5')] };
    expect(computeNetworkFingerprint(ifaces)).toBe(computeNetworkFingerprint(ifaces));
  });

  it('地址顺序 / 接口枚举顺序抖动不改变指纹（否则顺序抖动会被误判成换网）', () => {
    const a = { wlan0: [v4('192.168.1.5'), v6('2001:db8::1')], eth0: [v4('10.0.0.2')] };
    const b = { eth0: [v4('10.0.0.2')], wlan0: [v6('2001:db8::1'), v4('192.168.1.5')] };
    expect(computeNetworkFingerprint(a)).toBe(computeNetworkFingerprint(b));
  });

  it('换网（地址变化）→ 指纹变化', () => {
    expect(computeNetworkFingerprint({ wlan0: [v4('192.168.1.5')] })).not.toBe(
      computeNetworkFingerprint({ wlan0: [v4('192.168.2.5')] })
    );
  });

  it('接口新增 / 消失 → 指纹变化', () => {
    const base = { wlan0: [v4('192.168.1.5')] };
    expect(computeNetworkFingerprint(base)).not.toBe(
      computeNetworkFingerprint({ ...base, tun0: [v4('172.19.0.1')] })
    );
  });

  it('loopback（internal）不进指纹——恒定存在，不携带「网络变了」的信息', () => {
    const withLo = { lo: [v4('127.0.0.1', true)], wlan0: [v4('192.168.1.5')] };
    expect(computeNetworkFingerprint(withLo)).toBe(
      computeNetworkFingerprint({ wlan0: [v4('192.168.1.5')] })
    );
  });

  it('IPv6 link-local(fe80::) 不进指纹——接口 up 但未拿到可路由地址时刷缓存没有意义', () => {
    const withLl = { wlan0: [v4('192.168.1.5'), v6('fe80::1234:5678:9abc:def0')] };
    expect(computeNetworkFingerprint(withLl)).toBe(
      computeNetworkFingerprint({ wlan0: [v4('192.168.1.5')] })
    );
  });

  it('大写 FE80:: 同样被排除（内核/平台大小写不统一，漏判会让 link-local 抖动变成假换网）', () => {
    const withLl = { wlan0: [v4('192.168.1.5'), v6('FE80::1')] };
    expect(computeNetworkFingerprint(withLl)).toBe(
      computeNetworkFingerprint({ wlan0: [v4('192.168.1.5')] })
    );
  });

  it('IPv4 段 fe80 开头的普通地址不受 link-local 规则误伤（规则只针对 IPv6）', () => {
    // 反向对照：若排除条件漏判 family，任何以 fe80 起始的字符串都会被吞掉。
    const fp = computeNetworkFingerprint({ wlan0: [v4('254.128.0.1')] });
    expect(fp).toContain('254.128.0.1');
  });

  it('同一 MAC 换 IP 也算变化（不看 mac，只看地址）', () => {
    expect(computeNetworkFingerprint({ wlan0: [v4('192.168.1.5')] })).not.toBe(
      computeNetworkFingerprint({ wlan0: [v4('192.168.1.6')] })
    );
  });

  it('空接口表 / undefined 值不抛', () => {
    expect(computeNetworkFingerprint({})).toBe('');
    expect(computeNetworkFingerprint({ wlan0: undefined })).toBe('');
  });
});

describe('computeNetworkFingerprint — link-local 排除（补 IPv4 APIPA）', () => {
  it('IPv4 link-local(169.254/16) 不进指纹——DHCP 未成功时的占位地址，此刻网络没通', () => {
    const withApipa = { eth0: [v4('192.168.1.5'), v4('169.254.12.34')] };
    expect(computeNetworkFingerprint(withApipa)).toBe(
      computeNetworkFingerprint({ eth0: [v4('192.168.1.5')] })
    );
  });

  it('APIPA 反复起落不构成指纹变化（Windows DHCP 失败/恢复循环下每窗口空刷的来源）', () => {
    const a = computeNetworkFingerprint({ eth0: [v4('169.254.1.1')] });
    const b = computeNetworkFingerprint({ eth0: [v4('169.254.99.99')] });
    expect(a).toBe(b);
    expect(a).toBe('');
  });

  it('169.253/169.255 等相邻段不受误伤（判据是 169.254. 前缀，不是 169.）', () => {
    // 反向对照：写成 startsWith('169.') 会把这两个可路由地址一起吞掉。
    expect(computeNetworkFingerprint({ eth0: [v4('169.253.1.1')] })).toContain('169.253.1.1');
    expect(computeNetworkFingerprint({ eth0: [v4('169.255.1.1')] })).toContain('169.255.1.1');
  });
});

describe('nextFingerprintBaseline — 刷新后指纹基线', () => {
  it('flushed → 推进到本次指纹（下次同指纹即可跳过）', () => {
    expect(nextFingerprintBaseline('flushed', 'fp-A')).toBe('fp-A');
  });

  it.each(['failed', 'rate-limited', 'skipped'] as const)(
    '%s → 清空基线，下个事件无条件重刷（A→B→A 回退不得被判成「什么都没发生」）',
    (outcome) => {
      expect(nextFingerprintBaseline(outcome, 'fp-A')).toBeNull();
    }
  );

  it('flushed 但没带指纹（start/stop 早期路径）→ 仍清空，不凭空造基线', () => {
    expect(nextFingerprintBaseline('flushed', undefined)).toBeNull();
  });

  it('在飞期间被判脏 → 即便刷成功也不推进基线（否则盖掉那次判脏，A→B→A 在并发交织下复活）', () => {
    expect(nextFingerprintBaseline('flushed', 'fp-A', true)).toBeNull();
  });

  it('未被判脏时第三参不改变原有语义（缺省与显式 false 同解）', () => {
    expect(nextFingerprintBaseline('flushed', 'fp-A', false)).toBe('fp-A');
    expect(nextFingerprintBaseline('flushed', 'fp-A')).toBe('fp-A');
  });
});

describe('readLinuxResolverFingerprint — 上游 resolver 一路判据', () => {
  const CONF = '/run/systemd/resolve/resolv.conf';

  it('只取 nameserver / search 行，注释与空行不进指纹', () => {
    const fp = readLinuxResolverFingerprint(
      () => '# managed by systemd-resolved\n# Do not edit.\n\nnameserver 192.168.1.1\nsearch lan\n'
    );
    expect(fp).toBe('nameserver 192.168.1.1\nsearch lan');
  });

  it('换上游 → 指纹变（地址一字未变而 resolver 换了，正是纯地址指纹看不见的那一面）', () => {
    const a = readLinuxResolverFingerprint(() => 'nameserver 192.168.1.1\n');
    const b = readLinuxResolverFingerprint(() => 'nameserver 10.0.0.1\n');
    expect(a).not.toBe(b);
  });

  it('nameserver 主备互换算变化（次序即查询优先级，排序会把真实变化抹平成「没变」）', () => {
    const a = readLinuxResolverFingerprint(() => 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n');
    const b = readLinuxResolverFingerprint(() => 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n');
    expect(a).not.toBe(b);
  });

  it('读的是 /run/systemd/resolve/resolv.conf，不是 /etc/resolv.conf', () => {
    // /etc/resolv.conf 在 systemd-resolved 环境下恒为 stub（nameserver 127.0.0.53），零判别力。
    const seen: string[] = [];
    readLinuxResolverFingerprint((f) => {
      seen.push(f);
      return '';
    });
    expect(seen).toEqual([CONF]);
  });

  it('读失败（文件不存在 / 无权限）→ 空串，退化为「这一路判据不参与」而非误判成变化', () => {
    expect(
      readLinuxResolverFingerprint(() => {
        throw new Error('ENOENT');
      })
    ).toBe('');
  });

  it('文件存在但无 nameserver/search 行 → 空串（同上，不参与）', () => {
    expect(readLinuxResolverFingerprint(() => '# only comments\n')).toBe('');
  });
});
