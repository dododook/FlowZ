import {
  DEFAULT_SYSTEM_PROXY_BYPASS,
  parseBypassList,
  effectiveBypassList,
  isIpv4Cidr,
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
      expect(DEFAULT_SYSTEM_PROXY_BYPASS).toContain(e);
    }
  });
  it('无重复项', () => {
    expect(new Set(DEFAULT_SYSTEM_PROXY_BYPASS).size).toBe(DEFAULT_SYSTEM_PROXY_BYPASS.length);
  });
});

describe('parseBypassList', () => {
  it('逗号/分号/换行分隔 + trim + 去重 + 去空', () => {
    expect(parseBypassList('10.0.0.0/8, *.local ;localhost\n10.0.0.0/8\n')).toEqual([
      '10.0.0.0/8',
      '*.local',
      'localhost',
    ]);
  });
  it('空串 → []', () => {
    expect(parseBypassList('   ')).toEqual([]);
  });
});

describe('effectiveBypassList', () => {
  it('用户清单非空 → 用其（trim/去重）', () => {
    expect(effectiveBypassList([' a ', 'b', 'a'])).toEqual(['a', 'b']);
  });
  it('undefined/空 → 默认清单', () => {
    expect(effectiveBypassList(undefined)).toEqual([...DEFAULT_SYSTEM_PROXY_BYPASS]);
    expect(effectiveBypassList([])).toEqual([...DEFAULT_SYSTEM_PROXY_BYPASS]);
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
