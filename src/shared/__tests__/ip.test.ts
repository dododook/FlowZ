import {
  isIpv4,
  ipv4CidrsOverlap,
  ipv6CidrsOverlap,
  cidrsOverlap,
  cidrOverlapsAny,
  cidrContains,
  partitionCidrsByOverlap,
  subtractCidrs,
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
  it('剔除与 fakeip 段相交的旁路条目（v4 198.18/15 + v6 2001:db8::/32）', () => {
    const ranges = [FAKEIP_INET4_RANGE, FAKEIP_INET6_RANGE]; // [198.18.0.0/15, 2001:db8::/32]
    const r = partitionCidrsByOverlap(
      ['10.0.0.0/8', 'fc00::/7', '2001:db8:1::/48', '198.18.0.0/16'],
      ranges
    );
    // fc00::/7（ULA 旁路）现与 fakeip 公网假段不相交 → 保留；2001:db8 子段命中 v6 假段、198.18/16 命中 v4 假段 → 剔除
    expect(r.overlapping.sort()).toEqual(['198.18.0.0/16', '2001:db8:1::/48'].sort());
    expect(r.disjoint).toEqual(['10.0.0.0/8', 'fc00::/7']);
  });
  it('ranges 空 → 全保留（不启 fakeip 时不剔）', () => {
    expect(partitionCidrsByOverlap(['fc00::/7'], []).disjoint).toEqual(['fc00::/7']);
  });
  // 回归不变量：默认旁路清单 CIDR 必须与 fakeip 段全不相交（旁路含完整 ULA fc00::/7，fakeip v6 在公网文档段 2001:db8::/32，
  // 二者不相交；防未来把 fakeip 段改回 ULA 私网段再撞墙）。
  it('DEFAULT_BYPASS_LAN 与 FakeIP 段零相交（v4+v6 永久免疫同类撞墙）', () => {
    const ranges = [FAKEIP_INET4_RANGE, FAKEIP_INET6_RANGE];
    const { overlapping } = partitionCidrsByOverlap(
      bypassLanCidrs([...DEFAULT_BYPASS_LAN]),
      ranges
    );
    expect(overlapping).toEqual([]);
  });
});

describe('cidrContains — 方向性包含（inner ⊆ outer）', () => {
  it('包含（更宽含更窄）→ true；反向/相邻 → false', () => {
    expect(cidrContains('192.168.0.0/16', '192.168.50.0/24')).toBe(true);
    expect(cidrContains('192.168.50.0/24', '192.168.0.0/16')).toBe(false); // 方向性：窄不含宽
    expect(cidrContains('10.0.0.0/8', '10.0.0.0/8')).toBe(true); // 相等即含
    expect(cidrContains('192.168.0.0/16', '192.168.80.0/24')).toBe(true);
    expect(cidrContains('192.168.50.0/24', '192.168.80.0/24')).toBe(false); // 相邻不含
  });
  it('v6 + 跨族/非法 → 家族分派，跨族恒 false', () => {
    expect(cidrContains('fc00::/7', 'fd00::/64')).toBe(true);
    expect(cidrContains('fd00::/64', 'fc00::/7')).toBe(false);
    expect(cidrContains('fc00::/7', '10.0.0.0/8')).toBe(false); // 跨族
    expect(cidrContains('bad', '10.0.0.0/8')).toBe(false);
  });
});

describe('subtractCidrs — CIDR 差集（Windows bypassLAN carve 底座）', () => {
  it('/24 carve 出 /16 = 8 条覆盖前缀，且不再覆盖被挖段', () => {
    const r = subtractCidrs(['192.168.0.0/16'], ['192.168.50.0/24']);
    expect(r.length).toBe(8);
    expect(r.sort()).toEqual(
      [
        '192.168.0.0/19',
        '192.168.32.0/20',
        '192.168.48.0/23',
        '192.168.51.0/24',
        '192.168.52.0/22',
        '192.168.56.0/21',
        '192.168.64.0/18',
        '192.168.128.0/17',
      ].sort()
    );
    // 挖掉的段不再被覆盖；其余仍完整覆盖
    expect(cidrOverlapsAny('192.168.50.5/32', r)).toBe(false);
    expect(cidrOverlapsAny('192.168.49.5/32', r)).toBe(true);
    expect(cidrOverlapsAny('192.168.51.5/32', r)).toBe(true);
    expect(cidrOverlapsAny('192.168.200.1/32', r)).toBe(true);
  });

  it('carve 段 == base（tailnet 100.64/10 场景）→ 整条移除', () => {
    expect(subtractCidrs(['100.64.0.0/10'], ['100.64.0.0/10'])).toEqual([]);
  });

  it('carve 覆盖 base（更宽）→ base 消失', () => {
    expect(subtractCidrs(['10.5.0.0/16'], ['10.0.0.0/8'])).toEqual([]);
  });

  it('carve 与 base 不相交 → base 原样（规范化）', () => {
    expect(subtractCidrs(['10.0.0.0/8'], ['192.168.1.0/24'])).toEqual(['10.0.0.0/8']);
  });

  it('多重 carve 顺序无关，逐个挖洞', () => {
    const r = subtractCidrs(['10.0.0.0/8'], ['10.1.0.0/16', '10.2.0.0/16']);
    expect(cidrOverlapsAny('10.1.5.5/32', r)).toBe(false);
    expect(cidrOverlapsAny('10.2.5.5/32', r)).toBe(false);
    expect(cidrOverlapsAny('10.3.5.5/32', r)).toBe(true);
  });

  it('跨族互不影响：v4 carve 不动 v6 base，反之亦然', () => {
    expect(subtractCidrs(['fc00::/7'], ['192.168.1.0/24'])).toEqual(['fc00::/7']);
    expect(subtractCidrs(['10.0.0.0/8'], ['fd00::/64'])).toEqual(['10.0.0.0/8']);
  });

  it('v6：/64 carve 出 /7（ULA）= 57 条，且不覆盖被挖段', () => {
    const r = subtractCidrs(['fc00::/7'], ['fd00::/64']);
    expect(r.length).toBe(57);
    expect(cidrOverlapsAny('fd00::1/128', r)).toBe(false);
    expect(cidrOverlapsAny('fc00::1/128', r)).toBe(true);
    expect(cidrOverlapsAny('fd00:0:0:1::1/128', r)).toBe(true); // /64 之外仍覆盖
  });

  it('非法 carve 条目忽略、不腐蚀 base', () => {
    const r = subtractCidrs(['10.0.0.0/8'], ['not-a-cidr', '10.5.0.0/16', '999.1.1.1/8']);
    expect(cidrOverlapsAny('10.5.5.5/32', r)).toBe(false); // 合法 carve 生效
    expect(cidrOverlapsAny('10.6.5.5/32', r)).toBe(true); // 其余保留（非法项未误伤）
  });

  it('无法解析的 base 条目（域名）原样透传', () => {
    const r = subtractCidrs(['example.com', '10.0.0.0/8'], ['10.5.0.0/16']);
    expect(r).toContain('example.com');
    expect(cidrOverlapsAny('10.5.5.5/32', r)).toBe(false);
  });

  it('空 carve → base 原样（规范化，无变化）', () => {
    expect(subtractCidrs(['10.0.0.0/8', '192.168.0.0/16'], [])).toEqual([
      '10.0.0.0/8',
      '192.168.0.0/16',
    ]);
  });
});
