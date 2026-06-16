import { isValidIpCidr, validateRuleValue } from '../rules';

describe('isValidIpCidr', () => {
  it('接受合法 IPv4（带/不带掩码）', () => {
    for (const v of [
      '10.0.0.0/24',
      '192.168.1.1',
      '0.0.0.0/0',
      '255.255.255.255/32',
      '100.64.0.0/10',
    ]) {
      expect(isValidIpCidr(v)).toBe(true);
    }
  });

  it('接受合法 IPv6（带/不带掩码、压缩、内嵌 IPv4）', () => {
    for (const v of [
      '::/0',
      'fd00::2/128',
      '2001:db8::1',
      'fe80::1/64',
      '::1',
      '1:2:3:4:5:6:7:8',
      '::ffff:192.168.1.1',
      'FE80::1', // 大写 hex
    ]) {
      expect(isValidIpCidr(v)).toBe(true);
    }
  });

  it('拒绝 sing-box netip 会 FATAL 的畸形 IPv6（实测确认）', () => {
    for (const v of [
      '12345::1/64', // 段 >4 位
      '1:2:3:4:5:6:7:8:9/64', // >8 段
      '::::/0', // 多个 ::
      'dead::beef::1/64', // 多个 ::
      'fe80:/64', // 空尾段
      ':', // 退化
      '1:2:3:4:5:6:7/64', // 无 ::却只 7 段
    ]) {
      expect(isValidIpCidr(v)).toBe(false);
    }
  });

  it('拒绝 IPv4 前导零（sing-box netip 拒 010.0.0.1）', () => {
    expect(isValidIpCidr('010.0.0.1/32')).toBe(false);
    expect(isValidIpCidr('192.168.001.1')).toBe(false);
  });

  it('拒绝八位组越界（旧形状正则会放过）', () => {
    for (const v of ['300.300.300.300', '256.1.2.3', '10.0.0.999/24']) {
      expect(isValidIpCidr(v)).toBe(false);
    }
  });

  it('拒绝掩码越界（v4>32 / v6>128，会让 sing-box FATAL）', () => {
    expect(isValidIpCidr('10.0.0.0/40')).toBe(false);
    expect(isValidIpCidr('192.168.0.0/64')).toBe(false);
    expect(isValidIpCidr('fd00::/200')).toBe(false);
  });

  it('拒绝非 IP 文本（旧的 IPv6 hex 分支会误收 abc/deadbeef）', () => {
    for (const v of ['abc', 'deadbeef', 'hello/24', '10.0.0', '10.0.0.0.0', '']) {
      expect(isValidIpCidr(v)).toBe(false);
    }
  });

  it('两侧空白被 trim 后判定', () => {
    expect(isValidIpCidr('  10.0.0.0/24  ')).toBe(true);
  });

  it('validateRuleValue(ipCidr/sourceIpCidr) 复用同一校验', () => {
    expect(validateRuleValue('ipCidr', '10.0.0.0/40')).toBe(false);
    expect(validateRuleValue('sourceIpCidr', '300.1.2.3')).toBe(false);
    expect(validateRuleValue('ipCidr', '10.10.10.0/24')).toBe(true);
  });
});
