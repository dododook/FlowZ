/**
 * #57 resolve-ahead 解析器单测 —— 全 mock，零真实网络（本项目铁律：本机禁触宿主网络）。
 * 注入 doh / systemResolve4 / now / cache，验证分层 race / 去重 / IP 跳过 / TTL / 预算 / Tier 优先级。
 */
import {
  resolveNodeDomains,
  upstreamsForResolverMode,
  DOH_UPSTREAMS,
  DOH_DNSPOD,
  type NodeResolveOptions,
} from '../node-domain-resolver';

const SINGLE = ['https://u1/dns-query'];

/** doh 返回固定 IP（不论上游/域名）。 */
const dohConst = (ip: string) => jest.fn(async (_u: string, _d: string, _s: AbortSignal) => [ip]);

describe('resolveNodeDomains — Tier1 DoH', () => {
  it('单上游返回 A → 写入 map', async () => {
    const doh = dohConst('1.2.3.4');
    const map = await resolveNodeDomains(['node.example.com'], {
      doh,
      upstreams: SINGLE,
      cache: new Map(),
    });
    expect(map.get('node.example.com')).toBe('1.2.3.4');
  });

  it('多上游 first-valid：快上游胜出', async () => {
    const doh = jest.fn(async (u: string, _d: string, _s: AbortSignal) => {
      if (u.includes('slow')) {
        await new Promise((r) => setTimeout(r, 60));
        return ['9.9.9.9'];
      }
      return ['2.2.2.2']; // 快上游立即返回
    });
    const map = await resolveNodeDomains(['n.example.com'], {
      doh,
      upstreams: ['https://slow/dns-query', 'https://fast/dns-query'],
      cache: new Map(),
    });
    expect(map.get('n.example.com')).toBe('2.2.2.2');
  });

  it('上游返回空/无 A → 不取空，转 Tier2', async () => {
    const doh = jest.fn(async () => [] as string[]);
    const systemResolve4 = jest.fn(async () => ['8.8.4.4']);
    const map = await resolveNodeDomains(['n.example.com'], {
      doh,
      systemResolve4,
      upstreams: SINGLE,
      cache: new Map(),
    });
    expect(map.get('n.example.com')).toBe('8.8.4.4');
    expect(systemResolve4).toHaveBeenCalledTimes(1);
  });

  it('DoH 成功时不调用系统 DNS（系统不抢跑）', async () => {
    const doh = dohConst('1.1.1.1');
    const systemResolve4 = jest.fn(async () => ['8.8.8.8']);
    const map = await resolveNodeDomains(['n.example.com'], {
      doh,
      systemResolve4,
      upstreams: SINGLE,
      cache: new Map(),
    });
    expect(map.get('n.example.com')).toBe('1.1.1.1');
    expect(systemResolve4).not.toHaveBeenCalled();
  });
});

describe('resolveNodeDomains — 兜底与降级', () => {
  it('Tier1 抛错 + Tier2 抛错 → 不进 map（回退域名）', async () => {
    const doh = jest.fn(async () => {
      throw new Error('doh down');
    });
    const systemResolve4 = jest.fn(async () => {
      throw new Error('servfail');
    });
    const map = await resolveNodeDomains(['n.example.com'], {
      doh,
      systemResolve4,
      upstreams: SINGLE,
      cache: new Map(),
    });
    expect(map.has('n.example.com')).toBe(false);
  });

  it('整批预算超时：挂死上游不阻塞，返回空 map', async () => {
    // doh 永不 resolve，仅在 signal abort 时 reject；预算 50ms 应令整批快速结束。
    const doh = jest.fn(
      (_u: string, _d: string, signal: AbortSignal) =>
        new Promise<string[]>((_res, rej) => {
          signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
        })
    );
    const systemResolve4 = jest.fn(async () => ['1.1.1.1']); // 预算耗尽后不应被调用
    const start = Date.now();
    const map = await resolveNodeDomains(['n.example.com'], {
      doh,
      systemResolve4,
      upstreams: SINGLE,
      perUpstreamTimeoutMs: 1000,
      totalBudgetMs: 50,
      cache: new Map(),
    });
    expect(map.size).toBe(0);
    expect(systemResolve4).not.toHaveBeenCalled(); // budget aborted → 跳过 Tier2
    expect(Date.now() - start).toBeLessThan(900); // 远早于 per-upstream 1000ms
  });
});

describe('resolveNodeDomains — 去重 / IP 字面量', () => {
  it('重复域名只解析一次', async () => {
    const seen: string[] = [];
    const doh = jest.fn(async (_u: string, d: string) => {
      seen.push(d);
      return ['5.5.5.5'];
    });
    await resolveNodeDomains(['a.com', 'a.com', 'b.com', ' a.com '], {
      doh,
      upstreams: SINGLE,
      cache: new Map(),
    });
    expect(seen.sort()).toEqual(['a.com', 'b.com']); // a.com 去重（含 trim）
  });

  it('IP 字面量（v4/v6）跳过，不调用 doh', async () => {
    const doh = jest.fn(async () => ['7.7.7.7']);
    const map = await resolveNodeDomains(['1.2.3.4', '2001:db8::1', 'real.example.com'], {
      doh,
      upstreams: SINGLE,
      cache: new Map(),
    });
    expect(map.has('1.2.3.4')).toBe(false);
    expect(map.has('2001:db8::1')).toBe(false);
    expect(map.get('real.example.com')).toBe('7.7.7.7');
    expect(doh).toHaveBeenCalledTimes(1); // 仅 real.example.com
  });

  it('空入参 / 全 IP 入参 → 空 map，零 doh', async () => {
    const doh = jest.fn(async () => ['7.7.7.7']);
    expect((await resolveNodeDomains([], { doh, cache: new Map() })).size).toBe(0);
    expect((await resolveNodeDomains(['1.2.3.4'], { doh, cache: new Map() })).size).toBe(0);
    expect(doh).not.toHaveBeenCalled();
  });
});

describe('resolveNodeDomains — TTL 缓存', () => {
  it('未过期命中缓存，不重复 doh；过期后重解析', async () => {
    const cache = new Map();
    let clock = 1000;
    const doh = jest.fn(async () => ['3.3.3.3']);
    const common: NodeResolveOptions = {
      doh,
      upstreams: SINGLE,
      cache,
      ttlMs: 5000,
      now: () => clock,
    };

    // t=1000：解析，写缓存 expireAt=6000
    await resolveNodeDomains(['x.com'], common);
    expect(doh).toHaveBeenCalledTimes(1);

    // t=2000 < 6000：命中缓存，doh 不再调用
    clock = 2000;
    const hit = await resolveNodeDomains(['x.com'], common);
    expect(hit.get('x.com')).toBe('3.3.3.3');
    expect(doh).toHaveBeenCalledTimes(1);

    // t=7000 > 6000：过期，重解析
    clock = 7000;
    await resolveNodeDomains(['x.com'], common);
    expect(doh).toHaveBeenCalledTimes(2);
  });
});

describe('默认上游池', () => {
  it('含 AliDNS + DNSPod IP-DoH', () => {
    expect(DOH_UPSTREAMS).toContain('https://223.5.5.5/dns-query');
    expect(DOH_UPSTREAMS).toContain('https://1.12.12.12/dns-query');
  });
});

describe('upstreamsForResolverMode — 档位 → 预解析上游', () => {
  it('auto/缺省 → AliDNS+DNSPod 池；dnspod → 仅 DNSPod；system → 空池（纯系统 DNS）', () => {
    expect(upstreamsForResolverMode('auto')).toEqual(DOH_UPSTREAMS);
    expect(upstreamsForResolverMode(undefined)).toEqual(DOH_UPSTREAMS);
    expect(upstreamsForResolverMode('dnspod')).toEqual([DOH_DNSPOD]);
    expect(upstreamsForResolverMode('system')).toEqual([]);
  });

  it('system（空上游池）→ 跳过 DoH，直接用系统 DNS', async () => {
    const doh = jest.fn(async () => ['9.9.9.9']);
    const systemResolve4 = jest.fn(async () => ['10.0.0.5']);
    const map = await resolveNodeDomains(['n.example.com'], {
      doh,
      systemResolve4,
      upstreams: upstreamsForResolverMode('system'),
      cache: new Map(),
    });
    expect(map.get('n.example.com')).toBe('10.0.0.5');
    expect(doh).not.toHaveBeenCalled(); // 空池 → 不发 DoH
    expect(systemResolve4).toHaveBeenCalledTimes(1);
  });
});

describe('并发池', () => {
  it('maxConcurrency 限流下全部域名仍解析，且同时在飞数不超上限', async () => {
    let inFlight = 0;
    let peak = 0;
    const doh = jest.fn(async (_u: string, d: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return [`1.1.1.${d.length}`];
    });
    const domains = Array.from({ length: 10 }, (_v, i) => `n${i}.example.com`);
    const map = await resolveNodeDomains(domains, {
      doh,
      upstreams: SINGLE,
      maxConcurrency: 3,
      cache: new Map(),
    });
    expect(map.size).toBe(10);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('debug 日志回调', () => {
  it('逐域名 debug：DoH 命中带上游 / 系统兜底带「系统 DNS」 / 失败带「回退域名」', async () => {
    const logs: string[] = [];
    const log = (lvl: 'debug' | 'info' | 'warn', msg: string) => logs.push(`${lvl}|${msg}`);
    const doh = jest.fn(async (_u: string, d: string) => (d === 'a.com' ? ['1.1.1.1'] : []));
    const systemResolve4 = jest.fn(async (d: string) => (d === 'b.com' ? ['2.2.2.2'] : []));
    await resolveNodeDomains(['a.com', 'b.com', 'c.com'], {
      doh,
      systemResolve4,
      upstreams: ['https://u1/dns-query'],
      cache: new Map(),
      log,
    });
    expect(logs.some((l) => l.includes('a.com → 1.1.1.1') && l.includes('u1'))).toBe(true);
    expect(logs.some((l) => l.includes('b.com → 2.2.2.2') && l.includes('系统 DNS'))).toBe(true);
    expect(logs.some((l) => l.includes('回退域名') && l.includes('c.com'))).toBe(true);
    expect(logs.every((l) => l.startsWith('debug|'))).toBe(true);
  });

  it('缓存命中也打 debug（标「缓存」）', async () => {
    const logs: string[] = [];
    const log = (lvl: 'debug' | 'info' | 'warn', msg: string) => logs.push(`${lvl}|${msg}`);
    const cache = new Map();
    const doh = jest.fn(async () => ['3.3.3.3']);
    const common = { doh, upstreams: ['https://u1/dns-query'], cache };
    await resolveNodeDomains(['x.com'], common); // 首解 → 写缓存
    await resolveNodeDomains(['x.com'], { ...common, log }); // 命中缓存
    expect(logs.some((l) => l.includes('x.com → 3.3.3.3') && l.includes('缓存'))).toBe(true);
    expect(doh).toHaveBeenCalledTimes(1); // 第二次未再 DoH
  });
});
