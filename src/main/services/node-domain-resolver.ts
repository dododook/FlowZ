/**
 * #57 resolve-ahead：配置生成前，把代理节点服务器域名并发多上游预解析为 IP。
 *
 * 根因：节点域名解析绑死单点（dial→dns-bootstrap、rule1→dns-domestic），任一被限速/劫持/不可达 → 整条代理挂。
 * sing-box 无原生 DNS fallback/racing，故在 FlowZ 主进程侧把节点域名解析成 IP 字面量、写进 outbound.server
 * （SNI/Host 仍保留原域名，见 buildProxyOutbound）。本质 = 自动化「优选 IP」，拨号不再依赖运行时 DNS。
 *
 * 分层 race（抗污染）：
 *  - Tier 1：IP-DoH 池（AliDNS 223.5.5.5 + DNSPod 1.12.12.12）并发，Promise.any 取首个返回合法 A 的；单上游超时。
 *  - Tier 2：系统 DNS resolve4，仅在 Tier1 全失败后兜底（系统 DNS 可能被污染 → 不与 DoH 抢跑）。
 *  - 全失败 → 该域名不进结果（调用方回退原域名，走既有 dns-bootstrap，优雅降级）。
 *
 * 边界：去重入参、跳过 IP 字面量、TTL 缓存（重启仅重解析过期项）、整批时间预算（绝不无限阻塞 start）。
 * 仅解析 A（IPv4）——与关 IPv6 时 ipv4_only 一致；节点仅 v6 的极少数情形回退域名。
 *
 * 全部网络出入口（doh / systemResolve4 / now / cache）可注入 → 单测零真实网络（见 node-domain-resolver.test.ts）。
 */
import { isIpv4 } from '../../shared/ip';
import { isIpLiteral } from '../../shared/dns';
import { encodeDnsQuery, decodeDnsAnswers } from '../../shared/dns-wire';

/** IP-DoH 端点（IP 字面量，证书含 IP SAN；与 dns-bootstrap/dns-node 同源，主进程直连可达）。 */
export const DOH_ALIDNS = 'https://223.5.5.5/dns-query';
export const DOH_DNSPOD = 'https://1.12.12.12/dns-query';
/** Tier1 IP-DoH 上游池（auto 档）：AliDNS + DNSPod 并发抗污染。 */
export const DOH_UPSTREAMS: readonly string[] = [DOH_ALIDNS, DOH_DNSPOD];

export const DEFAULT_TTL_MS = 5 * 60_000; // 5min：start/restart 仅重解析过期项
export const DEFAULT_PER_UPSTREAM_TIMEOUT_MS = 1500;
export const DEFAULT_TOTAL_BUDGET_MS = 3000; // 整批硬上限，超时未完者按未解析处理
export const DEFAULT_MAX_CONCURRENCY = 16; // 域名级并发上限，防大订阅一次性数百 fetch 触发上游限流/FD 压力

/**
 * 节点解析「档位」(dnsConfig.nodeDomainResolver) → 预解析上游池，使「前置开关」与「解析档位」正交：
 * 档位选【用哪个解析器】、开关选【是否前置】，不再相互架空（修 review 重复冗余）。
 *  - auto（缺省）→ AliDNS + DNSPod DoH 池（并发抗污染）；
 *  - dnspod      → 仅 DNSPod DoH；
 *  - system      → 空池（跳过 DoH，纯系统 DNS resolve4）——尊重用户显式选 system 的意图，前置仍生效。
 */
export function upstreamsForResolverMode(
  mode: 'auto' | 'dnspod' | 'system' | undefined
): readonly string[] {
  if (mode === 'system') return [];
  if (mode === 'dnspod') return [DOH_DNSPOD];
  return DOH_UPSTREAMS;
}

interface CacheEntry {
  ip: string;
  expireAt: number;
}

export interface NodeResolveOptions {
  /** 注入 DoH 查询（默认 fetch + dns-wire）。返回该域名的 IPv4 列表（空=无 A）。signal 触发即中断。 */
  doh?: (upstream: string, domain: string, signal: AbortSignal) => Promise<string[]>;
  /** 注入系统 DNS resolve4（默认 dns.promises.resolve4）。 */
  systemResolve4?: (domain: string) => Promise<string[]>;
  /** 注入时钟（默认 Date.now），供 TTL 单测。 */
  now?: () => number;
  /** 注入/复用 TTL 缓存（默认模块级单例，跨 start 持久）。 */
  cache?: Map<string, CacheEntry>;
  ttlMs?: number;
  perUpstreamTimeoutMs?: number;
  totalBudgetMs?: number;
  upstreams?: readonly string[];
  /** 域名级并发上限（默认 16）。整批仍受 totalBudgetMs 硬约束，池只平滑并发、不改预算上限。 */
  maxConcurrency?: number;
  /** 日志回调：debug 级逐域名打解析路径（域名→IP/经哪个上游/失败回退/缓存命中），供 #57 真机排查。 */
  log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
}

/** 模块级 TTL 缓存单例：跨 start/restart 持久，重启廉价（仅重解析过期项）。 */
const sharedCache = new Map<string, CacheEntry>();

/** 默认 DoH：POST application/dns-message，解出 A 记录。非 2xx / 解码失败 → []。 */
async function defaultDoh(
  upstream: string,
  domain: string,
  signal: AbortSignal
): Promise<string[]> {
  const resp = await fetch(upstream, {
    method: 'POST',
    headers: {
      'content-type': 'application/dns-message',
      accept: 'application/dns-message',
    },
    body: encodeDnsQuery(domain).buffer as ArrayBuffer,
    signal,
  });
  if (!resp.ok) return [];
  return decodeDnsAnswers(new Uint8Array(await resp.arrayBuffer()));
}

/**
 * Promise.any 等价物（避免要求 ES2021 lib）：首个 fulfilled 即 resolve；全部 reject → reject。
 * 用于 DoH 池 first-valid——任一上游先返回合法 A 即胜出，全失败才回退 Tier2。
 */
function firstResolved<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let pending = promises.length;
    if (pending === 0) {
      reject(new Error('no upstreams'));
      return;
    }
    for (const p of promises) {
      p.then(resolve, () => {
        if (--pending === 0) reject(new Error('all upstreams failed'));
      });
    }
  });
}

/** 默认系统解析：dns.promises.resolve4（与 ProxyManager 现有用法同源）。 */
async function defaultSystemResolve4(domain: string): Promise<string[]> {
  const dns = require('dns').promises;
  return dns.resolve4(domain);
}

/** 把不可取消的 promise 包成「预算 signal abort 即提前 reject」（底层任务在后台自然结束，调用方不再 await）。 */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      }
    );
  });
}

/** 单上游 DoH：单上游超时 + 跟随整批预算中断；返回首个合法 IPv4，否则 reject（供 Promise.any 跳过）。 */
async function attemptDoh(
  upstream: string,
  domain: string,
  doh: NonNullable<NodeResolveOptions['doh']>,
  perTimeoutMs: number,
  budgetSignal: AbortSignal
): Promise<{ ip: string; upstream: string }> {
  const ctrl = new AbortController();
  const onBudget = () => ctrl.abort();
  budgetSignal.addEventListener('abort', onBudget, { once: true });
  const timer = setTimeout(() => ctrl.abort(), perTimeoutMs);
  try {
    const ips = await doh(upstream, domain, ctrl.signal);
    const ip = ips.find((x) => isIpv4(x));
    if (!ip) throw new Error('no A record'); // reject → firstResolved 转向其它上游
    return { ip, upstream }; // 带上游，供调用方 debug 日志标注解析来源
  } finally {
    clearTimeout(timer);
    budgetSignal.removeEventListener('abort', onBudget);
  }
}

/** Tier1：DoH 池并发 first-valid。全失败/空 → null。 */
async function raceDoh(
  domain: string,
  opts: NodeResolveOptions,
  budgetSignal: AbortSignal
): Promise<{ ip: string; upstream: string } | null> {
  const upstreams = opts.upstreams ?? DOH_UPSTREAMS;
  const doh = opts.doh ?? defaultDoh;
  const perTimeoutMs = opts.perUpstreamTimeoutMs ?? DEFAULT_PER_UPSTREAM_TIMEOUT_MS;
  try {
    return await firstResolved(
      upstreams.map((u) => attemptDoh(u, domain, doh, perTimeoutMs, budgetSignal))
    );
  } catch {
    return null; // 所有上游失败/无 A
  }
}

/** 单域名解析结果：IP + 来源（DoH 上游 URL 或「系统 DNS」），供调用方 debug 日志标注。 */
interface ResolveHit {
  ip: string;
  via: string;
}

/** 单域名：Tier1 DoH race → 失败兜 Tier2 系统 DNS（不抢跑）→ 全失败 null。 */
async function resolveOne(
  domain: string,
  opts: NodeResolveOptions,
  budgetSignal: AbortSignal
): Promise<ResolveHit | null> {
  const fromDoh = await raceDoh(domain, opts, budgetSignal);
  if (fromDoh) return { ip: fromDoh.ip, via: fromDoh.upstream };
  if (budgetSignal.aborted) return null; // 预算耗尽：不再发起系统解析
  const systemResolve4 = opts.systemResolve4 ?? defaultSystemResolve4;
  try {
    const ips = await abortable(systemResolve4(domain), budgetSignal);
    const ip = ips.find((x) => isIpv4(x));
    return ip ? { ip, via: '系统 DNS' } : null;
  } catch {
    return null;
  }
}

/**
 * 把一组节点域名并发解析为 IP。返回 Map<域名, IP>；解析不到的域名**不进 map**（调用方回退原域名）。
 * 入参自动去重 + 跳过 IP 字面量；命中未过期缓存直接复用；整批受 totalBudgetMs 硬约束。
 */
export async function resolveNodeDomains(
  domains: string[],
  opts: NodeResolveOptions = {}
): Promise<Map<string, string>> {
  const now = opts.now ?? Date.now;
  const cache = opts.cache ?? sharedCache;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const totalBudgetMs = opts.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;

  const deduped = Array.from(new Set(domains.map((d) => d.trim()).filter(Boolean)));
  const unique = deduped.filter((d) => !isIpLiteral(d));
  // 跳过 IP 字面量（节点本就是 IP，无需预解析；直接复用原值，调用方按未解析回退原值）。补 debug 可观测，
  // 排查「节点为何没走预解析」时一眼看到是 IP 字面量跳过而非解析失败（#57 真机排查）。
  if (unique.length !== deduped.length) {
    const skipped = deduped.filter((d) => isIpLiteral(d));
    opts.log?.('debug', `节点域名预解析跳过 ${skipped.length} 个 IP 字面量：${skipped.join(', ')}`);
  }

  const maxConcurrency = opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;

  const results = new Map<string, string>();
  const toResolve: string[] = [];
  const tNow = now();
  for (const d of unique) {
    const cached = cache.get(d);
    if (cached && cached.expireAt > tNow) {
      results.set(d, cached.ip);
      opts.log?.('debug', `节点域名预解析 ${d} → ${cached.ip}（缓存）`);
    } else {
      if (cached) cache.delete(d); // 顺手淘汰过期项，防模块级缓存随会话无界增长
      toResolve.push(d);
    }
  }
  if (toResolve.length === 0) return results;

  const budgetCtrl = new AbortController();
  const budgetTimer = setTimeout(() => budgetCtrl.abort(), totalBudgetMs);
  const resolveInto = async (d: string) => {
    const hit = await resolveOne(d, opts, budgetCtrl.signal);
    if (hit) {
      results.set(d, hit.ip);
      cache.set(d, { ip: hit.ip, expireAt: now() + ttlMs });
      opts.log?.('debug', `节点域名预解析 ${d} → ${hit.ip}（${hit.via}）`);
    } else {
      opts.log?.('debug', `节点域名预解析失败，回退域名：${d}`);
    }
  };
  try {
    // 域名级并发池（≤maxConcurrency）：大订阅去重后仍可能数百域名，无界并发会一次性打出数百 fetch →
    // 触发上游 DoH 限流 / FD 压力。共享游标拉取，整批受 budgetCtrl 硬约束（预算到点剩余项 resolveOne 立即返 null）。
    let cursor = 0;
    const workers = Array.from({ length: Math.min(maxConcurrency, toResolve.length) }, async () => {
      while (cursor < toResolve.length) {
        await resolveInto(toResolve[cursor++]);
      }
    });
    await Promise.all(workers);
  } finally {
    clearTimeout(budgetTimer);
  }
  return results;
}
