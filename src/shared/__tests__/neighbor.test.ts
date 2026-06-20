/**
 * shared/neighbor 单测（P6 LAN 设备识别簇）——MAC / 主机名 / neighbor_domain 校验 + 平台门控。
 * 锁内核实证约束（resources/linux/sing-box 1.14-alpha.32 check）：MAC=net.ParseMAC 三种 EUI-48 写法；
 * neighbor_domain 须以 '.' 开头；source_mac/hostname 仅 Linux/macOS；TUN MAC 过滤仅 Linux。
 */
import {
  isValidMacAddress,
  isValidSourceHostname,
  normalizeNeighborDomain,
  isValidNeighborDomain,
  isSourceDeviceMatchSupported,
  isTunMacFilterSupported,
} from '../neighbor';

describe('isValidMacAddress — 对齐 Go net.ParseMAC（EUI-48 实证）', () => {
  it.each([
    '00:11:22:33:44:55',
    'AA:BB:CC:DD:EE:FF',
    'aa:bb:cc:dd:ee:ff',
    '00-11-22-33-44-55',
    '0011.2233.4455',
  ])('接受合法写法 %s', (mac) => expect(isValidMacAddress(mac)).toBe(true));

  it.each([
    '001122334455', // 无分隔符（内核 REJECT）
    '00:11:22:33:44', // 段数不足
    '00:11:22:33:44:55:66', // 段数超
    '0:1:2:3:4:5', // 单 hex 位
    '00:11:22:33:44:5g', // 非 hex
    '', // 空
    undefined,
  ])('拒非法写法 %s', (mac) => expect(isValidMacAddress(mac)).toBe(false));

  it('混合分隔符（冒号+连字符）拒绝', () => {
    // 正则锁同一分隔符贯穿；混用非 net.ParseMAC 合法形态
    expect(isValidMacAddress('00:11-22:33-44:55')).toBe(false);
  });
});

describe('isValidSourceHostname', () => {
  it.each(['my-laptop', 'nas', 'host01', 'a.b.c'])('接受 %s', (h) =>
    expect(isValidSourceHostname(h)).toBe(true)
  );
  it.each(['', undefined, 'has space', '-leading', 'trailing-', 'a'.repeat(254)])('拒 %s', (h) =>
    expect(isValidSourceHostname(h as string)).toBe(false)
  );
});

describe('normalizeNeighborDomain — 内核要求每条以 "." 开头', () => {
  it('裸后缀补前导点', () => expect(normalizeNeighborDomain('lan')).toBe('.lan'));
  it('已带点原样', () => expect(normalizeNeighborDomain('.lan')).toBe('.lan'));
  it('多前导点收敛为一个', () => expect(normalizeNeighborDomain('..lan')).toBe('.lan'));
  it('多标签后缀', () => expect(normalizeNeighborDomain('home.arpa')).toBe('.home.arpa'));
  it('纯点 → "."（匹配任意单标签名）', () => expect(normalizeNeighborDomain('.')).toBe('.'));
  it('空/空白 → null', () => {
    expect(normalizeNeighborDomain('')).toBeNull();
    expect(normalizeNeighborDomain('   ')).toBeNull();
    expect(normalizeNeighborDomain(undefined)).toBeNull();
  });
});

describe('isValidNeighborDomain', () => {
  it.each(['lan', '.lan', 'home.arpa', '.'])('接受 %s', (d) =>
    expect(isValidNeighborDomain(d)).toBe(true)
  );
  it.each(['', undefined, 'bad space'])('拒 %s', (d) =>
    expect(isValidNeighborDomain(d as string)).toBe(false)
  );
});

describe('平台门控（内核硬限界）', () => {
  it('source_mac/hostname：仅 Linux/macOS', () => {
    expect(isSourceDeviceMatchSupported('linux')).toBe(true);
    expect(isSourceDeviceMatchSupported('darwin')).toBe(true);
    expect(isSourceDeviceMatchSupported('win32')).toBe(false);
    expect(isSourceDeviceMatchSupported(undefined)).toBe(false);
  });
  it('TUN include/exclude_mac：仅 Linux', () => {
    expect(isTunMacFilterSupported('linux')).toBe(true);
    expect(isTunMacFilterSupported('darwin')).toBe(false);
    expect(isTunMacFilterSupported('win32')).toBe(false);
    expect(isTunMacFilterSupported(undefined)).toBe(false);
  });
});
