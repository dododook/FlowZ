import {
  isIpv4,
  ipv4CidrsOverlap,
  ipv6CidrsOverlap,
  cidrsOverlap,
  cidrOverlapsAny,
  partitionCidrsByOverlap,
} from '../ip';
import { FAKEIP_INET4_RANGE, FAKEIP_INET6_RANGE } from '../fakeip-filter';
import { DEFAULT_BYPASS_LAN, bypassLanCidrs } from '../system-proxy-bypass';

describe('isIpv4 — 严格 IPv4 字面量', () => {
  it('合法 IPv4 → true', () => {
    expect(isIpv4('8.8.8.8')).toBe(true);
    expect(isIpv4('1.1.1.1')).toBe(true);
    expect(isIpv4('192.168.1.1')).toBe(true);
    expect(isIpv4('255.255.255.255')).toBe(true);
    expect(isIpv4('0.0.0.0')).toBe(true);
  });

  it('段越界(>255)→ false（纠正原 isIpv4Host 宽松误判）', () => {
    expect(isIpv4('999.1.1.1')).toBe(false);
    expect(isIpv4('256.1.1.1')).toBe(false);
    expect(isIpv4('1.1.1.256')).toBe(false);
  });

  it('非 IPv4 形态 → false', () => {
    expect(isIpv4('example.com')).toBe(false);
    expect(isIpv4('1.2.3')).toBe(false);
    expect(isIpv4('1.2.3.4.5')).toBe(false);
    expect(isIpv4('8.8.8.8:53')).toBe(false); // 带端口非纯字面量
    expect(isIpv4('::1')).toBe(false);
    expect(isIpv4('')).toBe(false);
  });
});

describe('ipv4CidrsOverlap — IPv4 CIDR 交集', () => {
  it('包含关系 → true（无 /n 视为 /32）', () => {
    expect(ipv4CidrsOverlap('192.168.50.0/24', '192.168.50.10/32')).toBe(true);
    expect(ipv4CidrsOverlap('192.168.50.10', '192.168.50.0/24')).toBe(true); // 顺序无关
    expect(ipv4CidrsOverlap('10.0.0.0/8', '10.5.6.7/24')).toBe(true);
  });
  it('相邻/不相交 → false', () => {
    expect(ipv4CidrsOverlap('192.168.50.0/24', '192.168.51.0/24')).toBe(false);
    expect(ipv4CidrsOverlap('192.168.50.0/24', '10.0.0.0/8')).toBe(false);
  });
  it('0.0.0.0/0 覆盖一切', () => {
    expect(ipv4CidrsOverlap('0.0.0.0/0', '192.168.1.1/32')).toBe(true);
  });
  it('非法/IPv6 → false（best-effort，不误报）', () => {
    expect(ipv4CidrsOverlap('fd00::/8', '192.168.1.0/24')).toBe(false);
    expect(ipv4CidrsOverlap('999.1.1.1/24', '192.168.1.0/24')).toBe(false);
    expect(ipv4CidrsOverlap('192.168.1.0/33', '192.168.1.0/24')).toBe(false);
  });
});

describe('cidrOverlapsAny — target 与候选集任一相交', () => {
  it('命中任一 mesh 段 → true；都不命中 → false', () => {
    const mesh = ['100.64.0.0/10', '192.168.50.0/24'];
    expect(cidrOverlapsAny('192.168.50.128/25', mesh)).toBe(true);
    expect(cidrOverlapsAny('100.64.1.2/32', mesh)).toBe(true);
    expect(cidrOverlapsAny('172.16.0.0/12', mesh)).toBe(false);
    expect(cidrOverlapsAny('10.0.0.0/8', [])).toBe(false);
  });
});

describe('ipv6CidrsOverlap — IPv6 CIDR 交集', () => {
  it('包含关系 → true', () => {
    expect(ipv6CidrsOverlap('fc00::/18', 'fc00::/7')).toBe(true); // fakeip v6 ⊂ ULA fc00::/7（旧旁路撞墙根因）
    expect(ipv6CidrsOverlap('fc00::/7', 'fc00:1::/32')).toBe(true);
    expect(ipv6CidrsOverlap('2001:db8::/32', '2001:db8:1::/48')).toBe(true);
    expect(ipv6CidrsOverlap('::/0', 'fd00::/8')).toBe(true);
  });
  it('不相交 → false', () => {
    expect(ipv6CidrsOverlap('fc00::/18', 'fd00::/8')).toBe(false); // 修复不变量：假 v6 不撞实际 ULA 旁路
    expect(ipv6CidrsOverlap('fc00::/8', 'fd00::/8')).toBe(false);
    expect(ipv6CidrsOverlap('fe80::/10', 'fc00::/18')).toBe(false);
  });
  it('非法/IPv4 → false', () => {
    expect(ipv6CidrsOverlap('192.168.1.0/24', 'fc00::/7')).toBe(false);
    expect(ipv6CidrsOverlap('fc00::/200', 'fc00::/7')).toBe(false);
    expect(ipv6CidrsOverlap('xyz::/8', 'fc00::/7')).toBe(false);
  });
});

describe('cidrsOverlap / cidrOverlapsAny — 家族感知(v4+v6)', () => {
  it('跨族恒不相交', () => {
    expect(cidrsOverlap('198.18.0.0/15', 'fc00::/18')).toBe(false);
    expect(cidrsOverlap('fc00::/18', '10.0.0.0/8')).toBe(false);
  });
  it('cidrOverlapsAny 同时支持 v4/v6 候选', () => {
    expect(cidrOverlapsAny('fc00:1::/32', ['fd00::/8', 'fc00::/7'])).toBe(true); // 命中 v6 候选
    expect(cidrOverlapsAny('fc00::/18', ['fd00::/8', 'fe80::/10'])).toBe(false);
  });
});

describe('partitionCidrsByOverlap + FakeIP 段护栏不变量', () => {
  it('剔除与 fakeip 段相交的旁路条目', () => {
    const ranges = [FAKEIP_INET4_RANGE, FAKEIP_INET6_RANGE];
    const r = partitionCidrsByOverlap(
      ['10.0.0.0/8', 'fc00::/7', 'fd00::/8', '198.18.0.0/16'],
      ranges
    );
    expect(r.overlapping.sort()).toEqual(['198.18.0.0/16', 'fc00::/7'].sort()); // 旧 ULA 旁路 + v4 假段子集被剔
    expect(r.disjoint).toEqual(['10.0.0.0/8', 'fd00::/8']);
  });
  it('ranges 空 → 全保留（不启 fakeip 时不剔）', () => {
    expect(partitionCidrsByOverlap(['fc00::/7'], []).disjoint).toEqual(['fc00::/7']);
  });
  // 回归不变量：默认旁路清单 CIDR 必须与 fakeip 段全不相交（防有人改回 fc00::/7 或改 fakeip 段再撞墙）。
  it('DEFAULT_BYPASS_LAN 与 FakeIP 段零相交（v4+v6 永久免疫同类撞墙）', () => {
    const ranges = [FAKEIP_INET4_RANGE, FAKEIP_INET6_RANGE];
    const { overlapping } = partitionCidrsByOverlap(bypassLanCidrs([...DEFAULT_BYPASS_LAN]), ranges);
    expect(overlapping).toEqual([]);
  });
});
