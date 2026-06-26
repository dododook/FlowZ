import { parseDefaultGateway, parseScutilRouter } from '../default-route';

describe('parseDefaultGateway', () => {
  it('典型 `route -n get default` 块 → 取 gateway IPv4', () => {
    const out = [
      '   route to: default',
      'destination: default',
      '       mask: default',
      '    gateway: 192.168.5.1',
      '  interface: en0',
      '      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>',
      ' recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire',
      '       0         0         0         0         0         0      1500         0',
    ].join('\n');
    expect(parseDefaultGateway(out)).toBe('192.168.5.1');
  });

  it('无 gateway 行（link# 出口、无网关）→ null', () => {
    const out = [
      '   route to: default',
      'destination: default',
      '       mask: default',
      '  interface: utun4',
      '      flags: <UP,DONE,STATIC>',
    ].join('\n');
    expect(parseDefaultGateway(out)).toBeNull();
  });

  it('空字符串 → null', () => {
    expect(parseDefaultGateway('')).toBeNull();
  });

  it('IPv6/垃圾 gateway 行（非 IPv4 字面量）→ 忽略 → null', () => {
    const out = ['    gateway: fe80::1%en0', '    gateway: link#22'].join('\n');
    expect(parseDefaultGateway(out)).toBeNull();
  });
});

describe('parseScutilRouter（停核补回取 configd 当前网关，避免起核快照陈旧）', () => {
  it('典型 scutil State:/Network/Global/IPv4 块 → 取 Router IPv4', () => {
    const out = [
      '<dictionary> {',
      '  PrimaryInterface : en0',
      '  PrimaryService : 11AA22BB-1234',
      '  Router : 192.168.99.1',
      '}',
    ].join('\n');
    expect(parseScutilRouter(out)).toBe('192.168.99.1');
  });

  it('无 Router 行（无网络/无主服务）→ null', () => {
    const out = ['<dictionary> {', '  PrimaryInterface : ', '}'].join('\n');
    expect(parseScutilRouter(out)).toBeNull();
  });

  it('空字符串 / 「No such key」 → null', () => {
    expect(parseScutilRouter('')).toBeNull();
    expect(parseScutilRouter('  No such key')).toBeNull();
  });

  it('IPv6 Router（非 IPv4 字面量）→ 忽略 → null', () => {
    expect(parseScutilRouter('  Router : fe80::1')).toBeNull();
  });
});
