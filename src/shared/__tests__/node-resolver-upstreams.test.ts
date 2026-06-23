/**
 * issue #147 上游解析模型单测（纯逻辑）：分 Tier / canonical 去重 / 纯 IP 校验 / 上限 3 / 空回退 / directIps。
 */
import {
  resolveUpstreams,
  parseCustomUpstream,
  isValidCustomUpstreamSpec,
  upstreamCanonicalKey,
  BUILTIN_UPSTREAMS,
  MAX_TIER1_UPSTREAMS,
} from '../node-resolver-upstreams';
import { DOH_ALIDNS_IP, DOH_DNSPOD_IP } from '../dns';

describe('内置上游单一真值', () => {
  it('ali/dnspod=Tier1 DoH，IP 派生 DOH_*_IP；system=Tier2', () => {
    expect(BUILTIN_UPSTREAMS.ali).toMatchObject({ kind: 'doh', ip: DOH_ALIDNS_IP, tier: 1 });
    expect(BUILTIN_UPSTREAMS.dnspod).toMatchObject({ kind: 'doh', ip: DOH_DNSPOD_IP, tier: 1 });
    expect(BUILTIN_UPSTREAMS.system).toMatchObject({ kind: 'system', tier: 2 });
  });
});

describe('parseCustomUpstream — 强制纯 IP', () => {
  it('域名 DoH → null（拒绝，零 bootstrap）', () => {
    expect(parseCustomUpstream({ id: 'c', spec: 'https://dns.google/dns-query' })).toBeNull();
    expect(parseCustomUpstream({ id: 'c', spec: 'tls://dns.google:853' })).toBeNull();
    expect(parseCustomUpstream({ id: 'c', spec: 'dns.google' })).toBeNull(); // 裸域名非法
  });
  it('IP-DoH → Tier1 doh', () => {
    expect(parseCustomUpstream({ id: 'c', spec: 'https://1.1.1.1/dns-query' })).toMatchObject({
      kind: 'doh',
      ip: '1.1.1.1',
      port: 443,
      tier: 1,
    });
  });
  it('IP-DoT(tls) → Tier1 doh + dot:true', () => {
    expect(parseCustomUpstream({ id: 'c', spec: 'tls://9.9.9.9:853' })).toMatchObject({
      kind: 'doh',
      ip: '9.9.9.9',
      port: 853,
      dot: true,
      tier: 1,
    });
  });
  it('裸 IP / udp → Tier2 udp', () => {
    expect(parseCustomUpstream({ id: 'c', spec: '8.8.8.8' })).toMatchObject({
      kind: 'udp',
      ip: '8.8.8.8',
      port: 53,
      tier: 2,
    });
    expect(parseCustomUpstream({ id: 'c', spec: 'udp://8.8.4.4:53' })).toMatchObject({
      kind: 'udp',
      tier: 2,
    });
  });
  it('isValidCustomUpstreamSpec：纯 IP 真、域名假', () => {
    expect(isValidCustomUpstreamSpec('https://1.1.1.1/dns-query')).toBe(true);
    expect(isValidCustomUpstreamSpec('1.1.1.1')).toBe(true);
    expect(isValidCustomUpstreamSpec('https://dns.google/dns-query')).toBe(false);
    expect(isValidCustomUpstreamSpec('')).toBe(false);
  });
});

describe('resolveUpstreams — 分 Tier + 去重 + 上限 + 回退', () => {
  it('默认 [ali,dnspod] → Tier1 两个、Tier2 空、directIps 两 IP', () => {
    const r = resolveUpstreams(['ali', 'dnspod']);
    expect(r.tier1.map((u) => u.id)).toEqual(['ali', 'dnspod']);
    expect(r.tier2).toEqual([]);
    expect(r.directIps).toEqual([DOH_ALIDNS_IP, DOH_DNSPOD_IP]);
  });

  it('system 入选 → Tier2，不占 Tier1 额度', () => {
    const r = resolveUpstreams(['ali', 'dnspod', 'system']);
    expect(r.tier1.map((u) => u.id)).toEqual(['ali', 'dnspod']);
    expect(r.tier2.map((u) => u.id)).toEqual(['system']);
  });

  it('去重：内置 ali 与等价自定义 https://223.5.5.5/dns-query 合并（只留先出现的）', () => {
    const custom = [{ id: 'c1', spec: `https://${DOH_ALIDNS_IP}/dns-query` }];
    const r = resolveUpstreams(['ali', 'c1', 'dnspod'], custom);
    // c1 与 ali canonical 相同 → 跳过；只剩 ali + dnspod
    expect(r.tier1.map((u) => u.id)).toEqual(['ali', 'dnspod']);
  });

  it('边界：udp 223.5.5.5 ≠ doh 223.5.5.5（协议/端口不同，不去重）', () => {
    const a = parseCustomUpstream({ id: 'u', spec: DOH_ALIDNS_IP })!; // udp:223.5.5.5:53
    expect(upstreamCanonicalKey(a)).not.toBe(upstreamCanonicalKey(BUILTIN_UPSTREAMS.ali));
  });

  it('上限 3：4 个 Tier1（含自定义 DoH）→ 截断到 3', () => {
    const custom = [
      { id: 'c1', spec: 'https://1.1.1.1/dns-query' },
      { id: 'c2', spec: 'https://9.9.9.9/dns-query' },
    ];
    const r = resolveUpstreams(['ali', 'dnspod', 'c1', 'c2'], custom);
    expect(r.tier1).toHaveLength(MAX_TIER1_UPSTREAMS);
    expect(r.tier1.map((u) => u.id)).toEqual(['ali', 'dnspod', 'c1']); // 第 4 个 c2 被截
  });

  it('空 Tier1（仅 system / 全无效）→ 回退默认 [ali,dnspod]', () => {
    expect(resolveUpstreams(['system']).tier1.map((u) => u.id)).toEqual(['ali', 'dnspod']);
    expect(resolveUpstreams(['unknown-id']).tier1.map((u) => u.id)).toEqual(['ali', 'dnspod']);
    expect(resolveUpstreams([]).tier1.map((u) => u.id)).toEqual(['ali', 'dnspod']);
  });

  it('自定义非纯 IP（域名）→ 跳过，不进结果', () => {
    const custom = [{ id: 'bad', spec: 'https://dns.google/dns-query' }];
    const r = resolveUpstreams(['ali', 'bad'], custom);
    expect(r.tier1.map((u) => u.id)).toEqual(['ali']);
  });

  it('directIps 含 Tier1+Tier2 全部纯 IP、去重、system 无 IP 不计', () => {
    const custom = [{ id: 'u', spec: '8.8.8.8' }];
    const r = resolveUpstreams(['ali', 'system', 'u'], custom);
    expect(r.directIps).toEqual([DOH_ALIDNS_IP, '8.8.8.8']); // system 无 ip
  });
});
