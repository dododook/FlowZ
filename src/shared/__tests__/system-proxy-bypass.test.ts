import {
  DEFAULT_BYPASS_LAN,
  effectiveBypassLan,
  bypassLanCidrs,
  isIpv4Cidr,
  isIpv6Cidr,
  ipv4CidrToWindowsPatterns,
  formatBypassForMac,
  formatBypassForWindows,
  formatBypassForLinux,
} from '../system-proxy-bypass';

describe('默认清单（业内聚合，对齐 Stash）', () => {
  it('含私网/保留段 + Apple 连通性 + 国内会被代理打断的 App/网银', () => {
    for (const e of [
      '10.0.0.0/8',
      '100.64.0.0/10',
      '127.0.0.0/8',
      '169.254.0.0/16',
      '172.16.0.0/12',
      '192.168.0.0/16',
      'fc00::/7',
      'fe80::/10',
      'localhost',
      '*.local',
      'captive.apple.com',
      'mobile-bank.psbc.com',
      'www.abchina.com.cn',
    ]) {
      expect(DEFAULT_BYPASS_LAN).toContain(e);
    }
  });
  it('无重复项', () => {
    expect(new Set(DEFAULT_BYPASS_LAN).size).toBe(DEFAULT_BYPASS_LAN.length);
  });
});

describe('effectiveBypassLan（开关 + 缺省单一真值）', () => {
  it('开关关 → []（不绕过）', () => {
    expect(effectiveBypassLan({ bypassLAN: false, bypassLANList: ['10.0.0.0/8'] })).toEqual([]);
  });
  it('开关开（或未设）+ 无用户清单 → 默认清单副本', () => {
    expect(effectiveBypassLan({})).toEqual([...DEFAULT_BYPASS_LAN]);
    expect(effectiveBypassLan({ bypassLAN: true })).toEqual([...DEFAULT_BYPASS_LAN]);
  });
  it('开关开 + 用户清单 → 用户清单原样', () => {
    expect(effectiveBypassLan({ bypassLAN: true, bypassLANList: ['1.2.3.0/24'] })).toEqual([
      '1.2.3.0/24',
    ]);
  });
});

describe('isIpv6Cidr', () => {
  it('合法 v6 CIDR 真', () => {
    expect(isIpv6Cidr('fc00::/7')).toBe(true);
    expect(isIpv6Cidr('fe80::/10')).toBe(true);
    expect(isIpv6Cidr('::1/128')).toBe(true);
  });
  it('v4 CIDR / 域名 / URL / 越界前缀 假', () => {
    expect(isIpv6Cidr('10.0.0.0/8')).toBe(false);
    expect(isIpv6Cidr('*.local')).toBe(false);
    expect(isIpv6Cidr('http://a:b/c')).toBe(false); // 含 : 和 / 但不是 CIDR
    expect(isIpv6Cidr('fc00::/200')).toBe(false); // 前缀越界
    expect(isIpv6Cidr('fc00::')).toBe(false); // 无前缀
  });
});

describe('bypassLanCidrs（TUN / Windows route_exclude 只取 IP 段）', () => {
  it('保留 v4/v6 CIDR，滤掉域名/通配/localhost/纯 IP', () => {
    expect(
      bypassLanCidrs([
        '10.0.0.0/8',
        '100.64.0.0/10',
        'fc00::/7',
        'fe80::/10',
        'localhost',
        '*.local',
        'captive.apple.com',
        '127.0.0.1',
      ])
    ).toEqual(['10.0.0.0/8', '100.64.0.0/10', 'fc00::/7', 'fe80::/10']);
  });
  it('从完整默认清单筛 CIDR：含全部 v4/v6 段、无域名项', () => {
    const cidrs = bypassLanCidrs([...DEFAULT_BYPASS_LAN]);
    expect(cidrs).toContain('10.0.0.0/8');
    expect(cidrs).toContain('fc00::/7');
    expect(cidrs).not.toContain('localhost');
    expect(cidrs).not.toContain('captive.apple.com');
    expect(cidrs.every((c) => c.includes('/'))).toBe(true);
  });
});

describe('isIpv4Cidr', () => {
  it('IPv4 CIDR 真，域名/v6/纯 IP 假', () => {
    expect(isIpv4Cidr('10.0.0.0/8')).toBe(true);
    expect(isIpv4Cidr('192.168.0.0/16')).toBe(true);
    expect(isIpv4Cidr('fc00::/7')).toBe(false);
    expect(isIpv4Cidr('*.local')).toBe(false);
    expect(isIpv4Cidr('127.0.0.1')).toBe(false);
  });
});

describe('ipv4CidrToWindowsPatterns', () => {
  it('/8 /16 /24 → 单通配', () => {
    expect(ipv4CidrToWindowsPatterns('10.0.0.0/8')).toEqual(['10.*']);
    expect(ipv4CidrToWindowsPatterns('192.168.0.0/16')).toEqual(['192.168.*']);
    expect(ipv4CidrToWindowsPatterns('192.0.0.0/24')).toEqual(['192.0.0.*']);
  });
  it('/12 → 第二段 base..base+15 共 16 条（172.16/12 → 172.16.*..172.31.*）', () => {
    const out = ipv4CidrToWindowsPatterns('172.16.0.0/12');
    expect(out).toHaveLength(16);
    expect(out[0]).toBe('172.16.*');
    expect(out[15]).toBe('172.31.*');
  });
  it('/10(CGNAT) /4(组播/保留) → 跳过（[]，Windows 无法干净通配）', () => {
    expect(ipv4CidrToWindowsPatterns('100.64.0.0/10')).toEqual([]);
    expect(ipv4CidrToWindowsPatterns('224.0.0.0/4')).toEqual([]);
    expect(ipv4CidrToWindowsPatterns('240.0.0.0/4')).toEqual([]);
  });
  it('非法越界 → []', () => {
    expect(ipv4CidrToWindowsPatterns('999.0.0.0/8')).toEqual([]);
  });
});

describe('formatBypassForWindows', () => {
  it('CIDR→通配、v6 CIDR 跳过、域名原样、补 <local>', () => {
    const out = formatBypassForWindows([
      '10.0.0.0/8',
      '100.64.0.0/10', // /10 跳过
      'fc00::/7', // v6 CIDR 跳过
      '*.local',
      'captive.apple.com',
      'localhost',
    ]);
    const parts = out.split(';');
    expect(parts).toContain('10.*');
    expect(parts).not.toContain('100.64.0.0/10');
    expect(parts).not.toContain('fc00::/7');
    expect(parts).toContain('*.local');
    expect(parts).toContain('captive.apple.com');
    expect(parts).toContain('localhost');
    expect(parts).toContain('<local>');
  });

  it('攻击面 M1：含 cmd 元字符/非法字符的项整项跳过 + 告警（不逐字符剥除改写主机名）', () => {
    const skipped: string[] = [];
    const out = formatBypassForWindows(
      [
        'evil";injected', // " 破坏 reg /d "..." 边界
        'a.com;b.com', // ; 拆出额外分隔项
        'a&calc', // & cmd 引号内命令分隔
        'a|whoami', // | cmd 管道
        'a%PATH%b', // % 环境变量展开
        'intra_net', // _ 非法 → 整项跳过，绝不静默改写成 intranet（路由到错误主机）
        'normal.com',
      ],
      (e) => skipped.push(e)
    );
    const parts = out.split(';');
    // cmd 元字符不出现在输出
    expect(
      parts.some((p) => p.includes('"') || p.includes('&') || p.includes('|') || p.includes('%'))
    ).toBe(false);
    // 整项跳过：不产生被逐字符剥除后的残体（旧实现会留 evilinjected / intranet → 路由到错误主机）
    expect(parts).not.toContain('evilinjected');
    expect(parts).not.toContain('intranet');
    // onUnsafe 收到全部被跳过的非法项（告警可见，不静默篡改）
    expect(skipped).toEqual(
      expect.arrayContaining([
        'evil";injected',
        'a.com;b.com',
        'a&calc',
        'a|whoami',
        'a%PATH%b',
        'intra_net',
      ])
    );
    // 合法输入保留
    expect(parts).toContain('normal.com');
    expect(parts).toContain('<local>');
  });
});

describe('formatBypassForMac / Linux', () => {
  it('mac：CIDR+域名原样，trim 去重', () => {
    expect(formatBypassForMac([' 10.0.0.0/8 ', 'fc00::/7', '*.local', '10.0.0.0/8'])).toEqual([
      '10.0.0.0/8',
      'fc00::/7',
      '*.local',
    ]);
  });
  it('linux：同样原样去重（gsettings ignore-hosts 接受 CIDR+域名）', () => {
    expect(formatBypassForLinux(['localhost', '192.168.0.0/16', 'localhost'])).toEqual([
      'localhost',
      '192.168.0.0/16',
    ]);
  });
});
