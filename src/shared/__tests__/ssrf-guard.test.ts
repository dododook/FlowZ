import { isPrivateIp, isFlowzFakeIp, assertHostAllowed } from '../ssrf-guard';
import { FAKEIP_INET4_RANGE, FAKEIP_INET6_RANGE } from '../fakeip-filter';

describe('isPrivateIp — IPv4', () => {
  it('私网/回环/link-local/CGNAT/通配 → BLOCK', () => {
    expect(isPrivateIp('0.0.0.0')).toBe(true);
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.1.2.3')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true); // 云元数据
    expect(isPrivateIp('100.64.0.1')).toBe(true); // CGNAT
    expect(isPrivateIp('100.127.255.255')).toBe(true);
  });

  it('公网 / 私网边界外 → ALLOW', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('172.15.0.1')).toBe(false); // 172.16 下界外
    expect(isPrivateIp('172.32.0.1')).toBe(false); // 172.31 上界外
    expect(isPrivateIp('100.63.0.1')).toBe(false); // CGNAT 下界外
    expect(isPrivateIp('100.128.0.1')).toBe(false); // CGNAT 上界外
  });
});

describe('isPrivateIp — IPv6 / IPv4-mapped / fe80::/10 防绕过', () => {
  it('IPv4-mapped hex / 展开 / 点分 各写法的内网地址 → BLOCK', () => {
    expect(isPrivateIp('::ffff:7f00:1')).toBe(true); // 127.0.0.1
    expect(isPrivateIp('0:0:0:0:0:ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('0:0:0:0:0:ffff:7f00:1')).toBe(true);
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:0a00:0001')).toBe(true); // 10.0.0.1
    expect(isPrivateIp('::ffff:192.168.1.1')).toBe(true);
    expect(isPrivateIp('::ffff:c0a8:0101')).toBe(true);
  });

  it('IPv4-mapped 公网地址 → ALLOW（按内嵌 IPv4 判）', () => {
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateIp('::ffff:0808:0808')).toBe(false);
  });

  it('fe80::/10 全段（fe80–febf）link-local → BLOCK；fec0:: 不误命中', () => {
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('fe9a::1')).toBe(true);
    expect(isPrivateIp('fea0::1')).toBe(true);
    expect(isPrivateIp('feb0::1')).toBe(true);
    expect(isPrivateIp('febf::1')).toBe(true);
    expect(isPrivateIp('fec0::1')).toBe(false);
  });

  it('回环 / ULA → BLOCK；公网 IPv6 → ALLOW', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('::')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd12:3456::1')).toBe(true);
    expect(isPrivateIp('2001:db8::1')).toBe(false);
    expect(isPrivateIp('2606:4700::1')).toBe(false);
  });

  it('非字面 IP → false（域名交由调用方先解析）', () => {
    expect(isPrivateIp('example.com')).toBe(false);
    expect(isPrivateIp('not-an-ip')).toBe(false);
  });
});

describe('assertHostAllowed — DNS rebinding 防护（注入 lookup）', () => {
  const ok = async (host: string) => assertHostAllowed(new URL(`https://${host}/sub`), neverCalled);
  const neverCalled = async () => {
    throw new Error('lookup 不应被调用（字面 IP/localhost 路径）');
  };

  it('字面公网 IP → 放行', async () => {
    await expect(ok('8.8.8.8')).resolves.toBeUndefined();
  });

  it('字面内网 IP → 拒绝', async () => {
    await expect(ok('127.0.0.1')).rejects.toThrow(/已拒绝/);
    await expect(ok('10.0.0.1')).rejects.toThrow(/已拒绝/);
  });

  it('localhost → 拒绝（不经 lookup）', async () => {
    await expect(ok('localhost')).rejects.toThrow(/已拒绝/);
  });

  it('域名解析到内网 → 拒绝（rebinding）', async () => {
    const lookup = async () => [{ address: '169.254.169.254' }];
    await expect(
      assertHostAllowed(new URL('https://evil.example.com/sub'), lookup)
    ).rejects.toThrow(/已拒绝/);
  });

  it('域名解析到公网 → 放行', async () => {
    const lookup = async () => [{ address: '93.184.216.34' }];
    await expect(
      assertHostAllowed(new URL('https://example.com/sub'), lookup)
    ).resolves.toBeUndefined();
  });

  it('域名解析失败 / 空结果 → 拒绝', async () => {
    const fail = async () => {
      throw Object.assign(new Error('boom'), { code: 'ENOTFOUND' });
    };
    await expect(assertHostAllowed(new URL('https://x.example.com/'), fail)).rejects.toThrow(
      /解析失败/
    );
    const empty = async () => [];
    await expect(assertHostAllowed(new URL('https://y.example.com/'), empty)).rejects.toThrow(
      /无法解析/
    );
  });

  it('多 IP 中任一内网 → 拒绝', async () => {
    const lookup = async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }];
    await expect(assertHostAllowed(new URL('https://mixed.example.com/'), lookup)).rejects.toThrow(
      /已拒绝/
    );
  });

  it('域名解析到 FakeIP（2001:2::/48）+ exemptFakeIp=true（经代理）→ 放行（核按域名重解析真实）', async () => {
    const v6 = async () => [{ address: '2001:2::57' }];
    await expect(
      assertHostAllowed(new URL('https://subscribe.example.com/sub'), v6, true)
    ).resolves.toBeUndefined();
    const v4 = async () => [{ address: '198.18.0.1' }];
    await expect(
      assertHostAllowed(new URL('https://subscribe.example.com/sub'), v4, true)
    ).resolves.toBeUndefined();
  });

  it('域名解析到真内网（fc00:: 真 ULA）+ exemptFakeIp=false（直连，默认）→ 拒（防本机内网 SSRF）', async () => {
    const v6 = async () => [{ address: 'fc00::57' }];
    await expect(
      assertHostAllowed(new URL('https://subscribe.example.com/sub'), v6)
    ).rejects.toThrow(/已拒绝/);
  });

  it('字面内网 IP（https://[fc00::57]）即便 exemptFakeIp=true → 拒（字面 IP 无域名反查，不豁免）', async () => {
    await expect(
      assertHostAllowed(new URL('https://[fc00::57]/sub'), neverCalled, true)
    ).rejects.toThrow(/已拒绝/);
  });

  it('真实 ULA（fd00::/8）非 FakeIP + exemptFakeIp=true → 仍拒（豁免只覆盖 FakeIP 段）', async () => {
    const lookup = async () => [{ address: 'fd00::1' }];
    await expect(
      assertHostAllowed(new URL('https://evil.example.com/sub'), lookup, true)
    ).rejects.toThrow(/已拒绝/);
  });

  it('FakeIP（2001:2）+ 真内网 混合 + exemptFakeIp=true → 拒（豁免假段但真内网仍命中）', async () => {
    const lookup = async () => [{ address: '2001:2::57' }, { address: '10.0.0.5' }];
    await expect(
      assertHostAllowed(new URL('https://mixed2.example.com/'), lookup, true)
    ).rejects.toThrow(/已拒绝/);
  });
});

describe('isFlowzFakeIp — FlowZ FakeIP 假段（198.18.0.0/15 + 2001:2::/48）', () => {
  it('FakeIP v4（198.18/15）+ v6（2001:2::/48）→ true', () => {
    expect(isFlowzFakeIp('198.18.0.1')).toBe(true);
    expect(isFlowzFakeIp('198.19.255.255')).toBe(true);
    expect(isFlowzFakeIp('2001:2::57')).toBe(true);
    expect(isFlowzFakeIp('2001:2:0:ffff::1')).toBe(true); // /48 内（第 4 组任意值仍在段内）
  });

  it('FakeIP 段外（真内网 / 真 ULA / link-local / 公网）→ false（豁免不放过真内网）', () => {
    expect(isFlowzFakeIp('198.17.0.1')).toBe(false); // 198.18/15 下界外
    expect(isFlowzFakeIp('198.20.0.1')).toBe(false); // 上界外
    expect(isFlowzFakeIp('2001:2:1::1')).toBe(false); // 超 2001:2::/48 上界（第 3 组非 0）
    expect(isFlowzFakeIp('2001:1::1')).toBe(false); // 下界外
    expect(isFlowzFakeIp('2001:db8::57')).toBe(false); // RFC 3849 文档段：已非 FlowZ 假段（Chromium LNA 判 local）
    expect(isFlowzFakeIp('fc00::57')).toBe(false); // 真实 ULA（已不再是假段）
    expect(isFlowzFakeIp('fd00::1')).toBe(false); // 真实 ULA（fd00::/8）
    expect(isFlowzFakeIp('fe80::1')).toBe(false); // link-local
    expect(isFlowzFakeIp('10.0.0.1')).toBe(false);
    expect(isFlowzFakeIp('8.8.8.8')).toBe(false);
  });

  // 不变量：isFlowzFakeIp 由 FAKEIP_INET*_RANGE 派生——改假段（含改回私网区间）识别自动跟随，守护 SSRF 豁免分支
  // 不因「假段改了、识别没同步」而静默失效（旧硬编码 0x2001/0x0db8 无此保证，是冗余豁免分支唯一仍生效的回归护栏）。
  it('由常量派生：识别段基址跟随 FAKEIP_INET*_RANGE，不漂移', () => {
    expect(isFlowzFakeIp(FAKEIP_INET4_RANGE.split('/')[0])).toBe(true); // 段基址 198.18.0.0
    expect(isFlowzFakeIp(FAKEIP_INET6_RANGE.replace(/\/\d+$/, '') + '1')).toBe(true); // 2001:2::1
  });
});
