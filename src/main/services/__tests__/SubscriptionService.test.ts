/**
 * SubscriptionService 单测（node env）。mock electron(app/net/session) + node dns。
 * 覆盖 review 必修：
 *  - HIGH-1：JSON-Clash 0 节点 throw（不被 catch 吞 → 不 fall through 落空集）。
 *  - M5：sing-box JSON / URL-list / Base64 三分支 0 节点 throw。
 *  - partial：provider transient 失败 → partial=true（调用方 merge-only）；permanent → 不 partial。
 *  - H1（SSRF DNS rebinding）：域名解析到内网 IP → 拒绝。
 *  - H2（重定向绕过）：30x 跳到内网 → 拒绝；正常跳转过 guard 续跳。
 *  - M2：响应体积超限 → throw。
 *  - M6：日志 url 脱敏（去 query）。
 *  - vmess 指纹 parity（Clash vs ProtocolParser）。
 *  - LOW-1：provider 复用主解析；内容再嵌套 proxy-providers → warn 不递归。
 */

// ── electron mock（必须在 import SubscriptionService 之前）──────────────────────
const mockFetch = jest.fn();
const mockSetProxy = jest.fn().mockResolvedValue(undefined);
jest.mock('electron', () => ({
  app: { getVersion: () => '9.9.9' },
  net: { fetch: (...a: unknown[]) => mockFetch(...a) },
  session: {
    fromPartition: () => ({
      setProxy: mockSetProxy,
      fetch: (...a: unknown[]) => mockFetch(...a),
    }),
  },
}));

// ── node dns mock（H1 SSRF：控制解析结果）──────────────────────────────────────
const mockLookup = jest.fn();
jest.mock('dns', () => ({
  promises: { lookup: (...a: unknown[]) => mockLookup(...a) },
}));

import { SubscriptionService } from '../SubscriptionService';
import { ProtocolParser } from '../ProtocolParser';
import type { ServerConfig } from '../../../shared/types';

const SUB_ID = 'sub-x';

// LogManager 桩：仅收集日志供 M6 脱敏断言。
class FakeLog {
  entries: { level: string; message: string }[] = [];
  addLog(level: string, message: string) {
    this.entries.push({ level, message });
  }
}

/** 构造 fetch Response 桩。body 用 ReadableStream（走 readBodyCapped 流式路径）。 */
function makeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}): unknown {
  const status = opts.status ?? 200;
  const headersMap = new Map<string, string>(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const text = opts.body ?? '';
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headersMap.get(k.toLowerCase()) ?? null },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    async text() {
      return text;
    },
  };
}

function newService(log: FakeLog): SubscriptionService {
  return new SubscriptionService(new ProtocolParser(), log as never);
}

/** 默认：所有域名解析到公网 IP（不触发 SSRF 拒绝）。 */
function allowAllDns() {
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
}

beforeEach(() => {
  mockFetch.mockReset();
  mockLookup.mockReset();
  allowAllDns();
});

describe('HIGH-1 + M5 — 0 节点必须 throw（不穿仓）', () => {
  it('HIGH-1：JSON 编码 Clash 0 可用节点 → throw（不 fall through 落空集）', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    // proxies 全是不支持类型 → 解析得 0 节点；JSON-Clash 分支应 throw 而非被 catch 吞。
    const body = JSON.stringify({
      proxies: [{ name: 'x', type: 'ssr', server: '1.1.1.1', port: 1 }],
    });
    mockFetch.mockResolvedValue(makeResponse({ body }));
    await expect(svc.fetchSubscription('https://sub.example.com/c', SUB_ID)).rejects.toThrow(
      /0 个可用节点/
    );
  });

  it('M5：sing-box JSON outbounds 0 节点 → throw', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    const body = JSON.stringify({ outbounds: [{ type: 'direct', tag: 'd' }] }); // 无受支持节点
    mockFetch.mockResolvedValue(makeResponse({ body }));
    await expect(svc.fetchSubscription('https://sub.example.com/sb', SUB_ID)).rejects.toThrow(
      /sing-box 订阅解析得到 0/
    );
  });

  it('M5：URL-list 全不可解析 → throw', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    mockFetch.mockResolvedValue(makeResponse({ body: 'notaurl://garbage\nmailto:x@y' }));
    await expect(svc.fetchSubscription('https://sub.example.com/u', SUB_ID)).rejects.toThrow(
      /0 个可用节点|无法识别/
    );
  });

  it('M5：Base64 解码后 0 节点 → throw', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    const b64 = Buffer.from('ssr://unsupported\n', 'utf-8').toString('base64');
    mockFetch.mockResolvedValue(makeResponse({ body: b64 }));
    await expect(svc.fetchSubscription('https://sub.example.com/b', SUB_ID)).rejects.toThrow(
      /0 个可用节点|无法识别/
    );
  });

  it('正常 JSON-Clash 有节点 → 不 throw，返回 servers', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    const body = JSON.stringify({
      proxies: [{ name: 'ok', type: 'vless', server: '1.2.3.4', port: 443, uuid: 'u' }],
    });
    mockFetch.mockResolvedValue(makeResponse({ body }));
    const r = await svc.fetchSubscription('https://sub.example.com/c', SUB_ID);
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0].protocol).toBe('vless');
  });
});

describe('partial → merge-only（reconcile 不删 leftover）', () => {
  it('provider transient 失败 → partial=true', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    // 主订阅：内联 1 节点 + 1 个 http provider；provider fetch 抛错（transient）。
    const main = JSON.stringify({
      proxies: [{ name: 'inline', type: 'vless', server: '1.1.1.1', port: 443, uuid: 'a' }],
      'proxy-providers': { p1: { type: 'http', url: 'https://prov.example.com/p1' } },
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('prov.example.com')) throw new Error('HTTP Error: 503');
      return makeResponse({ body: main });
    });
    const r = await svc.fetchSubscription('https://sub.example.com/c', SUB_ID);
    expect(r.partial).toBe(true);
    expect(r.servers.map((s) => s.name)).toContain('inline');
  });

  it('reconcile：partial 时 deletedIds 的 leftover 保留（merge-only）', () => {
    const old: ServerConfig[] = [
      { id: 'old1', name: 'keep', protocol: 'vless', address: '1.1.1.1', port: 443, uuid: 'a' },
      { id: 'old2', name: 'gone', protocol: 'vless', address: '2.2.2.2', port: 443, uuid: 'b' },
    ];
    // 新抓取只含 old1 指纹 → old2 进 deletedIds。
    const fetched: ServerConfig[] = [
      {
        id: 'newx',
        name: 'keep-renamed',
        protocol: 'vless',
        address: '1.1.1.1',
        port: 443,
        uuid: 'a',
      },
    ];
    const { servers, deletedIds } = SubscriptionService.reconcileServers(old, fetched, 'NOW');
    expect(deletedIds.has('old2')).toBe(true);
    // reconcile 命中保留旧 id（old1），名字以新值（keep-renamed）为准。
    expect(servers.map((s) => s.id)).toEqual(['old1']);
    expect(servers[0].name).toBe('keep-renamed');
    // 模拟 handler 的 merge-only：partial 时把 leftover 加回 → old2 不删。
    const leftover = old.filter((s) => deletedIds.has(s.id));
    const finalKeep = [...servers, ...leftover];
    expect(finalKeep.map((s) => s.id).sort()).toEqual(['old1', 'old2']);
  });

  it('M1：leftoverToKeep 按 provider 精确——只留失败 provider 名下的下架节点', () => {
    const old: ServerConfig[] = [
      {
        id: 'a',
        name: 'failP',
        protocol: 'vless',
        address: '1.1.1.1',
        port: 1,
        uuid: 'a',
        providerName: 'P_fail',
      },
      {
        id: 'b',
        name: 'okP',
        protocol: 'vless',
        address: '2.2.2.2',
        port: 2,
        uuid: 'b',
        providerName: 'P_ok',
      },
      { id: 'c', name: 'legacy', protocol: 'vless', address: '3.3.3.3', port: 3, uuid: 'c' },
    ];
    const deletedIds = new Set(['a', 'b', 'c']);
    // 失败 provider(P_fail) 名下 → 保留；成功 provider(P_ok) 真下架 → 删；undefined 归属（迁移前/内联）→ 保守保留。
    const kept = SubscriptionService.leftoverToKeep(old, deletedIds, ['P_fail']);
    expect(kept.map((s) => s.id).sort()).toEqual(['a', 'c']);
  });

  it('M1：failedProviders 空/缺（partial 但失败名未知）→ 全保守保留（退回整订阅级）', () => {
    const old: ServerConfig[] = [
      {
        id: 'a',
        name: 'x',
        protocol: 'vless',
        address: '1.1.1.1',
        port: 1,
        uuid: 'a',
        providerName: 'P_ok',
      },
      { id: 'b', name: 'y', protocol: 'vless', address: '2.2.2.2', port: 2, uuid: 'b' },
    ];
    const deletedIds = new Set(['a', 'b']);
    expect(
      SubscriptionService.leftoverToKeep(old, deletedIds, [])
        .map((s) => s.id)
        .sort()
    ).toEqual(['a', 'b']);
    expect(
      SubscriptionService.leftoverToKeep(old, deletedIds, undefined)
        .map((s) => s.id)
        .sort()
    ).toEqual(['a', 'b']);
  });

  it('M1：仅作用于 deletedIds——未删除的节点不进 leftover', () => {
    const old: ServerConfig[] = [
      {
        id: 'a',
        name: 'x',
        protocol: 'vless',
        address: '1.1.1.1',
        port: 1,
        uuid: 'a',
        providerName: 'P_fail',
      },
    ];
    expect(SubscriptionService.leftoverToKeep(old, new Set<string>(), ['P_fail'])).toEqual([]);
  });
});

describe('H1 SSRF DNS rebinding', () => {
  it('域名解析到 127.0.0.1 → 拒绝（不发 fetch）', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    mockLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    mockFetch.mockResolvedValue(makeResponse({ body: '' }));
    await expect(svc.fetchSubscription('https://evil.example.com/c', SUB_ID)).rejects.toThrow(
      /本机\/内网\/link-local/
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('域名解析到 169.254.169.254（云元数据）→ 拒绝', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(svc.fetchSubscription('https://metadata.example.com/c', SUB_ID)).rejects.toThrow(
      /本机\/内网\/link-local/
    );
  });

  it('域名解析到内网 10.x → 拒绝', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    mockLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
    await expect(svc.fetchSubscription('https://x.example.com/c', SUB_ID)).rejects.toThrow(
      /本机\/内网/
    );
  });

  it('多解析结果含一个内网 IP → 拒绝（逐 IP 校验）', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.0.5', family: 4 },
    ]);
    await expect(svc.fetchSubscription('https://x.example.com/c', SUB_ID)).rejects.toThrow(
      /本机\/内网/
    );
  });

  it('字面内网 IP host（localhost/127.0.0.1）直接拒（不查 DNS）', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    await expect(svc.fetchSubscription('http://127.0.0.1:9090/c', SUB_ID)).rejects.toThrow(
      /本机\/内网/
    );
    await expect(svc.fetchSubscription('http://localhost/c', SUB_ID)).rejects.toThrow(/本机\/内网/);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('解析到公网 IP → 放行', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    mockLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    const body = JSON.stringify({
      proxies: [{ name: 'ok', type: 'vless', server: '1.2.3.4', port: 443, uuid: 'u' }],
    });
    mockFetch.mockResolvedValue(makeResponse({ body }));
    const r = await svc.fetchSubscription('https://ok.example.com/c', SUB_ID);
    expect(r.servers).toHaveLength(1);
  });
});

describe('H2 重定向绕过', () => {
  it('30x 跳到内网域名 → 拒绝（重定向目标过 guard）', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    // 首跳：公网；Location 指向内网域名 → 第二次 lookup 返回内网。
    mockLookup.mockImplementation(async (host: string) => {
      if (host === 'inner.example.com') return [{ address: '10.0.0.9', family: 4 }];
      return [{ address: '93.184.216.34', family: 4 }];
    });
    mockFetch.mockResolvedValueOnce(
      makeResponse({ status: 302, headers: { location: 'https://inner.example.com/c' } })
    );
    await expect(svc.fetchSubscription('https://entry.example.com/c', SUB_ID)).rejects.toThrow(
      /本机\/内网/
    );
  });

  it('30x 跳到公网 → 续跳并返回最终内容', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    const body = JSON.stringify({
      proxies: [{ name: 'final', type: 'vless', server: '1.2.3.4', port: 443, uuid: 'u' }],
    });
    mockFetch
      .mockResolvedValueOnce(
        makeResponse({ status: 301, headers: { location: 'https://cdn.example.com/real' } })
      )
      .mockResolvedValueOnce(makeResponse({ body }));
    const r = await svc.fetchSubscription('https://entry.example.com/c', SUB_ID);
    expect(r.servers.map((s) => s.name)).toEqual(['final']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('重定向次数超过上限 → 拒绝', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    // 始终 302 自跳 → 触发 MAX_REDIRECTS。
    mockFetch.mockResolvedValue(
      makeResponse({ status: 302, headers: { location: 'https://loop.example.com/next' } })
    );
    await expect(svc.fetchSubscription('https://loop.example.com/c', SUB_ID)).rejects.toThrow(
      /重定向次数超过上限/
    );
  });
});

describe('M2 体积上限', () => {
  it('content-length 预检超限 → 拒绝', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    mockFetch.mockResolvedValue(
      makeResponse({ headers: { 'content-length': String(20 * 1024 * 1024) }, body: 'x' })
    );
    await expect(svc.fetchSubscription('https://big.example.com/c', SUB_ID)).rejects.toThrow(
      /体积.*超过上限/
    );
  });

  it('读取后字节超限（content-length 缺失）→ 拒绝', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    // 11MB body，无 content-length → readBodyCapped 累计超限 abort。
    const huge = 'a'.repeat(11 * 1024 * 1024);
    mockFetch.mockResolvedValue(makeResponse({ body: huge }));
    await expect(svc.fetchSubscription('https://big.example.com/c', SUB_ID)).rejects.toThrow(
      /体积.*超过上限/
    );
  });
});

describe('M6 日志 url 脱敏', () => {
  it('正在拉取/失败日志去 query（不落 token）', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    mockFetch.mockResolvedValue(makeResponse({ body: 'notaurl://x' })); // 触发 0 节点 throw
    await expect(
      svc.fetchSubscription('https://sub.example.com/c?token=SECRET123', SUB_ID)
    ).rejects.toThrow();
    const joined = log.entries.map((e) => e.message).join('\n');
    expect(joined).not.toContain('SECRET123');
    expect(joined).toContain('正在拉取订阅');
    expect(joined).toContain('<redacted>');
  });
});

describe('vmess 指纹 parity（Clash vs ProtocolParser）', () => {
  it('vmess 四元组全等（经 fetchSubscription 走 Clash 解析）', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    const body = JSON.stringify({
      proxies: [{ name: 'vm', type: 'vmess', server: '5.5.5.5', port: 443, uuid: 'VM-UUID' }],
    });
    mockFetch.mockResolvedValue(makeResponse({ body }));
    const r = await svc.fetchSubscription('https://sub.example.com/c', SUB_ID);
    const clash = r.servers[0];
    const url = new ProtocolParser().parseUrl(
      'vmess://' +
        Buffer.from(
          JSON.stringify({
            v: '2',
            add: '5.5.5.5',
            port: '443',
            id: 'VM-UUID',
            aid: '0',
            net: 'tcp',
            ps: 'vm',
          })
        ).toString('base64')
    );
    const four = (s: ServerConfig) => [
      (s.protocol || '').toLowerCase(),
      s.address,
      s.port,
      s.uuid || s.password || '',
    ];
    expect(four(clash)).toEqual(four(url));
  });
});

describe('LOW-1 provider 复用主解析 — 嵌套 proxy-providers 不递归 + warn', () => {
  it('provider 内容再含 proxy-providers → 只取内联 + warn（不递归）', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    const main = JSON.stringify({
      'proxy-providers': { p1: { type: 'http', url: 'https://prov.example.com/p1' } },
    });
    // provider 响应：内联 1 节点 + 嵌套 proxy-providers（应被 allowProviders:false 拦下，仅 warn）。
    const provBody = JSON.stringify({
      proxies: [{ name: 'prov-node', type: 'vless', server: '3.3.3.3', port: 443, uuid: 'c' }],
      'proxy-providers': { nested: { type: 'http', url: 'https://prov.example.com/nested' } },
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/p1')) return makeResponse({ body: provBody });
      if (url.includes('/nested')) throw new Error('不应被请求（嵌套不递归）');
      return makeResponse({ body: main });
    });
    const r = await svc.fetchSubscription('https://sub.example.com/c', SUB_ID);
    expect(r.servers.map((s) => s.name)).toEqual(['prov-node']);
    const joined = log.entries.map((e) => e.message).join('\n');
    expect(joined).toMatch(/再嵌套 proxy-providers|不递归/);
  });
});

describe('parseLocalContent — 本地导入（不联网）', () => {
  it('sing-box JSON：映射受支持节点 + 不支持 type 透传 custom + 内部 type 忽略；节点剥 subscriptionId', async () => {
    const svc = newService(new FakeLog());
    const text = JSON.stringify({
      outbounds: [
        { type: 'vless', tag: 'v1', server: '1.2.3.4', server_port: 443, uuid: 'abc' },
        { type: 'tor', tag: 't1' }, // 不支持 → 透传 custom
        { type: 'direct', tag: 'd' }, // 内部 → 忽略
      ],
    });
    const r = await svc.parseLocalContent(text);
    expect(r.format).toBe('singbox');
    expect(r.nodes).toHaveLength(2);
    expect(r.stats.unsupported).toBe(1);
    const custom = r.nodes.find((n) => n.protocol === 'custom')!;
    expect((custom.customSettings?.outbound as { type?: string })?.type).toBe('tor');
    expect(r.nodes.every((n) => n.subscriptionId === undefined)).toBe(true);
  });

  it('Xray JSON：按 protocol 解析（区别于 sing-box 的 type）', async () => {
    const svc = newService(new FakeLog());
    const text = JSON.stringify({
      outbounds: [
        {
          protocol: 'vmess',
          tag: 'vm1',
          settings: { vnext: [{ address: '1.2.3.4', port: 443, users: [{ id: 'uuid-x' }] }] },
        },
        { protocol: 'freedom', tag: 'd' },
      ],
    });
    const r = await svc.parseLocalContent(text);
    expect(r.format).toBe('xray');
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0].protocol).toBe('vmess');
    expect(r.nodes[0].uuid).toBe('uuid-x');
  });

  it('Clash YAML：proxies→自建节点；proxy-providers→订阅 {name,url}（不拉取）', async () => {
    const svc = newService(new FakeLog());
    const text = [
      'proxies:',
      '  - { name: a, type: vless, server: 1.2.3.4, port: 443, uuid: u }',
      'proxy-providers:',
      '  prov:',
      '    type: http',
      '    url: https://prov.example.com/p',
    ].join('\n');
    const r = await svc.parseLocalContent(text);
    expect(r.format).toBe('clash');
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0].subscriptionId).toBeUndefined();
    expect(r.subscriptions).toEqual([{ name: 'prov', url: 'https://prov.example.com/p' }]);
  });

  it('Base64 分享链接：解码后逐行解析为自建节点', async () => {
    const svc = newService(new FakeLog());
    const link = 'vless://uuid-z@5.6.7.8:443?security=tls&type=tcp#mynode';
    const b64 = Buffer.from(link, 'utf-8').toString('base64');
    const r = await svc.parseLocalContent(b64);
    expect(r.format).toBe('links');
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0].protocol).toBe('vless');
    expect(r.nodes[0].subscriptionId).toBeUndefined();
  });

  it('必填不全的节点被最终 gate 过滤计 failed（不入库防整体失败）', async () => {
    const svc = newService(new FakeLog());
    const text = JSON.stringify({
      outbounds: [{ type: 'vless', tag: 'bad', server: '1.2.3.4', server_port: 443 }], // 缺 uuid
    });
    const r = await svc.parseLocalContent(text);
    expect(r.nodes).toHaveLength(0);
    expect(r.stats.failed).toBeGreaterThanOrEqual(1);
  });

  it('不可识别格式 → throw（门控）', async () => {
    const svc = newService(new FakeLog());
    await expect(svc.parseLocalContent('this-is-not-a-config')).rejects.toThrow(/无法识别/);
  });

  it('sing-box socks/http 原生映射（非 custom，不置灰）', async () => {
    const svc = newService(new FakeLog());
    const text = JSON.stringify({
      outbounds: [
        {
          type: 'socks',
          tag: 's5',
          server: '1.2.3.4',
          server_port: 1080,
          username: 'u',
          password: 'p',
        },
        { type: 'http', tag: 'h', server: '1.2.3.4', server_port: 8080 },
      ],
    });
    const r = await svc.parseLocalContent(text);
    expect(r.format).toBe('singbox');
    expect(r.nodes.map((n) => n.protocol).sort()).toEqual(['http', 'socks']);
    expect(r.stats.unsupported).toBe(0);
  });

  it('端口越界(>65535)被最终 gate 过滤计 failed（防整批 saveConfig throw）', async () => {
    const svc = newService(new FakeLog());
    const text = JSON.stringify({
      outbounds: [
        { type: 'vless', tag: 'bad-port', server: '1.2.3.4', server_port: 70000, uuid: 'u' },
      ],
    });
    const r = await svc.parseLocalContent(text);
    expect(r.nodes).toHaveLength(0);
    expect(r.stats.failed).toBeGreaterThanOrEqual(1);
  });

  it('导入内容过大 → throw（体积闸）', async () => {
    const svc = newService(new FakeLog());
    const huge = 'x'.repeat(10 * 1024 * 1024 + 1);
    await expect(svc.parseLocalContent(huge)).rejects.toThrow(/过大/);
  });
});

// ── issue #263 补丁组：丢弃可见性聚合 / 指纹传输维度 / sing-box ssh 映射 ──
describe('issue #263 — 聚合可见性 / 指纹传输维度 / ssh 映射', () => {
  const CTX = { allowProviders: true, viaProxy: false, userAgent: 'ua' };

  it('URL-list：不支持 scheme 聚合 warn + 结果 info 带跳过计数', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    const content = [
      'vless://uuid-1@a.com:443?encryption=none#ok',
      'ssr://AAAA',
      'ssr://BBBB',
      'juicity://CCCC',
    ].join('\n');
    const r = await (svc as any).parseSubscriptionContent(content, 'sub-x', CTX);
    expect(r.servers).toHaveLength(1);
    const warns = log.entries
      .filter((e) => e.level === 'warn')
      .map((e) => e.message)
      .join('\n');
    expect(warns).toMatch(/跳过不支持的协议链接/);
    expect(warns).toMatch(/ssr\(2\)/);
    expect(warns).toMatch(/juicity\(1\)/);
    const infos = log.entries
      .filter((e) => e.level === 'info')
      .map((e) => e.message)
      .join('\n');
    expect(infos).toMatch(/另有 3 条被跳过\/失败/);
  });

  it('URL-list：xhttp 节点 fail 计入结果 info（issue #263 主症状可见化）', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    const content = [
      'anytls://pw@a.com:443#any',
      'vless://uuid-1@a.com:443?type=xhttp#dead',
    ].join('\n');
    const r = await (svc as any).parseSubscriptionContent(content, 'sub-x', CTX);
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0].protocol).toBe('anytls');
    const warns = log.entries
      .filter((e) => e.level === 'warn')
      .map((e) => e.message)
      .join('\n');
    expect(warns).toMatch(/不支持的传输层类型: xhttp/);
    const infos = log.entries
      .filter((e) => e.level === 'info')
      .map((e) => e.message)
      .join('\n');
    expect(infos).toMatch(/另有 1 条被跳过\/失败/);
  });

  it('sing-box outbounds：type/transport/缺字段三类跳过聚合 warn；internal 类型不计噪声', () => {
    const log = new FakeLog();
    const svc = newService(log);
    const obs = [
      { type: 'vless', tag: 'ok', server: 'a.com', server_port: 443, uuid: 'u' },
      { type: 'wireguard', tag: 'wg', server: 'a.com', server_port: 51820 },
      { type: 'vless', tag: 'noport', server: 'a.com', uuid: 'u' },
      { type: 'vless', tag: 'quic', server: 'a.com', server_port: 443, uuid: 'u', transport: { type: 'quic' } },
      { type: 'direct', tag: 'direct' },
      { type: 'selector', tag: 'sel', outbounds: [] },
    ];
    const servers = (svc as any).parseSingboxOutbounds(obs, 'sub-x');
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('ok');
    const warns = log.entries
      .filter((e) => e.level === 'warn')
      .map((e) => e.message)
      .join('\n');
    expect(warns).toMatch(/跳过不支持的 outbound 类型: wireguard\(1\)/);
    expect(warns).toMatch(/跳过不支持的传输层类型: quic\(1\)/);
    expect(warns).toMatch(/跳过 1 个缺 server\/port 的 outbound/);
    expect(warns).not.toMatch(/direct|selector/);
  });

  it('sing-box ssh outbound → 一等映射（与 Clash 路径同落点；private_key_path 刻意不收）', () => {
    const log = new FakeLog();
    const svc = newService(log);
    const servers = (svc as any).parseSingboxOutbounds(
      [
        {
          type: 'ssh',
          tag: 's1',
          server: 'a.com',
          server_port: 22,
          user: 'root',
          password: 'pw',
          private_key: 'PEM',
          private_key_passphrase: 'pp',
          host_key: ['ssh-ed25519 AAAA'],
          host_key_algorithms: ['ssh-ed25519'],
          client_version: 'SSH-2.0-x',
        },
      ],
      'sub-x'
    );
    expect(servers).toHaveLength(1);
    expect(servers[0].protocol).toBe('ssh');
    expect(servers[0].sshSettings).toEqual({
      user: 'root',
      password: 'pw',
      privateKey: 'PEM',
      privateKeyPassphrase: 'pp',
      hostKey: ['ssh-ed25519 AAAA'],
      hostKeyAlgorithms: ['ssh-ed25519'],
      clientVersion: 'SSH-2.0-x',
    });
  });

  it('serverFingerprint 含传输维度：同 host:port:cred 不同 network 不再误并；缺省归一 tcp', () => {
    const base = {
      id: 'i',
      name: 'n',
      protocol: 'vless',
      address: 'a.com',
      port: 443,
      uuid: 'u',
    } as unknown as ServerConfig;
    const ws = { ...base, network: 'ws' } as ServerConfig;
    const grpc = { ...base, network: 'grpc' } as ServerConfig;
    expect(SubscriptionService.serverFingerprint(ws)).not.toBe(
      SubscriptionService.serverFingerprint(grpc)
    );
    expect(SubscriptionService.serverFingerprint(base)).toMatch(/\|tcp$/);
  });
});

describe('issue #263 review 补测 — ssh 算法字段 / 行首空白', () => {
  it('ssh outbound cipher/mac/kex_algorithm → sshSettings 对应落点（不静默丢协商配置）', () => {
    const log = new FakeLog();
    const svc = newService(log);
    const servers = (svc as any).parseSingboxOutbounds(
      [
        {
          type: 'ssh',
          tag: 's',
          server: 'a.com',
          server_port: 22,
          user: 'root',
          password: 'pw',
          cipher: ['aes128-gcm@openssh.com'],
          mac: ['hmac-sha2-256'],
          kex_algorithm: ['curve25519-sha256'],
        },
      ],
      'sub-x'
    );
    expect(servers[0].sshSettings).toMatchObject({
      cipher: ['aes128-gcm@openssh.com'],
      mac: ['hmac-sha2-256'],
      kexAlgorithm: ['curve25519-sha256'],
    });
  });

  it('URL-list 行首空白的合法链接正常解析，不误计「不支持 scheme」', async () => {
    const log = new FakeLog();
    const svc = newService(log);
    const content = '  vless://uuid-1@a.com:443?encryption=none#ok  \n\t trojan://pw@b.com:443#t';
    const r = await (svc as any).parseSubscriptionContent(content, 'sub-x', {
      allowProviders: true,
      viaProxy: false,
      userAgent: 'ua',
    });
    expect(r.servers).toHaveLength(2);
    const warns = log.entries.filter((e) => e.level === 'warn');
    expect(warns.find((w) => w.message.includes('跳过不支持的协议链接'))).toBeUndefined();
  });
});

// ── Snell（一等公民，issue #146）：sing-box JSON 订阅路径映射 + 能力门控 ──
describe('parseSingboxOutbounds — snell', () => {
  it('v4 obfs http + v6 mode/userkey/reuse/network → 一等映射', () => {
    const log = new FakeLog();
    const svc = newService(log);
    const servers = (svc as any).parseSingboxOutbounds(
      [
        {
          type: 'snell',
          tag: 'sn4',
          server: 's.com',
          server_port: 443,
          version: 4,
          psk: 'psk-secret',
          obfs_mode: 'http',
          obfs_host: 'bing.com',
        },
        {
          type: 'snell',
          tag: 'sn6',
          server: 's.com',
          server_port: 444,
          version: 6,
          psk: 'p6',
          mode: 'unsafe-raw',
          reuse: true,
          network: 'tcp',
          userkey: 'uk',
        },
      ],
      'sub-x'
    );
    expect(servers).toHaveLength(2);
    expect(servers[0].protocol).toBe('snell');
    expect(servers[0].password).toBe('psk-secret');
    expect(servers[0].snellSettings).toEqual({ version: 4, obfsMode: 'http', obfsHost: 'bing.com' });
    expect(servers[1].snellSettings).toEqual({
      version: 6,
      mode: 'unsafe-raw',
      reuse: true,
      network: 'tcp',
      userkey: 'uk',
    });
  });

  it('版本非 4|6 / 缺 psk → warn 跳过（防坏节点连累整份订阅保存）', () => {
    const log = new FakeLog();
    const svc = newService(log);
    const servers = (svc as any).parseSingboxOutbounds(
      [
        { type: 'snell', tag: 'v3', server: 's.com', server_port: 443, version: 3, psk: 'p' },
        { type: 'snell', tag: 'nopsk', server: 's.com', server_port: 443, version: 4 },
      ],
      'sub-x'
    );
    expect(servers).toHaveLength(0);
    const warns = log.entries
      .filter((e) => e.level === 'warn')
      .map((e) => e.message)
      .join('\n');
    expect(warns).toMatch(/版本 3 不受支持/);
    expect(warns).toMatch(/缺 psk/);
  });
});

describe('parseSingboxOutbounds — snell review 边界补测', () => {
  it('v6 + obfs_mode http（脏 JSON）→ obfsMode 不落库（不变量：obfs 仅 v4）', () => {
    const log = new FakeLog();
    const svc = newService(log);
    const servers = (svc as any).parseSingboxOutbounds(
      [
        {
          type: 'snell',
          tag: 'dirty',
          server: 's.com',
          server_port: 443,
          version: 6,
          psk: 'p',
          obfs_mode: 'http',
          obfs_host: 'x.com',
        },
      ],
      'sub-x'
    );
    expect(servers).toHaveLength(1);
    expect(servers[0].snellSettings).toEqual({ version: 6 });
  });

  it('空白 psk → warn 跳过（trim 语义对齐 completeness）', () => {
    const log = new FakeLog();
    const svc = newService(log);
    const servers = (svc as any).parseSingboxOutbounds(
      [{ type: 'snell', tag: 'blank', server: 's.com', server_port: 443, version: 4, psk: '  ' }],
      'sub-x'
    );
    expect(servers).toHaveLength(0);
    expect(
      log.entries.filter((e) => e.level === 'warn').map((e) => e.message).join('\n')
    ).toMatch(/缺 psk/);
  });
});
