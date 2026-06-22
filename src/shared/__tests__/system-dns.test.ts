import {
  BOOTSTRAP_DIRECT_DNS_IPS,
  CONTROLLED_TUN_DNS_IP,
  DOH_UPSTREAM_IPS,
  DOH_ALIDNS_IP,
  DOH_DNSPOD_IP,
  isBootstrapDirectDnsIp,
} from '../dns';
import {
  controlledTunDnsIp,
  isControlledDnsIpValid,
  parseMacGetDnsServers,
  macSetDnsArgs,
  winSetDnsCommands,
  parseWinShowDnsServers,
  parseWinInterfaces,
  parseScutilNameservers,
  extractIpv4s,
  isPrivateIpv4,
  pickLanResolverIp,
  computeOriginalToSave,
} from '../system-dns';

describe('受控 DNS IP 选择守卫（核心不变量）', () => {
  it('CONTROLLED_TUN_DNS_IP 绝不在 bootstrap-direct 列表（否则 :53 被直连放行、逃逸 hijack → 接管失效）', () => {
    expect(isBootstrapDirectDnsIp(CONTROLLED_TUN_DNS_IP)).toBe(false);
    expect(isControlledDnsIpValid(CONTROLLED_TUN_DNS_IP)).toBe(true);
    expect(controlledTunDnsIp()).toBe(CONTROLLED_TUN_DNS_IP);
  });

  it('受控 IP 是真实可路由的公网 IP（崩溃未还原也降级真 DNS、不断网；非 fake 198.18.x）', () => {
    expect(CONTROLLED_TUN_DNS_IP).toBe('8.8.8.8');
    expect(CONTROLLED_TUN_DNS_IP.startsWith('198.18.')).toBe(false);
    expect(CONTROLLED_TUN_DNS_IP.startsWith('fc00')).toBe(false);
  });

  it('223.5.5.5 在 bootstrap-direct → 守卫判其不可用（佐证选 8.8.8.8 的理由）', () => {
    expect(isBootstrapDirectDnsIp('223.5.5.5')).toBe(true);
    expect(isControlledDnsIpValid('223.5.5.5')).toBe(false);
  });

  it('bootstrap-direct 列表含全部国内引导 DNS（与 route C 段单一真值一致）', () => {
    expect(BOOTSTRAP_DIRECT_DNS_IPS).toEqual([
      '223.5.5.5',
      '223.6.6.6',
      '1.12.12.12',
      '119.29.29.29',
      '119.28.28.28',
      '114.114.114.114',
    ]);
  });

  it('isBootstrapDirectDnsIp trim 空白后比较', () => {
    expect(isBootstrapDirectDnsIp(' 223.5.5.5 ')).toBe(true);
    expect(isBootstrapDirectDnsIp('8.8.8.8')).toBe(false);
  });

  // 单一真值不变量（#9）：DoH 上游 IP 必须 ∈ bootstrap-direct 列表，否则其 :443 DoH 不被直连放行 / 不进 TUN
  // exclude → 命中 TUN CIDR 回流死循环。锁死「新增或更换 DoH 上游 IP 时必须同步进 BOOTSTRAP_DIRECT_DNS_IPS」。
  it('DOH_UPSTREAM_IPS ⊆ BOOTSTRAP_DIRECT_DNS_IPS（换上游 IP 不漏 exclude/直连放行）', () => {
    expect(DOH_UPSTREAM_IPS).toEqual([DOH_ALIDNS_IP, DOH_DNSPOD_IP]);
    for (const ip of DOH_UPSTREAM_IPS) {
      expect(isBootstrapDirectDnsIp(ip)).toBe(true);
    }
  });
});

describe('macOS networksetup 解析 / 参数构造', () => {
  it("parseMacGetDnsServers: 未设置（There aren't any）→ []", () => {
    expect(parseMacGetDnsServers("There aren't any DNS Servers set on Wi-Fi.")).toEqual([]);
    expect(parseMacGetDnsServers('')).toEqual([]);
  });
  it('parseMacGetDnsServers: 每行一个 IP（v4/v6）', () => {
    expect(parseMacGetDnsServers('192.168.5.1\n8.8.8.8')).toEqual(['192.168.5.1', '8.8.8.8']);
    expect(parseMacGetDnsServers('2001:4860:4860::8888\n')).toEqual(['2001:4860:4860::8888']);
  });
  it('parseMacGetDnsServers: 过滤非 IP 噪声行', () => {
    expect(parseMacGetDnsServers('some note\n8.8.8.8')).toEqual(['8.8.8.8']);
  });
  it('macSetDnsArgs: 有 IP → 设具体值', () => {
    expect(macSetDnsArgs('Wi-Fi', ['8.8.8.8'])).toEqual(['-setdnsservers', 'Wi-Fi', '8.8.8.8']);
  });
  it('macSetDnsArgs: 空 → Empty（还原 DHCP）', () => {
    expect(macSetDnsArgs('Wi-Fi', [])).toEqual(['-setdnsservers', 'Wi-Fi', 'Empty']);
  });
  it('macSetDnsArgs: 服务名含空格作单一 argv（execFile 安全）', () => {
    expect(macSetDnsArgs('USB 10/100 LAN', [])).toEqual([
      '-setdnsservers',
      'USB 10/100 LAN',
      'Empty',
    ]);
  });
});

describe('Windows netsh 命令构造 / 解析', () => {
  const netsh = 'C\\\\netsh.exe';
  it('winSetDnsCommands: 空 → source=dhcp', () => {
    expect(winSetDnsCommands(netsh, 'Ethernet', [])).toEqual([
      `"${netsh}" interface ipv4 set dnsservers name="Ethernet" source=dhcp`,
    ]);
  });
  it('winSetDnsCommands: 单 IP → static primary', () => {
    expect(winSetDnsCommands(netsh, 'Ethernet', ['8.8.8.8'])).toEqual([
      `"${netsh}" interface ipv4 set dnsservers name="Ethernet" static 8.8.8.8 primary validate=no`,
    ]);
  });
  it('winSetDnsCommands: 多 IP → 首 static、其余 add', () => {
    expect(winSetDnsCommands(netsh, 'Ethernet', ['8.8.8.8', '8.8.4.4'])).toEqual([
      `"${netsh}" interface ipv4 set dnsservers name="Ethernet" static 8.8.8.8 primary validate=no`,
      `"${netsh}" interface ipv4 add dnsservers name="Ethernet" address=8.8.4.4 index=2 validate=no`,
    ]);
  });
  it('parseWinShowDnsServers: DHCP 配置 → []', () => {
    expect(
      parseWinShowDnsServers(
        'Configuration for interface "Ethernet"\n    DNS servers configured through DHCP:  192.168.1.1\n'
      )
    ).toEqual([]);
  });
  it('parseWinShowDnsServers: 静态配置 → IP 列表', () => {
    const out =
      'Configuration for interface "Ethernet"\n' +
      '    Statically Configured DNS Servers:    8.8.8.8\n' +
      '                                          8.8.4.4\n';
    expect(parseWinShowDnsServers(out)).toEqual(['8.8.8.8', '8.8.4.4']);
  });
  it('parseWinInterfaces: 取 connected 非 loopback', () => {
    const out =
      'Idx     Met         MTU          State                Name\n' +
      '---  ----------  ----------  ------------  ---------------------------\n' +
      '  1          75  4294967295  connected     Loopback Pseudo-Interface 1\n' +
      ' 12          25        1500  connected     Ethernet\n' +
      ' 14          25        1500  disconnected  Wi-Fi\n';
    expect(parseWinInterfaces(out)).toEqual(['Ethernet']);
  });
});

describe('computeOriginalToSave（防自指）', () => {
  it('首次接管（无既有 marker）：当前值即原始，即便恰为受控 IP 也尊重', () => {
    expect(computeOriginalToSave({ 'Wi-Fi': ['8.8.8.8'] }, '8.8.8.8', undefined)).toEqual({
      'Wi-Fi': ['8.8.8.8'],
    });
    expect(computeOriginalToSave({ 'Wi-Fi': ['192.168.5.1'] }, '8.8.8.8', undefined)).toEqual({
      'Wi-Fi': ['192.168.5.1'],
    });
  });
  it('再次接管（有既有 marker）：当前已是受控 IP → 回退既有 marker 的真实原始，不把受控 IP 误存成原始', () => {
    expect(
      computeOriginalToSave({ 'Wi-Fi': ['8.8.8.8'] }, '8.8.8.8', { 'Wi-Fi': ['192.168.5.1'] })
    ).toEqual({ 'Wi-Fi': ['192.168.5.1'] });
  });
  it('再次接管：当前已是受控 IP 但既有 marker 无此服务原始 → []（DHCP）', () => {
    expect(computeOriginalToSave({ Ethernet: ['8.8.8.8'] }, '8.8.8.8', {})).toEqual({
      Ethernet: [],
    });
  });
  it('再次接管：当前是用户改回的真实 DNS（非受控 IP）→ 采当前值', () => {
    expect(
      computeOriginalToSave({ 'Wi-Fi': ['1.1.1.1'] }, '8.8.8.8', { 'Wi-Fi': ['192.168.5.1'] })
    ).toEqual({ 'Wi-Fi': ['1.1.1.1'] });
  });
  it('DHCP 原始（[]）保持 []', () => {
    expect(computeOriginalToSave({ 'Wi-Fi': [] }, '8.8.8.8', undefined)).toEqual({ 'Wi-Fi': [] });
  });
});

describe('方案B：内网 LAN 解析器探测', () => {
  it('isPrivateIpv4: 10/8、172.16-31/12、192.168/16 为私网，其余非私网', () => {
    expect(isPrivateIpv4('10.0.0.1')).toBe(true);
    expect(isPrivateIpv4('172.16.0.1')).toBe(true);
    expect(isPrivateIpv4('172.31.255.254')).toBe(true);
    expect(isPrivateIpv4('192.168.5.1')).toBe(true);
    expect(isPrivateIpv4('172.15.0.1')).toBe(false); // 172.15 不在 16-31
    expect(isPrivateIpv4('172.32.0.1')).toBe(false);
    expect(isPrivateIpv4('8.8.8.8')).toBe(false);
    expect(isPrivateIpv4('240e::1')).toBe(false); // v6
    expect(isPrivateIpv4('999.1.1.1')).toBe(false); // 越界
  });

  it('parseScutilNameservers: 抓全部 nameserver[N] 并按序去重', () => {
    const out = [
      'resolver #1',
      '  nameserver[0] : 192.168.5.1',
      '  nameserver[1] : 240e:37a::1',
      '  if_index : 14 (en0)',
      'resolver #2',
      '  nameserver[0] : 192.168.5.1',
    ].join('\n');
    expect(parseScutilNameservers(out)).toEqual(['192.168.5.1', '240e:37a::1']);
  });
  it('parseScutilNameservers: 无 nameserver → []', () => {
    expect(parseScutilNameservers('DNS configuration\n')).toEqual([]);
  });

  it('extractIpv4s: 按序去重提取 IPv4', () => {
    expect(extractIpv4s('a 192.168.1.1 b 8.8.8.8 c 192.168.1.1')).toEqual([
      '192.168.1.1',
      '8.8.8.8',
    ]);
  });

  it('pickLanResolverIp: 取首个私网 IPv4、排除受控 IP', () => {
    expect(pickLanResolverIp(['8.8.8.8', '192.168.5.1', '10.0.0.1'])).toBe('192.168.5.1');
  });
  it('pickLanResolverIp: 受控 IP 即便私网外也跳过（接管残留时 scutil 报 8.8.8.8）', () => {
    expect(pickLanResolverIp(['8.8.8.8'], '8.8.8.8')).toBeNull();
  });
  it('pickLanResolverIp: 仅公网/v6/link-local → null（退回 dns-local）', () => {
    expect(pickLanResolverIp(['8.8.8.8', '1.1.1.1', '240e::1', 'fe80::1'])).toBeNull();
  });
  it('pickLanResolverIp: 空 → null', () => {
    expect(pickLanResolverIp([])).toBeNull();
  });
});
